import { randomUUID } from 'node:crypto';
import type {
  AuditLog,
  CallContext,
  CallRecord,
  Connection,
  CredentialKind,
  Mode,
  OAuthState,
  PermissionRule,
  Risk,
  Server,
  ToolManifest,
  ToolProvider,
  ToolResult,
  ToolStore,
  TurnContext,
  VaultClient,
} from '../src/ports.ts';
import { requireThat } from '../src/security.ts';

export const context = (extra: Partial<TurnContext> = {}): TurnContext => ({
  userId: 'user-a',
  verified: true,
  conversationId: 'dm-a',
  approvalConversationId: 'dm-a',
  isGroup: false,
  turnId: 'turn-1',
  requesterAgentId: 'personal-a',
  taskId: 'task-1',
  purpose: 'other',
  instruction: {
    source: 'user_dm',
    senderUserId: 'user-a',
    messageId: 'message-1',
    text: 'Please allow this action',
  },
  ...extra,
});
export const server: Server = {
  id: 'server-1',
  slug: 'github',
  displayName: 'GitHub',
  provider: 'custom',
  transport: 'streamable_http',
  authType: 'oauth2',
  status: 'active',
  callbackPath: '/oauth/callback/github',
  oauthConfig: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    revokeUrl: 'https://oauth.example/revoke',
    clientId: 'dummy-client',
    scopes: ['read:user'],
  },
};
export const manifest = (extra: Partial<ToolManifest> = {}): ToolManifest => ({
  name: 'get_me',
  description: 'Read profile',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    additionalProperties: false,
  },
  riskClass: 'read',
  defaultMode: 'allow',
  requiredScopes: ['read:user'],
  ...extra,
});
export class MemoryAudit implements AuditLog {
  events: Parameters<AuditLog['record']>[0][] = [];
  async record(event: Parameters<AuditLog['record']>[0]): Promise<void> {
    this.events.push(structuredClone(event));
  }
}
export class MemoryToolStore implements ToolStore {
  serverRows: Server[] = [structuredClone(server)];
  cache = new Map<string, { manifests: ToolManifest[]; refreshedAt: number }>();
  connections: Connection[] = [];
  permissionRows: PermissionRule[] = [];
  defaultRows: Array<{ userId: string; serverId: string; riskClass?: Risk; mode: Mode }> = [];
  states = new Map<string, OAuthState>();
  calls = new Map<string, CallRecord & { createdAt: number; status?: string }>();
  private locks = new Map<string, Promise<unknown>>();
  async withConnectionLock<T>(
    userId: string,
    serverId: string,
    work: (store: ToolStore) => Promise<T>,
  ): Promise<T> {
    const key = `${userId}:${serverId}`,
      previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => work(this));
    this.locks.set(key, next);
    return next;
  }
  async servers(): Promise<Server[]> {
    return structuredClone(this.serverRows);
  }
  async server(id: string): Promise<Server | null> {
    return structuredClone(this.serverRows.find((s) => s.id === id || s.slug === id) ?? null);
  }
  async tools(
    serverId: string,
  ): Promise<{ manifests: ToolManifest[]; refreshedAt: number } | null> {
    return structuredClone(this.cache.get(serverId) ?? null);
  }
  async replaceTools(
    serverId: string,
    manifests: ToolManifest[],
    refreshedAt: number,
  ): Promise<void> {
    this.cache.set(serverId, structuredClone({ manifests, refreshedAt }));
  }
  async connection(userId: string, serverId: string): Promise<Connection | null> {
    return structuredClone(
      this.connections.find((c) => c.userId === userId && c.serverId === serverId) ?? null,
    );
  }
  async saveConnection(c: Connection): Promise<void> {
    this.connections = this.connections.filter(
      (x) => x.userId !== c.userId || x.serverId !== c.serverId,
    );
    this.connections.push(structuredClone(c));
  }
  async rules(userId: string, serverId: string): Promise<PermissionRule[]> {
    return structuredClone(
      this.permissionRows.filter((r) => r.userId === userId && r.serverId === serverId),
    );
  }
  async defaults(userId: string, serverId: string): Promise<{ riskClass?: Risk; mode: Mode }[]> {
    return structuredClone(
      this.defaultRows.filter((r) => r.userId === userId && r.serverId === serverId),
    );
  }
  async saveRule(r: PermissionRule): Promise<void> {
    this.permissionRows = this.permissionRows.filter(
      (x) =>
        !(
          x.userId === r.userId &&
          x.serverId === r.serverId &&
          x.toolName === r.toolName &&
          x.conversationId === r.conversationId
        ),
    );
    this.permissionRows.push(structuredClone(r));
  }
  async saveDefault(r: {
    userId: string;
    serverId: string;
    riskClass: Risk;
    mode: Mode;
  }): Promise<void> {
    this.defaultRows = this.defaultRows.filter(
      (x) => !(x.userId === r.userId && x.serverId === r.serverId && x.riskClass === r.riskClass),
    );
    this.defaultRows.push(r);
  }
  async resetRules(userId: string, serverId: string): Promise<void> {
    this.permissionRows = this.permissionRows.filter(
      (r) => r.userId !== userId || r.serverId !== serverId,
    );
    this.defaultRows = this.defaultRows.filter(
      (r) => r.userId !== userId || r.serverId !== serverId,
    );
    await this.saveRule({
      id: randomUUID(),
      userId,
      serverId,
      source: 'user_dm',
      mode: 'ask',
      confirmed: true,
    });
  }
  async oauthPut(s: OAuthState): Promise<void> {
    for (const [k, v] of this.states)
      if (v.userId === s.userId && v.serverId === s.serverId) this.states.delete(k);
    this.states.set(s.hash, s);
  }
  async oauthTake(
    hash: string,
    userId: string,
    serverId: string,
    now: number,
  ): Promise<OAuthState | null> {
    const s = this.states.get(hash);
    if (!s || s.userId !== userId || s.serverId !== serverId || s.expiresAt <= now) return null;
    this.states.delete(hash);
    return s;
  }
  async callStart(c: CallRecord): Promise<boolean> {
    if (this.calls.has(c.key)) return false;
    if (c.limits) {
      const calls = [...this.calls.values()].filter((r) => r.decision === 'execute');
      if (
        calls.filter((r) => r.userId === c.userId && r.turnId === c.turnId).length >=
          c.limits.perTurn ||
        calls.filter((r) => r.userId === c.userId && r.createdAt > Date.now() - 60000).length >=
          c.limits.perUserMinute ||
        calls.filter(
          (r) => r.conversationId === c.conversationId && r.createdAt > Date.now() - 60000,
        ).length >= c.limits.perConversationMinute
      )
        return false;
    }
    this.calls.set(c.key, { ...c, createdAt: Date.now() });
    return true;
  }
  async callFinish(key: string, status: string): Promise<void> {
    const c = this.calls.get(key);
    if (c) c.status = status;
  }
}
export class FakeProvider implements ToolProvider {
  id = 'custom';
  manifests: ToolManifest[] = [manifest()];
  invocations: Array<{ serverId: string; tool: string; args: unknown; ctx: CallContext }> = [];
  discoveries = 0;
  result: ToolResult = { content: { profile: 'example' } };
  error?: Error;
  invoke?: (ctx: CallContext) => Promise<ToolResult>;
  async listTools(): Promise<ToolManifest[]> {
    this.discoveries++;
    if (this.error) throw this.error;
    return structuredClone(this.manifests);
  }
  async callTool(
    serverId: string,
    tool: string,
    args: unknown,
    ctx: CallContext,
  ): Promise<ToolResult> {
    this.invocations.push({ serverId, tool, args, ctx });
    if (this.error) throw this.error;
    return this.invoke ? this.invoke(ctx) : this.result;
  }
}
// Tests only: never exported from the production package.
export class MemoryVault implements VaultClient {
  private store: MemoryToolStore;
  values = new Map<string, { secret: string; expiresAt?: string }>();
  constructor(store: MemoryToolStore) {
    this.store = store;
  }
  private own(userId: string, connectionId: string): void {
    requireThat(
      this.store.connections.some((c) => c.userId === userId && c.id === connectionId),
      'credential_access_denied',
    );
  }
  async put(
    userId: string,
    id: string,
    kind: CredentialKind,
    secret: string,
    expiresAt?: string,
  ): Promise<void> {
    this.own(userId, id);
    this.values.set(`${id}:${kind}`, { secret, expiresAt });
  }
  async get(
    userId: string,
    id: string,
    kind: CredentialKind,
  ): Promise<{ secret: string; expiresAt?: string } | null> {
    this.own(userId, id);
    return this.values.get(`${id}:${kind}`) ?? null;
  }
  async delete(userId: string, id: string): Promise<void> {
    this.own(userId, id);
    for (const k of this.values.keys()) if (k.startsWith(`${id}:`)) this.values.delete(k);
  }
}
