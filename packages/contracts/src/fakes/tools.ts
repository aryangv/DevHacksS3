import { sampleMealOptions, sampleMenus, sampleToolManifests } from "../fixtures/tools";
import type {
  ApprovalService,
  CallContext,
  ConnectionService,
  PermissionResolver,
  ToolGateway,
  ToolProvider,
  VaultClient,
} from "../interfaces/p4";
import {
  DEFAULT_MODE_BY_RISK,
  type GatewayOutcome,
  type PermissionMode,
  type ResolvedPermission,
  type RiskClass,
  type ToolManifest,
  type ToolProposal,
  type ToolResult,
} from "../schemas/tools";
import type { TurnContext } from "../schemas/turn";
import { newId } from "../util/ids";
import { redact } from "../util/redact";
import { validateArgs } from "./json-schema-lite";

// In-memory fakes for P4's interfaces. Real implementations: @campus/tools + @campus/approvals (P4).

type Handler = (args: Record<string, unknown>, ctx: CallContext) => unknown | Promise<unknown>;

/** Fake MCP provider ("fake MCP server", spec 9) with the fixture manifests and canned handlers. */
export class FakeToolProvider implements ToolProvider {
  readonly id = "fake";
  readonly calls: Array<{
    server: string;
    tool: string;
    args: unknown;
    userId: string;
    idempotencyKey?: string;
  }> = [];
  private readonly handlers = new Map<string, Handler>();

  constructor(readonly manifests: ToolManifest[] = sampleToolManifests) {
    this.handle("dining", "search_options", (args) => {
      const max = typeof args.maxPricePerPersonMinor === "number" ? args.maxPricePerPersonMinor : Infinity;
      const cuisine = typeof args.cuisine === "string" ? args.cuisine.toLowerCase() : null;
      return {
        options: sampleMealOptions.filter(
          (o) => o.pricePerPersonMinor <= max && (!cuisine || o.cuisine === cuisine),
        ),
      };
    });
    this.handle("dining", "get_menu", (args) => {
      const option = sampleMealOptions.find((o) => o.id === args.optionId);
      return option ? { restaurant: option.name, items: sampleMenus[option.id] ?? [] } : { items: [] };
    });
    this.handle("dining", "place_order", (args) => ({
      sandbox: true,
      label: "SIMULATED ORDER (sandbox)",
      orderId: `SANDBOX-${String(args.optionId)}`,
    }));
    this.handle("canvas", "list_assignments", () => ({
      assignments: [{ id: "a1", title: "Problem Set 4", dueAt: "2026-10-27T23:59:00Z" }],
    }));
    this.handle("canvas", "submit_comment", () => ({ ok: true }));
  }

  handle(server: string, tool: string, fn: Handler): void {
    this.handlers.set(`${server}__${tool}`, fn);
  }

  async listTools(serverId: string): Promise<ToolManifest[]> {
    return this.manifests.filter((m) => m.server === serverId);
  }

  async callTool(serverId: string, tool: string, args: unknown, ctx: CallContext): Promise<ToolResult> {
    this.calls.push({
      server: serverId,
      tool,
      args,
      userId: ctx.userId,
      ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
    });
    const h = this.handlers.get(`${serverId}__${tool}`);
    if (!h) return { ok: false, data: null, errorCode: "tool_unknown" };
    return { ok: true, data: await h((args ?? {}) as Record<string, unknown>, ctx) };
  }
}

export class FakeConnectionService implements ConnectionService {
  private readonly connected = new Map<string, Set<string>>();
  private readonly disconnected = new Map<string, Set<string>>();

  /** `defaultConnected`: every user counts as connected to every server unless disconnected. */
  constructor(private readonly opts: { defaultConnected?: boolean } = {}) {}

  connect(userId: string, server: string): void {
    (this.connected.get(userId) ?? this.connected.set(userId, new Set()).get(userId)!).add(server);
    this.disconnected.get(userId)?.delete(server);
  }

  async disconnect(userId: string, server: string): Promise<void> {
    this.connected.get(userId)?.delete(server);
    (this.disconnected.get(userId) ?? this.disconnected.set(userId, new Set()).get(userId)!).add(server);
  }

  isConnected(userId: string, server: string): boolean {
    if (this.disconnected.get(userId)?.has(server)) return false;
    return (this.opts.defaultConnected ?? true) || (this.connected.get(userId)?.has(server) ?? false);
  }

  async listConnections(userId: string) {
    const servers = new Set([...(this.connected.get(userId) ?? [])]);
    return [...servers].map((server) => ({ server, status: "connected" as const, scopes: [] }));
  }

  async startConnection(_userId: string, serverSlug: string): Promise<{ url: string }> {
    return { url: `https://example.invalid/connect/${serverSlug}` };
  }
}

/** Risk-class defaults + simple per-user overrides + the spend hard cap. Not the full 6.6 resolver. */
export class FakePermissionResolver implements PermissionResolver {
  private readonly overrides = new Map<string, PermissionMode>();

  set(userId: string, server: string, tool: string, mode: PermissionMode): void {
    this.overrides.set(`${userId}:${server}:${tool}`, mode);
  }

  async resolve(input: {
    userId: string;
    server: string;
    tool: string;
    conversationId: string | null;
    riskClass: RiskClass;
  }): Promise<ResolvedPermission> {
    const o = this.overrides.get(`${input.userId}:${input.server}:${input.tool}`);
    if (input.riskClass === "spend" && (o ?? "ask") === "allow")
      return { mode: "ask", decidedBy: "hard_cap" };
    if (o) return { mode: o, decidedBy: "tool" };
    return { mode: DEFAULT_MODE_BY_RISK[input.riskClass], decidedBy: "risk_default" };
  }
}

export class FakeVaultClient implements VaultClient {
  private readonly secrets = new Map<string, string>();
  async getSecret(connectionId: string, kind: string) {
    return this.secrets.get(`${connectionId}:${kind}`) ?? null;
  }
  async putSecret(connectionId: string, kind: string, value: string) {
    this.secrets.set(`${connectionId}:${kind}`, value);
  }
  async deleteAll(connectionId: string) {
    for (const k of [...this.secrets.keys()]) if (k.startsWith(`${connectionId}:`)) this.secrets.delete(k);
  }
}

/**
 * Fake gateway following the spec 6.5 order: identity → connection → manifest/args → permission →
 * (ask → approval) → execute → redact. Re-checks everything even if the model saw the tool.
 */
export class FakeToolGateway implements ToolGateway {
  private readonly pending = new Map<
    string,
    { proposal: ToolProposal; manifest: ToolManifest; userId: string; used: boolean }
  >();

  constructor(
    private readonly deps: {
      provider: FakeToolProvider;
      connections: FakeConnectionService;
      permissions: PermissionResolver;
      approvals: ApprovalService & { isApproved?(approvalId: string, userId: string): boolean };
      /** Tests only: execute `ask` (non-spend) tools without asking. */
      autoApprove?: boolean;
    },
  ) {}

  async listVisibleTools(ctx: TurnContext): Promise<ToolManifest[]> {
    const visible: ToolManifest[] = [];
    for (const m of this.deps.provider.manifests) {
      if (!this.deps.connections.isConnected(ctx.userId, m.server)) continue;
      const perm = await this.deps.permissions.resolve({
        userId: ctx.userId,
        server: m.server,
        tool: m.name,
        conversationId: ctx.conversationId,
        riskClass: m.riskClass,
      });
      if (perm.mode !== "deny") visible.push(m);
    }
    return visible;
  }

  async propose(ctx: TurnContext, proposal: ToolProposal): Promise<GatewayOutcome> {
    if (!ctx.userId) return { status: "denied", reasonCode: "identity_unverified" };
    if (!this.deps.connections.isConnected(ctx.userId, proposal.server))
      return { status: "denied", reasonCode: "tool_not_connected" };
    const manifest = this.deps.provider.manifests.find(
      (m) => m.server === proposal.server && m.name === proposal.tool,
    );
    if (!manifest) return { status: "denied", reasonCode: "tool_unknown" };
    const argErrors = validateArgs(manifest.inputSchema, proposal.args);
    if (argErrors.length) return { status: "denied", reasonCode: "tool_args_invalid" };

    const perm = await this.deps.permissions.resolve({
      userId: ctx.userId,
      server: proposal.server,
      tool: proposal.tool,
      conversationId: ctx.conversationId,
      riskClass: manifest.riskClass,
    });
    if (perm.mode === "deny") return { status: "denied", reasonCode: "permission_denied" };
    if (perm.mode === "ask" && !(this.deps.autoApprove && manifest.riskClass !== "spend")) {
      const ask = await this.deps.approvals.createToolAsk(ctx, { proposal, manifest });
      this.pending.set(ask.approvalId, { proposal, manifest, userId: ctx.userId, used: false });
      return {
        status: "needs_approval",
        approvalId: ask.approvalId,
        channel: ask.channel,
        prompt: ask.prompt,
        expiresAt: ask.expiresAt,
        ...(ask.url ? { url: ask.url } : {}),
      };
    }
    return this.execute(ctx, proposal, manifest);
  }

  async executeApproved(ctx: TurnContext, approvalId: string): Promise<GatewayOutcome> {
    const p = this.pending.get(approvalId);
    if (!p || p.used || p.userId !== ctx.userId) return { status: "denied", reasonCode: "approval_invalid" };
    if (this.deps.approvals.isApproved && !this.deps.approvals.isApproved(approvalId, ctx.userId)) {
      return { status: "denied", reasonCode: "approval_required" };
    }
    p.used = true;
    return this.execute(ctx, p.proposal, p.manifest);
  }

  private async execute(
    ctx: TurnContext,
    proposal: ToolProposal,
    manifest: ToolManifest,
  ): Promise<GatewayOutcome> {
    const result = await this.deps.provider.callTool(proposal.server, proposal.tool, proposal.args, {
      turn: ctx,
      userId: ctx.userId,
      timeoutMs: 15_000,
      ...(manifest.riskClass === "read" ? {} : { idempotencyKey: `${ctx.turnId}:${proposal.proposalId}` }),
    });
    return {
      status: "executed",
      callId: newId(),
      result: redact(result),
      provenance: { server: proposal.server, tool: proposal.tool },
    };
  }
}
