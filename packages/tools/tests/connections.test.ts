import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup } from './setup.ts';
import { server } from './fakes.ts';
import { HttpOAuthClient } from '../src/connections.ts';
import { hash } from '../src/security.ts';
const session = { userId: 'user-a', sessionId: 'session-a', authenticated: true };
test('OAuth generates random state, S256 PKCE, encrypted verifier and session-bound callback; replay fails', async () => {
  const f = await setup();
  const start = await f.connections.initiate(session, 'github'),
    url = new URL(start.authorizationUrl),
    state = url.searchParams.get('state')!;
  const row = f.store.states.get(hash(state))!;
  assert(row);
  assert(!row.ciphertext.includes(state));
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://campus.example/oauth/callback/github',
  );
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    (await f.connections.callback(session, 'github', { state, code: 'dummy-code' })).status,
    'connected',
  );
  const request = f.oauth.exchanges[0];
  assert.equal(
    createHash('sha256').update(request.verifier).digest('base64url'),
    url.searchParams.get('code_challenge'),
  );
  assert.equal((await f.store.connection('user-a', 'server-1'))?.status, 'connected');
  assert.equal(
    await f.vault.get('user-a', 'connection-user-a', 'access_token').catch(() => null),
    null,
  );
  await assert.rejects(
    () => f.connections.callback(session, 'github', { state, code: 'dummy-code' }),
    /oauth_callback_failed/,
  );
  assert.equal(f.oauth.exchanges.length, 1);
  assert(!JSON.stringify(f.audit.events).includes('dummy-code'));
  assert(!JSON.stringify(f.audit.events).includes('dummy-access-secret'));
});
test('invalid, expired, wrong owner/session/server, provider-error callbacks rejected', async () => {
  let time = Date.now();
  const f = await setup({ now: () => time });
  await assert.rejects(() =>
    f.connections.callback(session, 'github', { state: 'forged', code: 'c' }),
  );
  for (const invalid of ['expired', 'owner', 'session', 'server', 'provider']) {
    const a = await f.connections.initiate(session, 'server-1'),
      state = new URL(a.authorizationUrl).searchParams.get('state')!;
    if (invalid === 'expired') time += 600001;
    if (invalid === 'server')
      f.store.serverRows.push({
        ...server,
        id: 'server-2',
        slug: 'other',
        callbackPath: '/oauth/callback/other',
      });
    await assert.rejects(() =>
      f.connections.callback(
        invalid === 'owner'
          ? { ...session, userId: 'user-b' }
          : invalid === 'session'
            ? { ...session, sessionId: 'session-other' }
            : session,
        invalid === 'server' ? 'other' : 'github',
        { state, code: 'c', ...(invalid === 'provider' ? { error: 'access_denied' } : {}) },
      ),
    );
  }
  assert.equal(f.oauth.exchanges.length, 0);
});
test('refresh proactively rotates tokens/scopes; failed refresh hides tools; concurrent refresh executes once', async () => {
  const f = await setup();
  await f.connect();
  await f.vault.put('user-a', 'connection-user-a', 'refresh_token', 'dummy-refresh');
  await f.vault.put(
    'user-a',
    'connection-user-a',
    'access_token',
    'expired',
    new Date(0).toISOString(),
  );
  await Promise.all([
    f.connections.credentials('user-a', server, AbortSignal.timeout(1000)),
    f.connections.credentials('user-a', server, AbortSignal.timeout(1000)),
  ]);
  assert.equal(f.oauth.refreshes, 1);
  assert.equal(
    (await f.vault.get('user-a', 'connection-user-a', 'refresh_token'))?.secret,
    'dummy-refresh-secret',
  );
  f.oauth.fail = true;
  await f.vault.put(
    'user-a',
    'connection-user-a',
    'access_token',
    'expired',
    new Date(0).toISOString(),
  );
  await assert.rejects(
    () => f.connections.credentials('user-a', server, AbortSignal.timeout(1000)),
    /connection_needs_reauth/,
  );
  assert.equal((await f.store.connection('user-a', 'server-1'))?.status, 'needs_reauth');
});
test('revocation deletes secrets and disables access even if upstream revoke fails', async () => {
  const f = await setup();
  await f.connect();
  f.oauth.fail = true;
  const result = await f.connections.revoke(session, 'github');
  assert.equal(result.upstreamRevoked, false);
  assert.equal(result.status, 'revoked');
  assert.equal(f.vault.values.size, 0);
  await assert.rejects(
    () => f.connections.credentials('user-a', server, AbortSignal.timeout(1000)),
    /connection_unavailable/,
  );
});
test('HTTP OAuth code exchange uses PKCE and env secret, rejects provider errors without leaking response', async () => {
  let posted = '';
  const fetcher: typeof fetch = async (_url, init) => {
    posted = String(init?.body);
    assert.equal(init?.redirect, 'error');
    return new Response(
      JSON.stringify({
        access_token: 'dummy-secret',
        refresh_token: 'dummy-refresh',
        token_type: 'bearer',
        scope: 'read:user',
        expires_in: 3600,
      }),
    );
  };
  const client = new HttpOAuthClient(() => 'dummy-client-secret', fetcher);
  const tokens = await client.exchange(
    { ...server.oauthConfig!, clientSecretRef: 'CLIENT_SECRET' },
    'code',
    'verifier',
    'https://campus.example/oauth/callback/github',
  );
  const form = new URLSearchParams(posted);
  assert.equal(form.get('code_verifier'), 'verifier');
  assert.equal(form.get('client_secret'), 'dummy-client-secret');
  assert.equal(tokens.accessToken, 'dummy-secret');
  const bad = new HttpOAuthClient(
    () => '',
    async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'dummy-secret' })),
  );
  await assert.rejects(
    () => bad.exchange(server.oauthConfig!, 'c', 'v', 'https://campus.example'),
    (error) => {
      assert(!String(error).includes('dummy-secret'));
      return true;
    },
  );
});

test('reconnecting replaces old credentials and never assumes omitted initial scopes', async () => {
  const f = await setup();
  await f.connect();
  await f.vault.put('user-a', 'connection-user-a', 'refresh_token', 'dummy-old-account-refresh');
  await f.vault.put('user-a', 'connection-user-a', 'api_key', 'dummy-old-api-key');
  f.oauth.tokens = { accessToken: 'dummy-new-account-access', expiresIn: 3600 };
  const start = await f.connections.initiate(session, 'github');
  const state = new URL(start.authorizationUrl).searchParams.get('state')!;
  await f.connections.callback(session, 'github', { state, code: 'dummy-new-code' });
  assert.equal(
    (await f.vault.get('user-a', 'connection-user-a', 'access_token'))?.secret,
    'dummy-new-account-access',
  );
  assert.equal(await f.vault.get('user-a', 'connection-user-a', 'refresh_token'), null);
  assert.equal(await f.vault.get('user-a', 'connection-user-a', 'api_key'), null);
  assert.deepEqual((await f.store.connection('user-a', 'server-1'))?.grantedScopes, []);
});

test('refresh preserves an omitted scope grant but honors an explicitly empty grant', async () => {
  for (const scopes of [undefined, []] as Array<string[] | undefined>) {
    const f = await setup();
    await f.connect();
    await f.vault.put(
      'user-a',
      'connection-user-a',
      'access_token',
      'dummy-expired',
      new Date(0).toISOString(),
    );
    await f.vault.put('user-a', 'connection-user-a', 'refresh_token', 'dummy-current-refresh');
    f.oauth.tokens = { accessToken: 'dummy-refreshed', expiresIn: 3600, scopes };
    const access = await f.connections.credentials('user-a', server, AbortSignal.timeout(1000));
    assert.deepEqual(access.connection.grantedScopes, scopes ?? ['read:user']);
    assert.equal(
      (await f.vault.get('user-a', 'connection-user-a', 'refresh_token'))?.secret,
      'dummy-current-refresh',
    );
  }
});

test('OAuth transport distinguishes absent scopes from explicit empty or malformed scopes', async () => {
  for (const scope of [undefined, '', 42]) {
    const client = new HttpOAuthClient(
      () => '',
      async () => new Response(JSON.stringify({ access_token: 'dummy-access', scope })),
    );
    if (typeof scope === 'number')
      await assert.rejects(
        () => client.refresh(server.oauthConfig!, 'dummy-refresh'),
        /oauth_exchange_failed/,
      );
    else
      assert.deepEqual(
        (await client.refresh(server.oauthConfig!, 'dummy-refresh')).scopes,
        scope === undefined ? undefined : [],
      );
  }
});
