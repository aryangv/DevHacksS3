import type { PermissionChangeRequest } from "./tools";

// harness-spec 4.2 step 10 and 6.6 approval channels. Implemented by P4 (approvals/).

export type ApprovalKind = "tool_ask" | "permission_change" | "spend_handoff";
export type ApprovalStatus = "pending" | "approved" | "declined" | "expired";

export type TextReplyResolution =
  | { matched: false }
  | {
      matched: true;
      approvalId: string;
      kind: ApprovalKind;
      decision: "approved" | "declined" | "expired" | "invalid";
      /** Plain-text acknowledgement to send back in the same 1:1 chat. */
      message: string;
    };

export type PermissionChangeOutcome =
  | { status: "applied"; message: string }
  | { status: "needs_confirmation"; approvalId: string; prompt: string; expiresAt: string }
  | { status: "rejected"; reasonCode: string; message: string };

export type SpendHandoffRequest = {
  taskId: string;
  payerUserId: string;
  /** Human-readable summary of exactly what is being approved. */
  summary: string;
  quoteId?: string;
};

export type SpendHandoff = { approvalId: string; url: string; expiresAt: string; sandbox: boolean };

export type { PermissionChangeRequest };
