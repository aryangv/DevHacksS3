import { AUDIT_ACTIONS_P1 } from "./audit-actions.p1";
import { AUDIT_ACTIONS_P2 } from "./audit-actions.p2";
import { AUDIT_ACTIONS_P3 } from "./audit-actions.p3";
import { AUDIT_ACTIONS_P4 } from "./audit-actions.p4";

export { AUDIT_ACTIONS_P1, AUDIT_ACTIONS_P2, AUDIT_ACTIONS_P3, AUDIT_ACTIONS_P4 };

export const AUDIT_ACTIONS = [
  ...AUDIT_ACTIONS_P1,
  ...AUDIT_ACTIONS_P2,
  ...AUDIT_ACTIONS_P3,
  ...AUDIT_ACTIONS_P4,
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
