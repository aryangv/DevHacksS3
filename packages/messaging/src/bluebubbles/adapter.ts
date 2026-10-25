import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  InboundMessage,
  Logger,
  MessagingAdapter,
  Platform,
  SendOptions,
  SendResult,
} from "@campus/contracts";
import { normalizeAddress } from "../address";
import type { BlueBubblesHttp } from "./http";

// Real MessagingAdapter over a BlueBubbles Server (iMessage via a Mac running Messages.app).
// Spec 7 contract; shapes verified against the BlueBubbles server source (v1 API):
//   webhook body  { type: "new-message", data: Message }   (no signature: see verifyWebhook)
//   Message       { guid, text, isFromMe, dateCreated (ms), itemType, associatedMessageType,
//                   handle: { address }, chats: [{ guid, style (43 group, 45 1:1), participants: [{ address }] }] }
//   send text     POST /api/v1/message/text { chatGuid, tempGuid, message, method, selectedMessageGuid? }
//   new 1:1 chat  POST /api/v1/chat/new     { addresses: [addr], message, tempGuid, method }
//   chat lookup   GET  /api/v1/chat/:guid?with=participants
//
// Conversation keys: a group is keyed by its BlueBubbles chat guid (authoritative, like Sendblue's
// group_id); a 1:1 chat is keyed by the person's address (spec 7: "sender number for DMs").

/** Header the webhook route copies the URL's `?token=` into before calling verifyWebhook. */
export const WEBHOOK_TOKEN_HEADER = "x-campus-webhook-token";

const GROUP_STYLE = 43;
const DM_STYLE = 45;
const MAX_CONTENT = 10_000;
/** U+FFFC marks an attachment's position in iMessage text. */
const OBJECT_REPLACEMENT = /￼/g;

export type BlueBubblesAdapterOptions = {
  http: BlueBubblesHttp;
  webhookSecret: string;
  /** The bot's own addresses (its phone/Apple ID); excluded from participant lists. */
  botAddresses?: string[];
  method?: "apple-script" | "private-api";
  inlineReplies?: boolean;
  logger?: Logger;
};

type Raw = Record<string, unknown>;

export class BlueBubblesAdapter implements MessagingAdapter {
  readonly platform: Platform = "imessage";
  /** address → 1:1 chat guid, learned from inbound messages (unknown ones go through chat/new). */
  private readonly dmChats = new Map<string, string>();
  private readonly bot: Set<string>;

  constructor(private readonly opts: BlueBubblesAdapterOptions) {
    this.bot = new Set((opts.botAddresses ?? []).map((a) => normalizeAddress(a) ?? a));
  }

  /** BlueBubbles does not sign webhooks; the registered URL carries a secret we compare in constant time. */
  verifyWebhook(headers: Record<string, string>, _rawBody: string): boolean {
    let given: string | null = null;
    for (const [k, v] of Object.entries(headers))
      if (k.toLowerCase() === WEBHOOK_TOKEN_HEADER) given = String(v);
    if (!given || !this.opts.webhookSecret) return false;
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(this.opts.webhookSecret).digest();
    return timingSafeEqual(a, b);
  }

  normalize(rawEvent: unknown): InboundMessage | null {
    const parsed = this.parse(rawEvent);
    if (!parsed) return null;
    if (!parsed.isGroup) this.dmChats.set(parsed.sender, parsed.chatGuid);
    return {
      platform: "imessage",
      providerMessageId: parsed.guid,
      providerConversationId: parsed.isGroup ? parsed.chatGuid : parsed.sender,
      senderExternalId: parsed.sender,
      participantExternalIds: parsed.isGroup ? parsed.participants : [parsed.sender],
      isGroup: parsed.isGroup,
      text: parsed.text,
      timestamp: parsed.timestamp,
    };
  }

  /**
   * normalize() plus a participant lookup when a group webhook arrived without its member list
   * (BlueBubbles may strip participants from large payloads). The webhook route prefers this.
   */
  async normalizeWithLookup(rawEvent: unknown): Promise<InboundMessage | null> {
    const msg = this.normalize(rawEvent);
    if (!msg || !msg.isGroup || msg.participantExternalIds.length > 0) return msg;
    try {
      const json = await this.opts.http.request(
        "GET",
        `/api/v1/chat/${encodeURIComponent(msg.providerConversationId)}`,
        "chat-lookup",
        undefined,
        { with: "participants" },
      );
      const data = (json.data ?? {}) as Raw;
      return { ...msg, participantExternalIds: this.participants(data.participants) };
    } catch (err) {
      this.opts.logger?.warn("bluebubbles participant lookup failed", { err });
      return msg;
    }
  }

  async sendDM(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    const to = normalizeAddress(recipientId) ?? recipientId;
    const chatGuid = this.dmChats.get(to);
    if (chatGuid) return this.sendText(chatGuid, text, opts);
    // No 1:1 chat seen yet (e.g. a sign-up confirmation): chat/new creates or reuses it and sends.
    const tempGuid = randomUUID();
    const json = await this.opts.http.request("POST", "/api/v1/chat/new", "chat-new", {
      addresses: [to],
      message: clip(text),
      method: this.opts.method ?? "apple-script",
      tempGuid,
    });
    const data = (json.data ?? {}) as Raw;
    if (typeof data.guid === "string") this.dmChats.set(to, data.guid);
    const first = Array.isArray(data.messages) ? (data.messages[0] as Raw | undefined) : undefined;
    return { messageId: typeof first?.guid === "string" ? first.guid : tempGuid };
  }

  async sendGroup(conversationId: string, text: string, opts?: SendOptions): Promise<SendResult> {
    return this.sendText(conversationId, text, opts);
  }

  private async sendText(chatGuid: string, text: string, opts?: SendOptions): Promise<SendResult> {
    const method = this.opts.method ?? "apple-script";
    const tempGuid = randomUUID();
    const json = await this.opts.http.request("POST", "/api/v1/message/text", "message-text", {
      chatGuid,
      tempGuid,
      message: clip(text),
      method,
      // Replies are a Private API feature; BlueBubbles forces private-api when this is set.
      ...(this.opts.inlineReplies && method === "private-api" && opts?.replyTo
        ? { selectedMessageGuid: opts.replyTo }
        : {}),
    });
    const data = (json.data ?? {}) as Raw;
    return { messageId: typeof data.guid === "string" && data.guid ? data.guid : tempGuid };
  }

  private parse(rawEvent: unknown): {
    guid: string;
    sender: string;
    chatGuid: string;
    isGroup: boolean;
    participants: string[];
    text: string;
    timestamp: string;
  } | null {
    if (!isObj(rawEvent) || rawEvent.type !== "new-message" || !isObj(rawEvent.data)) return null;
    const m = rawEvent.data;
    if (m.isFromMe === true) return null; // our own sends echo back as new-message
    // Tapbacks/reactions and group events (renames, member changes) are not chat messages.
    if (
      m.associatedMessageType !== undefined &&
      m.associatedMessageType !== null &&
      m.associatedMessageType !== 0
    )
      return null;
    if (typeof m.itemType === "number" && m.itemType !== 0) return null;

    const guid = str(m.guid);
    const handle = isObj(m.handle) ? str(m.handle.address) : null;
    const chat = Array.isArray(m.chats) && isObj(m.chats[0]) ? m.chats[0] : null;
    const chatGuid = chat ? str(chat.guid) : null;
    if (!guid || !handle || !chatGuid) return null;
    const sender = normalizeAddress(handle) ?? handle.toLowerCase();
    if (this.bot.has(sender)) return null;

    const isGroup = chat!.style === GROUP_STYLE || (chat!.style !== DM_STYLE && chatGuid.includes(";+;"));
    const ms = typeof m.dateCreated === "number" ? m.dateCreated : Date.parse(String(m.dateCreated ?? ""));
    const text = typeof m.text === "string" ? m.text.replace(OBJECT_REPLACEMENT, "").trim() : "";
    return {
      guid,
      sender,
      chatGuid,
      isGroup,
      participants: isGroup ? this.participants(chat!.participants) : [],
      text,
      timestamp: Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString(),
    };
  }

  private participants(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    const out = new Set<string>();
    for (const p of list) {
      const addr = isObj(p) ? str(p.address) : typeof p === "string" ? p : null;
      if (!addr) continue;
      const n = normalizeAddress(addr) ?? addr.toLowerCase();
      if (!this.bot.has(n)) out.add(n);
    }
    return [...out];
  }
}

const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const clip = (t: string) => (t.length > MAX_CONTENT ? `${t.slice(0, MAX_CONTENT - 1)}…` : t);
