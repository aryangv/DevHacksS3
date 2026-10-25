// Audit actions owned by P2 (front door: identity, auth gate, nudges, membership). Additive only.
export const AUDIT_ACTIONS_P2 = [
  "identity.created",
  "identity.verified",
  "identity.revoked",
  "nudge.sent",
  "nudge.suppressed",
  "membership.joined",
  "membership.left",
  "conversation.activated",
] as const;
