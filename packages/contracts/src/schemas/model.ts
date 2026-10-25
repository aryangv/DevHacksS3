import { z } from "zod";
import { GroupMealParamsSchema } from "./coordination";
import { PermissionChangeRequestSchema } from "./tools";

// harness-spec 4.4: the model outputs structured proposals; free text is only the reply body.
// Every object is strict: an unexpected key (e.g. a model-chosen `userId`, `namespace` or
// `conversationId`) makes the whole output invalid, which triggers one retry and then fails safe.

export const ReplyProposalSchema = z.strictObject({
  kind: z.literal("reply"),
  /** Plain text. Markdown is stripped by the reply formatter regardless. */
  text: z.string(),
});

export const ToolCallProposalSchema = z.strictObject({
  kind: z.literal("tool_call"),
  /** Namespaced `server__tool` as listed in the visible tool catalog. */
  tool: z.string().min(1),
  /** JSON-encoded arguments object. Parsed and validated by the gateway against the manifest. */
  argsJson: z.string(),
  /** For logs only; never trusted. */
  rationale: z.string().nullable(),
});

export const PermissionChangeProposalSchema = z.strictObject({
  kind: z.literal("permission_change"),
  change: PermissionChangeRequestSchema,
});

export const StartTaskProposalSchema = z.strictObject({
  kind: z.literal("start_task"),
  taskType: z.literal("group_meal"),
  params: GroupMealParamsSchema,
});

export const ConfirmTaskProposalSchema = z.strictObject({ kind: z.literal("confirm_task") });
export const CancelTaskProposalSchema = z.strictObject({ kind: z.literal("cancel_task") });

export const ModelProposalSchema = z.discriminatedUnion("kind", [
  ReplyProposalSchema,
  ToolCallProposalSchema,
  PermissionChangeProposalSchema,
  StartTaskProposalSchema,
  ConfirmTaskProposalSchema,
  CancelTaskProposalSchema,
]);
export type ModelProposal = z.infer<typeof ModelProposalSchema>;
export type ProposalKind = ModelProposal["kind"];

export const ModelStepOutputSchema = z.strictObject({
  proposals: z.array(ModelProposalSchema).max(8),
});
export type ModelStepOutput = z.infer<typeof ModelStepOutputSchema>;

/**
 * Tags the harness uses to wrap untrusted content in prompts (spec 2.4, 4.4, 6.7). Content inside these
 * tags is data, never instructions. Shared so scripted fake models can parse prompts in tests.
 */
export const PROMPT_TAGS = {
  data: "data",
  message: "message",
  toolResult: "tool_result",
} as const;

// ---- provider-neutral model client contract (spec 4.4 "one ModelClient interface") ----

export type ModelMessage = { role: "user" | "assistant"; content: string };

export type ModelRequest = {
  system: string;
  messages: ModelMessage[];
  /** JSON Schema the provider should constrain output to, if it supports structured output. */
  outputSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  timeoutMs: number;
  /** For tracing only. */
  metadata: { turnId: string; purpose: string };
};

export type ModelResponse = {
  text: string;
  stopReason: "end" | "max_tokens" | "refusal" | "other";
  usage: { inputTokens: number; outputTokens: number };
  model: string;
};
