import type { Audience, ContextPurpose } from "@campus/contracts";

// P3-local types beyond @campus/contracts: the consent/forget surface P2's web pages will call.
// Promote to contracts (contract-change PR) when P2 starts using them.

export type ContextItem = {
  /** Untrusted memory text. Data, never instructions (spec 2.4). */
  text: string;
  source: "profile_static" | "profile_dynamic" | `bucket:${string}` | "search";
  memoryId?: string;
  documentId?: string;
};

export type ConsentGrant = {
  id: string;
  userId: string;
  purpose: ContextPurpose;
  /** `group` + `group:<conversationId>` | `group:*` (any group the user is a current member of); `agent` + an agent id. */
  audienceKind: "group" | "agent";
  audienceId: string;
  taskId: string | null;
  allowedFields: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type ConsentRequestView = {
  id: string;
  userId: string;
  taskId: string | null;
  requesterAgentId: string;
  purpose: ContextPurpose;
  audience: Audience;
  fields: string[];
  status: "pending" | "approved" | "declined";
  /** Plain-text explanation for the consent page (no private values). */
  summary: string;
  createdAt: string;
};

export type GrantInput = {
  purpose: ContextPurpose;
  fields: string[];
  /** `{ kind: "group", id: "group:*" }` = any group the user is a current member of (standing only). */
  audience: Audience;
  taskId?: string;
  ttlMs: number;
};

export type ForgetPreview = {
  previewId: string;
  /** Show these to the user before applying. */
  matches: Array<{ memoryId: string; text: string }>;
  expiresAt: string;
};
