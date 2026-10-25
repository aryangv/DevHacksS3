import type { AuditLog, BucketProvisioner, Clock, ContextPurpose } from "@campus/contracts";
import type { ContextRepo } from "./repo";
import type { Supermemory } from "./supermemory/keys";
import { type Namespace, namespaces } from "./supermemory/namespaces";

/** Bump when bucket definitions change; provisioning re-applies to namespaces on an older version. */
export const BUCKET_VERSION = 1;

/** harness-spec §5.6. Descriptions steer Supermemory's ingestion-time classifier. */
export const USER_BUCKETS: Record<string, string> = {
  food_preferences:
    "Explicitly stated food likes/dislikes, dietary choices, favorite orders and restaurants. Exclude inferred traits.",
  budget: "Stated spending limits and price sensitivity for meals, rides and purchases.",
  schedule_habits:
    "Recurring availability patterns, preferred times, class schedule habits (not event titles).",
  campus_life: "Campus locations, clubs, courses at a high level, routines.",
  shopping_preferences: "Preferred stores, brands and grocery habits.",
};

/** Off by default; only with explicit consent and a stated purpose (§5.6). */
export const SENSITIVE_BUCKETS: Record<string, string> = {
  health:
    "Health conditions, allergies with medical context, medications and accessibility needs the person chose to share.",
  finances: "Income, debts, account details and financial circumstances the person chose to share.",
  relationships: "Family, partners and friendships the person chose to share.",
  values: "Religious, political and personal values the person chose to share.",
};

export const GROUP_BUCKETS: Record<string, string> = {
  group_plans:
    "Confirmed group decisions: what was decided, when, where and who is involved. Exclude suggestions not agreed on.",
};

export const USER_SUPPORTING_CONTEXT =
  "A college student's personal agent memory: study habits, food preferences, schedule habits, campus life. " +
  "Record only what the student explicitly said about themselves; do not infer health, finances, relationships or values.";

export const GROUP_SUPPORTING_CONTEXT =
  "A student group chat's shared memory: confirmed group decisions and plans (meals, meetups, study sessions). " +
  "Each entry is attributed to its author by author_user_id. Do not record private facts about individual members.";

/** Supermemory built-ins/reserved. Sending `preferences` silently overrides the built-in (verified live). */
const RESERVED = new Set(["preferences", "static", "dynamic"]);
const BUCKET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Minimal profile buckets per task purpose (§5.5). */
export const PURPOSE_BUCKETS: Record<ContextPurpose, string[]> = {
  group_meal: ["food_preferences", "budget"],
  scheduling: ["schedule_habits"],
  campus_match: ["campus_life"],
  other: [],
};

function checkBuckets(buckets: Record<string, string>) {
  const names = Object.keys(buckets);
  if (names.length > 50) throw new Error("at most 50 buckets per request");
  for (const [name, description] of Object.entries(buckets)) {
    if (!BUCKET_NAME.test(name) || RESERVED.has(name)) throw new Error(`invalid bucket name: ${name}`);
    if (description.length > 2000) throw new Error(`bucket description too long: ${name}`);
  }
}

export class DefaultBucketProvisioner implements BucketProvisioner {
  constructor(
    private readonly deps: { supermemory: Supermemory; repo: ContextRepo; audit: AuditLog; clock: Clock },
  ) {}

  async provisionUser(userId: string): Promise<void> {
    const ns = namespaces.user(userId);
    const settings = await this.deps.repo.getMemorySettings(userId);
    const wantSensitive = settings.sensitiveBucketsEnabled;
    const existing = await this.deps.repo.getNamespace(ns);
    if (existing && existing.bucket_version >= BUCKET_VERSION && existing.sensitive_enabled === wantSensitive)
      return;

    const buckets = wantSensitive ? { ...USER_BUCKETS, ...SENSITIVE_BUCKETS } : USER_BUCKETS;
    const skipped = await this.apply(ns, USER_SUPPORTING_CONTEXT, buckets);
    if (!wantSensitive && existing?.sensitive_enabled) {
      await this.deps.supermemory.admin.deleteBuckets(ns, Object.keys(SENSITIVE_BUCKETS));
    }
    await this.deps.repo.upsertNamespace({
      namespace: ns,
      principalKind: "user",
      principalId: userId,
      bucketVersion: BUCKET_VERSION,
      sensitiveEnabled: wantSensitive,
      now: this.deps.clock.now(),
    });
    await this.audit(userId, `user:${userId}`, {
      bucketVersion: BUCKET_VERSION,
      sensitive: wantSensitive,
      skippedOrgClashes: skipped,
    });
  }

  async provisionGroup(groupId: string): Promise<void> {
    // `groupId` is the group's conversation id (spec: group_{uuid} from internal ids).
    const ns = namespaces.group(groupId);
    const existing = await this.deps.repo.getNamespace(ns);
    if (existing && existing.bucket_version >= BUCKET_VERSION) return;
    const skipped = await this.apply(ns, GROUP_SUPPORTING_CONTEXT, GROUP_BUCKETS);
    await this.deps.repo.upsertNamespace({
      namespace: ns,
      principalKind: "group",
      principalId: groupId,
      bucketVersion: BUCKET_VERSION,
      sensitiveEnabled: false,
      now: this.deps.clock.now(),
    });
    await this.audit(null, `group:${groupId}`, { bucketVersion: BUCKET_VERSION, skippedOrgClashes: skipped });
  }

  /** Called by ConsentService when the user flips `sensitive_buckets_enabled`. */
  async setSensitiveBuckets(userId: string, enabled: boolean): Promise<void> {
    const ns = namespaces.user(userId);
    if (enabled) await this.apply(ns, USER_SUPPORTING_CONTEXT, SENSITIVE_BUCKETS);
    else await this.deps.supermemory.admin.deleteBuckets(ns, Object.keys(SENSITIVE_BUCKETS));
    await this.deps.repo.upsertNamespace({
      namespace: ns,
      principalKind: "user",
      principalId: userId,
      bucketVersion: BUCKET_VERSION,
      sensitiveEnabled: enabled,
      now: this.deps.clock.now(),
    });
    await this.audit(userId, `user:${userId}`, { sensitive: enabled });
  }

  /**
   * Namespace must exist before settings can be applied (404 otherwise), so write a
   * non-memory init document first. Returns bucket names skipped because an org-level
   * bucket of the same name exists (409: the org definition wins).
   */
  private async apply(
    ns: Namespace,
    supportingContext: string,
    buckets: Record<string, string>,
  ): Promise<string[]> {
    checkBuckets(buckets);
    const { admin } = this.deps.supermemory;
    await admin.initNamespace(ns);
    await admin.setSupportingContext(ns, supportingContext);
    const all = await admin.putBuckets(ns, buckets);
    if (!all.conflict) return [];
    const skipped: string[] = [];
    for (const [name, description] of Object.entries(buckets)) {
      if ((await admin.putBuckets(ns, { [name]: description })).conflict) skipped.push(name);
    }
    return skipped;
  }

  private audit(actorUserId: string | null, resource: string, detail: Record<string, unknown>) {
    return this.deps.audit.record({
      actorUserId,
      action: "memory.provisioned",
      resource,
      policyResult: "ok",
      detail,
    });
  }
}
