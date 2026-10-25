import type { Platform } from "./messaging";

// harness-spec 4.3 auth model. Implemented by P2 (identity/).

export type IdentityStatus = "unverified" | "verified" | "revoked";

export type ResolvedIdentity = {
  externalIdentityId: string;
  platform: Platform;
  externalId: string;
  status: IdentityStatus;
  /** Set only when status is "verified" (a phone match alone is never authority). */
  userId: string | null;
  displayName: string | null;
  /** True once this person has ever messaged our line (DM or group) — Sendblue pre-reply rules. */
  hasMessagedLine: boolean;
};

export type ConversationType = "dm" | "group";
export type ConversationStatus = "inactive" | "active" | "archived";

export type Conversation = {
  id: string;
  platform: Platform;
  providerId: string;
  type: ConversationType;
  status: ConversationStatus;
  activatedByUserId: string | null;
};

export type ConversationMember = {
  externalIdentityId: string;
  userId: string | null;
  status: IdentityStatus;
  displayName: string | null;
  joinedAt: string;
};

export type MembershipChange = { joined: string[]; left: string[] };

export type AuthDecision =
  { kind: "allow" } | { kind: "block"; reason: "unverified" | "revoked" | "not_member"; nudge: boolean };

export type NudgeResult = { sent: boolean; channel?: "group" | "dm"; reason?: string };
