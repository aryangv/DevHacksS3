import type { AuditLog, Clock, Logger, MemoryMetadata, MemoryStore, SqlClient } from "@campus/contracts";

// Group chat memory (team decision, overriding harness-spec 5.3 for group chats): everything said in
// a group chat the assistant is in goes into that group's namespace (group_{uuid}) — from verified
// and unverified members alike — so the group agent can recall the conversation.
//
// A worker job runs this every ~60 s. Each run takes messages not yet sent (core.group_memory_ingested),
// groups them per (conversation, speaker) and appends them to a stable document per speaker
// (`chat_<conversation>_<speaker>`), so Supermemory appends instead of duplicating and one member's
// lines can be removed on request (removeMemberContent filters on author_user_id).
//
// Still enforced: secrets are redacted (MemoryStore.add), a verified member who turned memory off is
// skipped, and lines are labelled as what people said (never instructions) when read back.

const BATCH_LIMIT = 500;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINE = 1_000;

type Row = {
  id: string;
  conversation_id: string;
  body: string;
  received_at: Date | string;
  sender: string | null;
  user_id: string | null;
  status: string | null;
  display_name: string | null;
  remember_enabled: boolean | null;
};

export type GroupChatIngestResult = { ingested: number; skipped: number; failed: number; documents: number };

export class GroupChatIngestor {
  constructor(
    private readonly deps: {
      sql: SqlClient;
      memoryStore: MemoryStore;
      audit: AuditLog;
      clock: Clock;
      logger?: Logger;
    },
  ) {}

  async ingestGroupChat(): Promise<GroupChatIngestResult> {
    const { sql, clock } = this.deps;
    const now = clock.now();
    const { rows } = await sql.query<Row>(
      `SELECT m.id, m.conversation_id, m.body, m.received_at, m.sender_external_identity_id AS sender,
              ei.user_id, ei.status, u.display_name, ms.remember_enabled
       FROM core.messages m
       JOIN core.conversations c ON c.id = m.conversation_id AND c.type = 'group'
       LEFT JOIN core.external_identities ei ON ei.id = m.sender_external_identity_id
       LEFT JOIN core.users u ON u.id = ei.user_id
       LEFT JOIN core.memory_settings ms ON ms.user_id = ei.user_id
       LEFT JOIN core.group_memory_ingested g ON g.message_id = m.id
       WHERE g.message_id IS NULL AND m.body IS NOT NULL AND btrim(m.body) <> '' AND m.received_at > $1
       ORDER BY m.received_at, m.id
       LIMIT ${BATCH_LIMIT}`,
      [new Date(now.getTime() - LOOKBACK_MS)],
    );

    const batches = new Map<string, { conversationId: string; speaker: Speaker; rows: Row[] }>();
    const skipped: Row[] = [];
    for (const r of rows) {
      const speaker = speakerOf(r);
      // A verified member who turned memory off is left out (their choice beats "everything").
      if (speaker.userId && r.remember_enabled === false) {
        skipped.push(r);
        continue;
      }
      const key = `${r.conversation_id}:${speaker.key}`;
      const b = batches.get(key) ?? { conversationId: r.conversation_id, speaker, rows: [] };
      b.rows.push(r);
      batches.set(key, b);
    }

    let ingested = 0;
    let failed = 0;
    for (const b of batches.values()) {
      const content = b.rows
        .map((r) => `[${stamp(r.received_at)}] ${b.speaker.label}: ${oneLine(r.body)}`)
        .join("\n");
      const metadata: MemoryMetadata = {
        source: "imessage",
        conversation_id: b.conversationId,
        speaker: b.speaker.key,
        speaker_verified: b.speaker.userId !== null,
        ingested_by: "p3_group_chat",
      };
      if (b.speaker.userId) metadata.author_user_id = b.speaker.userId;
      try {
        await this.deps.memoryStore.add(
          { kind: "group", conversationId: b.conversationId },
          { content, kind: "conversation", customId: `chat_${b.conversationId}_${b.speaker.key}`, metadata },
        );
        await this.mark(b.rows, "ingested");
        ingested += b.rows.length;
      } catch (err) {
        failed += b.rows.length; // left unmarked: retried on the next run
        this.deps.logger?.warn("group chat ingest failed", { conversationId: b.conversationId, err });
      }
    }
    if (skipped.length) await this.mark(skipped, "skipped");

    if (ingested || failed) {
      await this.deps.audit.record({
        action: "memory.group_chat_ingested",
        policyResult: failed ? "error" : "ok",
        detail: { messages: ingested, skipped: skipped.length, failed, documents: batches.size },
      });
    }
    return { ingested, skipped: skipped.length, failed, documents: batches.size };
  }

  private async mark(rows: Row[], outcome: "ingested" | "skipped"): Promise<void> {
    for (const r of rows) {
      await this.deps.sql.query(
        `INSERT INTO core.group_memory_ingested (message_id, conversation_id, outcome, ingested_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (message_id) DO NOTHING`,
        [r.id, r.conversation_id, outcome, this.deps.clock.now()],
      );
    }
  }
}

type Speaker = { key: string; label: string; userId: string | null };

function speakerOf(r: Row): Speaker {
  if (!r.sender) return { key: "assistant", label: "Assistant", userId: null };
  if (r.status === "verified" && r.user_id)
    return { key: r.user_id, label: r.display_name?.trim() || "A member", userId: r.user_id };
  // Never a phone number in memory: unverified members are keyed by their internal identity id.
  return { key: `ext_${r.sender}`, label: "A member who hasn't signed up", userId: null };
}

const stamp = (v: Date | string) => new Date(v).toISOString().slice(0, 16).replace("T", " ");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_LINE);
