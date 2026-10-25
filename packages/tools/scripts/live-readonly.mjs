// Explicit smoke-test entry point. No arbitrary tool names/arguments, no email output.
// Uses the real gateway, permission resolver, catalog, approvals and Composio provider.
// Storage is in memory because the P1 database runtime is not part of this branch.
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { setup } from '../tests/setup.ts';
import { context } from '../tests/fakes.ts';
import { composioFromEnv } from '../src/config.ts';
import { ComposioProvider } from '../src/providers.ts';
import { ConnectionService } from '../src/connections.ts';
import { ToolCatalog } from '../src/catalog.ts';
import { ToolGateway } from '../src/gateway.ts';
import { readOnlyComposioIntegrations } from '../src/composio-readonly.ts';

if (!process.argv.includes('--live-readonly'))
  throw new Error('explicit_live_readonly_flag_required');
loadEnvFile(new URL('../.env', import.meta.url));
// Flag applies to this bounded test process only; .env and the application stay off.
const sdk = composioFromEnv({ ...process.env, USE_REAL_TOOLS: 'true' });
const f = await setup();
const configs = readOnlyComposioIntegrations({
  searchId: 'search-smoke',
  gmailId: 'gmail-smoke',
  gmailAuthConfigId: process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID || 'unconfigured',
});
f.store.serverRows = configs.servers;
const provider = new ComposioProvider(sdk, configs.composio);
const providers = new Map([['composio', provider]]);
const connections = new ConnectionService({
  ...f,
  redirectBase: 'https://campus.example',
  composio: { sdk, provider },
});
const catalog = new ToolCatalog(f.store, providers, f.audit);
const gateway = new ToolGateway({
  ...f,
  connections,
  catalog,
  providers,
  timeoutMs: 60000,
  deliverApproval: async () => {
    throw new Error('live_approval_required');
  },
});
const userId = process.env.P4_LIVE_USER_ID || `public-smoke-${randomUUID()}`;
const ctx = context({ userId, requesterAgentId: `personal-${userId}`, turnId: randomUUID() });
await connections.connectPublicSearch(
  { userId, authenticated: true, sessionId: randomUUID() },
  'search-smoke',
);
const amazon = await gateway.execute(ctx, {
  proposalId: randomUUID(),
  server: 'composio_search',
  tool: 'COMPOSIO_SEARCH_AMAZON',
  args: { query: 'wireless bluetooth headphones', page: 1, amazon_domain: 'amazon.com' },
});
const executed = [...f.store.calls.values()].filter((c) => c.decision === 'execute');
// Report only shape/counts for the public Amazon result, never source text or email data.
const facts = {
  objectArrayItems: 0,
  nameProvided: false,
  priceProvided: false,
  ratingProvided: false,
  urlProvided: false,
  truncated: amazon.status === 'ok' && amazon.data?.truncated === true,
};
function inspectAmazon(value, depth = 0) {
  if (depth > 12 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    facts.objectArrayItems += value.filter((item) => item && typeof item === 'object').length;
    for (const item of value) inspectAmazon(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const provided = item !== null && item !== undefined && item !== '';
    if (/^(title|name|product_title|product_name)$/i.test(key) && provided)
      facts.nameProvided = true;
    if (/^(price|price_string|product_price|extracted_price)$/i.test(key) && provided)
      facts.priceProvided = true;
    if (/^(rating|stars|product_star_rating)$/i.test(key) && provided) facts.ratingProvided = true;
    if (/^(url|link|product_url)$/i.test(key) && provided) facts.urlProvided = true;
    inspectAmazon(item, depth + 1);
  }
}
if (amazon.status === 'ok') inspectAmazon(amazon.data);
process.stdout.write(
  JSON.stringify({
    amazon: {
      status: amazon.status,
      reasonCode: amazon.reasonCode,
      dataPresent: amazon.status === 'ok' && amazon.data !== null,
      audited:
        f.audit.events.some((e) => e.action === 'tool.invoke') &&
        f.audit.events.some((e) => ['tool.result', 'tool.rejected'].includes(e.action)),
      callStatus: executed[0]?.status,
      resultChecks: facts,
    },
  }) + '\n',
);
// Never import a Playground account by listing all users or assigning an account to a new user.
// Gmail needs a connection established by this application's authenticated OAuth callback.
const gmail = await gateway.execute(ctx, {
  proposalId: randomUUID(),
  server: 'gmail',
  tool: 'GMAIL_FETCH_EMAILS',
  args: { query: 'in:inbox', max_results: 1, ids_only: true },
});
process.stdout.write(
  JSON.stringify({
    gmail: {
      status: gmail.status,
      reasonCode: gmail.reasonCode,
      appUserConfigured: Boolean(process.env.P4_LIVE_USER_ID),
      authConfigConfigured: Boolean(process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID),
      persistentConnectionStoreAvailable: false,
    },
    auditRecords: f.audit.events.length,
  }) + '\n',
);
