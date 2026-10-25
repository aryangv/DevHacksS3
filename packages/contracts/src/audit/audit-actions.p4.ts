// Audit actions owned by P4 (tools, permissions, vault, approvals). Additive only.
export const AUDIT_ACTIONS_P4 = [
  "tool.call",
  "permission.changed",
  "permission.change_rejected",
  "approval.created",
  "approval.decided",
  "connection.connected",
  "connection.revoked",
] as const;
