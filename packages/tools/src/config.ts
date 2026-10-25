import { requireThat } from './security.ts';
import { EnvelopeCipher } from './vault.ts';
import { createComposio } from './providers.ts';

export function composioFromEnv(env: Record<string, string | undefined>) {
  requireThat(env.USE_REAL_TOOLS === 'true', 'real_tools_disabled');
  requireThat(env.COMPOSIO_API_KEY, 'composio_key_missing');
  return createComposio(env.COMPOSIO_API_KEY);
}

export function vaultCipherFromEnv(env: Record<string, string | undefined>): EnvelopeCipher {
  const current = Number(env.VAULT_KEY_ID),
    keys = new Map<number, Buffer>();
  requireThat(Number.isSafeInteger(current) && current > 0, 'vault_key_version_missing');
  for (const [name, value] of Object.entries(env)) {
    const match = /^VAULT_MASTER_KEY_V([1-9][0-9]*)$/.exec(name);
    if (match && value) {
      const key = Buffer.from(value, 'base64');
      requireThat(key.length === 32 && key.toString('base64') === value, 'vault_key_invalid');
      keys.set(Number(match[1]), key);
    }
  }
  if (env.VAULT_MASTER_KEY) {
    const key = Buffer.from(env.VAULT_MASTER_KEY, 'base64');
    requireThat(
      key.length === 32 && key.toString('base64') === env.VAULT_MASTER_KEY,
      'vault_key_invalid',
    );
    keys.set(current, key);
  }
  return new EnvelopeCipher(keys, current);
}
