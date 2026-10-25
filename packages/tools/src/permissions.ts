import { randomUUID } from 'node:crypto';
import type {
  ApprovalService,
  AuditLog,
  Connection,
  Mode,
  PermissionRule,
  Risk,
  ToolManifest,
  ToolStore,
  TurnContext,
} from './ports.ts';
import { requireThat } from './security.ts';

const strength: Record<Mode, number> = { allow: 0, ask: 1, deny: 2 };
const riskModes: Record<Risk, Mode> = {
  read: 'allow',
  write: 'ask',
  external_message: 'ask',
  destructive: 'ask',
  spend: 'ask',
};
export function constraintsMatch(
  constraints: Record<string, unknown> = {},
  args: unknown,
): boolean {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(constraints)) {
    if (key === 'maxAmountMinor') {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        typeof a.amountMinor !== 'number' ||
        !Number.isSafeInteger(a.amountMinor) ||
        a.amountMinor < 0 ||
        a.amountMinor > value
      )
        return false;
    } else if (key === 'allowedDomains') {
      if (
        !Array.isArray(value) ||
        !value.every((x) => typeof x === 'string') ||
        typeof a.url !== 'string'
      )
        return false;
      try {
        const u = new URL(a.url);
        if (u.protocol !== 'https:' || u.username || u.password || !value.includes(u.hostname))
          return false;
      } catch {
        return false;
      }
    } else return false; // Unknown constraints must never turn into unrestricted grants.
  }
  return true;
}

export class PermissionResolver {
  private store: ToolStore;
  private audit: AuditLog;
  private approvals: ApprovalService;
  private now: () => number;
  constructor(store: ToolStore, audit: AuditLog, approvals: ApprovalService, now = Date.now) {
    this.store = store;
    this.audit = audit;
    this.approvals = approvals;
    this.now = now;
  }
  async resolve(
    ctx: TurnContext,
    connection: Connection | null,
    tool: ToolManifest,
    args?: unknown,
  ): Promise<Mode> {
    let mode: Mode = 'deny';
    if (
      ctx.verified &&
      connection?.status === 'connected' &&
      connection.userId === ctx.userId &&
      tool.requiredScopes.every((x) => connection.grantedScopes.includes(x))
    ) {
      const rules = (await this.store.rules(ctx.userId, connection.serverId)).filter(
        (r) =>
          r.userId === ctx.userId &&
          r.serverId === connection.serverId &&
          !r.revokedAt &&
          (!r.expiresAt || Date.parse(r.expiresAt) > this.now()) &&
          (!r.conversationId || r.conversationId === ctx.conversationId) &&
          (!r.toolName || r.toolName === '*' || r.toolName === tool.name) &&
          (!(tool.riskClass === 'spend' || tool.riskClass === 'destructive') ||
            r.toolName === tool.name),
      );
      const rank = (r: PermissionRule) =>
        r.toolName && r.toolName !== '*' ? (r.conversationId ? 4 : 3) : r.conversationId ? 2 : 1;
      const best = rules.length ? Math.max(...rules.map(rank)) : 0;
      const selected = rules.filter((r) => rank(r) === best);
      if (selected.length) {
        // A constrained rule remains a cap: mismatches deny, rather than falling back to allow.
        mode = selected.reduce<Mode>((m, r) => {
          const next =
            args === undefined || constraintsMatch(r.constraints, args) ? r.mode : 'deny';
          return strength[next] > strength[m] ? next : m;
        }, 'allow');
      } else {
        const defaults = await this.store.defaults(ctx.userId, connection.serverId);
        const risk = defaults.filter(
          (d) =>
            d.riskClass === tool.riskClass &&
            tool.riskClass !== 'spend' &&
            tool.riskClass !== 'destructive',
        );
        // Risk defaults exist for all five risks, so global is the final fallback only.
        const candidates = risk.length ? risk : [];
        mode = candidates.length
          ? candidates.reduce<Mode>(
              (m, r) => (strength[r.mode] > strength[m] ? r.mode : m),
              'allow',
            )
          : (tool.defaultMode ??
            riskModes[tool.riskClass] ??
            defaults.find((d) => !d.riskClass)?.mode ??
            'ask');
      }
      if (tool.riskClass === 'spend' && mode === 'allow') mode = 'ask';
      if (
        tool.riskClass === 'destructive' &&
        mode === 'allow' &&
        !selected.some((r) => r.toolName === tool.name && r.confirmed && r.mode === 'allow')
      )
        mode = 'ask';
    }
    await this.audit.record({
      actorUserId: ctx.userId,
      action: 'permission.resolve',
      resource: tool.name,
      policyResult: mode,
    });
    return mode;
  }
  private ownDM(ctx: TurnContext): void {
    requireThat(
      ctx.verified &&
        !ctx.isGroup &&
        ctx.instruction?.source === 'user_dm' &&
        ctx.instruction.senderUserId === ctx.userId &&
        ctx.instruction.messageId,
      'permission_provenance_denied',
    );
  }
  async proposeChange(
    ctx: TurnContext,
    change:
      | {
          serverId: string;
          toolName?: string;
          conversationId?: string;
          riskClass?: Risk;
          mode: Mode;
          constraints?: Record<string, unknown>;
          expiresAt?: string;
        }
      | { serverId: string; reset: true },
  ): Promise<{ id: string; code?: string; expiresAt: string }> {
    try {
      this.ownDM(ctx);
    } catch (e) {
      await this.audit.record({
        actorUserId: ctx.userId,
        action: 'permission.change',
        policyResult: 'deny',
      });
      throw e;
    }
    const server = await this.store.server(change.serverId);
    requireThat(server?.status === 'active', 'server_unavailable');
    if (!('reset' in change)) {
      requireThat(['allow', 'ask', 'deny'].includes(change.mode), 'invalid_mode');
      if (change.riskClass) {
        requireThat(
          ['read', 'write', 'spend', 'external_message', 'destructive'].includes(
            change.riskClass,
          ) &&
            !change.toolName &&
            !change.conversationId &&
            !Object.keys(change.constraints ?? {}).length,
          'invalid_risk_rule',
        );
        requireThat(
          !(change.riskClass === 'spend' && change.mode === 'allow'),
          'spend_auto_allow_denied',
        );
      }
      requireThat(!change.expiresAt || Date.parse(change.expiresAt) > this.now(), 'invalid_expiry');
      requireThat(
        Object.keys(change.constraints ?? {}).every((k) =>
          ['maxAmountMinor', 'allowedDomains'].includes(k),
        ),
        'unsupported_constraint',
      );
      if (change.toolName && change.toolName !== '*') {
        const tool = (await this.store.tools(change.serverId))?.manifests.find(
          (t) => t.name === change.toolName,
        );
        requireThat(tool, 'unknown_tool');
        requireThat(
          !(tool.riskClass === 'spend' && change.mode === 'allow'),
          'spend_auto_allow_denied',
        );
      }
    }
    // ALL updates require confirmation (Section 17); broad changes show the exact JSON.
    const proposal = { operation: 'permissions.update', userId: ctx.userId, change };
    await this.audit.record({
      actorUserId: ctx.userId,
      action: 'permission.change_proposed',
      resource: change.serverId,
      policyResult: 'ask',
    });
    return this.approvals.create({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      kind: 'permission_change',
      proposal,
      channel: 'text',
    });
  }
  async applyChange(
    ctx: TurnContext,
    approvalId: string,
    change: Parameters<PermissionResolver['proposeChange']>[1],
  ): Promise<void> {
    try {
      this.ownDM(ctx);
    } catch (error) {
      await this.audit.record({
        actorUserId: ctx.userId,
        action: 'permission.change',
        policyResult: 'deny',
      });
      throw error;
    }
    requireThat(
      await this.approvals.consume(approvalId, ctx.userId, ctx.conversationId, {
        operation: 'permissions.update',
        userId: ctx.userId,
        change,
      }),
      'permission_confirmation_required',
    );
    await this.audit.record({
      actorUserId: ctx.userId,
      action: 'permission.change',
      resource: change.serverId,
      policyResult: 'allow',
      detail: { approvalId, source: 'user_dm' },
    });
    if ('reset' in change) await this.store.resetRules(ctx.userId, change.serverId);
    else if (change.riskClass)
      await this.store.saveDefault({ ...change, userId: ctx.userId, riskClass: change.riskClass });
    else
      await this.store.saveRule({
        ...change,
        id: randomUUID(),
        userId: ctx.userId,
        source: 'user_dm',
        confirmed: true,
      });
  }
  async currentRules(ctx: TurnContext, serverId: string): Promise<string[]> {
    this.ownDM(ctx);
    const rules = (await this.store.rules(ctx.userId, serverId))
      .filter((r) => !r.revokedAt && (!r.expiresAt || Date.parse(r.expiresAt) > this.now()))
      .map(
        (r) =>
          `${r.mode} ${r.toolName ?? 'all eligible tools'} on ${serverId}${r.conversationId ? ` in ${r.conversationId}` : ''}${r.expiresAt ? ` until ${r.expiresAt}` : ''}; constraints: ${JSON.stringify(r.constraints ?? {})}`,
      );
    const defaults = await this.store.defaults(ctx.userId, serverId);
    return [
      ...rules,
      ...defaults.map(
        (r) =>
          `${r.mode} ${r.riskClass ?? 'global'} default on ${serverId}; hard risk caps still apply`,
      ),
    ];
  }
}
