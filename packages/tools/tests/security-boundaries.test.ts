import { test } from 'node:test';
import assert from 'node:assert/strict';
import { context, manifest } from './fakes.ts';
import { setup } from './setup.ts';

test('undeclared arguments are rejected for empty schemas and inherited property names', async () => {
  for (const inputSchema of [
    { type: 'object' },
    { type: 'object', properties: { query: { type: 'string' } } },
  ]) {
    const f = await setup();
    await f.connect();
    f.provider.manifests = [manifest({ inputSchema })];
    for (const args of [{ unexpected: true }, { toString: 'inherited' }]) {
      assert.equal(
        (
          await f.gateway.execute(context(), {
            proposalId: crypto.randomUUID(),
            server: 'github',
            tool: 'get_me',
            args,
          })
        ).status,
        'denied',
      );
    }
    assert.equal(f.provider.invocations.length, 0);
  }
});

test('reserved authority fields rejected even if declared in the tool schema', async () => {
  const f = await setup();
  await f.connect();
  f.provider.manifests = [
    manifest({
      inputSchema: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          namespace: { type: 'string' },
          recipientId: { type: 'string' },
        },
      },
    }),
  ];
  for (const args of [
    { userId: 'user-b' },
    { namespace: 'user-b-private' },
    { recipientId: 'group-b' },
  ]) {
    const r = await f.gateway.execute(context(), {
      proposalId: crypto.randomUUID(),
      server: 'github',
      tool: 'get_me',
      args,
    });
    assert.equal(r.status, 'denied');
  }
  assert.equal(f.provider.invocations.length, 0);
});

test('external-message recipients come from trusted bindings, never from model arguments', async () => {
  const f = await setup();
  await f.connect();
  f.provider.manifests = [
    manifest({
      riskClass: 'external_message',
      defaultMode: 'allow',
      trustedArgumentNames: ['to'],
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, body: { type: 'string' } },
        required: ['to', 'body'],
        additionalProperties: false,
      },
    }),
  ];
  const p = { proposalId: 'message', server: 'github', tool: 'get_me', args: { body: 'hello' } };
  assert.deepEqual(await f.gateway.availableTools(context()), []);
  assert.equal((await f.gateway.execute(context(), p)).status, 'denied');
  const trusted = context({
    toolArgumentBindings: { github__get_me: { to: 'verified-recipient' } },
  });
  const list = await f.gateway.availableTools(trusted);
  assert.deepEqual(list[0].inputSchema.required, ['body']);
  assert.equal(
    (await f.gateway.execute(trusted, { ...p, args: { body: 'hello', to: 'attacker' } })).status,
    'denied',
  );
  assert.equal((await f.gateway.execute(trusted, p)).status, 'ok');
  assert.deepEqual(f.provider.invocations[0].args, { body: 'hello', to: 'verified-recipient' });
});

test('permission changing to ask during audit prevents an unapproved execution', async () => {
  const f = await setup();
  await f.connect();
  const original = f.audit.record.bind(f.audit);
  let count = 0;
  f.audit.record = async (event) => {
    await original(event);
    if (event.action === 'permission.resolve' && ++count === 1)
      f.store.permissionRows = [
        {
          id: 'new-policy',
          userId: 'user-a',
          serverId: 'server-1',
          mode: 'ask',
          source: 'user_dm',
        },
      ];
  };
  const result = await f.gateway.execute(context(), {
    proposalId: 'p',
    server: 'github',
    tool: 'get_me',
    args: {},
  });
  assert.equal(result.status, 'denied');
  assert.equal(f.provider.invocations.length, 0);
});

test('successful writes with denied disclosure are recorded as successful but withheld', async () => {
  const f = await setup();
  await f.connect();
  f.provider.manifests = [manifest({ riskClass: 'write', defaultMode: 'allow' })];
  const result = await f.gateway.execute(context({ isGroup: true }), {
    proposalId: 'p',
    server: 'github',
    tool: 'get_me',
    args: {},
  });
  assert.equal(result.status, 'error');
  assert([...f.store.calls.values()].some((c) => c.status === 'success_withheld'));
});
