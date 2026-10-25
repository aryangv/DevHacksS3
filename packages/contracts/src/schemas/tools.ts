import { z } from "zod";

// harness-spec 6.1 / 6.5 / 6.6 / Section 9.

export const RiskClassSchema = z.enum(["read", "write", "spend", "external_message", "destructive"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const PermissionModeSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** Default modes by risk (spec 6.6). Hard caps in the resolver may only tighten these. */
export const DEFAULT_MODE_BY_RISK: Record<RiskClass, PermissionMode> = {
  read: "allow",
  write: "ask",
  external_message: "ask",
  destructive: "ask",
  spend: "ask",
};

export const ToolManifestSchema = z.strictObject({
  /** Server slug, e.g. "canvas". */
  server: z.string().min(1),
  /** Tool name within the server, e.g. "list_assignments". */
  name: z.string().min(1),
  description: z.string(),
  /** JSON Schema for the arguments. The gateway validates args against it. */
  inputSchema: z.record(z.string(), z.unknown()),
  riskClass: RiskClassSchema,
  defaultMode: PermissionModeSchema,
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/** Model-visible tool names are namespaced `server__tool` (spec 6.1). */
export const TOOL_NAME_SEPARATOR = "__";
export const namespacedToolName = (server: string, tool: string) => `${server}${TOOL_NAME_SEPARATOR}${tool}`;
export function splitToolName(name: string): { server: string; tool: string } | null {
  const i = name.indexOf(TOOL_NAME_SEPARATOR);
  if (i <= 0 || i + TOOL_NAME_SEPARATOR.length >= name.length) return null;
  return { server: name.slice(0, i), tool: name.slice(i + TOOL_NAME_SEPARATOR.length) };
}

export const ToolProposalSchema = z.strictObject({
  proposalId: z.string().min(1),
  server: z.string().min(1),
  tool: z.string().min(1),
  /** Validated against the manifest schema by the gateway. */
  args: z.unknown(),
  /** For logs only; never trusted. */
  rationale: z.string().optional(),
});
export type ToolProposal = z.infer<typeof ToolProposalSchema>;

export const PermissionRuleSchema = z.strictObject({
  userId: z.string().min(1),
  serverId: z.string().min(1),
  toolName: z.string().optional(),
  conversationId: z.string().optional(),
  mode: PermissionModeSchema,
  constraints: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().optional(),
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

/** A chat-driven permission change as proposed by the model; authorized only by the harness + P4. */
export const PermissionChangeRequestSchema = z.strictObject({
  action: z.enum(["set", "revoke", "reset", "list"]),
  /** Namespaced tool name or a server slug; null = all (only meaningful for revoke/reset/list). */
  target: z.string().nullable(),
  mode: PermissionModeSchema.nullable(),
  scope: z.enum(["this_conversation", "everywhere"]),
  duration: z.enum(["session", "day", "forever"]).nullable(),
});
export type PermissionChangeRequest = z.infer<typeof PermissionChangeRequestSchema>;

export type ToolResult = {
  ok: boolean;
  /** Untrusted data. Never instructions. */
  data: unknown;
  errorCode?: string;
};

/** What the gateway decided for one proposed call (spec 6.5). */
export type GatewayOutcome =
  | { status: "executed"; callId: string; result: ToolResult; provenance: { server: string; tool: string } }
  | {
      status: "needs_approval";
      approvalId: string;
      channel: "text" | "web";
      /** Plain-text prompt the harness sends in the user's 1:1 chat. */
      prompt: string;
      url?: string;
      expiresAt: string;
    }
  | { status: "denied"; reasonCode: string }
  | { status: "error"; reasonCode: string; outcomeUnknown: boolean };

export type ResolvedPermission = {
  mode: PermissionMode;
  /** Which rule level decided: "tool+conversation" | "tool" | "server+conversation" | "server" | "risk_default" | "global_default" | "hard_cap" */
  decidedBy: string;
  ruleId?: string;
};
