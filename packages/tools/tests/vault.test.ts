import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EnvelopeCipher, PostgresVaultClient } from '../src/vault.ts';
import type { Sql } from '../src/ports.ts';
import { MemoryAudit } from './fakes.ts';
import { vaultCipherFromEnv } from '../src/config.ts';
test('envelope encryption authenticates value, owner, connection, kind, version; rotation supports old keys', () => {
  const key1 = randomBytes(32),
    key2 = randomBytes(32),
    cipher = new EnvelopeCipher(new Map([[1, key1]]), 1),
    aad = 'user:connection:access_token',
    secret = 'dummy-secret';
  const a = cipher.encrypt(secret, aad),
    b = cipher.encrypt(secret, aad);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert(!a.ciphertext.includes(secret));
  assert.equal(cipher.decrypt(a.ciphertext, 1, aad), secret);
  for (const wrong of [
    'other:connection:access_token',
    'user:other:access_token',
    'user:connection:refresh_token',
  ])
    assert.throws(() => cipher.decrypt(a.ciphertext, 1, wrong), /vault_decrypt_failed/);
  const envelope = JSON.parse(a.ciphertext.toString());
  envelope.data = envelope.data.slice(0, -5) + 'AAAAA';
  assert.throws(
    () => cipher.decrypt(Buffer.from(JSON.stringify(envelope)), 1, aad),
    /vault_decrypt_failed/,
  );
  const rotated = new EnvelopeCipher(
    new Map([
      [1, key1],
      [2, key2],
    ]),
    2,
  );
  assert.equal(rotated.decrypt(a.ciphertext, 1, aad), secret);
  assert.equal(rotated.encrypt(secret, aad).keyVersion, 2);
  assert.throws(() => rotated.decrypt(a.ciphertext, 2, aad), /vault_decrypt_failed/);
  assert.throws(() => new EnvelopeCipher(new Map(), 1), /vault_key_missing/);
});
test('vault fails closed without a configured key; versioned env keys support rotation', () => {
  assert.throws(() => vaultCipherFromEnv({}), /vault_key_version_missing/);
  assert.throws(
    () => vaultCipherFromEnv({ VAULT_KEY_ID: '1', VAULT_MASTER_KEY: 'weak' }),
    /vault_key_invalid/,
  );
  assert.equal(
    vaultCipherFromEnv({
      VAULT_KEY_ID: '2',
      VAULT_MASTER_KEY_V1: randomBytes(32).toString('base64'),
      VAULT_MASTER_KEY_V2: randomBytes(32).toString('base64'),
    }).currentVersion,
    2,
  );
});
test('restricted vault role and ownership enforced; encrypted credential CRUD; audit never contains secrets', async () => {
  const rows = new Map<string, { ciphertext: Buffer; key_version: number; expires_at: unknown }>();
  let role = { name: 'gateway', rolsuper: false, rolbypassrls: false, app_can_read: false };
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes('current_user AS name')) return { rows: [role], rowCount: 1 };
    if (text.startsWith('SELECT id FROM mcp.user_connections'))
      return {
        rows: values[0] === 'connection' && values[1] === 'owner' ? [{ id: 'connection' }] : [],
        rowCount: 1,
      };
    if (text.startsWith('INSERT INTO vault.credentials')) {
      rows.set(`${values[0]}:${values[1]}`, {
        ciphertext: values[2] as Buffer,
        key_version: values[3] as number,
        expires_at: values[4],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT ciphertext'))
      return {
        rows: rows.has(`${values[0]}:${values[1]}`) ? [rows.get(`${values[0]}:${values[1]}`)] : [],
        rowCount: 1,
      };
    if (text.startsWith('DELETE FROM vault.credentials')) {
      rows.clear();
      return { rows: [], rowCount: 1 };
    }
    throw new Error('unexpected SQL');
  };
  const db = {
    query,
    transaction: async (fn: (tx: Sql) => Promise<unknown>) => fn(db as unknown as Sql),
  } as unknown as Sql;
  const audit = new MemoryAudit(),
    cipher = new EnvelopeCipher(new Map([[1, randomBytes(32)]]), 1),
    vault = new PostgresVaultClient(db, cipher, audit);
  await assert.rejects(
    () => vault.put('owner', 'connection', 'api_key', 'dummy-secret'),
    /vault_not_initialized/,
  );
  for (const unsafe of [
    { ...role, rolsuper: true },
    { ...role, rolbypassrls: true },
    { ...role, app_can_read: true },
    { ...role, name: 'app' },
  ]) {
    role = unsafe;
    await assert.rejects(() => vault.initialize('gateway', 'app'), /vault_role_unsafe/);
  }
  role = { name: 'gateway', rolsuper: false, rolbypassrls: false, app_can_read: false };
  await vault.initialize('gateway', 'app');
  await assert.rejects(
    () => vault.get('attacker', 'connection', 'api_key'),
    /credential_access_denied/,
  );
  await vault.put('owner', 'connection', 'api_key', 'dummy-secret');
  assert(![...rows.values()][0].ciphertext.includes('dummy-secret'));
  assert.equal((await vault.get('owner', 'connection', 'api_key'))?.secret, 'dummy-secret');
  await vault.put('owner', 'connection', 'api_key', 'dummy-new-secret');
  assert.equal((await vault.get('owner', 'connection', 'api_key'))?.secret, 'dummy-new-secret');
  await vault.delete('owner', 'connection');
  assert.equal(await vault.get('owner', 'connection', 'api_key'), null);
  assert(!JSON.stringify(audit.events).includes('dummy-secret'));
  assert(!JSON.stringify(audit.events).includes('dummy-new-secret'));
});
