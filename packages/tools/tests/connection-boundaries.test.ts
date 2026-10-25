import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionService, HttpOAuthClient } from '../src/connections.ts';
import { plannedIntegrations } from '../src/integrations.ts';
import { connectionHandlers } from '../src/http-handlers.ts';
import { setup } from './setup.ts';

const session = { userId: 'user-a', sessionId: 's', authenticated: true };

test('API key connections need a trusted verifier and verified scopes, not browser claims', async () => {
  const f = await setup();
  f.store.serverRows[0].authType = 'api_key';
  await assert.rejects(
    () => f.connections.connectApiKey(session, 'github', 'dummy-secret'),
    /api_key_scope_verifier_required/,
  );
  const service = new ConnectionService({
    store: f.store,
    vault: f.vault,
    cipher: f.cipher,
    audit: f.audit,
    oauth: f.oauth,
    redirectBase: 'https://campus.example',
    verifyApiKey: async (_server, key) => {
      assert.equal(key, 'dummy-secret');
      return { scopes: ['read:user'] };
    },
  });
  await service.connectApiKey(session, 'github', 'dummy-secret');
  const c = await f.store.connection('user-a', 'server-1');
  assert.equal(c?.status, 'connected');
  assert.deepEqual(c?.grantedScopes, ['read:user']);
  assert.equal((await f.vault.get('user-a', c!.id, 'api_key'))?.secret, 'dummy-secret');
});

test('GitHub grant revocation follows the documented endpoint and does not send secrets to redirects', async () => {
  const config = plannedIntegrations({
    githubId: 'g',
    calendarId: 'c',
    githubClientId: 'client',
    calendarAuthConfigId: 'ac',
    calendarVersion: '20261001_00',
  }).servers[0].oauthConfig!;
  let calls = 0;
  const oauth = new HttpOAuthClient(
    () => 'dummy-client-secret',
    async (url, options) => {
      calls++;
      assert.equal(String(url), 'https://api.github.com/applications/client/grant');
      assert.equal(options?.method, 'DELETE');
      assert.equal(options?.redirect, 'error');
      assert.deepEqual(JSON.parse(options?.body as string), { access_token: 'dummy-access-token' });
      return new Response(null, { status: 204 });
    },
  );
  await oauth.revoke(config, 'dummy-access-token');
  assert.equal(calls, 1);
});

test('OAuth callback handlers reject malformed input and hide thrown secret values', async () => {
  const f = await setup(),
    handlers = connectionHandlers(f.connections);
  assert.equal((await handlers.callback(session, 'github', { state: [] })).statusCode, 400);
  assert.equal(
    (await handlers.callback(session, 'github', { state: 'forged', code: 'dummy-secret' }))
      .statusCode,
    400,
  );
  f.connections.initiate = async () => {
    throw new Error('dummy-provider-secret');
  };
  const started = await handlers.start(session, 'github');
  assert.equal(started.statusCode, 400);
  assert(!JSON.stringify(started).includes('dummy-provider-secret'));
});

test('parallel OAuth callbacks consume state before exactly one token exchange', async () => {
  const f = await setup(),
    start = await f.connections.initiate(session, 'github'),
    state = new URL(start.authorizationUrl).searchParams.get('state')!;
  const results = await Promise.allSettled([
    f.connections.callback(session, 'github', { state, code: 'c' }),
    f.connections.callback(session, 'github', { state, code: 'c' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.oauth.exchanges.length, 1);
});
