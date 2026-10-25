import {
  type AgentRuntime,
  type ApprovalService,
  type AuditLog,
  BudgetExhaustedError,
  type Budgets,
  type Clock,
  type GatewayOutcome,
  HarnessError,
  type Logger,
  type ModelClient,
  type ModelLoopInput,
  type ModelLoopResult,
  ModelOutputInvalidError,
  type ModelProposal,
  ModelStepOutputSchema,
  type TaskIntent,
  type ToolGateway,
  type ToolManifest,
  type TurnContext,
  type TurnIO,
  hashOf,
  splitToolName,
} from "@campus/contracts";
import { TurnBudget, withTimeout } from "./budgets";
import { callStructured } from "./model/structured";
import {
  OUTPUT_CONTRACT,
  SAFETY_RULES,
  assertPromptClean,
  describeTools,
  wrapData,
  wrapMessage,
  wrapToolResult,
} from "./prompt";
import { SlidingWindowLimiter } from "./rate-limit";

// The agent runtime: model step (structured proposals) → tool gateway → approvals, bounded by
// budgets (spec 4.2 steps 8–10, 4.4). Agents call this; they never talk to the model or gateway directly.

export type AgentRuntimeDeps = {
  model: ModelClient;
  gateway: ToolGateway;
  approvals: ApprovalService;
  audit: AuditLog;
  logger: Logger;
  clock: Clock;
  budgets: Budgets;
  rateLimits: { userModelCallsPer10Min: number; conversationModelCallsPer10Min: number };
};

export const FAIL_SAFE_REPLY =
  "Sorry, something went wrong on my side and I didn't do anything. Please try again in a moment.";
export const BUDGET_REPLY =
  "That took more steps than I'm allowed in one go, so I stopped. Try asking for one thing at a time.";
export const RATE_LIMIT_REPLY =
  "I'm getting a lot of requests right now. Give me a few minutes and try again.";
export const PERMISSION_PROVENANCE_REPLY =
  "I can only change what I'm allowed to do from your own 1:1 chat with me.";

/** The user's own words must ask for a permission change (spec 6.6 provenance). */
export const PERMISSION_INTENT =
  /\b(always|never)\s+(allow|ask|let|do)|\bfrom now on\b|\b(stop|don'?t|do not)\s+ask(ing)?\b|\bask me (every time|first|again)\b|\b(revoke|reset)\b|\bpermissions?\b|\bwhat (can|are) you allowed\b/i;

export class AgentRuntimeImpl implements AgentRuntime {
  private readonly turnBudgets = new Map<string, TurnBudget>();
  private readonly userLimiter: SlidingWindowLimiter;
  private readonly conversationLimiter: SlidingWindowLimiter;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.userLimiter = new SlidingWindowLimiter(deps.rateLimits.userModelCallsPer10Min, 600_000, deps.clock);
    this.conversationLimiter = new SlidingWindowLimiter(
      deps.rateLimits.conversationModelCallsPer10Min,
      600_000,
      deps.clock,
    );
  }

  /** One budget per turn, shared by every runtime call the agent makes during that turn. */
  budgetFor(ctx: TurnContext): TurnBudget {
    let b = this.turnBudgets.get(ctx.turnId);
    if (!b) {
      b = new TurnBudget(this.deps.budgets, ctx.deadlineMs, this.deps.clock);
      this.turnBudgets.set(ctx.turnId, b);
    }
    return b;
  }

  releaseTurn(turnId: string): { modelSteps: number; toolCalls: number; tokens: number } | undefined {
    const b = this.turnBudgets.get(turnId);
    this.turnBudgets.delete(turnId);
    return b ? { modelSteps: b.modelSteps, toolCalls: b.toolCalls, tokens: b.tokens } : undefined;
  }

  private audit(
    ctx: TurnContext,
    action: Parameters<AuditLog["record"]>[0]["action"],
    detail: Record<string, unknown>,
    policyResult?: string,
  ) {
    return this.deps.audit.record({
      action,
      actorUserId: ctx.userId,
      turnId: ctx.turnId,
      conversationId: ctx.conversationId,
      detail,
      ...(policyResult ? { policyResult } : {}),
    });
  }

  async runModelLoop(ctx: TurnContext, input: ModelLoopInput, io: TurnIO): Promise<ModelLoopResult> {
    const budget = this.budgetFor(ctx);
    const result: ModelLoopResult = {
      replyText: "",
      intents: [],
      toolOutcomes: [],
      usedToolData: [],
      status: "ok",
    };

    if (!this.userLimiter.tryTake(ctx.userId) || !this.conversationLimiter.tryTake(ctx.conversationId)) {
      await this.audit(ctx, "turn.rate_limited", { scope: "model_calls" }, "deny");
      return { ...result, replyText: RATE_LIMIT_REPLY, status: "budget_exhausted" };
    }

    let tools: ToolManifest[] = [];
    try {
      tools = await this.deps.gateway.listVisibleTools(ctx);
    } catch (err) {
      this.deps.logger.warn("listVisibleTools failed; continuing with no tools", { turnId: ctx.turnId, err });
    }

    const [system, firstUser] = assertPromptClean(
      [input.systemPrompt, SAFETY_RULES, OUTPUT_CONTRACT, `Available tools:\n${describeTools(tools)}`].join(
        "\n\n",
      ),
      [
        ...input.dataBlocks.map(wrapData),
        wrapMessage(
          ctx.conversationType === "dm" ? "the person you work for" : "group member",
          input.userText,
        ),
      ].join("\n\n"),
    );
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: firstUser! },
    ];
    const notes: string[] = [];
    let replyParts: string[] = [];

    for (let step = 1; ; step++) {
      try {
        budget.beginModelStep();
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          await this.audit(
            ctx,
            "turn.budget_exhausted",
            { budget: err.budget, ...budget.snapshot() },
            "deny",
          );
          result.status = "budget_exhausted";
          break;
        }
        throw err;
      }

      let proposals: ModelProposal[];
      try {
        const out = await withTimeout(
          callStructured(
            this.deps.model,
            {
              system: system!,
              messages,
              maxOutputTokens: this.deps.budgets.maxOutputTokensPerCall,
              timeoutMs: budget.callTimeout(this.deps.budgets.modelCallTimeoutMs),
              metadata: { turnId: ctx.turnId, purpose: input.purpose },
            },
            ModelStepOutputSchema,
            {
              schemaName: "model_step_output",
              onInvalid: (attempt, problem) =>
                void this.audit(
                  ctx,
                  "model.invalid_output",
                  { step, attempt, problem: problem.slice(0, 300) },
                  "error",
                ),
            },
          ),
          budget.callTimeout(this.deps.budgets.modelCallTimeoutMs * 2 + 1_000),
          "model step",
        );
        const usage = out.responses.reduce((n, r) => n + r.usage.inputTokens + r.usage.outputTokens, 0);
        budget.addTokens(usage);
        proposals = out.value.proposals;
        await this.audit(ctx, "model.call", {
          step,
          model: out.responses[out.responses.length - 1]?.model,
          tokens: usage,
          retried: out.retried,
          proposalKinds: proposals.map((p) => p.kind),
        });
      } catch (err) {
        const code = err instanceof HarnessError ? err.code : "unknown";
        await this.audit(ctx, "model.failed", { step, errorCode: code }, "error");
        this.deps.logger.warn("model step failed; failing safe", { turnId: ctx.turnId, errorCode: code });
        if (err instanceof HarnessError && err.code === "model_refused") {
          return { ...result, replyText: "I can't help with that one.", status: "failed_safe" };
        }
        if (err instanceof ModelOutputInvalidError || err instanceof HarnessError) {
          return { ...result, replyText: FAIL_SAFE_REPLY, status: "failed_safe" };
        }
        throw err;
      }

      replyParts = [];
      const toolResults: string[] = [];
      for (const [i, p] of proposals.entries()) {
        if (p.kind !== "permission_change" && !input.allowedKinds.includes(p.kind)) {
          await this.audit(
            ctx,
            "proposal.rejected",
            { step, kind: p.kind, reason: "kind_not_allowed_for_agent" },
            "deny",
          );
          continue;
        }
        switch (p.kind) {
          case "reply":
            replyParts.push(p.text);
            break;
          case "tool_call": {
            const text = await this.handleToolCall(ctx, budget, p, `${step}.${i}`, io, result);
            if (text === null) break;
            toolResults.push(text);
            break;
          }
          case "permission_change":
            // A proposal made after tool output entered the conversation may have been induced by it.
            notes.push(
              await this.handlePermissionChange(ctx, p.change, {
                userText: input.userText,
                afterToolOutput: step > 1,
              }),
            );
            break;
          case "start_task":
            result.intents.push({ kind: "start_task", taskType: p.taskType, params: p.params });
            break;
          case "confirm_task":
          case "cancel_task":
            result.intents.push({ kind: p.kind } as TaskIntent);
            break;
        }
      }

      if (result.status === "budget_exhausted" || toolResults.length === 0) break;
      messages.push({ role: "assistant", content: JSON.stringify({ proposals }) });
      messages.push({
        role: "user",
        content: `${toolResults.join("\n\n")}\n\nContinue. When you are done, reply to the person in plain text.`,
      });
    }

    const reply = [...replyParts, ...notes].filter((s) => s.trim()).join("\n\n");
    result.replyText = reply || (result.status === "budget_exhausted" ? BUDGET_REPLY : "");
    return result;
  }

  /** Returns the wrapped tool result for the next model step, or null if the call was not attempted. */
  private async handleToolCall(
    ctx: TurnContext,
    budget: TurnBudget,
    p: Extract<ModelProposal, { kind: "tool_call" }>,
    stepRef: string,
    io: TurnIO,
    result: ModelLoopResult,
  ): Promise<string | null> {
    try {
      budget.beginToolCall();
    } catch (err) {
      if (!(err instanceof BudgetExhaustedError)) throw err;
      await this.audit(ctx, "turn.budget_exhausted", { budget: err.budget, ...budget.snapshot() }, "deny");
      result.status = "budget_exhausted";
      return null;
    }
    let args: unknown;
    try {
      args = JSON.parse(p.argsJson);
    } catch {
      result.toolOutcomes.push({ tool: p.tool, status: "denied", reasonCode: "tool_args_invalid" });
      return wrapToolResult(p.tool, "denied", { reasonCode: "tool_args_invalid" });
    }
    const outcome = await this.propose(
      ctx,
      budget,
      p.tool,
      args,
      `${ctx.turnId}:${stepRef}`,
      p.rationale ?? undefined,
      io,
    );
    result.toolOutcomes.push({
      tool: p.tool,
      status: outcome.status,
      ...("reasonCode" in outcome ? { reasonCode: outcome.reasonCode } : {}),
    });
    return this.describeOutcome(p.tool, outcome, result);
  }

  private describeOutcome(tool: string, outcome: GatewayOutcome, result: ModelLoopResult): string {
    switch (outcome.status) {
      case "executed":
        result.usedToolData.push(outcome.provenance);
        return wrapToolResult(tool, "executed", outcome.result);
      case "needs_approval":
        return wrapToolResult(tool, "needs_approval", {
          message: "The person was asked privately to approve this. It has NOT run. Do not claim it ran.",
        });
      case "denied":
        return wrapToolResult(tool, "denied", { reasonCode: outcome.reasonCode });
      case "error":
        return wrapToolResult(tool, "error", {
          reasonCode: outcome.reasonCode,
          outcomeUnknown: outcome.outcomeUnknown,
        });
    }
  }

  private async propose(
    ctx: TurnContext,
    budget: TurnBudget,
    namespaced: string,
    args: unknown,
    proposalId: string,
    rationale: string | undefined,
    io: TurnIO,
  ): Promise<GatewayOutcome> {
    const split = splitToolName(namespaced);
    if (!split) return { status: "denied", reasonCode: "tool_unknown" };
    const proposal = {
      proposalId,
      server: split.server,
      tool: split.tool,
      args,
      ...(rationale ? { rationale } : {}),
    };
    await this.audit(ctx, "tool.proposed", { tool: namespaced, proposalId, argsHash: hashOf(args) });

    let outcome: GatewayOutcome;
    try {
      outcome = await withTimeout(
        this.deps.gateway.propose(ctx, proposal),
        budget.callTimeout(this.deps.budgets.toolCallTimeoutMs),
        `tool ${namespaced}`,
      );
    } catch (err) {
      // Side effects may or may not have happened: report unknown; reconcile before any retry (spec 4.7).
      const code = err instanceof HarnessError ? err.code : "provider_error";
      outcome = { status: "error", reasonCode: code, outcomeUnknown: true };
    }

    if (outcome.status === "needs_approval") {
      // Approvals always go to the requesting user's own 1:1 chat, never the group (spec 6.6).
      const delivered = await io.dmUser(ctx.userId, outcome.prompt);
      await this.audit(ctx, "approval.prompt_sent", {
        tool: namespaced,
        approvalId: outcome.approvalId,
        channel: outcome.channel,
        delivered,
      });
    }
    await this.audit(
      ctx,
      "tool.outcome",
      {
        tool: namespaced,
        proposalId,
        status: outcome.status,
        ...("reasonCode" in outcome ? { reasonCode: outcome.reasonCode } : {}),
      },
      outcome.status,
    );
    return outcome;
  }

  private async handlePermissionChange(
    ctx: TurnContext,
    change: Extract<ModelProposal, { kind: "permission_change" }>["change"],
    origin: { userText: string; afterToolOutput: boolean },
  ): Promise<string> {
    // Provenance (spec 6.6): only the user's own 1:1 message may change permissions — never a group
    // message, tool output or retrieved memory. The harness checks this deterministically:
    //   1. the turn was triggered by the user's own DM,
    //   2. the user's own words ask for a permission change (memory/tool text can't satisfy this),
    //   3. the proposal came before any tool output was shown to the model.
    const reason =
      ctx.provenance !== "user_dm" || ctx.conversationType !== "dm"
        ? "not_user_dm"
        : !PERMISSION_INTENT.test(origin.userText)
          ? "no_user_intent"
          : origin.afterToolOutput
            ? "after_tool_output"
            : null;
    if (reason) {
      await this.audit(
        ctx,
        "permission_change.rejected_provenance",
        { provenance: ctx.provenance, reason, action: change.action },
        "deny",
      );
      return reason === "not_user_dm"
        ? PERMISSION_PROVENANCE_REPLY
        : "I didn't change any permissions. If you want to, tell me directly what to allow or stop asking about.";
    }
    const outcome = await this.deps.approvals.requestPermissionChange(ctx, change);
    await this.audit(
      ctx,
      "permission_change.forwarded",
      { action: change.action, target: change.target, outcome: outcome.status },
      outcome.status,
    );
    return outcome.status === "needs_confirmation" ? outcome.prompt : outcome.message;
  }

  async invokeTool(ctx: TurnContext, tool: string, args: unknown, io: TurnIO): Promise<GatewayOutcome> {
    const budget = this.budgetFor(ctx);
    try {
      budget.beginToolCall();
    } catch (err) {
      if (!(err instanceof BudgetExhaustedError)) throw err;
      await this.audit(ctx, "turn.budget_exhausted", { budget: err.budget, ...budget.snapshot() }, "deny");
      return { status: "denied", reasonCode: "budget_exhausted" };
    }
    return this.propose(
      ctx,
      budget,
      tool,
      args,
      `${ctx.turnId}:direct:${budget.toolCalls}`,
      "harness-initiated",
      io,
    );
  }
}
