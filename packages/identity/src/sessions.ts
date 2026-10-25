import type { AuditLog, Clock, SqlClient } from "@campus/contracts";
import { hashToken, newToken } from "./util";

// Web sessions for the onboarding/settings/approval pages (spec 18.2 P2: "UI shell and session
// handling"). A session is issued only after a server-confirmed phone verification; the cookie holds
// a random token and the DB holds only its hash. A session is valid only while the user is active
// and still has a verified identity — revoking verification ends every session at once.

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WebSession = { sessionId: string; userId: string; displayName: string | null };

export class WebSessionService {
  constructor(private readonly deps: { sql: SqlClient; audit: AuditLog; clock: Clock }) {}

  async create(userId: string, via: string): Promise<{ token: string; expiresAt: Date }> {
    const now = this.deps.clock.now();
    const token = newToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const { rows } = await this.deps.sql.query<{ id: string }>(
      `INSERT INTO core.web_sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [hashToken(token), userId, now, expiresAt],
    );
    await this.deps.audit.record({
      action: "session.created",
      actorUserId: userId,
      resource: `web_session:${rows[0]!.id}`,
      detail: { via },
    });
    return { token, expiresAt };
  }

  async resolve(token: string | null | undefined): Promise<WebSession | null> {
    if (!token || token.length > 200) return null;
    const now = this.deps.clock.now();
    const { rows } = await this.deps.sql.query<{ id: string; user_id: string; display_name: string | null }>(
      `SELECT s.id, s.user_id, u.display_name FROM core.web_sessions s
       JOIN core.users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'active'
         AND EXISTS (SELECT 1 FROM core.external_identities ei WHERE ei.user_id = u.id AND ei.status = 'verified')`,
      [hashToken(token), now],
    );
    const r = rows[0];
    if (!r) return null;
    await this.deps.sql.query(`UPDATE core.web_sessions SET last_seen_at = $2 WHERE id = $1`, [r.id, now]);
    return { sessionId: r.id, userId: r.user_id, displayName: r.display_name };
  }

  async revoke(token: string): Promise<void> {
    const { rows } = await this.deps.sql.query<{ id: string; user_id: string }>(
      `UPDATE core.web_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, user_id`,
      [hashToken(token), this.deps.clock.now()],
    );
    if (rows[0])
      await this.deps.audit.record({
        action: "session.revoked",
        actorUserId: rows[0].user_id,
        resource: `web_session:${rows[0].id}`,
        detail: { via: "sign_out" },
      });
  }

  async revokeAllForUser(userId: string, via: string): Promise<number> {
    const { rows } = await this.deps.sql.query<{ id: string }>(
      `UPDATE core.web_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
      [userId, this.deps.clock.now()],
    );
    if (rows.length)
      await this.deps.audit.record({
        action: "session.revoked",
        actorUserId: userId,
        resource: `user:${userId}`,
        detail: { via, count: rows.length },
      });
    return rows.length;
  }
}
