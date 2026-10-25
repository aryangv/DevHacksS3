import type {
  AuthDecision,
  Conversation,
  ConversationMember,
  ConversationType,
  MembershipChange,
  NudgeResult,
  ResolvedIdentity,
} from "../schemas/identity";
import type { InboundMessage, Platform, SendOptions, SendResult } from "../schemas/messaging";

// Interfaces implemented by P2 (front door): MessagingAdapter, IdentityService, AuthGate,
// NudgeService, MembershipService. P1 calls them from the pipeline; P1 ships in-memory fakes.

/** spec Section 7. */
export interface MessagingAdapter {
  readonly platform: Platform;
  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean;
  normalize(rawEvent: unknown): InboundMessage | null;
  /** Plain text only. Implementations throttle, keep sticky from_number, honour pre-reply limits. */
  sendDM(recipientId: string, text: string, opts?: SendOptions): Promise<SendResult>;
  sendGroup(conversationId: string, text: string, opts?: SendOptions): Promise<SendResult>;
}

/** spec 4.3: identities and verification state. */
export interface IdentityService {
  /** Look up (platform, externalId); unknown → insert as `unverified`. Records that they messaged the line. */
  resolveSender(platform: Platform, externalId: string): Promise<ResolvedIdentity>;
  getUser(userId: string): Promise<{
    userId: string;
    displayName: string | null;
    status: "active" | "suspended" | "deleted";
  } | null>;
  /** The verified external id to reach this user 1:1 on `platform`, or null. */
  getPrimaryExternalId(userId: string, platform: Platform): Promise<string | null>;
}

/** spec 4.2 step 4, 4.3 group activation, join/leave. */
export interface MembershipService {
  ensureConversation(
    platform: Platform,
    providerConversationId: string,
    type: ConversationType,
  ): Promise<Conversation>;
  /** Reconcile members with the provider's participant list (joins/leaves; sets left_at). */
  syncParticipants(conversationId: string, participantExternalIds: string[]): Promise<MembershipChange>;
  isActiveMember(conversationId: string, externalIdentityId: string): Promise<boolean>;
  listActiveMembers(conversationId: string): Promise<ConversationMember[]>;
  /** A verified member addressed the agent → group becomes active (records activated_by_user_id). */
  activate(conversationId: string, byUserId: string): Promise<Conversation>;
}

/** spec 4.3: default deny. No verified identity → no model call. */
export interface AuthGate {
  check(input: {
    identity: ResolvedIdentity;
    conversation: Conversation;
    /** Whether the message addresses the agent (DM, mention, invocation phrase). Computed by the router. */
    addressed: boolean;
  }): Promise<AuthDecision>;
}

/** spec 4.3 nudge rules: only when addressed, rate-limited, Sendblue channel rules, no private info. */
export interface NudgeService {
  maybeNudge(input: {
    identity: ResolvedIdentity;
    conversation: Conversation;
    inbound: InboundMessage;
  }): Promise<NudgeResult>;
}
