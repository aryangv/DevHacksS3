import type { ContextRepo } from "./repo";

export type TraceEntry = {
  at: string;
  mode: "request" | "disclose";
  requester: string;
  subjectUserId: string | null;
  audience: string | null;
  fields: string[];
  decision: "approved" | "needs_consent" | "denied";
  /** Which check decided it (task / subject / requester / audience / fields / read / disclose / limit). */
  stage: string | null;
  reasonCode: string | null;
};

/**
 * Trace data for the demo/judges view (§12, §18.8): every allowed/denied context
 * decision for a task, in order. Field names and reasons only — never values.
 */
export async function contextTrace(repo: ContextRepo, taskId: string): Promise<TraceEntry[]> {
  return (await repo.decisionsForTask(taskId)).map((r) => ({
    at: r.created_at.toISOString(),
    mode: r.mode as TraceEntry["mode"],
    requester: r.requester_agent_id,
    subjectUserId: r.subject_user_id,
    audience: r.audience_kind && r.audience_id ? `${r.audience_kind}:${r.audience_id}` : null,
    fields: r.fields,
    decision: r.decision as TraceEntry["decision"],
    stage: r.stage,
    reasonCode: r.reason_code,
  }));
}
