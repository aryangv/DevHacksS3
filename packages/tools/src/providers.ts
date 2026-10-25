import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Composio } from '@composio/core';
import type { CallContext, ToolManifest, ToolProvider, ToolResult } from './ports.ts';
import { httpsUrl, requireThat, SecurityError } from './security.ts';

/** listTools has no ctx in the spec: gateway injects discovery credentials into an
 * async-local scope, never into a global mutable provider singleton. */
export const discoveryContext = new AsyncLocalStorage<CallContext>();
export type ToolPolicy = Omit<ToolManifest, 'name' | 'inputSchema'>;
export type CustomServerConfig = {
  url: string;
  tools: Record<string, ToolPolicy>;
  headers?: Record<string, string>;
};
export type McpSession = {
  listTools(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{
    tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    nextCursor?: string;
  }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    schema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
};
export type McpConnect = (config: CustomServerConfig, ctx: CallContext) => Promise<McpSession>;
export const connectMcp: McpConnect = async (config, ctx) => {
  const url = httpsUrl(config.url),
    token = ctx.credentials.access_token ?? ctx.credentials.api_key;
  const client = new Client({ name: 'campus-p4-gateway', version: '1.0.0' }, { capabilities: {} });
  const headers = { ...config.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers, redirect: 'error', signal: ctx.signal },
    reconnectionOptions: {
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  try {
    await client.connect(transport, { signal: ctx.signal, timeout: 15000 });
    return client as McpSession;
  } catch {
    await client.close().catch(() => {});
    throw new SecurityError('mcp_connect_failed');
  }
};
export class CustomMcpProvider implements ToolProvider {
  readonly id = 'custom';
  private configs: ReadonlyMap<string, CustomServerConfig>;
  private connect: McpConnect;
  constructor(configs: ReadonlyMap<string, CustomServerConfig>, connect: McpConnect = connectMcp) {
    this.configs = configs;
    this.connect = connect;
  }
  private config(serverId: string): CustomServerConfig {
    const c = this.configs.get(serverId);
    requireThat(c, 'provider_server_unknown');
    return c;
  }
  async listTools(serverId: string): Promise<ToolManifest[]> {
    const ctx = discoveryContext.getStore();
    requireThat(ctx, 'discovery_context_missing');
    let session: McpSession | undefined;
    try {
      const config = this.config(serverId);
      session = await this.connect(config, ctx);
      const result: ToolManifest[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const response = await session.listTools(cursor ? { cursor } : undefined, {
          signal: ctx.signal,
          timeout: 15000,
        });
        for (const tool of response.tools) {
          const policy = Object.hasOwn(config.tools, tool.name)
            ? config.tools[tool.name]
            : undefined;
          if (policy) result.push({ ...policy, name: tool.name, inputSchema: tool.inputSchema });
        }
        cursor = response.nextCursor;
        if (!cursor) return result;
        requireThat(!seen.has(cursor), 'mcp_pagination_invalid');
        seen.add(cursor);
      }
      throw new SecurityError('mcp_catalog_limit');
    } catch {
      throw new SecurityError('mcp_discovery_failed');
    } finally {
      await session?.close().catch(() => {});
    }
  }
  async callTool(
    serverId: string,
    tool: string,
    args: unknown,
    ctx: CallContext,
  ): Promise<ToolResult> {
    const config = this.config(serverId);
    requireThat(Object.hasOwn(config.tools, tool), 'provider_tool_unknown');
    let session: McpSession | undefined;
    try {
      session = await this.connect(config, ctx);
      const raw = (await session.callTool(
        { name: tool, arguments: args as Record<string, unknown> },
        undefined,
        { signal: ctx.signal, timeout: 15000 },
      )) as { content?: unknown; structuredContent?: unknown; isError?: boolean };
      return { content: raw.structuredContent ?? raw.content ?? [], isError: raw.isError === true };
    } catch {
      throw new SecurityError('mcp_call_failed');
    } finally {
      await session?.close().catch(() => {});
    }
  }
}

export type ComposioServerConfig = {
  toolkit: string;
  authConfigId: string;
  version: string;
  tools: Record<string, ToolPolicy>;
};
export type ComposioSdk = Pick<Composio, 'tools' | 'connectedAccounts'>;
export function createComposio(apiKey: string): Composio {
  requireThat(apiKey, 'composio_key_missing');
  // Disable SDK output and automatic local-file upload; only our AuditLog emits events.
  return new Composio({
    apiKey,
    logLevel: 'silent',
    allowTracking: false,
    dangerouslyAllowAutoUploadDownloadFiles: false,
    fileUploadDirs: false,
  });
}
export class ComposioProvider implements ToolProvider {
  readonly id = 'composio';
  private sdk: ComposioSdk;
  private configs: ReadonlyMap<string, ComposioServerConfig>;
  constructor(sdk: ComposioSdk, configs: ReadonlyMap<string, ComposioServerConfig>) {
    this.sdk = sdk;
    this.configs = configs;
  }
  config(serverId: string): ComposioServerConfig {
    const c = this.configs.get(serverId);
    requireThat(c && c.version && c.version !== 'latest', 'composio_config_missing');
    return c;
  }
  async listTools(serverId: string): Promise<ToolManifest[]> {
    const config = this.config(serverId),
      ctx = discoveryContext.getStore();
    requireThat(ctx, 'discovery_context_missing');
    try {
      const result: ToolManifest[] = [];
      for (const [name, policy] of Object.entries(config.tools)) {
        const tool = await this.sdk.tools.getRawComposioToolBySlug(
          name,
          { version: config.version },
          { signal: ctx.signal },
        );
        requireThat(
          tool.inputParameters && tool.toolkit?.slug === config.toolkit,
          'composio_manifest_invalid',
        );
        result.push({
          ...policy,
          name,
          inputSchema: tool.inputParameters as Record<string, unknown>,
        });
      }
      return result;
    } catch {
      throw new SecurityError('composio_discovery_failed');
    }
  }
  async verifyAccount(
    serverId: string,
    userId: string,
    accountId: string,
    signal = AbortSignal.timeout(15000),
  ): Promise<void> {
    const config = this.config(serverId);
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await this.sdk.connectedAccounts.list(
        {
          userIds: [userId],
          authConfigIds: [config.authConfigId],
          toolkitSlugs: [config.toolkit],
          cursor,
        },
        { signal },
      );
      const account = response.items.find((a) => a.id === accountId);
      if (account) {
        requireThat(
          account.status === 'ACTIVE' && !account.isDisabled,
          'composio_connection_inactive',
        );
        return;
      }
      cursor = response.nextCursor ?? undefined;
      if (!cursor) break;
    }
    throw new SecurityError('composio_account_owner_mismatch');
  }
  async callTool(
    serverId: string,
    tool: string,
    args: unknown,
    ctx: CallContext,
  ): Promise<ToolResult> {
    const config = this.config(serverId);
    requireThat(Object.hasOwn(config.tools, tool), 'provider_tool_unknown');
    const accountId = ctx.credentials.api_key;
    requireThat(accountId, 'composio_account_missing');
    try {
      await this.verifyAccount(serverId, ctx.userId, accountId, ctx.signal);
      const result = await this.sdk.tools.execute(
        tool,
        {
          userId: ctx.userId,
          connectedAccountId: accountId,
          arguments: args as Record<string, unknown>,
          version: config.version,
        },
        { signal: ctx.signal },
      );
      return { content: result.data, isError: !result.successful };
    } catch {
      throw new SecurityError('composio_call_failed');
    }
  }
}
