import type {
  PermissionChangeOutcome,
  PermissionChangeRequest,
  SpendHandoff,
  SpendHandoffRequest,
  TextReplyResolution,
} from "../schemas/approvals";
import type {
  GatewayOutcome,
  ResolvedPermission,
  RiskClass,
  ToolManifest,
  ToolProposal,
  ToolResult,
} from "../schemas/tools";
import type { TurnContext } from "../schemas/turn";

// Interfaces implemented by P4 (hands): ToolGateway, PermissionResolver, ToolProvider, VaultClient,
// ApprovalService, ConnectionService.

/** Passed to providers. Credentials are resolved by the gateway; providers never read the vault. */
export type CallContext = {
  turn: TurnContext;
  userId: string;
  credentials?: { kind: "access_token" | "api_key"; value: string };
  idempotencyKey?: string;
  timeoutMs: number;
};

/** spec 6.1. Composio and custom MCP servers sit behind this one interface. */
export interface ToolProvider {
  readonly id: string;
  listTools(serverId: string): Promise<ToolManifest[]>;
  callTool(serverId: string, tool: string, args: unknown, ctx: CallContext): Promise<ToolResult>;
}

/**
 * spec 6.5. Every proposed call goes through `propose`: identity → connection → manifest + arg
 * validation → permission → risk caps → ask/execute → post-process → audit.
 * The harness supplies ctx.userId (never the model) and sends any approval prompt it returns.
 */
export interface ToolGateway {
  /** Tools the model may see right now (convenience only; `propose` re-checks everything). */
  listVisibleTools(ctx: TurnContext): Promise<ToolManifest[]>;
  propose(ctx: TurnContext, proposal: ToolProposal): Promise<GatewayOutcome>;
  /** Execute a previously approved `tool_ask` (after a matching text reply). */
  executeApproved(ctx: TurnContext, approvalId: string): Promise<GatewayOutcome>;
}

/** spec 6.6 resolution order + hard caps. */
export interface PermissionResolver {
  resolve(input: {
    userId: string;
    server: string;
    tool: string;
    conversationId: string | null;
    riskClass: RiskClass;
  }): Promise<ResolvedPermission>;
}

/** spec 6.4. Only the gateway (restricted DB role) uses this. Never returns secrets to models/clients. */
export interface VaultClient {
  getSecret(connectionId: string, kind: "access_token" | "refresh_token" | "api_key"): Promise<string | null>;
  putSecret(
    connectionId: string,
    kind: "access_token" | "refresh_token" | "api_key",
    value: string,
    expiresAt?: Date,
  ): Promise<void>;
  deleteAll(connectionId: string): Promise<void>;
}

/** spec 6.3 connection lifecycle. */
export interface ConnectionService {
  listConnections(
    userId: string,
  ): Promise<
    Array<{ server: string; status: "pending" | "connected" | "needs_reauth" | "revoked"; scopes: string[] }>
  >;
  /** Returns a web URL; OAuth needs a browser. */
  startConnection(userId: string, serverSlug: string): Promise<{ url: string }>;
  disconnect(userId: string, serverSlug: string): Promise<void>;
}

/** spec 4.2 step 10, 6.6 approval channels. */
export interface ApprovalService {
  /** Create a pending `tool_ask` bound to the exact proposal (used by the gateway). */
  createToolAsk(
    ctx: TurnContext,
    input: { proposal: ToolProposal; manifest: ToolManifest },
  ): Promise<{
    approvalId: string;
    channel: "text" | "web";
    prompt: string;
    url?: string;
    expiresAt: string;
  }>;
  /** "YES 4821"-style replies: same verified user, 1:1 chat, unexpired, one-time. */
  resolveTextReply(ctx: TurnContext, text: string): Promise<TextReplyResolution>;
  /** Chat-driven permission change; ctx.provenance must be `user_dm` (also enforced by the harness). */
  requestPermissionChange(
    ctx: TurnContext,
    change: PermissionChangeRequest,
  ): Promise<PermissionChangeOutcome>;
  /** Money-moving actions never use text approval: hand off to the authenticated web page. */
  createSpendHandoff(ctx: TurnContext, request: SpendHandoffRequest): Promise<SpendHandoff>;
}
