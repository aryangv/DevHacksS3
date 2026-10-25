import { type AuditEvent, type AuditLog, type AuditQuery, type SqlClient, redact } from "@campus/contracts";
import { iso } from "../client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);

/** core.audit_events writer/reader. Detail is redacted before it is stored (spec 12). */
export class PgAuditLog implements AuditLog {
  constructor(private readonly sql: SqlClient) {}

  async record(event: AuditEvent): Promise<void> {
    const e = redact(event);
    await this.sql.query(
      `INSERT INTO core.audit_events (actor_user_id, action, resource, policy_result, detail, turn_id, conversation_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        uuidOrNull(e.actorUserId),
        e.action,
        e.resource ?? null,
        e.policyResult ?? null,
        JSON.stringify(e.detail ?? {}),
        uuidOrNull(e.turnId),
        uuidOrNull(e.conversationId),
      ],
    );
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, v: unknown) => {
      params.push(v);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (q.turnId) add("turn_id = ?", uuidOrNull(q.turnId));
    if (q.conversationId) add("conversation_id = ?", uuidOrNull(q.conversationId));
    if (q.actorUserId) add("actor_user_id = ?", uuidOrNull(q.actorUserId));
    if (q.action) add("action = ?", q.action);
    params.push(Math.min(q.limit ?? 500, 5_000));
    const rows = await this.sql.query<{
      id: string;
      actor_user_id: string | null;
      action: string;
      resource: string | null;
      policy_result: string | null;
      detail: Record<string, unknown> | null;
      turn_id: string | null;
      conversation_id: string | null;
      created_at: Date;
    }>(
      `SELECT * FROM (
         SELECT id, actor_user_id, action, resource, policy_result, detail, turn_id, conversation_id, created_at, seq
         FROM core.audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY seq DESC LIMIT $${params.length}
       ) t ORDER BY seq ASC`,
      params,
    );
    return rows.rows.map((r) => ({
      id: r.id,
      action: r.action as AuditEvent["action"],
      actorUserId: r.actor_user_id,
      resource: r.resource,
      policyResult: r.policy_result,
      detail: r.detail ?? {},
      turnId: r.turn_id,
      conversationId: r.conversation_id,
      createdAt: iso(r.created_at),
    }));
  }
}
