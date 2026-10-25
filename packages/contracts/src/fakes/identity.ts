import type {
  AuthGate,
  IdentityService,
  MembershipService,
  MessagingAdapter,
  NudgeService,
} from "../interfaces/p2";
import type {
  AuthDecision,
  Conversation,
  ConversationMember,
  ConversationType,
  IdentityStatus,
  MembershipChange,
  NudgeResult,
  ResolvedIdentity,
} from "../schemas/identity";
import type { InboundMessage, Platform } from "../schemas/messaging";
import { type Clock, newId, systemClock } from "../util/ids";

// In-memory fakes for P2's interfaces. Real implementations: @campus/identity (P2).

type IdentityRecord = ResolvedIdentity;

export class FakeIdentityService implements IdentityService {
  private readonly byKey = new Map<string, IdentityRecord>();
  private readonly users = new Map<string, { userId: string; displayName: string | null }>();

  /** Spec 18.3: "fake identity (all users verified)" by default. Tests flip this for the auth gate. */
  constructor(private readonly opts: { defaultStatus?: IdentityStatus } = {}) {}

  private key(platform: Platform, externalId: string) {
    return `${platform}:${externalId}`;
  }

  seedUser(input: {
    userId?: string;
    externalId: string;
    displayName?: string | null;
    verified?: boolean;
    platform?: Platform;
  }): IdentityRecord {
    const platform = input.platform ?? "imessage";
    const verified = input.verified ?? true;
    const userId = verified ? (input.userId ?? newId()) : null;
    const rec: IdentityRecord = {
      externalIdentityId: newId(),
      platform,
      externalId: input.externalId,
      status: verified ? "verified" : "unverified",
      userId,
      displayName: input.displayName ?? null,
      hasMessagedLine: false,
    };
    this.byKey.set(this.key(platform, input.externalId), rec);
    if (userId) this.users.set(userId, { userId, displayName: rec.displayName });
    return rec;
  }

  /** Simulates the Verify webhook completing (spec 4.3 onboarding step 5). */
  verify(
    externalId: string,
    opts: { userId?: string; displayName?: string; platform?: Platform } = {},
  ): IdentityRecord {
    const rec = this.ensure(opts.platform ?? "imessage", externalId);
    rec.status = "verified";
    rec.userId = rec.userId ?? opts.userId ?? newId();
    if (opts.displayName) rec.displayName = opts.displayName;
    this.users.set(rec.userId, { userId: rec.userId, displayName: rec.displayName });
    return rec;
  }

  revoke(externalId: string, platform: Platform = "imessage"): void {
    const rec = this.ensure(platform, externalId);
    rec.status = "revoked";
  }

  /** Look up or create without counting as "messaged the line". */
  ensure(platform: Platform, externalId: string): IdentityRecord {
    const k = this.key(platform, externalId);
    let rec = this.byKey.get(k);
    if (!rec) {
      const status = this.opts.defaultStatus ?? "verified";
      const userId = status === "verified" ? newId() : null;
      rec = {
        externalIdentityId: newId(),
        platform,
        externalId,
        status,
        userId,
        displayName: null,
        hasMessagedLine: false,
      };
      this.byKey.set(k, rec);
      if (userId) this.users.set(userId, { userId, displayName: null });
    }
    return rec;
  }

  byExternalIdentityId(id: string): IdentityRecord | undefined {
    for (const rec of this.byKey.values()) if (rec.externalIdentityId === id) return rec;
    return undefined;
  }

  async resolveSender(platform: Platform, externalId: string): Promise<ResolvedIdentity> {
    const rec = this.ensure(platform, externalId);
    rec.hasMessagedLine = true;
    return { ...rec };
  }

  async getUser(userId: string) {
    const u = this.users.get(userId);
    return u ? { ...u, status: "active" as const } : null;
  }

  async getPrimaryExternalId(userId: string, platform: Platform): Promise<string | null> {
    for (const rec of this.byKey.values()) {
      if (rec.userId === userId && rec.platform === platform && rec.status === "verified")
        return rec.externalId;
    }
    return null;
  }
}

export class FakeMembershipService implements MembershipService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly members = new Map<string, Map<string, { joinedAt: string; leftAt: string | null }>>();

  constructor(
    private readonly identity: FakeIdentityService,
    private readonly clock: Clock = systemClock,
  ) {}

  async ensureConversation(
    platform: Platform,
    providerConversationId: string,
    type: ConversationType,
  ): Promise<Conversation> {
    const k = `${platform}:${providerConversationId}`;
    let c = this.conversations.get(k);
    if (!c) {
      c = {
        id: newId(),
        platform,
        providerId: providerConversationId,
        type,
        status: type === "dm" ? "active" : "inactive",
        activatedByUserId: null,
      };
      this.conversations.set(k, c);
      this.members.set(c.id, new Map());
    }
    return { ...c };
  }

  async syncParticipants(
    conversationId: string,
    participantExternalIds: string[],
  ): Promise<MembershipChange> {
    const conv = [...this.conversations.values()].find((c) => c.id === conversationId);
    if (!conv) throw new Error(`unknown conversation ${conversationId}`);
    const roster = this.members.get(conversationId)!;
    const now = this.clock.now().toISOString();
    const present = new Set(
      participantExternalIds.map((x) => this.identity.ensure(conv.platform, x).externalIdentityId),
    );
    const change: MembershipChange = { joined: [], left: [] };
    for (const id of present) {
      const m = roster.get(id);
      if (!m || m.leftAt) {
        roster.set(id, { joinedAt: now, leftAt: null });
        change.joined.push(id);
      }
    }
    for (const [id, m] of roster) {
      if (!m.leftAt && !present.has(id)) {
        m.leftAt = now;
        change.left.push(id);
      }
    }
    return change;
  }

  async isActiveMember(conversationId: string, externalIdentityId: string): Promise<boolean> {
    const m = this.members.get(conversationId)?.get(externalIdentityId);
    return !!m && !m.leftAt;
  }

  async listActiveMembers(conversationId: string): Promise<ConversationMember[]> {
    const roster = this.members.get(conversationId) ?? new Map();
    const out: ConversationMember[] = [];
    for (const [id, m] of roster) {
      if (m.leftAt) continue;
      const rec = this.identity.byExternalIdentityId(id);
      if (!rec) continue;
      out.push({
        externalIdentityId: id,
        userId: rec.status === "verified" ? rec.userId : null,
        status: rec.status,
        displayName: rec.displayName,
        joinedAt: m.joinedAt,
      });
    }
    return out;
  }

  async activate(conversationId: string, byUserId: string): Promise<Conversation> {
    const conv = [...this.conversations.values()].find((c) => c.id === conversationId);
    if (!conv) throw new Error(`unknown conversation ${conversationId}`);
    if (conv.status !== "active") {
      conv.status = "active";
      conv.activatedByUserId = byUserId;
    }
    return { ...conv };
  }
}

export class FakeAuthGate implements AuthGate {
  async check(input: { identity: ResolvedIdentity; addressed: boolean }): Promise<AuthDecision> {
    if (input.identity.status === "verified" && input.identity.userId) return { kind: "allow" };
    if (input.identity.status === "revoked") return { kind: "block", reason: "revoked", nudge: false };
    return { kind: "block", reason: "unverified", nudge: input.addressed };
  }
}

/** Rate-limited nudges (once per identity per conversation per N hours), Sendblue channel rules simplified. */
export class FakeNudgeService implements NudgeService {
  readonly nudges: Array<{
    externalIdentityId: string;
    conversationId: string;
    channel: "group" | "dm";
    text: string;
    at: string;
  }> = [];

  constructor(
    private readonly messaging: MessagingAdapter,
    private readonly opts: { appOrigin?: string; intervalHours?: number; clock?: Clock } = {},
  ) {}

  async maybeNudge(input: {
    identity: ResolvedIdentity;
    conversation: Conversation;
    inbound: InboundMessage;
  }): Promise<NudgeResult> {
    const clock = this.opts.clock ?? systemClock;
    const intervalMs = (this.opts.intervalHours ?? 6) * 3_600_000;
    const last = [...this.nudges]
      .reverse()
      .find(
        (n) =>
          n.externalIdentityId === input.identity.externalIdentityId &&
          n.conversationId === input.conversation.id,
      );
    if (last && clock.now().getTime() - new Date(last.at).getTime() < intervalMs) {
      return { sent: false, reason: "rate_limited" };
    }
    const link = `${this.opts.appOrigin ?? "https://example.invalid"}/onboard`;
    let channel: "group" | "dm";
    let text: string;
    if (input.conversation.type === "group") {
      channel = "group";
      text = `Hi! Before I can help you here, please verify your number (takes a minute): ${link}`;
      await this.messaging.sendGroup(input.inbound.providerConversationId, text);
    } else {
      channel = "dm";
      text = input.identity.hasMessagedLine
        ? `Hi! Please verify your number before we chat: ${link}`
        : "Hi! Please verify your number before we chat. Ask a friend in your group for the sign-up link.";
      await this.messaging.sendDM(input.inbound.senderExternalId, text);
    }
    this.nudges.push({
      externalIdentityId: input.identity.externalIdentityId,
      conversationId: input.conversation.id,
      channel,
      text,
      at: clock.now().toISOString(),
    });
    return { sent: true, channel };
  }
}
