import { z } from "zod";
import type { Platform } from "./messaging";

// The harness-injected context for one turn (spec 4.4: the model never chooses user_id,
// conversation_id, namespace, credentials or recipients). Consumed by P2/P3/P4 implementations.

export const ProvenanceSchema = z.enum(["user_dm", "group_message"]);
/** What triggered this turn. Only `user_dm` may authorize permission changes (spec 6.6). */
export type Provenance = z.infer<typeof ProvenanceSchema>;

export type AgentRef = { kind: "personal" | "group"; id: string };

export type TurnContext = {
  /** Stable across retries of the same inbound event (it is the inbound event id). */
  turnId: string;
  platform: Platform;
  conversationId: string;
  conversationType: "dm" | "group";
  providerConversationId: string;
  providerMessageId: string;
  /** Verified principal. Never model-supplied. */
  userId: string;
  externalIdentityId: string;
  agent: AgentRef;
  provenance: Provenance;
  receivedAt: string;
  /** Epoch ms after which the turn must stop (budget). */
  deadlineMs: number;
};

export type Budgets = {
  maxModelSteps: number;
  maxToolCalls: number;
  turnTimeoutMs: number;
  modelCallTimeoutMs: number;
  toolCallTimeoutMs: number;
  maxTokensPerTurn: number;
  maxOutputTokensPerCall: number;
};

export type TurnOutcomeStatus =
  | "replied"
  | "ignored"
  | "blocked_unverified"
  | "approval_resolved"
  | "budget_exhausted"
  | "failed_safe"
  | "duplicate";

export type TurnOutcome = {
  turnId: string;
  status: TurnOutcomeStatus;
  conversationId?: string;
  repliesSent: number;
  detail?: Record<string, unknown>;
};
