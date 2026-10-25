import {
  type Audience,
  type AuditLog,
  CONTEXT_FIELDS_BY_PURPOSE,
  type Clock,
  type ContextBroker,
  type ContextFieldName,
  type ContextPurpose,
  type ContextRequest,
  ContextRequestSchema,
  type ContextResult,
  type DiscloseRequest,
  DiscloseRequestSchema,
  type DiscloseResult,
  parseAgentId,
  personalAgentId,
} from "@campus/contracts";
import type { Directory, TaskInfo } from "./directory";
import { CLASS_POLICIES, type DataClassInfo, RESOLVERS, classify, validValue } from "./fields";
import { readNamespace } from "./read-path";
import type { ConsentRequestRow, ContextRepo } from "./repo";
import type { Supermemory } from "./supermemory/keys";
import { namespaces } from "./supermemory/namespaces";
import type { ConsentGrant } from "./types";

// Deterministic Context Broker (spec 5.7). The model may propose; this code decides. Checks run
// before retrieval (Read) and again before disclosure (Disclose); results are registry projections.
// Every decision is recorded (core.context_decisions + audit) with its stage and reason — field
// names only, never values.

export type BrokerDeps = {
  repo: ContextRepo;
  supermemory: Supermemory;
  directory: Directory;
  audit: AuditLog;
  clock: Clock;
  requestsPerMinute?: number;
  resultTtlMs?: number;
};

/** Who will see the result. `self` = the subject's own personal agent. */
type Target =
  | { kind: "self"; userId: string }
  | { kind: "group"; conversationId: string }
  | { kind: "agent"; agentId: string };

class Deny {
  constructor(
    readonly stage: string,
    readonly reasonCode: string,
  ) {}
}

type FieldPlan = { info: DataClassInfo; grant: ConsentGrant | null };

export class DefaultContextBroker implements ContextBroker {
  private readonly rpm: number;
  private readonly ttlMs: number;

  constructor(private readonly deps: BrokerDeps) {
    this.rpm = deps.requestsPerMinute ?? 60;
    this.ttlMs = deps.resultTtlMs ?? 15 * 60 * 1000;
  }

  async requestContext(input: ContextRequest): Promise<ContextResult> {
    const parsed = ContextRequestSchema.safeParse(input);
    if (!parsed.success) return this.denied("request", shape(input), new Deny("validate", "invalid_request"));
    const req = parsed.data;
    const meta: DecisionMeta = {
      requester: req.requesterAgentId,
      taskId: req.taskId,
      subject: req.subjectUserId,
      purpose: req.purpose,
      audience: req.audience,
      fields: req.fields,
    };

    const checked = await this.checkRequest(req);
    if (checked instanceof Deny) return this.denied("request", meta, checked);
    const { task, target } = checked;

    const plans = await this.planFields(
      req.subjectUserId,
      req.purpose,
      task.id,
      target,
      req.fields,
      "request",
    );
    if (plans instanceof Deny) return this.denied("request", meta, plans);
    if ("consentRequestId" in plans) return this.needsConsent("request", meta, target, plans);

    // Resolve from the subject's OWN namespace — chosen here, never by the requester.
    const values: Record<string, unknown> = {};
    const sources: Record<string, string> = {};
    const evidence = this.evidenceFor(req.subjectUserId);
    for (const { info } of plans) {
      const field = info.field!;
      const r = await this.resolve(req.subjectUserId, field, evidence);
      sources[field] = r.source;
      if (r.source !== "none") values[field] = r.value; // unknown → omitted (no constraint), never guessed
    }
    let expires = this.deps.clock.now().getTime() + this.ttlMs;
    for (const p of plans) if (p.grant?.expiresAt) expires = Math.min(expires, Date.parse(p.grant.expiresAt));
    await this.record("request", meta, target, "approved", null, { sources });
    return { status: "approved", fields: values, expiresAt: new Date(expires).toISOString() };
  }

  async disclose(input: DiscloseRequest): Promise<DiscloseResult> {
    const parsed = DiscloseRequestSchema.safeParse(input);
    if (!parsed.success) {
      const d = new Deny("validate", "invalid_request");
      await this.record("disclose", shape(input), null, "denied", d);
      return { allowed: false, reasonCode: d.reasonCode };
    }
    const req = parsed.data;
    const meta: DecisionMeta = {
      requester: `disclose:${req.subjectUserId}`,
      taskId: req.taskId ?? null,
      subject: req.subjectUserId,
      purpose: req.purpose,
      audience: req.audience,
      fields: req.dataClasses,
    };
    const deny = async (d: Deny): Promise<DiscloseResult> => {
      await this.record("disclose", meta, null, "denied", d);
      return { allowed: false, reasonCode: d.reasonCode };
    };

    if (await this.rateLimited(meta.requester)) return deny(new Deny("limit", "rate_limited"));
    if (!(await this.deps.directory.isVerifiedUser(req.subjectUserId)))
      return deny(new Deny("subject", "subject_unverified"));

    let task: TaskInfo | null = null;
    if (req.taskId) {
      task = await this.deps.directory.task(req.taskId);
      if (!task) return deny(new Deny("task", "task_not_found"));
      if (!task.active) return deny(new Deny("task", "task_inactive"));
    }
    const target = await this.discloseTarget(req.subjectUserId, req.audience, task);
    if (target instanceof Deny) return deny(target);

    const plans = await this.planFields(
      req.subjectUserId,
      req.purpose,
      task?.id ?? null,
      target,
      req.dataClasses,
      "disclose",
    );
    if (plans instanceof Deny) return deny(plans);
    if ("consentRequestId" in plans) {
      await this.needsConsent("disclose", meta, target, plans);
      // DiscloseResult has no needs_consent; the caller withholds and the user can approve later.
      return { allowed: false, reasonCode: "consent_required" };
    }
    await this.record("disclose", meta, target, "approved", null);
    return { allowed: true };
  }

  // ---- checks ---------------------------------------------------------------------------------

  /** Task, subject, requester and audience for requestContext. */
  private async checkRequest(req: ContextRequest): Promise<Deny | { task: TaskInfo; target: Target }> {
    const { directory } = this.deps;
    if (await this.rateLimited(req.requesterAgentId)) return new Deny("limit", "rate_limited");

    for (const f of req.fields) {
      const info = classify(f);
      if (!info?.field) return new Deny("fields", `unknown_field:${f}`);
      if (!CONTEXT_FIELDS_BY_PURPOSE[req.purpose].includes(info.field))
        return new Deny("fields", `field_not_allowed_for_purpose:${f}`);
    }
    if (new Set(req.fields).size !== req.fields.length) return new Deny("validate", "duplicate_fields");

    const requester = parseAgentId(req.requesterAgentId);
    if (!requester) return new Deny("requester", "invalid_requester");

    const task = await directory.task(req.taskId);
    if (!task) return new Deny("task", "task_not_found");
    if (!task.active) return new Deny("task", "task_inactive");

    if (!(await directory.isVerifiedUser(req.subjectUserId)))
      return new Deny("subject", "subject_unverified");
    const groupId =
      task.conversationId && (await directory.conversation(task.conversationId))?.type === "group"
        ? task.conversationId
        : null;
    const members = groupId ? await directory.verifiedMembers(groupId) : null;
    if (members && !members.has(req.subjectUserId)) return new Deny("subject", "subject_not_member");
    if (!groupId && !(task.ownerType === "user" && task.ownerId === req.subjectUserId))
      return new Deny("subject", "subject_not_in_task");

    if (requester.kind === "group") {
      if (!groupId || requester.id !== groupId) return new Deny("requester", "requester_not_task_group");
      if ((await directory.conversation(groupId))?.status !== "active")
        return new Deny("requester", "group_inactive");
    } else if (requester.id !== req.subjectUserId) {
      if (!members?.has(requester.id)) return new Deny("requester", "requester_not_member");
    }

    // Audience: the requester itself, or the task's group.
    let target: Target;
    if (req.audience.kind === "agent") {
      if (req.audience.id !== req.requesterAgentId) return new Deny("audience", "audience_mismatch");
      if (requester.kind === "group") target = { kind: "group", conversationId: requester.id };
      else if (requester.id === req.subjectUserId) target = { kind: "self", userId: req.subjectUserId };
      else target = { kind: "agent", agentId: req.audience.id };
    } else {
      const conv = groupIdOf(req.audience.id);
      if (!groupId || conv !== groupId) return new Deny("audience", "audience_not_task_group");
      target = { kind: "group", conversationId: groupId };
    }
    return { task, target };
  }

  private async discloseTarget(
    subject: string,
    audience: Audience,
    task: TaskInfo | null,
  ): Promise<Deny | Target> {
    const { directory } = this.deps;
    const parsedAgent = parseAgentId(audience.id);
    const conv =
      audience.kind === "group"
        ? groupIdOf(audience.id)
        : parsedAgent?.kind === "group"
          ? parsedAgent.id
          : null;
    if (conv) {
      if (task && task.conversationId !== conv) return new Deny("audience", "audience_not_task_group");
      if (!(await directory.verifiedMembers(conv)).has(subject))
        return new Deny("subject", "subject_not_member");
      return { kind: "group", conversationId: conv };
    }
    if (parsedAgent?.kind === "personal") {
      if (parsedAgent.id === subject) return { kind: "self", userId: subject };
      if (!(await directory.isVerifiedUser(parsedAgent.id)))
        return new Deny("audience", "audience_unverified");
      return { kind: "agent", agentId: audience.id };
    }
    return new Deny("audience", "audience_mismatch");
  }

  /**
   * Per field / data class: shareability, then Read (a live grant for purpose + field in scope),
   * then Disclose (that grant names this audience). Missing consent → one deduped consent request.
   */
  private async planFields(
    subject: string,
    purpose: ContextPurpose,
    taskId: string | null,
    target: Target,
    names: string[],
    mode: Mode,
  ): Promise<Deny | FieldPlan[] | { consentRequestId: string; needConsent: string[] }> {
    const { repo, clock } = this.deps;
    const now = clock.now();
    const grants = await repo.liveGrants(subject, purpose, now);
    const prior = await repo.consentRequestsFor(subject, taskId);
    const wanted = audienceRow(target);
    const plans: FieldPlan[] = [];
    const needConsent: string[] = [];

    for (const name of names) {
      const info = classify(name);
      if (!info) return new Deny("fields", `unknown_data_class:${name}`);
      if (mode === "disclose" && info.field && !CONTEXT_FIELDS_BY_PURPOSE[purpose].includes(info.field)) {
        return new Deny("fields", `field_not_allowed_for_purpose:${name}`);
      }
      // Registry rule: only SHAREABLE fields ever reach anyone but the subject's own agent. Never prompted.
      if (!info.shareable && target.kind !== "self") return new Deny("disclose", `not_shareable:${name}`);

      const policy = CLASS_POLICIES[info.dataClass];
      const readable = grants.filter(
        (g) =>
          g.allowedFields.includes(name) &&
          (g.taskId === null ? policy.grantScope === "standing_or_task" : g.taskId === taskId),
      );
      const grant = readable.find((g) => grantCovers(g, target)) ?? null;
      if (grant) {
        plans.push({ info, grant });
      } else if (declined(prior, name, wanted)) {
        return new Deny(readable.length ? "disclose" : "read", `consent_declined:${name}`);
      } else if (policy.promptable) {
        needConsent.push(name);
      } else {
        return new Deny(readable.length ? "disclose" : "read", `explicit_grant_required:${name}`);
      }
    }

    if (!needConsent.length) return plans;
    const existing = prior.find(
      (r) =>
        r.status === "pending" &&
        r.audience_kind === wanted.kind &&
        r.audience_id === wanted.id &&
        needConsent.every((f) => r.fields.includes(f)),
    );
    const request =
      existing ??
      (await repo.insertConsentRequest({
        userId: subject,
        taskId,
        requesterAgentId: wanted.kind === "agent" ? wanted.id : `group:${groupIdOf(wanted.id)}`,
        purpose,
        audienceKind: wanted.kind,
        audienceId: wanted.id,
        fields: needConsent,
        createdAt: now,
      }));
    return { consentRequestId: request.id, needConsent };
  }

  // ---- resolution -----------------------------------------------------------------------------

  private evidenceFor(subject: string) {
    const client = this.deps.supermemory.forNamespace(namespaces.user(subject));
    const cache = new Map<string, Promise<string[]>>();
    return (buckets: string[], query: string) => {
      const key = `${buckets.join(",")}|${query}`;
      if (!cache.has(key)) {
        cache.set(
          key,
          readNamespace(client, this.deps.repo, { buckets, query, now: this.deps.clock.now() }).then(
            (items) => items.map((i) => i.text),
          ),
        );
      }
      return cache.get(key)!;
    };
  }

  /** Deterministic rules over the subject's own memory; then a seeded preference (labelled); else unknown. */
  private async resolve(
    subject: string,
    field: ContextFieldName,
    evidence: (buckets: string[], query: string) => Promise<string[]>,
  ): Promise<{ value: unknown; source: "memory" | "seeded" | "none" }> {
    const resolver = RESOLVERS[field];
    if (resolver) {
      const texts = await evidence(resolver.buckets, resolver.query);
      if (texts.length) {
        const value = resolver.fromEvidence(texts);
        if (validValue(field, value)) return { value, source: "memory" };
      }
    }
    const seeded = await this.deps.repo.getSeed(subject, field);
    if (validValue(field, seeded)) return { value: seeded, source: "seeded" };
    return { value: undefined, source: "none" };
  }

  // ---- recording ------------------------------------------------------------------------------

  private async rateLimited(key: string): Promise<boolean> {
    const since = new Date(this.deps.clock.now().getTime() - 60_000);
    return (await this.deps.repo.countRecentDecisions(key, since)) >= this.rpm;
  }

  private async denied(mode: Mode, meta: DecisionMeta, d: Deny): Promise<ContextResult> {
    await this.record(mode, meta, null, "denied", d);
    return { status: "denied", reasonCode: d.reasonCode };
  }

  private async needsConsent(
    mode: Mode,
    meta: DecisionMeta,
    target: Target,
    plan: { consentRequestId: string; needConsent: string[] },
  ): Promise<ContextResult> {
    await this.record(mode, meta, target, "needs_consent", null, {
      consentRequestId: plan.consentRequestId,
      needsConsent: plan.needConsent,
    });
    await this.deps.audit.record({
      action: "consent.requested",
      actorUserId: null,
      resource: `user:${meta.subject}`,
      policyResult: "needs_consent",
      detail: { consentRequestId: plan.consentRequestId, fields: plan.needConsent, purpose: meta.purpose },
    });
    return { status: "needs_consent", consentRequestId: plan.consentRequestId };
  }

  private async record(
    mode: Mode,
    meta: DecisionMeta,
    target: Target | null,
    decision: "approved" | "needs_consent" | "denied",
    d: Deny | null,
    extra: { sources?: Record<string, string>; consentRequestId?: string; needsConsent?: string[] } = {},
  ): Promise<void> {
    const audience = target
      ? audienceRow(target)
      : meta.audience
        ? { kind: meta.audience.kind, id: meta.audience.id }
        : null;
    await this.deps.repo.insertDecision({
      mode,
      taskId: meta.taskId,
      requesterAgentId: meta.requester.slice(0, 120),
      subjectUserId: meta.subject,
      purpose: meta.purpose,
      audienceKind: audience?.kind ?? null,
      audienceId: audience?.id ?? null,
      fields: meta.fields.slice(0, 16).map(String),
      fieldParams: {},
      decision,
      stage: d?.stage ?? null,
      reasonCode: d?.reasonCode ?? null,
      consentRequestId: extra.consentRequestId ?? null,
      createdAt: this.deps.clock.now(),
    });
    const action =
      mode === "disclose"
        ? decision === "approved"
          ? "disclose.allowed"
          : "disclose.denied"
        : decision === "approved"
          ? "context.granted"
          : decision === "denied"
            ? "context.denied"
            : "context.needs_consent";
    await this.deps.audit.record({
      action,
      actorUserId: null,
      resource: `task:${meta.taskId ?? "-"}/subject:${meta.subject ?? "-"}`,
      policyResult: decision,
      detail: {
        requester: meta.requester,
        audience: audience ? `${audience.kind}:${audience.id}` : null,
        fields: meta.fields,
        stage: d?.stage,
        reasonCode: d?.reasonCode,
        needsConsent: extra.needsConsent,
        // Where each value came from (memory / seeded / none) — never the value.
        sources: extra.sources,
      },
    });
  }
}

type Mode = "request" | "disclose";

type DecisionMeta = {
  requester: string;
  taskId: string | null;
  subject: string | null;
  purpose: string | null;
  audience: Audience | null;
  fields: string[];
};

/** `group:<id>` or a bare conversation id → conversation id. */
function groupIdOf(id: string): string {
  return id.startsWith("group:") ? id.slice("group:".length) : id;
}

/** How a target is stored on grants and consent requests. */
function audienceRow(target: Target): { kind: "group" | "agent"; id: string } {
  if (target.kind === "group") return { kind: "group", id: `group:${target.conversationId}` };
  if (target.kind === "self") return { kind: "agent", id: personalAgentId(target.userId) };
  return { kind: "agent", id: target.agentId };
}

function grantCovers(g: ConsentGrant, target: Target): boolean {
  const want = audienceRow(target);
  if (g.audienceKind !== want.kind) return false;
  // `group:*` = any group the subject is a current member of (membership is checked live above).
  if (want.kind === "group")
    return g.audienceId === want.id || g.audienceId === "group:*" || `group:${g.audienceId}` === want.id;
  return g.audienceId === want.id;
}

function declined(prior: ConsentRequestRow[], field: string, wanted: { kind: string; id: string }): boolean {
  return prior.some(
    (r) =>
      r.status === "declined" &&
      r.fields.includes(field) &&
      r.audience_kind === wanted.kind &&
      r.audience_id === wanted.id,
  );
}

function shape(input: unknown): DecisionMeta {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : null);
  return {
    requester:
      str(o.requesterAgentId) ?? (str(o.subjectUserId) ? `disclose:${str(o.subjectUserId)}` : "unknown"),
    taskId: str(o.taskId),
    subject: str(o.subjectUserId),
    purpose: str(o.purpose),
    audience: null,
    fields: [],
  };
}
