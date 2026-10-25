import {
  type Audience,
  type AuditLog,
  CONTEXT_FIELDS_BY_PURPOSE,
  type Clock,
  type ConsentService,
  type ContextPurpose,
  HarnessError,
  type MemoryKind,
  type MemorySettings,
  parseAgentId,
  personalAgentId,
} from "@campus/contracts";
import type { DefaultBucketProvisioner } from "./buckets";
import type { Directory, TaskInfo } from "./directory";
import { CLASS_POLICIES, FIELD_TEXT, PURPOSE_TEXT, classify } from "./fields";
import type { ConsentRequestRow, ContextRepo } from "./repo";
import type { ConsentGrant, ConsentRequestView, GrantInput } from "./types";

// Consent (spec 5.4 + grants). Postgres is the system of record. Every mutating call takes
// `actingUserId` from an authenticated web session (P2) — never from chat text — and only ever acts on
// that user's own grants and settings.

const KINDS: MemoryKind[] = ["preference", "fact", "conversation", "feedback", "decision"];

export class DefaultConsentService implements ConsentService {
  constructor(
    private readonly deps: {
      repo: ContextRepo;
      directory: Directory;
      provisioner: DefaultBucketProvisioner;
      audit: AuditLog;
      clock: Clock;
    },
  ) {}

  getMemorySettings(userId: string): Promise<MemorySettings> {
    return this.deps.repo.getMemorySettings(userId);
  }

  /** Standing grants only (no task context here) covering every field for this audience. */
  async hasActiveGrant(
    userId: string,
    purpose: ContextPurpose,
    audience: Audience,
    fields: string[],
  ): Promise<boolean> {
    const grants = (await this.deps.repo.liveGrants(userId, purpose, this.deps.clock.now())).filter(
      (g) => g.taskId === null,
    );
    const want = normalizeAudience(audience);
    if (!want) return false;
    return fields.every((f) =>
      grants.some(
        (g) =>
          g.allowedFields.includes(f) &&
          g.audienceKind === want.kind &&
          (g.audienceId === want.id || (want.kind === "group" && g.audienceId === "group:*")),
      ),
    );
  }

  // ---- consent page (P2 UI) -------------------------------------------------------------------

  async listPending(actingUserId: string): Promise<ConsentRequestView[]> {
    return (await this.deps.repo.pendingConsentRequests(actingUserId)).map(toView);
  }

  listGrants(actingUserId: string): Promise<ConsentGrant[]> {
    return this.deps.repo.listGrants(actingUserId);
  }

  /** One grant per field, so each can be revoked on its own. */
  async approve(
    requestId: string,
    actingUserId: string,
    options: { standing?: boolean; allMyGroups?: boolean; ttlMs?: number } = {},
  ): Promise<ConsentGrant[]> {
    const { repo } = this.deps;
    const now = this.deps.clock.now();
    const request = await repo.getConsentRequest(requestId);
    if (!request || request.user_id !== actingUserId)
      throw new HarnessError("consent_request_not_found", "consent request not found");
    const task = request.task_id ? await this.activeTask(request.task_id) : null;
    if (!(await repo.resolveConsentRequest(request.id, "approved", now))) {
      throw new HarnessError("consent_request_not_pending", "consent request already resolved");
    }
    const grants: ConsentGrant[] = [];
    for (const field of request.fields) {
      const policy = CLASS_POLICIES[classify(field)!.dataClass];
      // Task-less requests (disclose checks) can only be satisfied by a standing grant.
      const standing = (options.standing === true || !task) && policy.grantScope === "standing_or_task";
      const audienceId =
        standing && options.allMyGroups && request.audience_kind === "group"
          ? "group:*"
          : request.audience_id;
      grants.push(
        await repo.insertGrant({
          userId: actingUserId,
          purpose: request.purpose,
          audienceKind: request.audience_kind,
          audienceId,
          taskId: standing ? null : task!.id,
          allowedFields: [field],
          expiresAt: new Date(
            now.getTime() + Math.min(options.ttlMs ?? policy.maxGrantTtlMs, policy.maxGrantTtlMs),
          ),
          createdAt: now,
        }),
      );
    }
    await this.audit(actingUserId, "consent.granted", `consent_request:${request.id}`, {
      fields: request.fields,
      grantIds: grants.map((g) => g.id),
      standing: grants.map((g) => g.taskId === null),
    });
    return grants;
  }

  async decline(requestId: string, actingUserId: string): Promise<void> {
    const request = await this.deps.repo.getConsentRequest(requestId);
    if (!request || request.user_id !== actingUserId)
      throw new HarnessError("consent_request_not_found", "consent request not found");
    if (!(await this.deps.repo.resolveConsentRequest(request.id, "declined", this.deps.clock.now()))) {
      throw new HarnessError("consent_request_not_pending", "consent request already resolved");
    }
    await this.audit(actingUserId, "consent.declined", `consent_request:${request.id}`, {
      fields: request.fields,
    });
  }

  /** Proactive grant from the settings page (e.g. at onboarding: "use my food preferences for group meals"). */
  async grant(actingUserId: string, input: GrantInput): Promise<ConsentGrant[]> {
    const now = this.deps.clock.now();
    if (!input.fields.length) throw new HarnessError("invalid_grant", "no fields");
    if (!(input.ttlMs > 0)) throw new HarnessError("invalid_grant", "ttl must be positive");
    const audience = normalizeAudience(input.audience);
    if (!audience) throw new HarnessError("invalid_grant", "invalid audience");

    const task = input.taskId ? await this.activeTask(input.taskId) : null;
    if (
      task?.conversationId &&
      !(await this.deps.directory.verifiedMembers(task.conversationId)).has(actingUserId)
    ) {
      throw new HarnessError("invalid_grant", "not a member of the task's conversation");
    }
    if (task && audience.kind === "group" && audience.id !== `group:${task.conversationId}`) {
      throw new HarnessError("invalid_grant", "audience is not the task's group");
    }
    if (audience.id === "group:*" && task)
      throw new HarnessError("invalid_grant", "group:* requires a standing grant");

    const grants: ConsentGrant[] = [];
    for (const field of new Set(input.fields)) {
      const info = classify(field);
      if (!info) throw new HarnessError("invalid_grant", `unknown field: ${field}`);
      if (info.field && !CONTEXT_FIELDS_BY_PURPOSE[input.purpose].includes(info.field)) {
        throw new HarnessError("invalid_grant", `field not allowed for purpose: ${field}`);
      }
      // Registry rule: non-shareable fields only ever go to the user's own agent.
      if (!info.shareable && !(audience.kind === "agent" && audience.id === personalAgentId(actingUserId))) {
        throw new HarnessError("invalid_grant", `field is not shareable: ${field}`);
      }
      const policy = CLASS_POLICIES[info.dataClass];
      if (policy.grantScope === "task_only" && !task)
        throw new HarnessError("invalid_grant", `task required: ${field}`);
      grants.push(
        await this.deps.repo.insertGrant({
          userId: actingUserId,
          purpose: input.purpose,
          audienceKind: audience.kind,
          audienceId: audience.id,
          taskId: task?.id ?? null,
          allowedFields: [field],
          expiresAt: new Date(now.getTime() + Math.min(input.ttlMs, policy.maxGrantTtlMs)),
          createdAt: now,
        }),
      );
    }
    await this.audit(actingUserId, "consent.granted", `user:${actingUserId}`, {
      purpose: input.purpose,
      fields: input.fields,
      grantIds: grants.map((g) => g.id),
    });
    return grants;
  }

  /** Stops future use at once (the broker re-checks every request). Cannot recall what was already shown. */
  async revoke(grantId: string, actingUserId: string): Promise<void> {
    const grant = await this.deps.repo.getGrant(grantId);
    if (!grant || grant.userId !== actingUserId) throw new HarnessError("grant_not_found", "grant not found");
    await this.deps.repo.revokeGrant(grant.id, this.deps.clock.now());
    await this.audit(actingUserId, "consent.revoked", `grant:${grant.id}`, { fields: grant.allowedFields });
  }

  async updateMemorySettings(
    actingUserId: string,
    patch: Partial<Omit<MemorySettings, "userId">>,
  ): Promise<MemorySettings> {
    const { userId: _ignored, ...current } = await this.deps.repo.getMemorySettings(actingUserId);
    const next = { ...current, ...patch };
    if (!next.allowedKinds.every((k) => KINDS.includes(k)))
      throw new HarnessError("invalid_grant", "invalid memory kind");
    if (next.retentionDays !== null && !(Number.isInteger(next.retentionDays) && next.retentionDays > 0)) {
      throw new HarnessError("invalid_grant", "invalid retention");
    }
    await this.deps.repo.upsertMemorySettings(actingUserId, next, this.deps.clock.now());
    if (next.sensitiveBucketsEnabled !== current.sensitiveBucketsEnabled) {
      await this.deps.provisioner.setSensitiveBuckets(actingUserId, next.sensitiveBucketsEnabled);
    }
    await this.audit(actingUserId, "memory.settings_updated", `user:${actingUserId}`, {
      changed: Object.keys(patch),
    });
    return { userId: actingUserId, ...next };
  }

  private async activeTask(taskId: string): Promise<TaskInfo> {
    const task = await this.deps.directory.task(taskId);
    if (!task || !task.active) throw new HarnessError("invalid_grant", "task is not active");
    return task;
  }

  private audit(
    userId: string,
    action: "consent.granted" | "consent.declined" | "consent.revoked" | "memory.settings_updated",
    resource: string,
    detail: Record<string, unknown>,
  ) {
    return this.deps.audit.record({ action, actorUserId: userId, resource, policyResult: "ok", detail });
  }
}

/** Grants store `group:<conversationId>`, `group:*`, or an agent id. */
function normalizeAudience(a: Audience): { kind: "group" | "agent"; id: string } | null {
  if (a.kind === "group") {
    const parsed = parseAgentId(a.id);
    if (a.id === "group:*") return { kind: "group", id: a.id };
    return { kind: "group", id: parsed?.kind === "group" ? a.id : `group:${a.id}` };
  }
  return parseAgentId(a.id) ? { kind: "agent", id: a.id } : null;
}

function toView(r: ConsentRequestRow): ConsentRequestView {
  const what = r.fields
    .map((f) => {
      const info = classify(f);
      return info?.field
        ? FIELD_TEXT[info.field]
        : `results from ${f.replace(/^tool:/, "").replace("__", " / ")}`;
    })
    .join("; ");
  const who =
    r.audience_kind === "group"
      ? "this group"
      : r.audience_id.startsWith("personal:")
        ? "your assistant"
        : "another assistant";
  const purpose = r.purpose as ContextPurpose;
  return {
    id: r.id,
    userId: r.user_id,
    taskId: r.task_id,
    requesterAgentId: r.requester_agent_id,
    purpose,
    audience: { kind: r.audience_kind, id: r.audience_id },
    fields: r.fields,
    status: r.status,
    summary: `Let ${who} use ${what}, for ${PURPOSE_TEXT[purpose] ?? "a task"}. Only that answer is used — never your messages or memories.`,
    createdAt: r.created_at.toISOString(),
  };
}
