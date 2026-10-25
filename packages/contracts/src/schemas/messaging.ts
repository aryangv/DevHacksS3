import { z } from "zod";

// harness-spec Section 7. Frozen at M0; additive changes only (PR label `contract-change`).

export const PlatformSchema = z.enum(["imessage", "discord", "slack", "whatsapp"]);
export type Platform = z.infer<typeof PlatformSchema>;

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
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export type SendOptions = { replyTo?: string };
export type SendResult = { messageId: string };
