import type { AuditLog, IdentityService, Platform, ResolvedIdentity, SqlClient } from "@campus/contracts";
import { UUID_RE } from "./util";

// IdentityService over core.external_identities + core.users (spec 4.3).
// States: unverified → verified → revoked. `userId` is exposed ONLY for verified identities: a link
// that exists in the table (e.g. a revoked one) is never authority (spec 4.3 "what authenticated means").

type IdentityRow = {
  id: string;
  user_id: string | null;
  platform: Platform;
  external_id: string;
  status: "unverified" | "verified" | "revoked";
  display_name: string | null;
  last_inbound_at: Date | string | null;
};

const SELECT_IDENTITY = `
  SELECT ei.id, ei.user_id, ei.platform, ei.external_id, ei.status, u.display_name, ei.last_inbound_at
  FROM core.external_identities ei
  LEFT JOIN core.users u ON u.id = ei.user_id`;

export function toResolved(row: IdentityRow): ResolvedIdentity {
  const verified = row.status === "verified" && row.user_id !== null;
  return {
    externalIdentityId: row.id,
    platform: row.platform,
    externalId: row.external_id,
    status: verified ? "verified" : row.status === "revoked" ? "revoked" : "unverified",
    userId: verified ? row.user_id : null,
    displayName: verified ? row.display_name : null,
    hasMessagedLine: row.last_inbound_at !== null,
  };
}

export class PgIdentityService implements IdentityService {
  constructor(private readonly deps: { sql: SqlClient; audit: AuditLog }) {}

  async resolveSender(platform: Platform, externalId: string): Promise<ResolvedIdentity> {
    const { row, created } = await this.upsert(platform, externalId, true);
    if (created) {
      await this.deps.audit.record({
        action: "identity.created",
        resource: `external_identity:${row.id}`,
        detail: { platform, via: "inbound_message" },
      });
    }
    return toResolved(row);
  }

  /** Look up or create without marking "has messaged the line" (group participants, onboarding). */
  async ensureIdentity(platform: Platform, externalId: string): Promise<ResolvedIdentity> {
    const { row, created } = await this.upsert(platform, externalId, false);
    if (created) {
      await this.deps.audit.record({
        action: "identity.created",
        resource: `external_identity:${row.id}`,
        detail: { platform, via: "participant_or_onboarding" },
      });
    }
    return toResolved(row);
  }

  async byId(externalIdentityId: string): Promise<ResolvedIdentity | null> {
    if (!UUID_RE.test(externalIdentityId)) return null;
    const { rows } = await this.deps.sql.query<IdentityRow>(`${SELECT_IDENTITY} WHERE ei.id = $1`, [
      externalIdentityId,
    ]);
    return rows[0] ? toResolved(rows[0]) : null;
  }

  async find(platform: Platform, externalId: string): Promise<ResolvedIdentity | null> {
    const { rows } = await this.deps.sql.query<IdentityRow>(
      `${SELECT_IDENTITY} WHERE ei.platform = $1 AND ei.external_id = $2`,
      [platform, externalId],
    );
    return rows[0] ? toResolved(rows[0]) : null;
  }

  async getUser(userId: string) {
    if (!UUID_RE.test(userId)) return null;
    const { rows } = await this.deps.sql.query<{
      id: string;
      display_name: string | null;
      status: "active" | "suspended" | "deleted";
    }>(`SELECT id, display_name, status FROM core.users WHERE id = $1`, [userId]);
    const r = rows[0];
    return r ? { userId: r.id, displayName: r.display_name, status: r.status } : null;
  }

  async getPrimaryExternalId(userId: string, platform: Platform): Promise<string | null> {
    if (!UUID_RE.test(userId)) return null;
    const { rows } = await this.deps.sql.query<{ external_id: string }>(
      `SELECT ei.external_id FROM core.external_identities ei
       JOIN core.users u ON u.id = ei.user_id
       WHERE ei.user_id = $1 AND ei.platform = $2 AND ei.status = 'verified' AND u.status = 'active'
       ORDER BY ei.verified_at DESC NULLS LAST LIMIT 1`,
      [userId, platform],
    );
    return rows[0]?.external_id ?? null;
  }

  /** All addresses a user verified (settings page). */
  async listForUser(userId: string): Promise<ResolvedIdentity[]> {
    if (!UUID_RE.test(userId)) return [];
    const { rows } = await this.deps.sql.query<IdentityRow>(
      `${SELECT_IDENTITY} WHERE ei.user_id = $1 ORDER BY ei.first_seen_at`,
      [userId],
    );
    return rows.map(toResolved);
  }

  /**
   * Revocation (spec 4.3 security notes): every identity of the user becomes `revoked`, so the auth
   * gate blocks them at once. It cannot undo what was already disclosed (spec 12).
   */
  async revokeUser(userId: string): Promise<number> {
    if (!UUID_RE.test(userId)) return 0;
    const { rows } = await this.deps.sql.query<{ id: string }>(
      `UPDATE core.external_identities SET status = 'revoked' WHERE user_id = $1 AND status <> 'revoked' RETURNING id`,
      [userId],
    );
    for (const r of rows)
      await this.deps.audit.record({
        action: "identity.revoked",
        actorUserId: userId,
        resource: `external_identity:${r.id}`,
        detail: { via: "user_request" },
      });
    return rows.length;
  }

  private async upsert(
    platform: Platform,
    externalId: string,
    inbound: boolean,
  ): Promise<{ row: IdentityRow; created: boolean }> {
    // xmax = 0 ⇔ this statement inserted the row (Postgres idiom; works on PGlite too).
    const { rows } = await this.deps.sql.query<IdentityRow & { inserted: boolean }>(
      `WITH up AS (
         INSERT INTO core.external_identities (platform, external_id, last_inbound_at)
         VALUES ($1, $2, CASE WHEN $3 THEN now() END)
         ON CONFLICT (platform, external_id) DO UPDATE
           SET last_inbound_at = CASE WHEN $3 THEN now() ELSE core.external_identities.last_inbound_at END
         RETURNING id, user_id, platform, external_id, status, last_inbound_at, (xmax = 0) AS inserted
       )
       SELECT up.*, u.display_name FROM up LEFT JOIN core.users u ON u.id = up.user_id`,
      [platform, externalId, inbound],
    );
    const row = rows[0]!;
    return { row, created: row.inserted === true };
  }
}
