import type { MessagingAdapter } from "../interfaces/p2";
import type { InboundMessage, Platform, SendOptions, SendResult } from "../schemas/messaging";

export type SentMessage = {
  kind: "dm" | "group";
  to: string;
  text: string;
  replyTo?: string;
  messageId: string;
  at: string;
};

/**
 * Fake messaging adapter. Accepts every webhook, normalizes Sendblue-shaped payloads (the fixtures) and
 * records outbound messages instead of sending them. Real implementation: P2 (@campus/messaging).
 */
export class FakeMessagingAdapter implements MessagingAdapter {
  readonly platform: Platform = "imessage";
  readonly sent: SentMessage[] = [];
  private seq = 0;
  private listeners: Array<(m: SentMessage) => void> = [];

  constructor(private readonly lineNumber = "+15550000000") {}

  onSend(listener: (m: SentMessage) => void): void {
    this.listeners.push(listener);
  }

  verifyWebhook(_headers: Record<string, string>, _rawBody: string): boolean {
    return true;
  }

  normalize(rawEvent: unknown): InboundMessage | null {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const e = rawEvent as Record<string, unknown>;
    if (e.is_outbound === true) return null;
    const handle = typeof e.message_handle === "string" ? e.message_handle : null;
    const from = typeof e.from_number === "string" ? e.from_number : null;
    if (!handle || !from) return null;
    const groupId = typeof e.group_id === "string" && e.group_id.length > 0 ? e.group_id : null;
    const participants = Array.isArray(e.participants)
      ? (e.participants.filter((p) => typeof p === "string" && p !== this.lineNumber) as string[])
      : [];
    return {
      platform: "imessage",
      providerMessageId: handle,
      providerConversationId: groupId ?? from,
      senderExternalId: from,
      participantExternalIds: groupId ? participants : [from],
      isGroup: groupId !== null,
      text: typeof e.content === "string" ? e.content : "",
      timestamp: typeof e.date_sent === "string" ? e.date_sent : new Date().toISOString(),
    };
  }

  async sendDM(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    return this.record("dm", recipientId, text, opts);
  }

  async sendGroup(conversationId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    return this.record("group", conversationId, text, opts);
  }

  /** Messages sent to a recipient (DM) or provider conversation id (group). */
  to(target: string): SentMessage[] {
    return this.sent.filter((m) => m.to === target);
  }

  private record(kind: "dm" | "group", to: string, text: string, opts?: SendOptions): SendResult {
    const messageId = `fake-out-${++this.seq}`;
    const msg: SentMessage = {
      kind,
      to,
      text,
      messageId,
      at: new Date().toISOString(),
      ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
    };
    this.sent.push(msg);
    for (const l of this.listeners) l(msg);
    return { messageId };
  }
}
