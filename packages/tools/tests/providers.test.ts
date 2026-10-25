import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ComposioProvider, CustomMcpProvider, discoveryContext } from '../src/providers.ts';
import type { ComposioSdk } from '../src/providers.ts';
import type { CallContext } from '../src/ports.ts';
import { manifest } from './fakes.ts';
const ctx: CallContext = {
  userId: 'user-a',
  connectionId: 'c',
  credentials: { access_token: 'dummy-secret' },
  signal: AbortSignal.timeout(10000),
  idempotencyKey: 'stable-key',
};
const policy = {
  description: 'Reviewed read',
  riskClass: 'read' as const,
  defaultMode: 'allow' as const,
  requiredScopes: [],
};
test('custom provider uses real MCP SDK protocol with a local fake server; ignores unreviewed tools', async () => {
  let received: unknown;
  const sessions: Server[] = [];
  const provider = new CustomMcpProvider(
    new Map([['s', { url: 'https://mcp.example', tools: { get_me: policy } }]]),
    async () => {
      const server = new Server(
        { name: 'local-test-mcp', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      sessions.push(server);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: 'get_me', inputSchema: manifest().inputSchema },
          { name: 'purchase', inputSchema: { type: 'object' } },
          { name: 'toString', inputSchema: { type: 'object' } },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        received = request.params.arguments;
        return { content: [{ type: 'text', text: 'untrusted result' }] };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(a);
      return client;
    },
  );
  const tools = await discoveryContext.run(ctx, () => provider.listTools('s'));
  assert.deepEqual(
    tools.map((t) => t.name),
    ['get_me'],
  );
  assert.equal(tools[0].description, 'Reviewed read');
  const result = await provider.callTool('s', 'get_me', { query: 'x' }, ctx);
  assert.deepEqual(received, { query: 'x' });
  assert.equal(result.isError, false);
  await assert.rejects(() => provider.callTool('s', 'purchase', {}, ctx), /provider_tool_unknown/);
  await assert.rejects(() => provider.callTool('s', 'toString', {}, ctx), /provider_tool_unknown/);
  await assert.rejects(() => provider.listTools('s'), /discovery_context_missing/);
  await Promise.all(sessions.map((s) => s.close()));
});
test('custom provider handles pagination, closes on errors, and never surfaces provider secrets', async () => {
  let closed = 0,
    calls = 0;
  const p = new CustomMcpProvider(
    new Map([['s', { url: 'https://mcp.example', tools: { get_me: policy } }]]),
    async () => ({
      listTools: async () => {
        calls++;
        return { tools: [], nextCursor: 'repeat' };
      },
      callTool: async () => {
        throw new Error('dummy-secret');
      },
      close: async () => {
        closed++;
      },
    }),
  );
  await assert.rejects(
    () => discoveryContext.run(ctx, () => p.listTools('s')),
    /mcp_discovery_failed/,
  );
  assert.equal(calls, 2);
  assert.equal(closed, 1);
  await assert.rejects(() => p.callTool('s', 'get_me', {}, ctx), /mcp_call_failed/);
  assert.equal(closed, 2);
});
test('Composio discovers reviewed version-pinned schemas, pins actor/account/version and verifies account ownership', async () => {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const sdk = {
    tools: {
      getRawComposioToolBySlug: async (name: string, options: unknown) => {
        assert.deepEqual(options, { version: '20261001_00' });
        return {
          slug: name,
          toolkit: { slug: 'googlecalendar' },
          inputParameters: manifest().inputSchema,
        };
      },
      execute: async (name: string, body: Record<string, unknown>) => {
        calls.push({ name, body });
        return { successful: true, data: { busy: false } };
      },
    },
    connectedAccounts: {
      list: async (query: { userIds: string[]; authConfigIds: string[] }) => {
        assert.deepEqual(query.userIds, ['user-a']);
        assert.deepEqual(query.authConfigIds, ['ac-calendar']);
        return { items: [{ id: 'account-a', status: 'ACTIVE', isDisabled: false }] };
      },
    },
  } as unknown as ComposioSdk;
  const provider = new ComposioProvider(
    sdk,
    new Map([
      [
        'calendar',
        {
          toolkit: 'googlecalendar',
          authConfigId: 'ac-calendar',
          version: '20261001_00',
          tools: { GOOGLECALENDAR_FREE_BUSY_QUERY: policy },
        },
      ],
    ]),
  );
  assert.equal(
    (await discoveryContext.run(ctx, () => provider.listTools('calendar')))[0].name,
    'GOOGLECALENDAR_FREE_BUSY_QUERY',
  );
  const result = await provider.callTool(
    'calendar',
    'GOOGLECALENDAR_FREE_BUSY_QUERY',
    {},
    { ...ctx, credentials: { api_key: 'account-a' } },
  );
  assert.deepEqual(result.content, { busy: false });
  assert.equal(calls[0].body.userId, 'user-a');
  assert.equal(calls[0].body.connectedAccountId, 'account-a');
  assert.equal(calls[0].body.version, '20261001_00');
  await assert.rejects(
    () =>
      provider.callTool(
        'calendar',
        'GOOGLECALENDAR_FREE_BUSY_QUERY',
        {},
        { ...ctx, credentials: { api_key: 'account-b' } },
      ),
    /composio_account_owner_mismatch/,
  );
  assert.equal(calls.length, 1);
  const unpinned = new ComposioProvider(
    sdk,
    new Map([
      ['s', { toolkit: 'googlecalendar', authConfigId: 'ac', version: 'latest', tools: {} }],
    ]),
  );
  await assert.rejects(
    () => discoveryContext.run(ctx, () => unpinned.listTools('s')),
    /composio_config_missing/,
  );
});
