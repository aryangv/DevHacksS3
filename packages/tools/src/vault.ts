import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AuditLog, CredentialKind, Sql, VaultClient } from './ports.ts';
import { requireThat, SecurityError } from './security.ts';

/** Envelope: independent random DEK per value, wrapped by a versioned env KEK.
 * Both AES-GCM layers bind purpose/owner/connection/kind with authenticated data.
 */
export class EnvelopeCipher {
  private keys: ReadonlyMap<number, Buffer>;
  readonly currentVersion: number;
  constructor(keys: ReadonlyMap<number, Buffer>, currentVersion: number) {
    requireThat(
      keys.has(currentVersion) && [...keys.values()].every((k) => k.length === 32),
      'vault_key_missing',
    );
    this.keys = new Map([...keys].map(([v, k]) => [v, Buffer.from(k)]));
    this.currentVersion = currentVersion;
  }
  encrypt(secret: string, aad: string): { ciphertext: Buffer; keyVersion: number } {
    const dek = randomBytes(32),
      keyVersion = this.currentVersion;
    try {
      const seal = (key: Buffer, data: Buffer, purpose: string) => {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(`${keyVersion}:${aad}:${purpose}`));
        return Buffer.concat([
          iv,
          cipher.update(data),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString('base64');
      };
      return {
        ciphertext: Buffer.from(
          JSON.stringify({
            format: 1,
            wrapped: seal(this.keys.get(keyVersion)!, dek, 'key'),
            data: seal(dek, Buffer.from(secret), 'data'),
          }),
        ),
        keyVersion,
      };
    } finally {
      dek.fill(0);
    }
  }
  decrypt(ciphertext: Buffer, keyVersion: number, aad: string): string {
    let dek: Buffer | undefined;
    try {
      const kek = this.keys.get(keyVersion);
      requireThat(kek, 'vault_key_missing');
      const envelope = JSON.parse(ciphertext.toString('utf8')) as {
        format: number;
        wrapped: string;
        data: string;
      };
      requireThat(envelope.format === 1, 'vault_ciphertext_invalid');
      const open = (key: Buffer, encoded: string, purpose: string) => {
        const bytes = Buffer.from(encoded, 'base64');
        requireThat(bytes.length >= 28, 'vault_ciphertext_invalid');
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAAD(Buffer.from(`${keyVersion}:${aad}:${purpose}`));
        cipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
      };
      dek = open(kek, envelope.wrapped, 'key');
      return open(dek, envelope.data, 'data').toString('utf8');
    } catch {
      throw new SecurityError('vault_decrypt_failed');
    } finally {
      dek?.fill(0);
    }
  }
}

export class PostgresVaultClient implements VaultClient {
  private db: Sql;
  private cipher: EnvelopeCipher;
  private audit: AuditLog;
  private ready = false;
  constructor(db: Sql, cipher: EnvelopeCipher, audit: AuditLog) {
    this.db = db;
    this.cipher = cipher;
    this.audit = audit;
  }
  async initialize(gatewayRole: string, appRole: string): Promise<void> {
    this.ready = false;
    const { rows } = await this.db.query(
      `SELECT current_user AS name, r.rolsuper, r.rolbypassrls,
      has_table_privilege($1, 'vault.credentials', 'SELECT') AS app_can_read,
      pg_has_role($1,current_user,'MEMBER') AS app_can_assume
      FROM pg_roles r WHERE r.rolname = current_user`,
      [appRole],
    );
    const r = rows[0];
    requireThat(
      r &&
        r.name === gatewayRole &&
        gatewayRole !== appRole &&
        !r.rolsuper &&
        !r.rolbypassrls &&
        !r.app_can_read &&
        !r.app_can_assume,
      'vault_role_unsafe',
    );
    this.ready = true;
  }
  private async own(userId: string, connectionId: string): Promise<void> {
    requireThat(this.ready, 'vault_not_initialized');
    const { rows } = await this.db.query(
      'SELECT id FROM mcp.user_connections WHERE id=$1 AND user_id=$2',
      [connectionId, userId],
    );
    if (!rows.length) {
      await this.audit.record({
        actorUserId: userId,
        action: 'vault.access',
        policyResult: 'deny',
      });
      throw new SecurityError('credential_access_denied');
    }
  }
  async put(
    userId: string,
    connectionId: string,
    kind: CredentialKind,
    secret: string,
    expiresAt?: string,
  ): Promise<void> {
    await this.own(userId, connectionId);
    requireThat(secret.length > 0, 'credential_empty');
    const value = this.cipher.encrypt(secret, `${userId}:${connectionId}:${kind}`);
    await this.audit.record({
      actorUserId: userId,
      action: 'vault.update',
      resource: connectionId,
      policyResult: 'allow',
      detail: { kind },
    });
    await this.db.query(
      `INSERT INTO vault.credentials(connection_id,kind,ciphertext,key_version,expires_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(connection_id,kind) DO UPDATE SET
      ciphertext=EXCLUDED.ciphertext,key_version=EXCLUDED.key_version,expires_at=EXCLUDED.expires_at`,
      [connectionId, kind, value.ciphertext, value.keyVersion, expiresAt ?? null],
    );
  }
  async get(
    userId: string,
    connectionId: string,
    kind: CredentialKind,
  ): Promise<{ secret: string; expiresAt?: string } | null> {
    await this.own(userId, connectionId);
    await this.audit.record({
      actorUserId: userId,
      action: 'vault.access',
      resource: connectionId,
      policyResult: 'allow',
      detail: { kind },
    });
    const { rows } = await this.db.query(
      'SELECT ciphertext,key_version,expires_at FROM vault.credentials WHERE connection_id=$1 AND kind=$2',
      [connectionId, kind],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      secret: this.cipher.decrypt(
        r.ciphertext as Buffer,
        Number(r.key_version),
        `${userId}:${connectionId}:${kind}`,
      ),
      expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : undefined,
    };
  }
  async delete(userId: string, connectionId: string): Promise<void> {
    await this.own(userId, connectionId);
    await this.audit.record({
      actorUserId: userId,
      action: 'vault.revoke',
      resource: connectionId,
      policyResult: 'allow',
    });
    await this.db.query('DELETE FROM vault.credentials WHERE connection_id=$1', [connectionId]);
  }
}
