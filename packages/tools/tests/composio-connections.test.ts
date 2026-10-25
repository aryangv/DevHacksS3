import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionService } from '../src/connections.ts';
import { ComposioProvider } from '../src/providers.ts';
import type { ComposioSdk } from '../src/providers.ts';
import { plannedIntegrations } from '../src/integrations.ts';
import { setup } from './setup.ts';

const session = { userId: 'user-a', sessionId: 's', authenticated: true };
test('Composio hosted OAuth binds the issued account, verifies ownership/scopes, stores only a vault reference and revokes', async () => {
  const f = await setup();
  const configs = plannedIntegrations({
    githubId: 'github',
    calendarId: 'calendar',
    githubClientId: 'client',
    calendarAuthConfigId: 'ac',
    calendarVersion: '20261001_00',
  });
  f.store.serverRows = configs.servers;
  let callbackUrl = '',
    revoked = false;
  const account = {
    id: 'account-a',
    status: 'ACTIVE',
    isDisabled: false,
    state: {
      authScheme: 'OAUTH2',
      val: { scope: 'https://www.googleapis.com/auth/calendar.freebusy' },
    },
  };
  const sdk = {
    connectedAccounts: {
      link: async (
        userId: string,
        authConfigId: string,
        options: { callbackUrl: string; experimental: unknown },
      ) => {
        assert.equal(userId, 'user-a');
        assert.equal(authConfigId, 'ac');
        assert.deepEqual(options.experimental, { accountType: 'PRIVATE' });
        callbackUrl = options.callbackUrl;
        return { id: 'account-a', redirectUrl: 'https://connect.composio.dev/example' };
      },
      list: async () => ({ items: [account] }),
      get: async () => account,
      revoke: async (id: string) => {
        assert.equal(id, 'account-a');
        revoked = true;
      },
    },
  } as unknown as ComposioSdk;
  const provider = new ComposioProvider(sdk, configs.composio),
    service = new ConnectionService({
      store: f.store,
      vault: f.vault,
      cipher: f.cipher,
      audit: f.audit,
      oauth: f.oauth,
      redirectBase: 'https://campus.example',
      composio: { sdk, provider },
    });
  await service.initiate(session, 'calendar');
  const state = new URL(callbackUrl).searchParams.get('state')!;
  await service.callback(session, 'googlecalendar', {
    state,
    status: 'success',
    connected_account_id: 'account-a',
  });
  const c = await f.store.connection('user-a', 'calendar');
  assert.deepEqual(c?.grantedScopes, ['https://www.googleapis.com/auth/calendar.freebusy']);
  assert.equal((await f.vault.get('user-a', c!.id, 'api_key'))?.secret, 'account-a');
  assert.equal(
    (await service.credentials('user-a', configs.servers[1], AbortSignal.timeout(1000))).connection
      .status,
    'connected',
  );
  assert.equal((await service.revoke(session, 'calendar')).upstreamRevoked, true);
  assert(revoked);
  assert.equal(f.vault.values.size, 0);
});
