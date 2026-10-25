import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { AuditLog, CallContext, ToolManifest, ToolProvider, ToolStore } from './ports.ts';
import { discoveryContext } from './providers.ts';
import { canonical, hash, requireThat } from './security.ts';

export class ToolCatalog {
  private store: ToolStore;
  private providers: ReadonlyMap<string, ToolProvider>;
  private audit: AuditLog;
  private ttlMs: number;
  private now: () => number;
  private validators = new Map<string, ValidateFunction>();
  private ajv = new Ajv({
    strict: true,
    allErrors: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    validateFormats: false,
  });
  constructor(
    store: ToolStore,
    providers: ReadonlyMap<string, ToolProvider>,
    audit: AuditLog,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.store = store;
    this.providers = providers;
    this.audit = audit;
    this.ttlMs = options.ttlMs ?? 300000;
    this.now = options.now ?? Date.now;
    requireThat(this.ttlMs > 0, 'invalid_catalog_ttl');
  }
  private compile(tool: ToolManifest): ValidateFunction {
    const key = hash(tool.inputSchema);
    let validator = this.validators.get(key);
    if (!validator) {
      requireThat(canonical(tool.inputSchema).length <= 65536, 'manifest_schema_too_large');
      requireThat(tool.inputSchema.type === 'object', 'manifest_schema_invalid');
      // Only local references: compile never fetches remote schemas.
      validator = this.ajv.compile(tool.inputSchema);
      this.validators.set(key, validator);
    }
    return validator;
  }
  async manifests(serverId: string, ctx: CallContext, force = false): Promise<ToolManifest[]> {
    const cache = await this.store.tools(serverId);
    if (!force && cache && cache.refreshedAt + this.ttlMs > this.now()) return cache.manifests;
    const server = await this.store.server(serverId);
    requireThat(server?.status === 'active', 'server_unavailable');
    const provider = this.providers.get(server.provider);
    requireThat(provider, 'provider_unavailable');
    try {
      const manifests = provider.listTools.bind(provider); // run with per-user credentials for authenticated discovery
      const tools = await discoveryContext.run(ctx, () => manifests(serverId));
      requireThat(tools.length <= 500, 'catalog_too_large');
      const names = new Set<string>();
      for (const tool of tools) {
        requireThat(
          /^[A-Za-z0-9_-]{1,128}$/.test(tool.name) &&
            !tool.name.includes('__') &&
            !names.has(tool.name),
          'manifest_name_invalid',
        );
        requireThat(
          ['read', 'write', 'spend', 'external_message', 'destructive'].includes(tool.riskClass) &&
            ['allow', 'ask', 'deny'].includes(tool.defaultMode),
          'manifest_policy_invalid',
        );
        requireThat(
          Array.isArray(tool.requiredScopes) &&
            tool.requiredScopes.every((s) => typeof s === 'string'),
          'manifest_scopes_invalid',
        );
        names.add(tool.name);
        this.compile(tool);
      }
      await this.store.replaceTools(serverId, tools, this.now());
      await this.audit.record({
        actorUserId: ctx.userId,
        action: 'tool.discover',
        resource: serverId,
        policyResult: 'allow',
        detail: { count: tools.length },
      });
      return tools;
    } catch (e) {
      await this.audit.record({
        actorUserId: ctx.userId,
        action: 'tool.discover',
        resource: serverId,
        policyResult: 'deny',
      });
      throw e; // Expired cache is never silently served on failed refresh.
    }
  }
  validate(tool: ToolManifest, args: unknown): void {
    requireThat(canonical(args).length <= 32768, 'tool_args_too_large');
    requireThat(this.compile(tool)(args), 'tool_args_invalid');
    // Reject undeclared keys even if a provider omitted additionalProperties:false.
    const strict = (schema: Record<string, unknown>, value: unknown): void => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        for (const [k, v] of Object.entries(value)) {
          requireThat(
            k !== '__proto__' && k !== 'constructor' && k !== 'prototype',
            'tool_args_invalid',
          );
          requireThat(
            Object.hasOwn(properties, k) ||
              schema.additionalProperties === true ||
              typeof schema.additionalProperties === 'object',
            'tool_args_unknown',
          );
          if (properties[k]) strict(properties[k], v);
        }
      }
      if (Array.isArray(value) && schema.items && typeof schema.items === 'object')
        for (const v of value) strict(schema.items as Record<string, unknown>, v);
    };
    strict(tool.inputSchema, args);
  }
}
