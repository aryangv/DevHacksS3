import { type ConversationLine, type MessageLog, type SqlClient, insertIdempotent } from "@campus/contracts";
import { iso } from "../client";

/**
 * core.messages. Inbound rows carry the sender identity; outbound (agent) rows have a NULL sender.
 * Bodies of unverified senders are stored as NULL in 1:1 chats; group chat text is kept (team decision).
 */
export class PgMessageLog implements MessageLog {
  constructor(private readonly sql: SqlClient) {}

  async recordInbound(
    input: Parameters<MessageLog["recordInbound"]>[0],
  ): Promise<{ id: string; inserted: boolean }> {
    const { inserted, row } = await insertIdempotent<{ id: string }>(
      this.sql,
      "core.messages",
      {
        conversation_id: input.conversationId,
        platform: input.platform,
        provider_message_id: input.providerMessageId,
        sender_external_identity_id: input.senderExternalIdentityId,
        body: input.body,
        received_at: input.receivedAt,
      },
      ["platform", "provider_message_id"],
      "id",
    );
    return { id: row.id, inserted };
  }

  async recordOutbound(input: Parameters<MessageLog["recordOutbound"]>[0]): Promise<void> {
    await this.sql.query(
      `INSERT INTO core.messages (conversation_id, platform, provider_message_id, sender_external_identity_id, body, received_at, processed_at)
       VALUES ($1, $2, $3, NULL, $4, now(), now())
       ON CONFLICT (platform, provider_message_id) DO NOTHING`,
      [input.conversationId, input.platform, input.providerMessageId, input.body],
    );
  }

  async markProcessed(id: string): Promise<void> {
    await this.sql.query(
      "UPDATE core.messages SET processed_at = now() WHERE id = $1 AND processed_at IS NULL",
      [id],
    );
  }

  async recent(conversationId: string, limit: number): Promise<ConversationLine[]> {
    const r = await this.sql.query<{
      sender: string | null;
      user_id: string | null;
      status: string | null;
      display_name: string | null;
      body: string;
      received_at: Date;
    }>(
      `SELECT * FROM (
         SELECT m.sender_external_identity_id AS sender, ei.user_id, ei.status, u.display_name, m.body, m.received_at
         FROM core.messages m
         LEFT JOIN core.external_identities ei ON ei.id = m.sender_external_identity_id
         LEFT JOIN core.users u ON u.id = ei.user_id
         WHERE m.conversation_id = $1 AND m.body IS NOT NULL
         ORDER BY m.received_at DESC LIMIT $2
       ) t ORDER BY received_at ASC`,
      [conversationId, limit],
    );
    return r.rows.map((x) => ({
      direction: x.sender ? "inbound" : "outbound",
      senderUserId: x.status === "verified" ? x.user_id : null,
      senderDisplayName: x.status === "verified" ? x.display_name : null,
      body: x.body,
      at: iso(x.received_at),
    }));
  }
}
