import {
  type AgentRuntime,
  type AgentTask,
  type AgentTurnInput,
  type AgentTurnResult,
  type ApprovalService,
  type AuditLog,
  type Clock,
  type ContextBroker,
  type CoordinationBus,
  type Coordinator,
  type DataBlock,
  type GroupAgent,
  type GroupAgentFactory,
  type GroupMealParams,
  type GroupMealState,
  type Logger,
  type MealOption,
  MealOptionSchema,
  type MemoryCandidate,
  type MemoryStore,
  type MembershipService,
  type OptionVerdicts,
  type TaskIntent,
  type TaskStore,
  type TurnContext,
  type TurnIO,
  groupAgentId,
  personalAgentId,
} from "@campus/contracts";
import { z } from "zod";
import { counterofferCeiling } from "./coordinator";
import { formatHistory, formatMoney, groupSystemPrompt } from "./prompts";

// GroupAgent(conversationId): shared context + task state (spec 4.1, 4.6). It never reads any user's
// private memory; it asks personal agents through the bus and receives projections only.

export type GroupAgentDeps = {
  runtime: AgentRuntime;
  tasks: TaskStore;
  membership: MembershipService;
  coordinator: Coordinator;
  bus: CoordinationBus;
  broker: ContextBroker;
  memoryStore: MemoryStore;
  approvals: ApprovalService;
  audit: AuditLog;
  logger: Logger;
  clock: Clock;
  agentName: string;
  /** How members address the agent, e.g. "@agent" (first configured invocation name). */
  invocationHint: string;
  /** Namespaced tool that returns `{ options: MealOption[] }`. */
  optionsTool: string;
  coordinationTtlMs?: number;
  maxRounds?: number;
};

const TASK_TYPE = "group_meal";
const ToolOptionsSchema = z.object({ options: z.array(MealOptionSchema) });
type Task = AgentTask<GroupMealState>;

export class GroupAgentImpl implements GroupAgent {
  readonly agentId: string;

  constructor(
    readonly conversationId: string,
    private readonly deps: GroupAgentDeps,
  ) {
    this.agentId = groupAgentId(conversationId);
  }

  async handleTurn(ctx: TurnContext, input: AgentTurnInput, io: TurnIO): Promise<AgentTurnResult> {
    if (ctx.conversationId !== this.conversationId || ctx.agent.id !== this.agentId) {
      throw new Error("group agent invoked for a different conversation");
    }
    const active = await this.deps.tasks.findActive<GroupMealState>(this.conversationId, TASK_TYPE);
    const dataBlocks: DataBlock[] = [];
    try {
      const recalled = await this.deps.memoryStore.search(
        { kind: "group", conversationId: this.conversationId },
        { query: input.text, limit: 5 },
      );
      if (recalled.length)
        dataBlocks.push({
          label: "group memory: past decisions",
          content: recalled.map((m) => m.content).join("\n"),
        });
    } catch (err) {
      this.deps.logger.warn("group memory read failed", { turnId: ctx.turnId, err });
    }
    if (input.history.length)
      dataBlocks.push({ label: "recent group messages", content: formatHistory(input.history, "Member") });
    if (active) dataBlocks.push({ label: "current group plan", content: this.describeTask(active) });

    const loop = await this.deps.runtime.runModelLoop(
      ctx,
      {
        purpose: "group_turn",
        systemPrompt: groupSystemPrompt(this.deps.agentName),
        dataBlocks,
        userText: input.text,
        allowedKinds: ["reply", "tool_call", "start_task", "confirm_task", "cancel_task"],
      },
      io,
    );

    const replies: string[] = [];
    const memoryCandidates: MemoryCandidate[] = [];
    const intent = loop.intents[0];
    if (intent) {
      const out = await this.handleIntent(ctx, intent, active, io);
      replies.push(...out.replies);
      memoryCandidates.push(...out.memoryCandidates);
    } else if (loop.replyText) {
      replies.push(await this.discloseChecked(ctx, loop.replyText, loop.usedToolData, io));
    }
    return { replies, memoryCandidates, status: loop.status, detail: { intent: intent?.kind ?? null } };
  }

  // ---- intents ----

  private async handleIntent(
    ctx: TurnContext,
    intent: TaskIntent,
    active: Task | null,
    io: TurnIO,
  ): Promise<{ replies: string[]; memoryCandidates: MemoryCandidate[] }> {
    switch (intent.kind) {
      case "start_task":
        if (active && (active.status === "collecting" || active.status === "proposed")) {
          return {
            replies: [
              `We already have a plan going: ${this.describeTask(active)} Say "confirm" to lock it in or "cancel" to start over.`,
            ],
            memoryCandidates: [],
          };
        }
        return { replies: [await this.startMeal(ctx, intent.params, io)], memoryCandidates: [] };
      case "confirm_task":
        return this.confirmMeal(ctx, active, io);
      case "cancel_task":
        if (!active) return { replies: ["There's no plan to cancel."], memoryCandidates: [] };
        await this.update(ctx, active, "cancelled", active.state);
        return { replies: ["Okay, cancelled the plan."], memoryCandidates: [] };
    }
  }

  private async startMeal(ctx: TurnContext, params: GroupMealParams, io: TurnIO): Promise<string> {
    const members = await this.deps.membership.listActiveMembers(this.conversationId);
    const verified = members.filter((m) => m.status === "verified" && m.userId);
    const unverifiedCount = members.length - verified.length;

    let task = (await this.deps.tasks.create<GroupMealState>({
      ownerType: "group",
      ownerId: this.conversationId,
      conversationId: this.conversationId,
      type: TASK_TYPE,
      status: "collecting",
      state: { params, invokedByUserId: ctx.userId, options: [], round: 0 },
    })) as Task;
    await this.audit(ctx, "task.created", {
      taskId: task.id,
      type: TASK_TYPE,
      verifiedMembers: verified.length,
      unverifiedMembers: unverifiedCount,
    });

    // Groups have no typing indicator → a short "on it" (spec 4.5).
    await io.reply("On it - checking options with everyone's agents.");

    const options = await this.fetchOptions(ctx, params, params.budgetPerPersonMinor, io);
    if (!options.ok) {
      await this.update(ctx, task, "failed", task.state);
      return `I couldn't look up places right now (${options.reason}). Whoever asked may need to connect a dining account first.`;
    }

    const participants = verified.map((m) => ({ userId: m.userId!, name: m.displayName }));
    const maxRounds = this.deps.maxRounds ?? 2;
    let decision = null as ReturnType<Coordinator["decide"]> | null;
    let candidates = options.options;

    for (let round = 1; round <= maxRounds; round++) {
      task = await this.update(ctx, task, "collecting", { ...task.state, options: candidates, round });
      const verdicts = await this.ask(ctx, task.id, participants, "evaluate_option", {
        options: candidates,
        ...(params.budgetPerPersonMinor ? { groupBudgetPerPersonMinor: params.budgetPerPersonMinor } : {}),
      });
      decision = this.deps.coordinator.decide({
        options: candidates,
        verdicts,
        groupBudgetPerPersonMinor: params.budgetPerPersonMinor,
      });
      await this.audit(ctx, "coordination.decision", {
        taskId: task.id,
        round,
        kind: decision.kind,
        ...(decision.kind === "propose"
          ? {
              optionId: decision.option.id,
              acceptCount: decision.acceptCount,
              respondents: decision.respondents,
            }
          : {}),
      });
      if (decision.kind !== "counteroffer_needed" || round === maxRounds) break;

      // Counteroffer round: ask agents that rejected everything for a coarse, shareable constraint,
      // then re-source options under it.
      const rejecters = participants.filter(
        (p) => verdicts.find((v) => v.agentId === personalAgentId(p.userId))?.response.status === "rejected",
      );
      if (rejecters.length === 0) break;
      const counters = await this.ask(ctx, task.id, rejecters, "share_constraint", {
        fields: ["meal.price_band"],
      });
      const ceiling = counterofferCeiling(counters);
      if (ceiling === null) break;
      const cap =
        params.budgetPerPersonMinor === null ? ceiling : Math.min(ceiling, params.budgetPerPersonMinor);
      const refreshed = await this.fetchOptions(ctx, params, cap, io);
      const next = this.deps.coordinator.applyCounteroffers(
        refreshed.ok ? refreshed.options : candidates,
        counters,
      );
      if (next.length === 0 || sameIds(next, candidates)) break;
      candidates = next;
    }

    const nameOf = (agentId: string) =>
      participants.find((p) => personalAgentId(p.userId) === agentId)?.name ?? "someone";
    const waiting: string[] = [];
    if (decision && decision.kind !== "no_options") waiting.push(...decision.pending.map(nameOf));
    const waitingText = [
      waiting.length ? `Still waiting on ${waiting.join(", ")} to share preferences with their agent.` : "",
      unverifiedCount
        ? `${unverifiedCount} member${unverifiedCount > 1 ? "s haven't" : " hasn't"} verified yet, so I couldn't include them - they can message me to get set up.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (!decision || decision.kind === "no_options") {
      await this.update(ctx, task, "no_consensus", task.state);
      return `I couldn't find any places${params.budgetPerPersonMinor ? ` under ${formatMoney(params.budgetPerPersonMinor)} per person` : ""}. Want to try a different budget or cuisine?`;
    }
    if (decision.kind === "counteroffer_needed") {
      await this.update(ctx, task, "no_consensus", task.state);
      const closest = decision.bestPartial
        ? ` Closest: ${decision.bestPartial.option.name} (${decision.bestPartial.acceptCount} of ${decision.respondents} agents in).`
        : "";
      return `I couldn't find a place that works for everyone.${closest} Want me to try a different budget or cuisine? ${waitingText}`.trim();
    }

    const o = decision.option;
    await this.update(ctx, task, "proposed", {
      ...task.state,
      proposal: {
        optionId: o.id,
        acceptCount: decision.acceptCount,
        respondents: decision.respondents,
        waitingOn: waiting,
      },
    });
    return [
      `Proposal: ${o.name} (${o.cuisine}), about ${formatMoney(o.pricePerPersonMinor, o.currency)} per person${o.distanceMeters !== undefined ? `, ${(o.distanceMeters / 1000).toFixed(1)} km away` : ""}.`,
      `${decision.acceptCount} of ${decision.respondents} members' agents are in.`,
      waitingText,
      `Reply "${this.deps.invocationHint} confirm" to lock it in, or "${this.deps.invocationHint} cancel".`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async confirmMeal(
    ctx: TurnContext,
    active: Task | null,
    io: TurnIO,
  ): Promise<{ replies: string[]; memoryCandidates: MemoryCandidate[] }> {
    if (!active || active.status !== "proposed" || !active.state.proposal) {
      return {
        replies: ["There's nothing to confirm yet. Ask me to plan something first."],
        memoryCandidates: [],
      };
    }
    const option = active.state.options.find((x) => x.id === active.state.proposal!.optionId);
    if (!option)
      return { replies: ["I lost track of that proposal. Ask me to plan again."], memoryCandidates: [] };

    const decidedAt = this.deps.clock.now().toISOString();
    let task = await this.update(ctx, active, "decided", {
      ...active.state,
      decision: { optionId: option.id, decidedByUserId: ctx.userId, decidedAt },
    });
    const memoryCandidates: MemoryCandidate[] = [
      {
        principal: { kind: "group", conversationId: this.conversationId },
        authorUserId: ctx.userId,
        write: {
          content: `Group decision (${decidedAt.slice(0, 10)}): ${option.name} (${option.cuisine}), about ${formatMoney(option.pricePerPersonMinor, option.currency)} per person.`,
          kind: "decision",
          customId: `task_${task.id}`,
          metadata: { author_user_id: ctx.userId, task_id: task.id, kind: "decision", decided_at: decidedAt },
        },
      },
    ];

    // Money never moves on a chat message: hand the payer an authenticated approval page (spec 4.2 step 10).
    try {
      const handoff = await this.deps.approvals.createSpendHandoff(ctx, {
        taskId: task.id,
        payerUserId: ctx.userId,
        summary: `Group order at ${option.name}, about ${formatMoney(option.pricePerPersonMinor, option.currency)} per person for ${active.state.proposal.respondents} people`,
      });
      const delivered = await io.dmUser(
        ctx.userId,
        `Approve the group order at ${option.name} here: ${handoff.url}${handoff.sandbox ? " (sandbox test - no real money moves)" : ""}`,
      );
      task = await this.update(ctx, task, "handed_off", {
        ...task.state,
        handoff: { approvalId: handoff.approvalId, payerUserId: ctx.userId, sandbox: handoff.sandbox },
      });
      await this.audit(ctx, "spend.handoff_requested", {
        taskId: task.id,
        approvalId: handoff.approvalId,
        sandbox: handoff.sandbox,
        delivered,
      });
      return {
        replies: [
          `Locked in: ${option.name}. I sent a private link to approve the order${handoff.sandbox ? " (sandbox test)" : ""}. Nothing is ordered until it's approved and the restaurant confirms.`,
        ],
        memoryCandidates,
      };
    } catch (err) {
      this.deps.logger.warn("spend handoff unavailable", { turnId: ctx.turnId, err });
      return {
        replies: [`Locked in: ${option.name}. Ordering isn't set up yet, so nothing was ordered.`],
        memoryCandidates,
      };
    }
  }

  // ---- helpers ----

  private async fetchOptions(
    ctx: TurnContext,
    params: GroupMealParams,
    maxPrice: number | null,
    io: TurnIO,
  ): Promise<{ ok: true; options: MealOption[] } | { ok: false; reason: string }> {
    const args: Record<string, unknown> = {};
    if (maxPrice !== null && Number.isFinite(maxPrice)) args.maxPricePerPersonMinor = maxPrice;
    if (params.cuisine) args.cuisine = params.cuisine;
    const outcome = await this.deps.runtime.invokeTool(ctx, this.deps.optionsTool, args, io);
    if (outcome.status !== "executed")
      return { ok: false, reason: "reasonCode" in outcome ? outcome.reasonCode : outcome.status };
    if (!outcome.result.ok) return { ok: false, reason: outcome.result.errorCode ?? "provider_error" };
    const parsed = ToolOptionsSchema.safeParse(outcome.result.data); // tool output is untrusted data
    if (!parsed.success) return { ok: false, reason: "invalid_options" };
    return { ok: true, options: parsed.data.options };
  }

  private async ask(
    ctx: TurnContext,
    taskId: string,
    participants: Array<{ userId: string }>,
    requestType: "evaluate_option" | "share_constraint",
    payload: Record<string, unknown>,
  ): Promise<OptionVerdicts> {
    const expiresAt = new Date(
      this.deps.clock.now().getTime() + (this.deps.coordinationTtlMs ?? 30_000),
    ).toISOString();
    const trace = { turnId: ctx.turnId, conversationId: ctx.conversationId };
    return Promise.all(
      participants.map(async (p) => {
        const agentId = personalAgentId(p.userId);
        const response = await this.deps.bus.request(
          {
            taskId,
            requesterAgentId: this.agentId,
            targetAgentId: agentId,
            requestType,
            purpose: TASK_TYPE,
            payload,
            expiresAt,
          },
          trace,
        );
        return { agentId, response };
      }),
    );
  }

  /** Disclose check before tool-derived content reaches the group (spec 6.5 step 10). */
  private async discloseChecked(
    ctx: TurnContext,
    reply: string,
    used: Array<{ server: string; tool: string }>,
    io: TurnIO,
  ): Promise<string> {
    if (used.length === 0) return reply;
    const res = await this.deps.broker.disclose({
      subjectUserId: ctx.userId,
      purpose: "other",
      audience: { kind: "group", id: this.agentId },
      dataClasses: used.map((u) => `tool:${u.server}__${u.tool}`),
    });
    if (res.allowed) return reply;
    await this.audit(ctx, "reply.withheld_disclosure", {
      reasonCode: res.reasonCode,
      tools: used.map((u) => `${u.server}__${u.tool}`),
    });
    const sent = await io.dmUser(ctx.userId, reply);
    return sent
      ? "That includes private info, so I sent it to you directly."
      : "That includes private info, so I can't share it here.";
  }

  private async update(ctx: TurnContext, task: Task, status: string, state: GroupMealState): Promise<Task> {
    const next = (await this.deps.tasks.update<GroupMealState>(
      task.id,
      { status, state },
      task.version,
    )) as Task;
    await this.audit(ctx, "task.updated", { taskId: task.id, status });
    return next;
  }

  private describeTask(task: Task): string {
    const p = task.state.proposal;
    const option = p ? task.state.options.find((o) => o.id === p.optionId) : undefined;
    if (task.status === "proposed" && option)
      return `Proposed ${option.name}, about ${formatMoney(option.pricePerPersonMinor, option.currency)} per person (${p!.acceptCount} of ${p!.respondents} agents in).`;
    return `Meal plan is ${task.status}.`;
  }

  private audit(
    ctx: TurnContext,
    action: Parameters<AuditLog["record"]>[0]["action"],
    detail: Record<string, unknown>,
  ) {
    return this.deps.audit.record({
      action,
      turnId: ctx.turnId,
      conversationId: ctx.conversationId,
      actorUserId: ctx.userId,
      resource: `agent:${this.agentId}`,
      detail,
    });
  }
}

function sameIds(a: MealOption[], b: MealOption[]): boolean {
  return a.length === b.length && a.every((o, i) => o.id === b[i]?.id);
}

export class GroupAgentRegistry implements GroupAgentFactory {
  constructor(private readonly deps: GroupAgentDeps) {}
  forConversation(conversationId: string): GroupAgent {
    return new GroupAgentImpl(conversationId, this.deps);
  }
}
