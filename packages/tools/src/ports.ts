/** P4-local bridge ONLY: Section 18.3 fallback. Replace imports with P1 contracts
 * when published. No claim that the unspecified method shapes are frozen contracts.
 */
export type Mode = 'allow' | 'ask' | 'deny';
export type Risk = 'read' | 'write' | 'spend' | 'external_message' | 'destructive';
export type TurnContext = Readonly<{
  userId: string;
  verified: boolean;
  conversationId: string;
  isGroup: boolean;
  turnId: string;
  requesterAgentId: string;
  taskId: string;
  purpose: 'group_meal' | 'campus_match' | 'scheduling' | 'other';
  // Resolved by P1/P2, never from model arguments.
  approvalConversationId: string;
  toolArgumentBindings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  instruction?: {
    source: 'user_dm' | 'group' | 'tool' | 'memory';
    senderUserId: string;
    messageId: string;
    text: string;
  };
}>;
export type WebSession = Readonly<{ userId: string; sessionId: string; authenticated: boolean }>;
export interface AuditLog {
  record(event: {
    actorUserId?: string;
    action: string;
    resource?: string;
    policyResult?: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
}
export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T>;
}
export type ToolManifest = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskClass: Risk;
  defaultMode: Mode;
  requiredScopes: string[];
  sensitive?: boolean;
  trustedArgumentNames?: string[];
};
export type ToolProposal = {
  proposalId: string;
  server: string;
  tool: string;
  args: unknown;
  rationale?: string;
};
export type PermissionRule = {
  id: string;
  userId: string;
  serverId: string;
  toolName?: string;
  conversationId?: string;
  mode: Mode;
  constraints?: Record<string, unknown>;
  expiresAt?: string;
  source: 'default' | 'user_dm' | 'admin';
  confirmed?: boolean;
  revokedAt?: string;
};
export type OAuthConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  revokeStyle?: 'rfc7009' | 'github_grant';
  clientId: string;
  clientSecretRef?: string;
  scopes: string[];
};
export type Server = {
  id: string;
  slug: string;
  displayName: string;
  provider: 'custom' | 'composio';
  transport: string;
  baseUrl?: string;
  authType: 'oauth2' | 'api_key' | 'none' | 'composio_managed';
  oauthConfig?: OAuthConfig;
  callbackPath: string;
  status: string;
};
export type Connection = {
  id: string;
  userId: string;
  serverId: string;
  status: 'pending' | 'connected' | 'needs_reauth' | 'revoked';
  grantedScopes: string[];
};
export type CredentialKind = 'access_token' | 'refresh_token' | 'api_key';
export type CallContext = {
  userId: string;
  connectionId: string;
  credentials: Partial<Record<CredentialKind, string>>;
  signal: AbortSignal;
  idempotencyKey: string;
};
export type ToolResult = { content: unknown; isError?: boolean };
export interface ToolProvider {
  id: string;
  listTools(serverId: string): Promise<ToolManifest[]>;
  callTool(serverId: string, tool: string, args: unknown, ctx: CallContext): Promise<ToolResult>;
}
export interface ContextBroker {
  disclose(request: {
    taskId: string;
    requesterAgentId: string;
    subjectUserId: string;
    purpose: TurnContext['purpose'];
    fields: string[];
    audience: { kind: 'group'; id: string };
    data: unknown;
  }): Promise<
    | { status: 'approved'; fields: Record<string, unknown>; expiresAt: string }
    | { status: 'denied'; reasonCode: string }
    | { status: 'needs_consent'; consentRequestId: string }
  >;
}
export type ApprovalRequest = {
  userId: string;
  conversationId: string;
  kind: 'tool_ask' | 'permission_change' | 'spend_handoff';
  proposal: unknown;
  channel: 'text' | 'web';
  sensitive?: boolean;
};
export interface ApprovalService {
  create(
    request: ApprovalRequest,
  ): Promise<{ id: string; code?: string; token?: string; expiresAt: string }>;
  consume(id: string, userId: string, conversationId: string, proposal: unknown): Promise<boolean>;
}
export interface VaultClient {
  put(
    userId: string,
    connectionId: string,
    kind: CredentialKind,
    secret: string,
    expiresAt?: string,
  ): Promise<void>;
  get(
    userId: string,
    connectionId: string,
    kind: CredentialKind,
  ): Promise<{ secret: string; expiresAt?: string } | null>;
  delete(userId: string, connectionId: string): Promise<void>;
}
export interface ToolStore {
  withConnectionLock<T>(
    userId: string,
    serverId: string,
    work: (store: ToolStore) => Promise<T>,
  ): Promise<T>;
  servers(): Promise<Server[]>;
  server(idOrSlug: string): Promise<Server | null>;
  tools(serverId: string): Promise<{ manifests: ToolManifest[]; refreshedAt: number } | null>;
  replaceTools(serverId: string, manifests: ToolManifest[], refreshedAt: number): Promise<void>;
  connection(userId: string, serverId: string): Promise<Connection | null>;
  saveConnection(connection: Connection): Promise<void>;
  rules(userId: string, serverId: string): Promise<PermissionRule[]>;
  defaults(userId: string, serverId: string): Promise<{ riskClass?: Risk; mode: Mode }[]>;
  saveRule(rule: PermissionRule): Promise<void>;
  saveDefault(rule: {
    userId: string;
    serverId: string;
    riskClass: Risk;
    mode: Mode;
    expiresAt?: string;
  }): Promise<void>;
  resetRules(userId: string, serverId: string): Promise<void>;
  oauthPut(state: OAuthState): Promise<void>;
  oauthTake(
    hash: string,
    userId: string,
    serverId: string,
    now: number,
  ): Promise<OAuthState | null>;
  callStart(call: CallRecord): Promise<boolean>;
  callFinish(key: string, status: string, latencyMs: number): Promise<void>;
}
export type OAuthState = {
  hash: string;
  userId: string;
  serverId: string;
  ciphertext: Buffer;
  keyVersion: number;
  expiresAt: number;
};
export type CallRecord = {
  key: string;
  userId: string;
  conversationId: string;
  serverId: string;
  toolName: string;
  argsHash: string;
  decision: string;
  modeUsed: Mode;
  approvalId?: string;
  turnId?: string;
  limits?: { perTurn: number; perUserMinute: number; perConversationMinute: number };
};
