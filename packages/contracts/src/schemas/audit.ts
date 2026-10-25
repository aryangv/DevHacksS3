import type { AuditAction } from "../audit";

// core.audit_events. No secrets, no private values in `detail` (spec 12).

export type AuditEvent = {
  id?: string;
  action: AuditAction;
  actorUserId?: string | null;
  resource?: string | null;
  /** allow | ask | deny | approved | denied | needs_consent | ok | error | ... */
  policyResult?: string | null;
  detail?: Record<string, unknown>;
  turnId?: string | null;
  conversationId?: string | null;
  createdAt?: string;
};

export type AuditQuery = {
  turnId?: string;
  conversationId?: string;
  actorUserId?: string;
  action?: AuditAction;
  limit?: number;
};
