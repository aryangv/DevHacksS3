import { type InboundEvent, type InboundMessage, type InboundQueue, type SqlClient } from "@campus/contracts";
import { iso } from "../client";

const CLAIM_LOCK = 4242002;
const conversationKeyOf = (m: InboundMessage) => `${m.platform}:${m.providerConversationId}`;

/**
 * Durable inbound queue on core.inbound_events.
 * - enqueue: dedupe via UNIQUE (platform, provider_message_id) → duplicates return inserted=false.
 * - claimNext: oldest pending event whose conversation has nothing processing and no earlier pending
 *   event (per-conversation FIFO, one turn in flight per conversation — spec 4.2 step 3). Claims are
 *   serialized with a transaction-scoped advisory lock so two workers can't claim the same conversation.
 * - stale `processing` rows (crashed worker) are reclaimed after the visibility timeout.
 */
export class PgInboundQueue implements InboundQueue {
  constructor(
    private readonly sql: SqlClient,
    private readonly opts: { visibilityTimeoutMs?: number } = {},
  ) {}

  async enqueue(message: InboundMessage): Promise<{ eventId: string; inserted: boolean }> {
    const ins = await this.sql.query<{ id: string }>(
      `INSERT INTO core.inbound_events (platform, provider_message_id, conversation_key, message)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (platform, provider_message_id) DO NOTHING RETURNING id`,
      [message.platform, message.providerMessageId, conversationKeyOf(message), JSON.stringify(message)],
    );
    if (ins.rows[0]) return { eventId: ins.rows[0].id, inserted: true };
    const existing = await this.sql.query<{ id: string }>(
      "SELECT id FROM core.inbound_events WHERE platform = $1 AND provider_message_id = $2",
      [message.platform, message.providerMessageId],
    );
    return { eventId: existing.rows[0]!.id, inserted: false };
  }

  async claimNext(): Promise<InboundEvent | null> {
    const visibilityMs = this.opts.visibilityTimeoutMs ?? 5 * 60_000;
    return this.sql.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(${CLAIM_LOCK})`);
      await tx.query(
        `UPDATE core.inbound_events SET status = 'pending', locked_at = NULL
         WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 millisecond')`,
        [visibilityMs],
      );
      const r = await tx.query<{
        id: string;
        conversation_key: string;
        message: InboundMessage;
        attempts: number;
        received_at: Date;
      }>(
        `UPDATE core.inbound_events SET status = 'processing', attempts = attempts + 1, locked_at = now()
         WHERE id = (
           SELECT e.id FROM core.inbound_events e
           WHERE e.status = 'pending' AND e.available_at <= now()
             AND NOT EXISTS (
               SELECT 1 FROM core.inbound_events p
               WHERE p.conversation_key = e.conversation_key
                 AND (p.status = 'processing' OR (p.status = 'pending' AND p.seq < e.seq))
             )
           ORDER BY e.seq LIMIT 1
         )
         RETURNING id, conversation_key, message, attempts, received_at`,
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        conversationKey: row.conversation_key,
        message: row.message,
        attempts: row.attempts,
        receivedAt: iso(row.received_at),
      };
    });
  }

  async complete(eventId: string): Promise<void> {
    await this.sql.query(
      "UPDATE core.inbound_events SET status = 'done', completed_at = now(), locked_at = NULL WHERE id = $1",
      [eventId],
    );
  }

  async fail(eventId: string, error: string, opts: { retryAt?: Date; deadLetter: boolean }): Promise<void> {
    await this.sql.query(
      `UPDATE core.inbound_events
       SET status = $2, last_error = $3, locked_at = NULL, available_at = COALESCE($4::timestamptz, now())
       WHERE id = $1`,
      [
        eventId,
        opts.deadLetter ? "dead" : "pending",
        error.slice(0, 1_000),
        opts.retryAt ? opts.retryAt.toISOString() : null,
      ],
    );
  }

  async counts(): Promise<Record<string, number>> {
    const r = await this.sql.query<{ status: string; n: string | number }>(
      "SELECT status, count(*) AS n FROM core.inbound_events GROUP BY status",
    );
    const out: Record<string, number> = { pending: 0, processing: 0, done: 0, dead: 0 };
    for (const row of r.rows) out[row.status] = Number(row.n);
    return out;
  }
}
