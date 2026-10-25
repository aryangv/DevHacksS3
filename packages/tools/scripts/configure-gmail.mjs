// Creates a separate managed OAuth config; never changes the Playground config.
import { loadEnvFile } from 'node:process';
import { appendFile } from 'node:fs/promises';
import { createComposio, composioFailure } from '../src/providers.ts';
import { GMAIL_READ_SCOPE } from '../src/composio-readonly.ts';
if (!process.argv.includes('--configure-gmail'))
  throw new Error('explicit_configuration_flag_required');
const envFile = new URL('../.env', import.meta.url);
loadEnvFile(envFile);
const sdk = createComposio(process.env.COMPOSIO_API_KEY);
try {
  let id = process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID;
  if (!id) {
    const result = await sdk.authConfigs.create(
      'gmail',
      {
        type: 'use_composio_managed_auth',
        name: 'DevHacks P4 Gmail read only',
        credentials: { scopes: GMAIL_READ_SCOPE },
        isEnabledForToolRouter: false,
      },
      { signal: AbortSignal.timeout(15000) },
    );
    id = result.id;
    // Config IDs are not credentials; append only this setting to the ignored env file.
    await appendFile(envFile, `\nCOMPOSIO_GMAIL_AUTH_CONFIG_ID=${id}\n`);
  }
  const config = await sdk.authConfigs.get(id, { signal: AbortSignal.timeout(15000) });
  const value = config.credentials?.scopes ?? config.credentials?.scope;
  const scopes = typeof value === 'string' ? value.split(/[ ,]+/).filter(Boolean) : value;
  const readOnly = Array.isArray(scopes) && scopes.length === 1 && scopes[0] === GMAIL_READ_SCOPE;
  if (!readOnly || config.isComposioManaged !== true || config.authScheme !== 'OAUTH2')
    throw new Error('gmail_readonly_config_invalid');
  process.stdout.write(
    JSON.stringify({
      configured: true,
      managed: config.isComposioManaged,
      authScheme: config.authScheme,
      readOnlyScope: readOnly,
      sessionsEnabled: config.isEnabledForToolRouter,
    }) + '\n',
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      configured: false,
      reasonCode: composioFailure(error, 'composio_configuration_failed').code,
      errorType: error?.constructor?.name,
      httpStatus: error?.status ?? error?.statusCode ?? error?.cause?.status,
    }) + '\n',
  );
  process.exitCode = 1;
}
