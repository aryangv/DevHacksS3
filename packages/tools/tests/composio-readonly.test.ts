import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from './setup.ts';
import { context } from './fakes.ts';
import { ComposioProvider } from '../src/providers.ts';
import type { ComposioSdk } from '../src/providers.ts';
import { ConnectionService } from '../src/connections.ts';
import { ToolCatalog } from '../src/catalog.ts';
import { ToolGateway } from '../src/gateway.ts';
import { composioFromEnv } from '../src/config.ts';
import {
  GMAIL_READ_SCOPE,
  GMAIL_TOOLS,
  SEARCH_TOOLS,
  readOnlyComposioIntegrations,
} from '../src/composio-readonly.ts';

// Public live-catalog schemas, no account data or credentials. Validates actual provider shapes.
const schemas = JSON.parse(
  readFileSync(new URL('./composio-schemas.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const session = { userId: 'user-a', authenticated: true, sessionId: 'web-a' };
const email = {
  messages: [
    {
      id: '1234567890abcdef',
      subject: 'Private subject',
      body: 'Private email body',
      sender: 'test@example.com',
    },
  ],
};

async function fixture() {
  const f = await setup();
  const configs = readOnlyComposioIntegrations({
    searchId: 'search',
    gmailId: 'gmail',
    gmailAuthConfigId: 'ac-readonly',
  });
  f.store.serverRows = configs.servers;
  let callbackUrl = '',
    accountStatus = 'ACTIVE',
    owner = 'user-a';
  let executionError: unknown, accountError: unknown;
  let data: unknown = {
    products: [
      {
        name: 'Source product',
        price: '$23.99',
        rating: 4.5,
        url: 'https://amazon.com/dp/example',
      },
    ],
    travel: {
      departure: 'PHX',
      arrival: 'LAX',
      price: 'USD 120',
      url: 'https://source.example/travel',
    },
  };
  const executions: Array<{ name: string; body: Record<string, unknown> }> = [];
  const sdk = {
    tools: {
      getRawComposioToolBySlug: async (slug: string) => structuredClone(schemas[slug]),
      execute: async (name: string, body: Record<string, unknown>) => {
        // Mandatory checks must have completed BEFORE any external execution.
        assert(
          f.audit.events.some((e) => e.action === 'tool.invoke' && e.policyResult === 'allow'),
        );
        assert(
          f.audit.events.some(
            (e) =>
              e.action === 'permission.resolve' && ['allow', 'ask'].includes(e.policyResult ?? ''),
          ),
        );
        assert(
          [...f.store.calls.values()].some((c) => c.decision === 'execute' && c.toolName === name),
        );
        executions.push({ name, body });
        if (executionError) throw executionError;
        return { successful: true, data: structuredClone(data) };
      },
    },
    connectedAccounts: {
      link: async (userId: string, authConfig: string, options: { callbackUrl: string }) => {
        assert.equal(userId, session.userId);
        assert.equal(authConfig, 'ac-readonly');
        callbackUrl = options.callbackUrl;
        return { id: 'account-a', redirectUrl: 'https://connect.composio.dev/read-only-test' };
      },
      list: async (query: {
        userIds: string[];
        authConfigIds: string[];
        toolkitSlugs: string[];
      }) => {
        assert.deepEqual(query.userIds, ['user-a']);
        assert.deepEqual(query.authConfigIds, ['ac-readonly']);
        assert.deepEqual(query.toolkitSlugs, ['gmail']);
        if (accountError) throw accountError;
        return {
          items:
            owner === session.userId
              ? [{ id: 'account-a', status: accountStatus, isDisabled: false }]
              : [],
        };
      },
      get: async () => ({
        state: { val: { scope: GMAIL_READ_SCOPE, access_token: 'not-stored-oauth-token' } },
      }),
    },
  } as unknown as ComposioSdk;
  const provider = new ComposioProvider(sdk, configs.composio);
  const providers = new Map([['composio', provider]]);
  const connections = new ConnectionService({
    ...f,
    redirectBase: 'https://campus.example',
    composio: { sdk, provider },
  });
  const catalog = new ToolCatalog(f.store, providers, f.audit);
  const delivered: Array<{ approvalId: string; proposal: unknown; token?: string }> = [];
  const gateway = new ToolGateway({
    ...f,
    connections,
    catalog,
    providers,
    deliverApproval: async (request) => {
      delivered.push(request);
    },
  });
  async function connectGmail() {
    const link = await connections.initiate(session, 'gmail');
    assert(link.authorizationUrl.startsWith('https://connect.composio.dev/'));
    await connections.callback(session, 'gmail', {
      state: new URL(callbackUrl).searchParams.get('state')!,
      status: 'success',
      connected_account_id: 'account-a',
    });
    data = email;
  }
  return {
    ...f,
    configs,
    provider,
    connections,
    catalog,
    gateway,
    executions,
    delivered,
    connectGmail,
    setStatus: (status: string) => {
      accountStatus = status;
    },
    setOwner: (userId: string) => {
      owner = userId;
    },
    setExecutionError: (error: unknown) => {
      executionError = error;
    },
    setAccountError: (error: unknown) => {
      accountError = error;
    },
    getData: () => data,
  };
}
const proposal = (
  tool = 'GMAIL_FETCH_EMAILS',
  args: unknown = { query: 'in:inbox', max_results: 3 },
) => ({ proposalId: 'p1', server: 'gmail', tool, args });
const searchArgs: Record<string, unknown> = {
  COMPOSIO_SEARCH_GOOGLE_MAPS: { q: 'restaurants near ASU' },
  COMPOSIO_SEARCH_FLIGHTS: { departure_id: 'PHX', arrival_id: 'LAX', outbound_date: '2026-11-12' },
  COMPOSIO_SEARCH_HOTELS: {
    q: 'Phoenix',
    check_in_date: '2026-11-12',
    check_out_date: '2026-11-13',
  },
};

for (const name of SEARCH_TOOLS)
  test(`${name}: real schema, gateway permissions and audit; preserve source facts`, async () => {
    const f = await fixture();
    await f.connections.connectPublicSearch(session, 'search');
    const visible = await f.gateway.availableTools(context());
    assert.deepEqual(
      visible.map((t) => t.name),
      [...SEARCH_TOOLS],
    );
    assert(visible.every((t) => t.riskClass === 'read'));
    const result = await f.gateway.execute(context(), {
      proposalId: 'search-1',
      server: 'composio_search',
      tool: name,
      args: searchArgs[name] ?? { query: 'wireless headphones' },
    });
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.deepEqual(result.data, f.getData());
      assert.equal(result.provenance.untrusted, true);
    }
    assert.equal(f.executions.length, 1);
    assert.equal(f.executions[0].body.userId, session.userId);
    assert.equal(f.executions[0].body.connectedAccountId, undefined);
    assert.equal(f.executions[0].body.allowTracing, false);
    assert(f.audit.events.some((e) => e.action === 'tool.result'));
    assert(!JSON.stringify(f.audit.events).includes('Source product'));
  });

test('Gmail OAuth callback binds the app user, grants read scope and stores only account reference', async () => {
  const f = await fixture();
  await f.connectGmail();
  const connection = await f.store.connection(session.userId, 'gmail');
  assert.equal(connection?.status, 'connected');
  assert.deepEqual(connection?.grantedScopes, [GMAIL_READ_SCOPE]);
  assert.equal((await f.vault.get(session.userId, connection!.id, 'api_key'))?.secret, 'account-a');
  assert(!JSON.stringify([...f.vault.values]).includes('not-stored-oauth-token'));
  const visible = await f.gateway.availableTools(context());
  assert.deepEqual(
    visible.map((t) => t.name),
    [...GMAIL_TOOLS],
  );
  assert(visible.every((t) => !Object.hasOwn(t.inputSchema.properties as object, 'user_id')));
});

for (const tool of GMAIL_TOOLS)
  test(`${tool}: connected search/retrieval, actor binding, private audit`, async () => {
    const f = await fixture();
    await f.connectGmail();
    const result = await f.gateway.execute(
      context(),
      proposal(
        tool,
        tool === GMAIL_TOOLS[0]
          ? { query: 'in:inbox', max_results: 3 }
          : { message_id: '1234567890abcdef', format: 'full' },
      ),
    );
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.deepEqual(result.data, email);
    assert.equal(f.executions[0].body.connectedAccountId, 'account-a');
    assert.equal((f.executions[0].body.arguments as Record<string, unknown>).user_id, 'me');
    assert(!JSON.stringify(f.audit.events).includes('Private email'));
    assert(!JSON.stringify([...f.store.calls.values()]).includes('in:inbox'));
  });

test('missing Gmail is invisible and returns authenticated connection flow without execution', async () => {
  const f = await fixture();
  assert.deepEqual(await f.gateway.availableTools(context()), []);
  assert.deepEqual(await f.gateway.execute(context(), proposal()), {
    status: 'connection_required',
    reasonCode: 'connection_unavailable',
    connection: {
      server: 'gmail',
      startPath: '/connections/gmail/start',
      authenticationRequired: true,
    },
  });
  assert.equal(f.executions.length, 0);
  assert(f.audit.events.some((e) => e.action === 'tool.rejected'));
});

for (const status of ['EXPIRED', 'REVOKED', 'FAILED'])
  test(`Gmail ${status} authorization hides tools and requires reauthorization`, async () => {
    const f = await fixture();
    await f.connectGmail();
    f.setStatus(status);
    assert.equal((await f.gateway.execute(context(), proposal())).status, 'connection_required');
    assert.equal((await f.store.connection(session.userId, 'gmail'))?.status, 'needs_reauth');
    assert.deepEqual(await f.gateway.availableTools(context()), []);
    assert.equal(f.executions.length, 0);
  });

test('foreign Playground account never becomes usable by an application user', async () => {
  const f = await fixture();
  await f.connectGmail();
  f.setOwner('playground-user');
  assert.equal((await f.gateway.execute(context(), proposal())).status, 'connection_required');
  assert.equal(f.executions.length, 0);
});

test('Gmail write operations and unreviewed search tools stay blocked even under wildcard allow', async () => {
  const f = await fixture();
  await f.connectGmail();
  f.store.permissionRows.push({
    id: 'wild',
    userId: session.userId,
    serverId: 'gmail',
    mode: 'allow',
    source: 'admin',
  });
  for (const tool of [
    'GMAIL_SEND_EMAIL',
    'GMAIL_DELETE_MESSAGE',
    'GMAIL_BATCH_DELETE_MESSAGES',
    'GMAIL_ADD_LABEL_TO_EMAIL',
    'GMAIL_MODIFY_THREAD_LABELS',
    'GMAIL_CREATE_EMAIL_DRAFT',
  ]) {
    const result = await f.gateway.execute(context(), proposal(tool, {}));
    assert.equal(result.status, 'denied');
    assert('reasonCode' in result && result.reasonCode === 'tool_not_allowed');
  }
  await f.connections.connectPublicSearch(session, 'search');
  assert.equal(
    (
      await f.gateway.execute(context(), {
        ...proposal('COMPOSIO_SEARCH_WEB', {}),
        server: 'composio_search',
      })
    ).status,
    'denied',
  );
  // Even a misconfigured operator policy cannot enable a write at the provider boundary.
  f.configs.composio.get('gmail')!.tools.GMAIL_SEND_EMAIL = {
    description: 'forged',
    riskClass: 'read',
    defaultMode: 'allow',
    requiredScopes: [],
  };
  await assert.rejects(
    () =>
      f.provider.callTool(
        'gmail',
        'GMAIL_SEND_EMAIL',
        {},
        {
          userId: session.userId,
          connectionId: 'c',
          credentials: { api_key: 'account-a' },
          signal: AbortSignal.timeout(1000),
          idempotencyKey: 'k',
        },
      ),
    /provider_tool_denied/,
  );
  assert.equal(f.executions.length, 0);
});

test('Gmail missing credentials, insufficient scope, forged user and excessive result count fail closed', async () => {
  const f = await fixture();
  await f.connectGmail();
  for (const args of [{ user_id: 'other@example.com' }, { max_results: 21 }, { unknown: true }])
    assert.equal(
      (await f.gateway.execute(context(), proposal('GMAIL_FETCH_EMAILS', args))).status,
      'denied',
    );
  f.store.connections[0].grantedScopes = [];
  assert.equal((await f.gateway.execute(context(), proposal())).status, 'denied');
  f.store.connections[0].grantedScopes = [GMAIL_READ_SCOPE];
  await f.vault.delete(session.userId, f.store.connections[0].id);
  assert.equal((await f.gateway.execute(context(), proposal())).status, 'connection_required');
  assert.equal(f.executions.length, 0);
});

test('Gmail deny prevents execution; ask requires a bound one-time web approval', async () => {
  const f = await fixture();
  await f.connectGmail();
  const rule = {
    id: 'permission',
    userId: session.userId,
    serverId: 'gmail',
    mode: 'deny' as const,
    source: 'admin' as const,
  };
  f.store.permissionRows.push(rule);
  assert.equal((await f.gateway.execute(context(), proposal())).status, 'denied');
  f.store.permissionRows = [{ ...rule, mode: 'ask' }];
  assert.equal((await f.gateway.execute(context(), proposal())).status, 'pending');
  assert.equal(f.executions.length, 0);
  const pending = f.delivered[0];
  assert(
    await f.approvals.decideWeb(
      pending.approvalId,
      session,
      pending.token!,
      true,
      pending.proposal,
    ),
  );
  assert.equal((await f.gateway.execute(context(), proposal(), pending.approvalId)).status, 'ok');
  assert.equal(
    (await f.gateway.execute(context(), proposal(), pending.approvalId)).status,
    'denied',
  );
  assert.equal(f.executions.length, 1);
});

for (const status of [401, 403, 429, 503])
  test(`Composio HTTP ${status} is sanitized and does not revoke Gmail`, async () => {
    const f = await fixture();
    await f.connectGmail();
    f.setAccountError(Object.assign(new Error('secret-provider-error'), { status }));
    const result = await f.gateway.execute(context(), proposal());
    assert.equal(result.status, 'denied');
    assert(
      'reasonCode' in result &&
        result.reasonCode ===
          (status === 429
            ? 'composio_rate_limited'
            : status === 503
              ? 'composio_connection_check_failed'
              : 'composio_api_access_denied'),
    );
    assert.equal((await f.store.connection(session.userId, 'gmail'))?.status, 'connected');
    assert(!JSON.stringify([result, f.audit.events]).includes('secret-provider-error'));
  });

test('execution rate limits and failures are audited without raw error content or email data', async () => {
  const f = await fixture();
  await f.connectGmail();
  f.setExecutionError(Object.assign(new Error('Private email body'), { status: 429 }));
  const result = await f.gateway.execute(context(), proposal());
  assert.equal(result.status, 'error');
  assert('reasonCode' in result && result.reasonCode === 'composio_rate_limited');
  assert([...f.store.calls.values()].some((c) => c.status === 'failed'));
  assert(!JSON.stringify([result, f.audit.events]).includes('Private email body'));
});

test('live tools default off and require a project credential', () => {
  assert.throws(() => composioFromEnv({}), /real_tools_disabled/);
  assert.throws(
    () => composioFromEnv({ USE_REAL_TOOLS: 'false', COMPOSIO_API_KEY: 'unused' }),
    /real_tools_disabled/,
  );
  assert.throws(() => composioFromEnv({ USE_REAL_TOOLS: 'true' }), /composio_key_missing/);
});
