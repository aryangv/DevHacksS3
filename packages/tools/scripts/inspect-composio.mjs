// Metadata only: never print SDK errors, credentials, account records, or email content.
import { loadEnvFile } from 'node:process';
import { createComposio } from '../src/providers.ts';
import { writeFile } from 'node:fs/promises';
import {
  SEARCH_TOOLS,
  GMAIL_TOOLS,
  SEARCH_VERSION,
  GMAIL_VERSION,
  GMAIL_READ_SCOPE,
} from '../src/composio-readonly.ts';
loadEnvFile(new URL('../.env', import.meta.url));
process.stdout.write(
  JSON.stringify({
    keyLoaded: Boolean(process.env.COMPOSIO_API_KEY),
    realToolsEnabled: process.env.USE_REAL_TOOLS === 'true',
    configured: Object.keys(process.env).filter((k) =>
      /^(COMPOSIO_|P4_|USE_REAL_TOOLS|VAULT_|OAUTH_)/.test(k),
    ),
  }) + '\n',
);
const sdk = createComposio(process.env.COMPOSIO_API_KEY);
const fixtures = {};
for (const slug of [...SEARCH_TOOLS, ...GMAIL_TOOLS]) {
  const version = slug.startsWith('GMAIL_') ? GMAIL_VERSION : SEARCH_VERSION;
  try {
    const tool = await sdk.tools.getRawComposioToolBySlug(
      slug,
      { version },
      { signal: AbortSignal.timeout(15000) },
    );
    fixtures[slug] = {
      slug,
      toolkit: { slug: tool.toolkit.slug },
      inputParameters: tool.inputParameters,
    };
    process.stdout.write(
      JSON.stringify({
        slug,
        toolkit: tool.toolkit.slug,
        version,
        inputFields: Object.keys(tool.inputParameters.properties ?? {}),
      }) + '\n',
    );
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        slug,
        failed: true,
        httpStatus: e.status ?? e.statusCode ?? e.cause?.status,
      }) + '\n',
    );
  }
}
if (Object.keys(fixtures).length === 10 && process.argv.includes('--save-schemas'))
  await writeFile(
    new URL('../tests/composio-schemas.json', import.meta.url),
    JSON.stringify(fixtures, null, 2) + '\n',
  );
try {
  const configs = await sdk.authConfigs.list(
    { toolkit: 'gmail', isComposioManaged: true },
    { signal: AbortSignal.timeout(15000) },
  );
  process.stdout.write(
    JSON.stringify({
      gmailAuthConfigs: configs.items.map((c) => {
        const scope = c.credentials?.scopes ?? c.credentials?.scope;
        const scopes =
          typeof scope === 'string' ? scope.split(/[ ,]+/) : Array.isArray(scope) ? scope : [];
        return {
          id: c.id,
          authScheme: c.authScheme,
          status: c.status,
          managed: c.isComposioManaged,
          readOnlyScopeConfigured: scopes.includes(GMAIL_READ_SCOPE),
          scopesMetadataAvailable: scopes.length > 0,
        };
      }),
    }) + '\n',
  );
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      authConfigInspectionFailed: true,
      httpStatus: e.status ?? e.statusCode ?? e.cause?.status,
    }) + '\n',
  );
}
