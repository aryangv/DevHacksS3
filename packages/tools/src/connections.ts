import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AuditLog,
  CallContext,
  Connection,
  CredentialKind,
  OAuthConfig,
  Server,
  ToolStore,
  VaultClient,
  WebSession,
} from './ports.ts';
import { EnvelopeCipher } from './vault.ts';
import { hash, httpsUrl, requireThat, SecurityError } from './security.ts';
import type { ComposioProvider, ComposioSdk } from './providers.ts';

export type Tokens = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  // Omitted on refresh means the existing grant is unchanged; [] explicitly clears it.
  scopes?: string[];
};
export interface OAuthClient {
  exchange(
    config: OAuthConfig,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<Tokens>;
  refresh(config: OAuthConfig, refreshToken: string): Promise<Tokens>;
  revoke(config: OAuthConfig, token: string): Promise<void>;
}
export class HttpOAuthClient implements OAuthClient {
  private secret: (ref: string) => string;
  private fetcher: typeof fetch;
  constructor(secret: (ref: string) => string, fetcher: typeof fetch = fetch) {
    this.secret = secret;
    this.fetcher = fetcher;
  }
  private async token(config: OAuthConfig, params: Record<string, string>): Promise<Tokens> {
    const body = new URLSearchParams({ ...params, client_id: config.clientId });
    if (config.clientSecretRef) body.set('client_secret', this.secret(config.clientSecretRef));
    try {
      const response = await this.fetcher(httpsUrl(config.tokenUrl), {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      requireThat(response.ok, 'oauth_exchange_failed');
      const text = await response.text();
      requireThat(Buffer.byteLength(text) <= 65536, 'oauth_response_invalid');
      const data = JSON.parse(text) as Record<string, unknown>;
      requireThat(
        !data.error &&
          typeof data.access_token === 'string' &&
          data.access_token &&
          (!data.token_type || String(data.token_type).toLowerCase() === 'bearer'),
        'oauth_response_invalid',
      );
      requireThat(
        data.expires_in === undefined ||
          (Number.isFinite(Number(data.expires_in)) && Number(data.expires_in) > 0),
        'oauth_expiry_invalid',
      );
      requireThat(
        data.scope === undefined || typeof data.scope === 'string',
        'oauth_scopes_invalid',
      );
      const scopes =
        typeof data.scope === 'string' ? data.scope.split(/[ ,]+/).filter(Boolean) : undefined;
      return {
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
        expiresIn: data.expires_in === undefined ? undefined : Number(data.expires_in),
        scopes,
      };
    } catch {
      throw new SecurityError('oauth_exchange_failed');
    }
  }
  exchange(
    config: OAuthConfig,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<Tokens> {
    return this.token(config, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
  }
  refresh(config: OAuthConfig, refreshToken: string): Promise<Tokens> {
    return this.token(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
  }
  async revoke(config: OAuthConfig, token: string): Promise<void> {
    if (!config.revokeUrl) return;
    if (config.revokeStyle === 'github_grant') {
      requireThat(config.clientSecretRef, 'oauth_revoke_config_missing');
      const url = httpsUrl(config.revokeUrl);
      requireThat(
        url.hostname === 'api.github.com' &&
          url.pathname === `/applications/${config.clientId}/grant`,
        'oauth_revoke_config_invalid',
      );
      const response = await this.fetcher(url, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${this.secret(config.clientSecretRef)}`).toString('base64')}`,
        },
        body: JSON.stringify({ access_token: token }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      requireThat(response.ok, 'oauth_revoke_failed');
      return;
    }
    const body = new URLSearchParams({ token, client_id: config.clientId });
    if (config.clientSecretRef) body.set('client_secret', this.secret(config.clientSecretRef));
    const response = await this.fetcher(httpsUrl(config.revokeUrl), {
      method: 'POST',
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    requireThat(response.ok, 'oauth_revoke_failed');
  }
}

export class ConnectionService {
  private store: ToolStore;
  private vault: VaultClient;
  private cipher: EnvelopeCipher;
  private audit: AuditLog;
  private oauth: OAuthClient;
  private base: URL;
  private now: () => number;
  private composio?: { sdk: ComposioSdk; provider: ComposioProvider };
  private verifyApiKey?: (server: Server, key: string) => Promise<{ scopes: string[] }>;
  constructor(deps: {
    store: ToolStore;
    vault: VaultClient;
    cipher: EnvelopeCipher;
    audit: AuditLog;
    oauth: OAuthClient;
    redirectBase: string;
    now?: () => number;
    composio?: { sdk: ComposioSdk; provider: ComposioProvider };
    verifyApiKey?: ConnectionService['verifyApiKey'];
  }) {
    this.store = deps.store;
    this.vault = deps.vault;
    this.cipher = deps.cipher;
    this.audit = deps.audit;
    this.oauth = deps.oauth;
    this.base = httpsUrl(deps.redirectBase);
    requireThat(this.base.pathname === '/' && !this.base.search, 'invalid_redirect_base');
    this.now = deps.now ?? Date.now;
    this.composio = deps.composio;
    this.verifyApiKey = deps.verifyApiKey;
  }
  private session(s: WebSession): void {
    requireThat(s.authenticated && s.userId && s.sessionId, 'authentication_required');
  }
  private redirect(server: Server): string {
    requireThat(server.callbackPath === `/oauth/callback/${server.slug}`, 'invalid_callback_path');
    return new URL(server.callbackPath, this.base).href;
  }
  private async event(
    userId: string,
    action: string,
    serverId: string,
    result = 'allow',
  ): Promise<void> {
    await this.audit.record({
      actorUserId: userId,
      action,
      resource: serverId,
      policyResult: result,
    });
  }
  async list(session: WebSession): Promise<
    Array<{
      serverId: string;
      slug: string;
      displayName: string;
      status: string;
      grantedScopes: string[];
    }>
  > {
    this.session(session);
    const result = [];
    for (const server of await this.store.servers()) {
      const c = await this.store.connection(session.userId, server.id);
      result.push({
        serverId: server.id,
        slug: server.slug,
        displayName: server.displayName,
        status: c?.status ?? 'disconnected',
        grantedScopes: c?.grantedScopes ?? [],
      });
    }
    return result;
  }
  async initiate(
    session: WebSession,
    serverId: string,
  ): Promise<{ authorizationUrl: string; expiresAt: string }> {
    this.session(session);
    const server = await this.store.server(serverId);
    requireThat(server?.status === 'active', 'server_unavailable');
    requireThat(
      server.authType === 'oauth2' || server.authType === 'composio_managed',
      'oauth_not_supported',
    );
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url'),
      expiresAt = this.now() + 600000;
    const redirectUri = this.redirect(server),
      payload: { verifier: string; sessionHash: string; accountId?: string } = {
        verifier,
        sessionHash: hash(session.sessionId),
      };
    let authorizationUrl: string;
    if (server.authType === 'composio_managed') {
      requireThat(this.composio, 'composio_unavailable');
      const config = this.composio.provider.config(server.id);
      const callback = new URL(redirectUri);
      callback.searchParams.set('state', state);
      let result;
      try {
        result = await this.composio.sdk.connectedAccounts.link(
          session.userId,
          config.authConfigId,
          { callbackUrl: callback.href, experimental: { accountType: 'PRIVATE' } },
          { signal: AbortSignal.timeout(15000) },
        );
      } catch {
        await this.event(session.userId, 'oauth.failure', server.id, 'deny');
        throw new SecurityError('composio_link_failed');
      }
      requireThat(result.redirectUrl && result.id, 'composio_link_failed');
      payload.accountId = result.id;
      authorizationUrl = httpsUrl(result.redirectUrl).href;
    } else {
      const config = server.oauthConfig;
      requireThat(config, 'oauth_config_missing');
      const url = httpsUrl(config.authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', config.scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('base64url'),
      );
      url.searchParams.set('code_challenge_method', 'S256');
      authorizationUrl = url.href;
    }
    const sealed = this.cipher.encrypt(
      JSON.stringify(payload),
      `oauth:${session.userId}:${server.id}`,
    );
    await this.store.withConnectionLock(session.userId, server.id, async (store) => {
      const c = await store.connection(session.userId, server.id);
      await store.saveConnection({
        id: c?.id ?? randomUUID(),
        userId: session.userId,
        serverId: server.id,
        status: 'pending',
        grantedScopes: [],
      });
      await store.oauthPut({
        hash: hash(state),
        userId: session.userId,
        serverId: server.id,
        ...sealed,
        expiresAt,
      });
    });
    await this.event(session.userId, 'connection.initiate', server.id);
    return { authorizationUrl, expiresAt: new Date(expiresAt).toISOString() };
  }
  async callback(
    session: WebSession,
    slug: string,
    query: {
      state: string;
      code?: string;
      error?: string;
      connected_account_id?: string;
      status?: string;
    },
  ): Promise<{ status: 'connected' }> {
    this.session(session);
    const server = await this.store.server(slug);
    requireThat(server && server.slug === slug && server.status === 'active', 'server_unavailable');
    try {
      requireThat(
        typeof query.state === 'string' && /^[\w-]{43}$/.test(query.state),
        'oauth_state_invalid',
      );
      const state = await this.store.oauthTake(
        hash(query.state),
        session.userId,
        server.id,
        this.now(),
      );
      requireThat(state, 'oauth_state_invalid');
      const payload = JSON.parse(
        this.cipher.decrypt(
          state.ciphertext,
          state.keyVersion,
          `oauth:${session.userId}:${server.id}`,
        ),
      ) as { verifier: string; sessionHash: string; accountId?: string };
      requireThat(payload.sessionHash === hash(session.sessionId), 'oauth_session_mismatch');
      requireThat(!query.error, 'oauth_provider_denied');
      await this.store.withConnectionLock(session.userId, server.id, async (store) => {
        const c = await store.connection(session.userId, server.id);
        requireThat(c?.status === 'pending', 'connection_not_pending');
        let scopes: string[];
        if (server.authType === 'composio_managed') {
          requireThat(
            this.composio &&
              query.status === 'success' &&
              query.connected_account_id === payload.accountId,
            'composio_callback_invalid',
          );
          await this.composio.provider.verifyAccount(server.id, session.userId, payload.accountId!);
          const account = await this.composio.sdk.connectedAccounts.get(payload.accountId!, {
            signal: AbortSignal.timeout(15000),
          });
          // Never assume requested scopes were granted. Absent metadata means no access.
          const val = (
            account.state as unknown as { val?: { scope?: unknown; scopes?: unknown } } | undefined
          )?.val;
          const scope = val?.scope ?? val?.scopes;
          scopes =
            typeof scope === 'string'
              ? scope.split(/[ ,]+/).filter(Boolean)
              : Array.isArray(scope)
                ? scope.filter((x): x is string => typeof x === 'string')
                : [];
          await this.vault.delete(session.userId, c.id);
          await this.vault.put(session.userId, c.id, 'api_key', payload.accountId!);
        } else {
          requireThat(
            server.authType === 'oauth2' &&
              server.oauthConfig &&
              typeof query.code === 'string' &&
              query.code.length > 0 &&
              query.code.length < 4096,
            'oauth_code_invalid',
          );
          const tokens = await this.oauth.exchange(
            server.oauthConfig,
            query.code,
            payload.verifier,
            this.redirect(server),
          );
          // A new authorization replaces the old account's entire credential set.
          // Never retain an earlier refresh token if this grant does not issue one.
          await this.vault.delete(session.userId, c.id);
          await this.saveTokens(c, tokens);
          scopes = tokens.scopes ?? [];
        }
        await store.saveConnection({ ...c, status: 'connected', grantedScopes: scopes });
      });
      await this.event(session.userId, 'connection.connected', server.id);
      return { status: 'connected' };
    } catch {
      await this.event(session.userId, 'oauth.failure', server.id, 'deny');
      throw new SecurityError('oauth_callback_failed');
    }
  }
  private async saveTokens(c: Connection, tokens: Tokens): Promise<void> {
    requireThat(
      tokens.accessToken &&
        (tokens.scopes === undefined || tokens.scopes.every((s) => typeof s === 'string')),
      'oauth_tokens_invalid',
    );
    await this.vault.put(
      c.userId,
      c.id,
      'access_token',
      tokens.accessToken,
      tokens.expiresIn ? new Date(this.now() + tokens.expiresIn * 1000).toISOString() : undefined,
    );
    if (tokens.refreshToken)
      await this.vault.put(c.userId, c.id, 'refresh_token', tokens.refreshToken);
  }
  async connectApiKey(session: WebSession, serverId: string, key: string): Promise<void> {
    this.session(session);
    const server = await this.store.server(serverId);
    requireThat(
      server?.status === 'active' && server.authType === 'api_key',
      'api_key_connection_denied',
    );
    requireThat(this.verifyApiKey, 'api_key_scope_verifier_required');
    // The verifier is operator-installed, never supplied by a browser/model.
    let scopes: string[];
    try {
      scopes = (await this.verifyApiKey(server, key)).scopes;
      requireThat(
        scopes.every((s) => typeof s === 'string'),
        'api_key_scopes_invalid',
      );
    } catch {
      await this.event(session.userId, 'connection.api_key_failed', server.id, 'deny');
      throw new SecurityError('api_key_verification_failed');
    }
    // Commit pending row before the separate restricted-role vault connection uses its FK.
    const id = await this.store.withConnectionLock(session.userId, server.id, async (store) => {
      const old = await store.connection(session.userId, server.id);
      const id = old?.id ?? randomUUID();
      await store.saveConnection({
        id,
        userId: session.userId,
        serverId: server.id,
        status: 'pending',
        grantedScopes: [],
      });
      return id;
    });
    await this.store.withConnectionLock(session.userId, server.id, async (store) => {
      const c = await store.connection(session.userId, server.id);
      requireThat(c?.status === 'pending' && c.id === id, 'connection_not_pending');
      await this.vault.delete(session.userId, c.id);
      await this.vault.put(session.userId, c.id, 'api_key', key);
      await store.saveConnection({ ...c, status: 'connected', grantedScopes: scopes });
    });
    await this.event(session.userId, 'connection.connected', server.id);
  }
  async credentials(
    userId: string,
    server: Server,
    signal: AbortSignal,
  ): Promise<{ connection: Connection; ctx: CallContext }> {
    return this.store.withConnectionLock(userId, server.id, async (store) => {
      let c = await store.connection(userId, server.id);
      requireThat(c?.status === 'connected', 'connection_unavailable');
      const credentials: Partial<Record<CredentialKind, string>> = {};
      if (server.authType === 'oauth2') {
        let token = await this.vault.get(userId, c.id, 'access_token');
        if (!token || (token.expiresAt && Date.parse(token.expiresAt) <= this.now() + 60000)) {
          try {
            const refresh = await this.vault.get(userId, c.id, 'refresh_token');
            requireThat(refresh && server.oauthConfig, 'oauth_refresh_unavailable');
            const updated = await this.oauth.refresh(server.oauthConfig, refresh.secret);
            await this.saveTokens(c, updated);
            // If refresh omits scope, OAuth keeps the original grant; explicit [] stays restrictive.
            c = { ...c, grantedScopes: updated.scopes ?? c.grantedScopes };
            await store.saveConnection(c);
            token = await this.vault.get(userId, c.id, 'access_token');
            requireThat(token, 'oauth_refresh_failed');
            await this.event(userId, 'connection.refresh', server.id);
          } catch {
            await store.saveConnection({ ...c, status: 'needs_reauth' });
            await this.event(userId, 'connection.needs_reauth', server.id, 'deny');
            throw new SecurityError('connection_needs_reauth');
          }
        }
        requireThat(token, 'credential_missing');
        credentials.access_token = token.secret;
      } else if (server.authType === 'api_key' || server.authType === 'composio_managed') {
        const token = await this.vault.get(userId, c.id, 'api_key');
        requireThat(
          token && (!token.expiresAt || Date.parse(token.expiresAt) > this.now()),
          'credential_missing',
        );
        credentials.api_key = token.secret;
        if (server.authType === 'composio_managed') {
          requireThat(this.composio, 'composio_unavailable');
          try {
            await this.composio.provider.verifyAccount(server.id, userId, token.secret, signal);
          } catch {
            await store.saveConnection({ ...c, status: 'needs_reauth' });
            await this.event(userId, 'connection.needs_reauth', server.id, 'deny');
            throw new SecurityError('connection_needs_reauth');
          }
        }
      }
      return {
        connection: c,
        ctx: { userId, connectionId: c.id, credentials, signal, idempotencyKey: '' },
      };
    });
  }
  async revoke(
    session: WebSession,
    serverId: string,
  ): Promise<{ status: 'revoked'; upstreamRevoked: boolean }> {
    this.session(session);
    const server = await this.store.server(serverId);
    requireThat(server, 'server_unavailable');
    let upstreamRevoked = false;
    await this.store.withConnectionLock(session.userId, server.id, async (store) => {
      const c = await store.connection(session.userId, server.id);
      requireThat(c, 'connection_unavailable');
      // Disable first; never leave tool access active on upstream failure.
      await store.saveConnection({ ...c, status: 'revoked', grantedScopes: [] });
      try {
        if (server.authType === 'composio_managed') {
          requireThat(this.composio, 'composio_unavailable');
          const account = await this.vault.get(session.userId, c.id, 'api_key');
          if (account) {
            await this.composio.sdk.connectedAccounts.revoke(account.secret, {
              signal: AbortSignal.timeout(15000),
            });
            upstreamRevoked = true;
          }
        } else if (server.oauthConfig?.revokeUrl) {
          const access = await this.vault.get(session.userId, c.id, 'access_token');
          if (access) {
            await this.oauth.revoke(server.oauthConfig, access.secret);
            upstreamRevoked = true;
          }
        }
      } catch {
        await this.event(session.userId, 'connection.upstream_revoke_failed', server.id, 'deny');
      } finally {
        await this.vault.delete(session.userId, c.id);
      }
    });
    await this.event(session.userId, 'connection.revoked', server.id);
    return { status: 'revoked', upstreamRevoked };
  }
}
