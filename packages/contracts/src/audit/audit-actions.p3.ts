// Audit actions owned by P3 (memory, consent, broker). Additive only.
export const AUDIT_ACTIONS_P3 = [
  "context.granted",
  "context.denied",
  "context.needs_consent",
  "disclose.allowed",
  "disclose.denied",
  "consent.granted",
  "consent.revoked",
  "memory.forgotten",
  "consent.requested",
  "consent.declined",
  "memory.settings_updated",
  "memory.provisioned",
  "memory.deleted_user",
  "memory.member_content_removed",
] as const;
