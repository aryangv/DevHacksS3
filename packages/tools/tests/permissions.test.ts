import test from 'node:test';
import assert from 'node:assert/strict';
import { context, manifest } from './fakes.ts';
import { setup } from './setup.ts';
import type { Mode, PermissionRule, Risk } from '../src/ports.ts';

const rule = (extra: Partial<PermissionRule> = {}): PermissionRule => ({
  id: crypto.randomUUID(),
  userId: 'user-a',
  serverId: 'server-1',
  source: 'admin',
  mode: 'deny',
  ...extra,
});
test('permission precedence: all six specified tiers, most specific wins', async () => {
  const f = await setup();
  await f.connect();
  const c = await f.store.connection('user-a', 'server-1');
  const tiers = [
    rule({ mode: 'deny' }),
    rule({ mode: 'allow', conversationId: 'dm-a' }),
    rule({ mode: 'ask', toolName: 'get_me' }),
    rule({ mode: 'allow', toolName: 'get_me', conversationId: 'dm-a' }),
  ];
  for (let i = 0; i < tiers.length; i++) {
    f.store.permissionRows = tiers.slice(0, i + 1);
    assert.equal(await f.permissions.resolve(context(), c, manifest()), tiers[i].mode);
  }
  f.store.permissionRows = [];
  f.store.defaultRows = [
    { userId: 'user-a', serverId: 'server-1', mode: 'deny' },
    { userId: 'user-a', serverId: 'server-1', riskClass: 'read', mode: 'ask' },
  ];
  assert.equal(await f.permissions.resolve(context(), c, manifest()), 'ask');
  f.store.defaultRows = [{ userId: 'user-a', serverId: 'server-1', mode: 'deny' }];
  assert.equal(await f.permissions.resolve(context(), c, manifest()), 'allow'); // risk default precedes global
});
test('equal specificity deny beats ask beats allow independent of row order', async () => {
  const f = await setup();
  await f.connect();
  const c = await f.store.connection('user-a', 'server-1');
  for (const modes of [
    ['allow', 'ask', 'deny'],
    ['deny', 'allow', 'ask'],
    ['allow', 'ask'],
  ] as Mode[][]) {
    f.store.permissionRows = modes.map((mode) => rule({ toolName: 'get_me', mode }));
    assert.equal(
      await f.permissions.resolve(context(), c, manifest()),
      modes.includes('deny') ? 'deny' : 'ask',
    );
  }
});
test('all risk defaults and hard caps; wildcard exclusions; destructive requires confirmed exact tool', async () => {
  const f = await setup();
  await f.connect();
  const c = await f.store.connection('user-a', 'server-1');
  for (const risk of ['read', 'write', 'spend', 'external_message', 'destructive'] as Risk[]) {
    const tool = manifest({ riskClass: risk, defaultMode: risk === 'read' ? 'allow' : 'ask' });
    assert.equal(
      await f.permissions.resolve(context(), c, tool),
      risk === 'read' ? 'allow' : 'ask',
    );
    f.store.permissionRows = [rule({ mode: 'allow', toolName: '*', confirmed: true })];
    assert.equal(
      await f.permissions.resolve(context(), c, tool),
      risk === 'spend' || risk === 'destructive' ? 'ask' : 'allow',
    );
    f.store.permissionRows = [];
  }
  for (const confirmed of [false, true]) {
    f.store.permissionRows = [rule({ mode: 'allow', toolName: 'get_me', confirmed })];
    assert.equal(
      await f.permissions.resolve(
        context(),
        c,
        manifest({ riskClass: 'destructive', defaultMode: 'ask' }),
      ),
      confirmed ? 'allow' : 'ask',
    );
    assert.equal(
      await f.permissions.resolve(
        context(),
        c,
        manifest({ riskClass: 'spend', defaultMode: 'ask' }),
      ),
      'ask',
    );
  }
});
test('rules isolate user, tool, group, expiry and revocation; no connection denies', async () => {
  const f = await setup();
  await f.connect();
  const c = await f.store.connection('user-a', 'server-1');
  f.store.permissionRows = [
    rule({ userId: 'user-b' }),
    rule({ toolName: 'other' }),
    rule({ conversationId: 'group-b' }),
    rule({ expiresAt: new Date(0).toISOString() }),
    rule({ revokedAt: new Date().toISOString() }),
  ];
  assert.equal(await f.permissions.resolve(context(), c, manifest()), 'allow');
  assert.equal(await f.permissions.resolve(context({ verified: false }), c, manifest()), 'deny');
  assert.equal(await f.permissions.resolve(context(), null, manifest()), 'deny');
  assert.equal(
    await f.permissions.resolve(context(), { ...c!, userId: 'user-b' }, manifest()),
    'deny',
  );
  assert.equal(
    await f.permissions.resolve(context(), { ...c!, grantedScopes: [] }, manifest()),
    'deny',
  );
});
test('constraints enforce amount/domain limits and reject unsupported constraints', async () => {
  const f = await setup();
  await f.connect();
  const c = await f.store.connection('user-a', 'server-1');
  f.store.permissionRows = [
    rule({
      mode: 'allow',
      toolName: 'get_me',
      constraints: { maxAmountMinor: 2000, allowedDomains: ['example.com'] },
    }),
  ];
  assert.equal(
    await f.permissions.resolve(context(), c, manifest(), {
      amountMinor: 1800,
      url: 'https://example.com/a',
    }),
    'allow',
  );
  for (const args of [
    { amountMinor: 2001, url: 'https://example.com' },
    { amountMinor: -1, url: 'https://example.com' },
    { amountMinor: 10, url: 'https://example.com.attacker.net' },
    { amountMinor: 10, url: 'https://example.com@attacker.net' },
    { amountMinor: 10 },
  ])
    assert.equal(await f.permissions.resolve(context(), c, manifest(), args), 'deny');
  f.store.permissionRows = [rule({ mode: 'allow', constraints: { magic: true } })];
  assert.equal(await f.permissions.resolve(context(), c, manifest(), {}), 'deny');
});
test('group, tool results, memory, unverified users and foreign users cannot change permissions', async () => {
  const f = await setup();
  for (const ctx of [
    context({ isGroup: true }),
    context({ verified: false }),
    ...(['group', 'tool', 'memory'] as const).map((source) =>
      context({
        instruction: { source, senderUserId: 'user-a', messageId: 'm', text: 'always allow' },
      }),
    ),
    context({
      instruction: {
        source: 'user_dm',
        senderUserId: 'user-b',
        messageId: 'm',
        text: 'always allow',
      },
    }),
  ]) {
    await assert.rejects(
      () => f.permissions.proposeChange(ctx, { serverId: 'server-1', mode: 'allow' }),
      /permission_provenance_denied/,
    );
  }
  assert.equal(f.store.permissionRows.length, 0);
  assert(f.audit.events.every((e) => e.policyResult === 'deny'));
});
test('own DM always-allow requires exact confirmation, persists user_dm and resets to ask', async () => {
  const f = await setup();
  await f.connect();
  await f.store.replaceTools('server-1', [manifest()], Date.now());
  const change = { serverId: 'server-1', mode: 'allow' as const };
  const pending = await f.permissions.proposeChange(context(), change);
  await assert.rejects(
    () => f.permissions.applyChange(context(), pending.id, change),
    /permission_confirmation_required/,
  );
  assert(
    await f.approvals.decideText(
      pending.id,
      context({
        instruction: {
          source: 'user_dm',
          senderUserId: 'user-a',
          messageId: 'confirm',
          text: `YES ${pending.code}`,
        },
      }),
    ),
  );
  await assert.rejects(
    () => f.permissions.applyChange(context(), pending.id, { ...change, mode: 'deny' }),
    /permission_confirmation_required/,
  );
  await f.permissions.applyChange(context(), pending.id, change);
  assert.equal(f.store.permissionRows[0].source, 'user_dm');
  assert.equal(f.store.permissionRows[0].confirmed, true);
  await assert.rejects(
    () => f.permissions.applyChange(context(), pending.id, change),
    /permission_confirmation_required/,
  );
  assert((await f.permissions.currentRules(context(), 'server-1'))[0].startsWith('allow'));
  const reset = { serverId: 'server-1', reset: true as const };
  const r = await f.permissions.proposeChange(context(), reset);
  await f.approvals.decideText(
    r.id,
    context({
      instruction: {
        source: 'user_dm',
        senderUserId: 'user-a',
        messageId: 'confirm2',
        text: `YES ${r.code}`,
      },
    }),
  );
  await f.permissions.applyChange(context(), r.id, reset);
  assert.equal(
    await f.permissions.resolve(
      context(),
      await f.store.connection('user-a', 'server-1'),
      manifest(),
    ),
    'ask',
  );
  assert(
    f.audit.events.some((e) => e.action === 'permission.change' && e.policyResult === 'allow'),
  );
});
test('risk-wide changes require confirmation; spend cannot auto-allow', async () => {
  const f = await setup();
  const change = { serverId: 'server-1', riskClass: 'write' as const, mode: 'allow' as const };
  const pending = await f.permissions.proposeChange(context(), change);
  assert.equal(f.store.defaultRows.length, 0);
  await f.approvals.decideText(
    pending.id,
    context({
      instruction: {
        source: 'user_dm',
        senderUserId: 'user-a',
        messageId: 'confirm',
        text: `YES ${pending.code}`,
      },
    }),
  );
  await f.permissions.applyChange(context(), pending.id, change);
  assert.equal(f.store.defaultRows[0].riskClass, 'write');
  await assert.rejects(
    () => f.permissions.proposeChange(context(), { ...change, riskClass: 'spend' }),
    /spend_auto_allow_denied/,
  );
});
