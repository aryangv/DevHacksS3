// Task state (core.agent_tasks / core.coordination_events). Owned by P1 (TaskStore).

export type TaskOwnerType = "user" | "group";

/** Generic statuses; workflows may use their own strings, but these are understood by the runtime. */
export const TERMINAL_TASK_STATUSES = [
  "completed",
  "cancelled",
  "failed",
  "expired",
  "no_consensus",
] as const;

export type AgentTask<State = Record<string, unknown>> = {
  id: string;
  ownerType: TaskOwnerType;
  ownerId: string;
  conversationId: string | null;
  type: string;
  status: string;
  state: State;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type NewTask<State = Record<string, unknown>> = {
  ownerType: TaskOwnerType;
  ownerId: string;
  conversationId: string | null;
  type: string;
  status: string;
  state: State;
};

export type CoordinationEvent = {
  id: string;
  taskId: string;
  fromAgent: string;
  toAgent: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

// ---- group_meal task state (dinner slice) ----

export type GroupMealStatus =
  "collecting" | "proposed" | "decided" | "handed_off" | "no_consensus" | "cancelled" | "failed";

export type GroupMealState = {
  params: { budgetPerPersonMinor: number | null; cuisine: string | null; notes: string | null };
  invokedByUserId: string;
  options: Array<{
    id: string;
    name: string;
    cuisine: string;
    pricePerPersonMinor: number;
    currency: string;
    distanceMeters?: number;
    tags: string[];
  }>;
  round: number;
  proposal?: {
    optionId: string;
    acceptCount: number;
    respondents: number;
    waitingOn: string[];
    /** The proposal message we sent; a 👍 on exactly this message confirms. */
    messageId?: string;
  };
  decision?: { optionId: string; decidedByUserId: string; decidedAt: string };
  handoff?: { approvalId: string; payerUserId: string; sandbox: boolean };
  /** Item-level group order built from each member's agent's picks (additive, P2 contribution). */
  order?: {
    restaurant: string;
    currency: string;
    lines: Array<{
      userId: string;
      name: string | null;
      items: Array<{ itemId: string; name: string; quantity: number; priceMinor: number }>;
      subtotalMinor: number;
    }>;
    /** Members whose agent picked nothing (no acceptable item, or no answer). */
    notIncluded: string[];
    totalMinor: number;
    payerUserId: string;
    /** Each non-payer owes the payer their own subtotal. */
    splits: Array<{ userId: string; name: string | null; owesMinor: number }>;
  };
};
