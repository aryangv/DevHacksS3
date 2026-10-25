import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ApprovalService,
  AuditLog,
  ContextBroker,
  Mode,
  ToolManifest,
  ToolProposal,
  ToolProvider,
  ToolStore,
  TurnContext,
} from './ports.ts';
import type { ConnectionService } from './connections.ts';
import type { ToolCatalog } from './catalog.ts';
import type { PermissionResolver } from './permissions.ts';
import { hash, requireThat, safeData, SecurityError } from './security.ts';

const proposalSchema = z
  .object({
    proposalId: z.string().min(1).max(128),
    server: z.string().min(1).max(128),
    tool: z.string().min(1).max(128),
    args: z.unknown(),
    rationale: z.string().max(1000).optional(),
  })
  .strict();
export type GatewayResult =
  | {
      status: 'ok';
      data: unknown;
      provenance: { server: string; tool: string; untrusted: true; disclosureExpiresAt?: string };
    }
  | { status: 'pending'; approvalId: string; channel: 'text' | 'web' }
  | { status: 'denied' | 'error' | 'unknown'; reasonCode: string };
export class ToolGateway {
  private store: ToolStore;
  private catalog: ToolCatalog;
  private connections: ConnectionService;
  private permissions: PermissionResolver;
  private approvals: ApprovalService;
  private audit: AuditLog;
  private providers: ReadonlyMap<string, ToolProvider>;
  private broker?: ContextBroker;
  private deliver: (request: {
    userId: string;
    conversationId: string;
    approvalId: string;
    code?: string;
    token?: string;
    channel: 'text' | 'web';
    proposal: unknown;
  }) => Promise<void>;
  private timeoutMs: number;
  private limits: { perTurn: number; perUserMinute: number; perConversationMinute: number };
  constructor(deps: {
    store: ToolStore;
    catalog: ToolCatalog;
    connections: ConnectionService;
    permissions: PermissionResolver;
    approvals: ApprovalService;
    audit: AuditLog;
    providers: ReadonlyMap<string, ToolProvider>;
    broker?: ContextBroker;
    deliverApproval: ToolGateway['deliver'];
    timeoutMs?: number;
    limits?: ToolGateway['limits'];
  }) {
    this.store = deps.store;
    this.catalog = deps.catalog;
    this.connections = deps.connections;
    this.permissions = deps.permissions;
    this.approvals = deps.approvals;
    this.audit = deps.audit;
    this.providers = deps.providers;
    this.broker = deps.broker;
    this.deliver = deps.deliverApproval;
    this.timeoutMs = deps.timeoutMs ?? 15000;
    this.limits = deps.limits ?? { perTurn: 8, perUserMinute: 30, perConversationMinute: 60 };
    requireThat(
      this.timeoutMs > 0 &&
        this.timeoutMs <= 120000 &&
        Object.values(this.limits).every((n) => Number.isSafeInteger(n) && n > 0),
      'invalid_gateway_limits',
    );
  }
  async availableTools(
    ctx: TurnContext,
  ): Promise<Array<ToolManifest & { modelName: string; server: string }>> {
    if (!ctx.verified) return [];
    const result: Array<ToolManifest & { modelName: string; server: string }> = [];
    for (const server of await this.store.servers()) {
      if (server.status !== 'active') continue;
      const c = await this.store.connection(ctx.userId, server.id);
      if (c?.status !== 'connected') continue;
      try {
        const access = await this.connections.credentials(
          ctx.userId,
          server,
          AbortSignal.timeout(this.timeoutMs),
        );
        for (const tool of await this.catalog.manifests(server.id, access.ctx)) {
          if (tool.riskClass === 'spend') continue; // payments are gated stretch work
          const bound = ctx.toolArgumentBindings?.[`${server.slug}__${tool.name}`] ?? {};
          const trusted = tool.trustedArgumentNames ?? [];
          if (
            (tool.riskClass === 'external_message' && !trusted.length) ||
            !trusted.every((n) => Object.hasOwn(bound, n))
          )
            continue;
          if ((await this.permissions.resolve(ctx, access.connection, tool)) !== 'deny') {
            const schema = structuredClone(tool.inputSchema);
            if (schema.properties && typeof schema.properties === 'object')
              for (const name of tool.trustedArgumentNames ?? [])
                delete (schema.properties as Record<string, unknown>)[name];
            if (Array.isArray(schema.required))
              schema.required = schema.required.filter(
                (n) => !tool.trustedArgumentNames?.includes(String(n)),
              );
            result.push({
              ...tool,
              inputSchema: schema,
              server: server.slug,
              modelName: `${server.slug}__${tool.name}`,
            });
          }
        }
      } catch {
        await this.audit.record({
          actorUserId: ctx.userId,
          action: 'tool.visibility',
          resource: server.id,
          policyResult: 'deny',
        });
      }
    }
    return result;
  }
  async execute(
    ctx: TurnContext,
    input: ToolProposal,
    approvalId?: string,
  ): Promise<GatewayResult> {
    const started = Date.now(),
      abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), this.timeoutMs);
    let serverId: string | undefined,
      toolName = 'unknown',
      argsHash = hash(null),
      mode: Mode = 'deny',
      key: string | undefined,
      executing = false,
      providerCompleted = false,
      sideEffect = false;
    try {
      requireThat(
        ctx.verified && ctx.userId && ctx.conversationId && ctx.turnId,
        'caller_unverified',
      );
      const parsed = proposalSchema.safeParse(input);
      requireThat(parsed.success, 'tool_proposal_invalid');
      const p = parsed.data;
      argsHash = hash(p.args);
      const server = await this.store.server(p.server);
      requireThat(server?.status === 'active', 'server_unavailable');
      serverId = server.id;
      const access = await this.connections.credentials(ctx.userId, server, abort.signal);
      const tools = await this.catalog.manifests(server.id, access.ctx);
      const tool = tools.find((t) => t.name === p.tool);
      requireThat(tool, 'tool_not_visible');
      toolName = tool.name;
      requireThat(
        tool.requiredScopes.every((s) => access.connection.grantedScopes.includes(s)),
        'tool_scope_denied',
      );
      // Reserved authority fields can only be injected by P1. External-message
      // recipient fields must be explicitly named by local operator policy.
      const forbidden =
        /^(?:user_?id|conversation_?id|connection_?id|namespace|credentials?|recipient_?ids?|audience)$/i;
      const checkArgs = (value: unknown): void => {
        if (Array.isArray(value)) for (const v of value) checkArgs(v);
        else if (value && typeof value === 'object')
          for (const [name, v] of Object.entries(value)) {
            requireThat(!forbidden.test(name), 'model_authority_field_denied');
            checkArgs(v);
          }
      };
      checkArgs(p.args);
      const bindings = ctx.toolArgumentBindings?.[`${server.slug}__${tool.name}`] ?? {};
      const trusted = tool.trustedArgumentNames ?? [];
      requireThat(
        tool.riskClass !== 'external_message' || trusted.length > 0,
        'recipient_binding_required',
      );
      requireThat(
        trusted.every(
          (name) =>
            Object.hasOwn(bindings, name) &&
            !(p.args && typeof p.args === 'object' && Object.hasOwn(p.args, name)),
        ),
        'trusted_argument_missing_or_model_supplied',
      );
      requireThat(
        p.args && typeof p.args === 'object' && !Array.isArray(p.args),
        'tool_args_invalid',
      );
      const executionArgs = {
        ...p.args,
        ...Object.fromEntries(trusted.map((name) => [name, bindings[name]])),
      };
      argsHash = hash(executionArgs);
      this.catalog.validate(tool, executionArgs);
      mode = await this.permissions.resolve(ctx, access.connection, tool, executionArgs);
      requireThat(mode !== 'deny', 'tool_permission_denied');
      requireThat(tool.riskClass !== 'spend', 'spend_stretch_disabled');
      // Always bind approvals to exact arguments, actor, origin, and proposal identity.
      const action = {
        ...p,
        args: executionArgs,
        rationale: undefined,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        serverId: server.id,
      };
      delete action.rationale;
      if (mode === 'ask') {
        if (!approvalId) {
          requireThat(ctx.approvalConversationId, 'approval_dm_missing');
          const channel = tool.sensitive ? 'web' : 'text';
          const pending = await this.approvals.create({
            userId: ctx.userId,
            conversationId: ctx.approvalConversationId,
            kind: 'tool_ask',
            proposal: action,
            channel,
            sensitive: tool.sensitive,
          });
          await this.deliver({
            userId: ctx.userId,
            conversationId: ctx.approvalConversationId,
            approvalId: pending.id,
            ...pending,
            channel,
            proposal: safeData(action, []),
          });
          await this.audit.record({
            actorUserId: ctx.userId,
            action: 'tool.approval_required',
            resource: server.id,
            policyResult: 'ask',
          });
          await this.store.callStart({
            key: `ask:${randomUUID()}`,
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            serverId: server.id,
            toolName: p.tool,
            argsHash,
            decision: 'ask',
            modeUsed: mode,
            approvalId: pending.id,
          });
          return { status: 'pending', approvalId: pending.id, channel };
        }
        requireThat(
          await this.approvals.consume(approvalId, ctx.userId, ctx.approvalConversationId, action),
          'tool_approval_invalid',
        );
      }
      const provider = this.providers.get(server.provider);
      requireThat(provider, 'provider_unavailable');
      // Recheck current revocation and permissions immediately before starting an external action.
      const current = await this.store.connection(ctx.userId, server.id);
      requireThat(
        current?.status === 'connected' && current.id === access.connection.id,
        'connection_unavailable',
      );
      const finalMode = await this.permissions.resolve(ctx, current, tool, executionArgs);
      requireThat(
        finalMode !== 'deny' && !(finalMode === 'ask' && mode !== 'ask'),
        'tool_permission_changed',
      );
      requireThat(!abort.signal.aborted, 'tool_timeout');
      key = hash({ userId: ctx.userId, proposalId: p.proposalId });
      await this.audit.record({
        actorUserId: ctx.userId,
        action: 'tool.invoke',
        resource: server.id,
        policyResult: 'allow',
        detail: { tool: tool.name, mode, proposalHash: hash(p.proposalId) },
      });
      requireThat(
        await this.store.callStart({
          key,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          serverId: server.id,
          toolName: p.tool,
          argsHash,
          decision: 'execute',
          modeUsed: mode,
          approvalId,
          turnId: ctx.turnId,
          limits: this.limits,
        }),
        'tool_replay_or_budget_exceeded',
      );
      executing = true;
      sideEffect = tool.riskClass !== 'read';
      let rejectAbort: () => void = () => {};
      const timedOut = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new SecurityError('tool_timeout'));
        abort.signal.addEventListener('abort', rejectAbort, { once: true });
        if (abort.signal.aborted) rejectAbort();
      });
      let raw;
      try {
        raw = await Promise.race([
          provider.callTool(server.id, p.tool, executionArgs, {
            ...access.ctx,
            idempotencyKey: key,
          }),
          timedOut,
        ]);
      } finally {
        abort.signal.removeEventListener('abort', rejectAbort);
      }
      requireThat(!raw.isError, 'tool_provider_error');
      providerCompleted = true;
      const secrets = Object.values(access.ctx.credentials).filter(
        (s): s is string => typeof s === 'string',
      );
      let data = safeData(raw.content, secrets);
      let disclosureExpiresAt: string | undefined;
      if (ctx.isGroup) {
        requireThat(this.broker, 'group_disclosure_unavailable');
        const disclosure = await this.broker.disclose({
          taskId: ctx.taskId,
          requesterAgentId: ctx.requesterAgentId,
          subjectUserId: ctx.userId,
          purpose: ctx.purpose,
          fields: [`${server.slug}__${tool.name}`],
          audience: { kind: 'group', id: ctx.conversationId },
          data,
        });
        requireThat(
          disclosure.status === 'approved' && Date.parse(disclosure.expiresAt) > Date.now(),
          'group_disclosure_denied',
        );
        data = safeData(disclosure.fields, secrets);
        disclosureExpiresAt = disclosure.expiresAt;
        await this.audit.record({
          actorUserId: ctx.userId,
          action: 'tool.disclose',
          resource: server.id,
          policyResult: 'allow',
        });
      }
      await this.store.callFinish(key, 'success', Date.now() - started);
      await this.audit.record({
        actorUserId: ctx.userId,
        action: 'tool.result',
        resource: server.id,
        policyResult: 'allow',
        detail: { status: 'success' },
      });
      return {
        status: 'ok',
        data,
        provenance: { server: server.slug, tool: tool.name, untrusted: true, disclosureExpiresAt },
      };
    } catch (error) {
      const code = error instanceof SecurityError ? error.code : 'tool_failed';
      const unknown = executing && sideEffect && !providerCompleted;
      if (key && executing)
        await this.store.callFinish(
          key,
          providerCompleted ? 'success_withheld' : unknown ? 'unknown' : 'failed',
          Date.now() - started,
        );
      else if (serverId)
        await this.store.callStart({
          key: `reject:${randomUUID()}`,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          serverId,
          toolName,
          argsHash,
          decision: 'deny',
          modeUsed: mode,
        });
      await this.audit.record({
        actorUserId: ctx.userId,
        action: code.startsWith('group_disclosure') ? 'tool.disclose' : 'tool.rejected',
        resource: serverId,
        policyResult: 'deny',
        detail: { reasonCode: code, status: unknown ? 'unknown' : 'rejected' },
      });
      return { status: unknown ? 'unknown' : executing ? 'error' : 'denied', reasonCode: code };
    } finally {
      clearTimeout(timer);
    }
  }
}
