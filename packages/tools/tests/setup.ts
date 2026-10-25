import { randomBytes } from 'node:crypto';
// Test-only wiring of P4's own two packages (gateway + approvals) for end-to-end gateway tests.
// eslint-disable-next-line boundaries/only-contracts
import { ApprovalService } from '../../approvals/src/service.ts';
// eslint-disable-next-line boundaries/only-contracts
import { MemoryApprovalStore } from '../../approvals/tests/fakes.ts';
import { ToolCatalog } from '../src/catalog.ts';
import { ConnectionService } from '../src/connections.ts';
import type { OAuthClient, Tokens } from '../src/connections.ts';
import { ToolGateway } from '../src/gateway.ts';
import { PermissionResolver } from '../src/permissions.ts';
import { EnvelopeCipher } from '../src/vault.ts';
import type { ContextBroker, OAuthConfig } from '../src/ports.ts';
import { FakeProvider, MemoryAudit, MemoryToolStore, MemoryVault } from './fakes.ts';

export class FakeOAuth implements OAuthClient {
  exchanges: Array<{ config: OAuthConfig; code: string; verifier: string; redirectUri: string }> =
    [];
  refreshes = 0;
  revokes = 0;
  tokens: Tokens = {
    accessToken: 'dummy-access-secret',
    refreshToken: 'dummy-refresh-secret',
    expiresIn: 3600,
    scopes: ['read:user'],
  };
  fail = false;
  async exchange(
    config: OAuthConfig,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<Tokens> {
    this.exchanges.push({ config, code, verifier, redirectUri });
    if (this.fail) throw new Error('dummy-access-secret');
    return this.tokens;
  }
  async refresh(): Promise<Tokens> {
    this.refreshes++;
    if (this.fail) throw new Error('dummy-refresh-secret');
    return this.tokens;
  }
  async revoke(): Promise<void> {
    this.revokes++;
    if (this.fail) throw new Error('dummy-refresh-secret');
  }
}
export async function setup(
  options: {
    broker?: ContextBroker;
    timeoutMs?: number;
    ttlMs?: number;
    now?: () => number;
    limits?: { perTurn: number; perUserMinute: number; perConversationMinute: number };
  } = {},
) {
  const store = new MemoryToolStore(),
    audit = new MemoryAudit(),
    vault = new MemoryVault(store),
    cipher = new EnvelopeCipher(new Map([[1, randomBytes(32)]]), 1),
    oauth = new FakeOAuth();
  const approvalStore = new MemoryApprovalStore(),
    approvals = new ApprovalService(approvalStore, audit, randomBytes(32), { now: options.now });
  const permissions = new PermissionResolver(store, audit, approvals, options.now),
    provider = new FakeProvider(),
    providers = new Map([['custom', provider]]);
  const connections = new ConnectionService({
    store,
    audit,
    vault,
    cipher,
    oauth,
    redirectBase: 'https://campus.example',
    now: options.now,
  });
  const catalog = new ToolCatalog(store, providers, audit, {
    ttlMs: options.ttlMs,
    now: options.now,
  });
  const delivered: unknown[] = [];
  const gateway = new ToolGateway({
    store,
    audit,
    connections,
    catalog,
    permissions,
    approvals,
    providers,
    broker: options.broker,
    timeoutMs: options.timeoutMs,
    limits: options.limits,
    deliverApproval: async (r) => {
      delivered.push(r);
    },
  });
  async function connect(userId = 'user-a') {
    const id = `connection-${userId}`;
    await store.saveConnection({
      id,
      userId,
      serverId: 'server-1',
      status: 'connected',
      grantedScopes: ['read:user'],
    });
    await vault.put(
      userId,
      id,
      'access_token',
      `dummy-${userId}-secret`,
      new Date((options.now?.() ?? Date.now()) + 3600000).toISOString(),
    );
  }
  return {
    store,
    audit,
    vault,
    cipher,
    oauth,
    approvalStore,
    approvals,
    permissions,
    provider,
    providers,
    connections,
    catalog,
    gateway,
    delivered,
    connect,
  };
}
