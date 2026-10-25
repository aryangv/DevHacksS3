import { z } from "zod";

// harness-spec Section 7. Frozen at M0; additive changes only (PR label `contract-change`).

export const PlatformSchema = z.enum(["imessage", "discord", "slack", "whatsapp"]);
export type Platform = z.infer<typeof PlatformSchema>;

/** iMessage tapbacks (BlueBubbles reports which message was reacted to). Additive (P2). */
export const ReactionTypeSchema = z.enum(["love", "like", "dislike", "laugh", "emphasize", "question"]);
export type ReactionType = z.infer<typeof ReactionTypeSchema>;

export const InboundMessageSchema = z.strictObject({
  platform: PlatformSchema,
  /** Sendblue `message_handle`. Dedupe key together with `platform`. */
  providerMessageId: z.string().min(1),
  /** Sendblue `group_id` for groups (authoritative); sender number for DMs. */
  providerConversationId: z.string().min(1),
  /** E.164 for iMessage. */
  senderExternalId: z.string().min(1),
  participantExternalIds: z.array(z.string().min(1)),
  isGroup: z.boolean(),
  text: z.string(),
  /** ISO-8601. */
  timestamp: z.string().min(1),
  /**
   * Set when this event is a tapback on an earlier message (then `text` is empty). `removed` = the
   * person took the reaction back. Additive (P2); absent on transports without reactions.
   */
  reaction: z
    .strictObject({ type: ReactionTypeSchema, targetMessageId: z.string().min(1), removed: z.boolean() })
    .optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export type SendOptions = { replyTo?: string };
export type SendResult = { messageId: string };
