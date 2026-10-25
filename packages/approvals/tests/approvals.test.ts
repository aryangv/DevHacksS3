import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ApprovalService } from '../src/service.ts';
import { MemoryApprovalStore } from './fakes.ts';
const make = (now = Date.now) => {
  const store = new MemoryApprovalStore(),
    events: unknown[] = [];
  return {
    store,
    events,
    service: new ApprovalService(
      store,
      {
        record: async (e) => {
          events.push(e);
        },
      },
      randomBytes(32),
      { now },
    ),
  };
};
const request = {
  userId: 'u',
  conversationId: 'dm',
  kind: 'tool_ask' as const,
  proposal: { server: 'github', tool: 'write', args: { title: 'example' } },
  channel: 'text' as const,
};
const ctx = (text: string) => ({
  userId: 'u',
  verified: true,
  conversationId: 'dm',
  isGroup: false,
  instruction: { source: 'user_dm', senderUserId: 'u', messageId: 'm', text },
});
test('text approval exact binding, owner/conversation checks and one-time concurrent consumption', async () => {
  const f = make(),
    a = await f.service.create(request);
  assert(!JSON.stringify([...f.store.rows.values()]).includes(a.code!));
  assert.equal(
    await f.service.decideText(a.id, {
      ...ctx(`YES ${a.code}`),
      userId: 'other',
    }),
    false,
  );
  assert.equal(
    await f.service.decideText(a.id, {
      ...ctx(`YES ${a.code}`),
      conversationId: 'other',
    }),
    false,
  );
  assert.equal(
    await f.service.decideText(a.id, {
      ...ctx(`YES ${a.code}`),
      isGroup: true,
    }),
    false,
  );
  assert.equal(await f.service.decideText(a.id, ctx(`YES ${a.code}`)), true);
  assert.equal(await f.service.decideText(a.id, ctx(`YES ${a.code}`)), false);
  assert.equal(
    await f.service.consume(a.id, 'u', 'dm', {
      ...request.proposal,
      args: { title: 'changed' },
    }),
    false,
  );
  const consumed = await Promise.all(
    Array.from({ length: 10 }, () => f.service.consume(a.id, 'u', 'dm', request.proposal)),
  );
  assert.equal(consumed.filter(Boolean).length, 1);
});
test('expired codes and approved-but-expired actions fail; declines cannot execute', async () => {
  let time = 1000000;
  const f = make(() => time);
  const a = await f.service.create(request);
  time += 300001;
  assert.equal(await f.service.decideText(a.id, ctx(`YES ${a.code}`)), false);
  assert.equal(f.store.rows.get(a.id)?.status, 'expired');
  const b = await f.service.create(request);
  assert(await f.service.decideText(b.id, ctx(`YES ${b.code}`)));
  time += 300001;
  assert.equal(await f.service.consume(b.id, 'u', 'dm', request.proposal), false);
  const c = await f.service.create(request);
  assert(await f.service.decideText(c.id, ctx(`NO ${c.code}`)));
  assert.equal(await f.service.consume(c.id, 'u', 'dm', request.proposal), false);
});
test('codes rate limited; no tool output or memory grants; secrets absent from pending views/audit', async () => {
  const f = make();
  const a = await f.service.create({
    ...request,
    proposal: {
      ...request.proposal,
      args: { access_token: 'dummy-secret', title: 'safe' },
    },
  });
  for (let i = 0; i < 5; i++)
    assert.equal(await f.service.decideText(a.id, ctx('YES 000000')), false);
  assert.equal(await f.service.decideText(a.id, ctx(`YES ${a.code}`)), false);
  for (const source of ['tool', 'memory', 'group'])
    assert.equal(
      await f.service.decideText(a.id, {
        ...ctx(`YES ${a.code}`),
        instruction: { ...ctx('').instruction, source },
      }),
      false,
    );
  const visible = await f.service.pending({
    userId: 'u',
    sessionId: 's',
    authenticated: true,
  });
  assert(!JSON.stringify({ visible, events: f.events }).includes('dummy-secret'));
  assert(!JSON.stringify(f.events).includes(a.code!));
});
test('sensitive/spend text approval forbidden; web requires authenticated owner, token and exact quote', async () => {
  const f = make();
  await assert.rejects(
    () => f.service.create({ ...request, kind: 'spend_handoff' }),
    /web_approval_required/,
  );
  await assert.rejects(
    () => f.service.create({ ...request, sensitive: true }),
    /web_approval_required/,
  );
  const a = await f.service.create({
    ...request,
    kind: 'spend_handoff',
    channel: 'web',
    proposal: {
      quoteId: 'q',
      merchant: 'm',
      totalMinor: 1000,
      currency: 'USD',
      payer: 'u',
      items: [{ sku: 's', quantity: 1 }],
    },
  });
  const quote = {
      quoteId: 'q',
      merchant: 'm',
      totalMinor: 1000,
      currency: 'USD',
      payer: 'u',
      items: [{ sku: 's', quantity: 1 }],
    },
    session = { userId: 'u', sessionId: 's', authenticated: true };
  assert.equal(await f.service.decideText(a.id, ctx(`YES ${a.token}`)), false);
  assert.equal(
    await f.service.decideWeb(a.id, { ...session, authenticated: false }, a.token!, true, quote),
    false,
  );
  assert.equal(
    await f.service.decideWeb(a.id, { ...session, userId: 'other' }, a.token!, true, quote),
    false,
  );
  assert.equal(
    await f.service.decideWeb(a.id, session, a.token!, true, {
      ...quote,
      totalMinor: 2000,
    }),
    false,
  );
  assert.equal(await f.service.decideWeb(a.id, session, a.token!, true, quote), true);
  assert.equal(await f.service.decideWeb(a.id, session, a.token!, true, quote), false);
});
