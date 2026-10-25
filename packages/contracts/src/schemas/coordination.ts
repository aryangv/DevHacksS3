import { z } from "zod";

// harness-spec 4.6 internal agent coordination. Agents never chat free text; they exchange these forms.

export const CoordinationRequestTypeSchema = z.enum(["evaluate_option", "share_constraint", "offer_help"]);

export const CoordinationRequestSchema = z.strictObject({
  taskId: z.string().min(1),
  requesterAgentId: z.string().min(1),
  targetAgentId: z.string().min(1),
  requestType: CoordinationRequestTypeSchema,
  purpose: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  expiresAt: z.string(),
});
export type CoordinationRequest = z.infer<typeof CoordinationRequestSchema>;

export const CoordinationResponseSchema = z.strictObject({
  taskId: z.string().min(1),
  status: z.enum(["accepted", "rejected", "counteroffer", "needs_consent"]),
  /** Approved, task-scoped facts only; never raw memory. */
  payload: z.record(z.string(), z.unknown()),
  reasonCode: z.string().optional(),
});
export type CoordinationResponse = z.infer<typeof CoordinationResponseSchema>;

/** Agent ids are structural so the harness, not the model, decides who is addressed. */
export const personalAgentId = (userId: string) => `personal:${userId}`;
export const groupAgentId = (conversationId: string) => `group:${conversationId}`;
export function parseAgentId(agentId: string): { kind: "personal" | "group"; id: string } | null {
  const m = /^(personal|group):(.+)$/.exec(agentId);
  return m ? { kind: m[1] as "personal" | "group", id: m[2]! } : null;
}

// ---- group_meal payloads (dinner vertical slice, spec 4.6.1) ----

export const MealOptionSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  cuisine: z.string(),
  pricePerPersonMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  distanceMeters: z.number().nonnegative().optional(),
  tags: z.array(z.string()).default([]),
});
export type MealOption = z.infer<typeof MealOptionSchema>;

export const EvaluateOptionsPayloadSchema = z.strictObject({
  options: z.array(MealOptionSchema).min(1),
  groupBudgetPerPersonMinor: z.number().int().positive().optional(),
});
export type EvaluateOptionsPayload = z.infer<typeof EvaluateOptionsPayloadSchema>;

/** The only thing a personal agent tells the group about an evaluation: which options it accepts. */
export const EvaluateOptionsAnswerSchema = z.strictObject({
  acceptedOptionIds: z.array(z.string()),
});
export type EvaluateOptionsAnswer = z.infer<typeof EvaluateOptionsAnswerSchema>;

export const ShareConstraintPayloadSchema = z.strictObject({
  fields: z.array(z.string().min(1)).min(1),
});

export const GroupMealParamsSchema = z.strictObject({
  budgetPerPersonMinor: z.number().int().positive().nullable(),
  cuisine: z.string().nullable(),
  notes: z.string().nullable(),
});
export type GroupMealParams = z.infer<typeof GroupMealParamsSchema>;
