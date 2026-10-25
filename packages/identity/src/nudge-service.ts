import type {
  AuditLog,
  Clock,
  Conversation,
  InboundMessage,
  Logger,
  MessagingAdapter,
  NudgeResult,
  NudgeService,
  ResolvedIdentity,
  SqlClient,
} from "@campus/contracts";
import { hashToken, newToken } from "./util";

// Nudges (spec 4.3 nudge rules):
//   - only when the person addressed the agent (the pipeline calls us only then);
//   - at most once per identity per conversation per NUDGE_INTERVAL_HOURS (counted in core.nudges);
//   - in a group, the nudge goes to the group (as a reply to their message); in a 1:1 chat, to them.
//     (Sendblue's pre-reply link limits in spec 3.1 do not apply: the transport is BlueBubbles.)
//   - short plain text, no private info.
// The link carries a single-use challenge token (core.auth_challenges, hashed) bound to this
// identity and the conversation it came from, so the "You're set" confirmation lands there.

export const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;

export type NudgeDeps = {
  sql: SqlClient;
  messaging: MessagingAdapter;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
  appOrigin: string;
  intervalHours: number;
  agentName: string;
};

export class DefaultNudgeService implements NudgeService {
  constructor(private readonly deps: NudgeDeps) {}

  async maybeNudge(input: {
    identity: ResolvedIdentity;
    conversation: Conversation;
    inbound: InboundMessage;
  }): Promise<NudgeResult> {
    const { identity, conversation, inbound } = input;
    const d = this.deps;
    if (identity.status !== "unverified") return { sent: false, reason: `status_${identity.status}` };
    const now = d.clock.now();

    const { rows } = await d.sql.query<{ last: Date | string | null }>(
      `SELECT max(sent_at) AS last FROM core.nudges WHERE external_identity_id = $1 AND conversation_id = $2`,
      [identity.externalIdentityId, conversation.id],
    );
    const last = rows[0]?.last ? new Date(rows[0].last).getTime() : null;
    if (last !== null && now.getTime() - last < d.intervalHours * 3_600_000) {
      await this.audit(conversation.id, "nudge.suppressed", {
        reason: "rate_limited",
        type: conversation.type,
      });
      return { sent: false, reason: "rate_limited" };
    }

    const token = newToken();
    await d.sql.query(
      `INSERT INTO core.auth_challenges (external_identity_id, token_hash, origin_conversation_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        identity.externalIdentityId,
        hashToken(token),
        conversation.id,
        new Date(now.getTime() + CHALLENGE_TTL_MS),
        now,
      ],
    );
    const link = `${d.appOrigin.replace(/\/+$/, "")}/onboard?t=${token}`;

    let channel: "group" | "dm";
    let text: string;
    try {
      if (conversation.type === "group") {
        channel = "group";
        text = `Hi! I'm ${d.agentName}, an AI assistant in this chat. Before I can help you, please verify your number (takes a minute): ${link}`;
        await d.messaging.sendGroup(inbound.providerConversationId, text, {
          replyTo: inbound.providerMessageId,
        });
      } else {
        channel = "dm";
        text = `Hi! I'm ${d.agentName}, an AI assistant. Before we chat, please verify your number (takes a minute): ${link}`;
        await d.messaging.sendDM(inbound.senderExternalId, text);
      }
    } catch (err) {
      d.logger.warn("nudge send failed", { conversationId: conversation.id, err });
      await this.audit(conversation.id, "nudge.suppressed", {
        reason: "send_failed",
        type: conversation.type,
      });
      return { sent: false, reason: "send_failed" };
    }

    await d.sql.query(
      `INSERT INTO core.nudges (external_identity_id, conversation_id, sent_at) VALUES ($1, $2, $3)`,
      [identity.externalIdentityId, conversation.id, now],
    );
    await this.audit(conversation.id, "nudge.sent", {
      channel,
      withLink: text.includes(link),
      chars: text.length,
    });
    return { sent: true, channel };
  }

  private audit(
    conversationId: string,
    action: "nudge.sent" | "nudge.suppressed",
    detail: Record<string, unknown>,
  ) {
    return this.deps.audit.record({
      action,
      conversationId,
      policyResult: action === "nudge.sent" ? "ok" : "skip",
      detail,
    });
  }
}
