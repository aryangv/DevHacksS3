import type { ContextPurpose, MemoryKind, MemorySettings, SqlClient } from "@campus/contracts";
import type { ConsentGrant } from "./types";
import { isUuid } from "./supermemory/namespaces";

/**
 * SQL for the tables P3 owns (core.memory_settings, core.consent_grants and the P3
 * migration). Parameterised only. IDs that are not UUIDs cannot exist in these
 * tables, so they short-circuit to "not found" instead of raising a cast error.
 */

export const DEFAULT_MEMORY_SETTINGS: Omit<MemorySettings, "userId"> = {
  rememberEnabled: true,
  allowedKinds: ["preference", "fact"],
  sensitiveBucketsEnabled: false,
  retentionDays: null,
};

type GrantRow = {
  id: string;
  user_id: string;
  purpose: string;
  audience_kind: string;
  audience_id: string;
  task_id: string | null;
  allowed_fields: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

export type ConsentRequestRow = {
  id: string;
  user_id: string;
  task_id: string | null;
  requester_agent_id: string;
  purpose: string;
  audience_kind: "group" | "agent";
  audience_id: string;
  fields: string[];
  status: "pending" | "approved" | "declined";
  created_at: Date;
  resolved_at: Date | null;
};

export type DecisionInsert = {
  mode: "request" | "disclose";
  taskId: string | null;
  requesterAgentId: string;
  subjectUserId: string | null;
  purpose: string | null;
  audienceKind: string | null;
  audienceId: string | null;
  fields: string[];
  fieldParams: Record<string, string>;
  decision: "approved" | "needs_consent" | "denied";
  stage: string | null;
  reasonCode: string | null;
  consentRequestId: string | null;
  createdAt: Date;
};

export type CleanupRow = {
  id: string;
  namespace: string;
  target_kind: "document" | "memory";
  target_id: string;
  attempts: number;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toGrant(row: GrantRow): ConsentGrant {
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose as ContextPurpose,
    audienceKind: row.audience_kind as ConsentGrant["audienceKind"],
    audienceId: row.audience_id,
    taskId: row.task_id,
    allowedFields: row.allowed_fields,
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    createdAt: row.created_at.toISOString(),
  };
}

export class ContextRepo {
  constructor(private readonly sql: SqlClient) {}

  // --- memory settings ------------------------------------------------------

  async getMemorySettings(userId: string): Promise<MemorySettings> {
    if (!isUuid(userId)) return { userId, ...DEFAULT_MEMORY_SETTINGS };
    const { rows } = await this.sql.query<{
      remember_enabled: boolean;
      allowed_kinds: string[];
      sensitive_buckets_enabled: boolean;
      retention_days: number | null;
    }>(
      `SELECT remember_enabled, allowed_kinds, sensitive_buckets_enabled, retention_days FROM core.memory_settings WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return { userId, ...DEFAULT_MEMORY_SETTINGS };
    return {
      userId,
      rememberEnabled: row.remember_enabled,
      allowedKinds: row.allowed_kinds as MemoryKind[],
      sensitiveBucketsEnabled: row.sensitive_buckets_enabled,
      retentionDays: row.retention_days,
    };
  }

  async upsertMemorySettings(userId: string, s: Omit<MemorySettings, "userId">, now: Date): Promise<void> {
    await this.sql.query(
      `INSERT INTO core.memory_settings (user_id, remember_enabled, allowed_kinds, sensitive_buckets_enabled, retention_days, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET remember_enabled = $2, allowed_kinds = $3,
         sensitive_buckets_enabled = $4, retention_days = $5, updated_at = $6`,
      [userId, s.rememberEnabled, s.allowedKinds, s.sensitiveBucketsEnabled, s.retentionDays, now],
    );
  }

  // --- consent grants -------------------------------------------------------

  async liveGrants(userId: string, purpose: string, now: Date): Promise<ConsentGrant[]> {
    if (!isUuid(userId)) return [];
    const { rows } = await this.sql.query<GrantRow>(
      `SELECT * FROM core.consent_grants
       WHERE user_id = $1 AND purpose = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3)`,
      [userId, purpose, now],
    );
    return rows.map(toGrant);
  }

  async getGrant(id: string): Promise<ConsentGrant | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.sql.query<GrantRow>(`SELECT * FROM core.consent_grants WHERE id = $1`, [id]);
    return rows[0] ? toGrant(rows[0]) : null;
  }

  async listGrants(userId: string): Promise<ConsentGrant[]> {
    if (!isUuid(userId)) return [];
    const { rows } = await this.sql.query<GrantRow>(
      `SELECT * FROM core.consent_grants WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map(toGrant);
  }

  async insertGrant(g: {
    userId: string;
    purpose: string;
    audienceKind: string;
    audienceId: string;
    taskId: string | null;
    allowedFields: string[];
    expiresAt: Date;
    createdAt: Date;
  }): Promise<ConsentGrant> {
    const { rows } = await this.sql.query<GrantRow>(
      `INSERT INTO core.consent_grants (user_id, purpose, audience_kind, audience_id, task_id, allowed_fields, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        g.userId,
        g.purpose,
        g.audienceKind,
        g.audienceId,
        g.taskId,
        g.allowedFields,
        g.expiresAt,
        g.createdAt,
      ],
    );
    return toGrant(rows[0]!);
  }

  async revokeGrant(id: string, now: Date): Promise<boolean> {
    const { rows } = await this.sql.query(
      `UPDATE core.consent_grants SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [id, now],
    );
    return rows.length > 0;
  }

  // --- consent requests -----------------------------------------------------

  /** Requests for this user and task; `taskId` null = task-less (disclose) requests. */
  async consentRequestsFor(userId: string, taskId: string | null): Promise<ConsentRequestRow[]> {
    if (!isUuid(userId) || (taskId !== null && !isUuid(taskId))) return [];
    const { rows } = await this.sql.query<ConsentRequestRow>(
      `SELECT * FROM core.consent_requests WHERE user_id = $1 AND task_id IS NOT DISTINCT FROM $2::uuid`,
      [userId, taskId],
    );
    return rows;
  }

  async getConsentRequest(id: string): Promise<ConsentRequestRow | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.sql.query<ConsentRequestRow>(
      `SELECT * FROM core.consent_requests WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async pendingConsentRequests(userId: string): Promise<ConsentRequestRow[]> {
    if (!isUuid(userId)) return [];
    const { rows } = await this.sql.query<ConsentRequestRow>(
      `SELECT * FROM core.consent_requests WHERE user_id = $1 AND status = 'pending' ORDER BY created_at`,
      [userId],
    );
    return rows;
  }

  async insertConsentRequest(r: {
    userId: string;
    taskId: string | null;
    requesterAgentId: string;
    purpose: string;
    audienceKind: "group" | "agent";
    audienceId: string;
    fields: string[];
    createdAt: Date;
  }): Promise<ConsentRequestRow> {
    const { rows } = await this.sql.query<ConsentRequestRow>(
      `INSERT INTO core.consent_requests (user_id, task_id, requester_agent_id, purpose, audience_kind, audience_id, fields, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        r.userId,
        r.taskId,
        r.requesterAgentId,
        r.purpose,
        r.audienceKind,
        r.audienceId,
        r.fields,
        r.createdAt,
      ],
    );
    return rows[0]!;
  }

  /** Compare-and-set from `pending`, so a double-submitted approval mints grants once. */
  async resolveConsentRequest(id: string, status: "approved" | "declined", now: Date): Promise<boolean> {
    const { rows } = await this.sql.query(
      `UPDATE core.consent_requests SET status = $2, resolved_at = $3 WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id, status, now],
    );
    return rows.length > 0;
  }

  // --- broker decisions (trace + limits) ------------------------------------

  async insertDecision(d: DecisionInsert): Promise<void> {
    await this.sql.query(
      `INSERT INTO core.context_decisions (mode, task_id, requester_agent_id, subject_user_id, purpose, audience_kind, audience_id,
         fields, field_params, decision, stage, reason_code, consent_request_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        d.mode,
        d.taskId && isUuid(d.taskId) ? d.taskId : null,
        d.requesterAgentId,
        d.subjectUserId && isUuid(d.subjectUserId) ? d.subjectUserId : null,
        d.purpose,
        d.audienceKind,
        d.audienceId,
        d.fields,
        JSON.stringify(d.fieldParams),
        d.decision,
        d.stage,
        d.reasonCode,
        d.consentRequestId,
        d.createdAt,
      ],
    );
  }

  async countRecentDecisions(requesterAgentId: string, since: Date): Promise<number> {
    const { rows } = await this.sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.context_decisions WHERE requester_agent_id = $1 AND created_at >= $2`,
      [requesterAgentId, since],
    );
    return rows[0]?.n ?? 0;
  }

  /** Distinct parameter sets already disclosed for (task, subject, field), other than `exceptHash`. */
  async countDistinctProbes(
    taskId: string,
    subjectUserId: string,
    field: string,
    exceptHash: string,
  ): Promise<number> {
    const { rows } = await this.sql.query<{ n: number }>(
      `SELECT count(DISTINCT field_params ->> $3)::int AS n FROM core.context_decisions
       WHERE task_id = $1 AND subject_user_id = $2 AND decision = 'approved'
         AND jsonb_exists(field_params, $3) AND field_params ->> $3 <> $4`,
      [taskId, subjectUserId, field, exceptHash],
    );
    return rows[0]?.n ?? 0;
  }

  async decisionsForTask(taskId: string) {
    if (!isUuid(taskId)) return [];
    const { rows } = await this.sql.query<{
      created_at: Date;
      mode: string;
      requester_agent_id: string;
      subject_user_id: string | null;
      purpose: string | null;
      audience_kind: string | null;
      audience_id: string | null;
      fields: string[];
      decision: string;
      stage: string | null;
      reason_code: string | null;
    }>(
      `SELECT created_at, mode, requester_agent_id, subject_user_id, purpose, audience_kind, audience_id, fields, decision, stage, reason_code
       FROM core.context_decisions WHERE task_id = $1 ORDER BY created_at, seq`,
      [taskId],
    );
    return rows;
  }

  // --- namespaces registry --------------------------------------------------

  async getNamespace(namespace: string) {
    const { rows } = await this.sql.query<{ bucket_version: number; sensitive_enabled: boolean }>(
      `SELECT bucket_version, sensitive_enabled FROM core.memory_namespaces WHERE namespace = $1`,
      [namespace],
    );
    return rows[0] ?? null;
  }

  async upsertNamespace(n: {
    namespace: string;
    principalKind: "user" | "group";
    principalId: string;
    bucketVersion: number;
    sensitiveEnabled: boolean;
    now: Date;
  }): Promise<void> {
    await this.sql.query(
      `INSERT INTO core.memory_namespaces (namespace, principal_kind, principal_id, bucket_version, sensitive_enabled, provisioned_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (namespace) DO UPDATE SET bucket_version = $4, sensitive_enabled = $5, provisioned_at = $6`,
      [n.namespace, n.principalKind, n.principalId, n.bucketVersion, n.sensitiveEnabled, n.now],
    );
  }

  async listNamespaces(): Promise<string[]> {
    const { rows } = await this.sql.query<{ namespace: string }>(
      `SELECT namespace FROM core.memory_namespaces ORDER BY namespace`,
    );
    return rows.map((r) => r.namespace);
  }

  // --- cleanup queue --------------------------------------------------------

  async enqueueCleanup(
    items: Array<{
      namespace: string;
      targetKind: "document" | "memory";
      targetId: string;
      reason: string;
      lastError: string;
    }>,
    now: Date,
  ): Promise<void> {
    for (const i of items) {
      await this.sql.query(
        `INSERT INTO core.memory_cleanup (namespace, target_kind, target_id, reason, last_error, next_attempt_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (namespace, target_kind, target_id) DO UPDATE SET done_at = NULL, next_attempt_at = $6, last_error = $5`,
        [i.namespace, i.targetKind, i.targetId, i.reason, i.lastError, now],
      );
    }
  }

  async dueCleanup(now: Date, limit: number): Promise<CleanupRow[]> {
    const { rows } = await this.sql.query<CleanupRow>(
      `SELECT id, namespace, target_kind, target_id, attempts FROM core.memory_cleanup
       WHERE done_at IS NULL AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2`,
      [now, limit],
    );
    return rows;
  }

  async markCleanupDone(id: string, now: Date): Promise<void> {
    await this.sql.query(`UPDATE core.memory_cleanup SET done_at = $2 WHERE id = $1`, [id, now]);
  }

  async rescheduleCleanup(id: string, attempts: number, next: Date, lastError: string): Promise<void> {
    await this.sql.query(
      `UPDATE core.memory_cleanup SET attempts = $2, next_attempt_at = $3, last_error = $4 WHERE id = $1`,
      [id, attempts, next, lastError],
    );
  }

  async countPendingCleanup(): Promise<number> {
    const { rows } = await this.sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.memory_cleanup WHERE done_at IS NULL`,
    );
    return rows[0]?.n ?? 0;
  }

  /** Targets awaiting deletion in a namespace; reads hide these until Supermemory catches up. */
  async pendingDeletions(namespace: string): Promise<{ documents: Set<string>; memories: Set<string> }> {
    const { rows } = await this.sql.query<{ target_kind: string; target_id: string }>(
      `SELECT target_kind, target_id FROM core.memory_cleanup WHERE namespace = $1 AND done_at IS NULL`,
      [namespace],
    );
    const documents = new Set<string>();
    const memories = new Set<string>();
    for (const r of rows) (r.target_kind === "document" ? documents : memories).add(r.target_id);
    return { documents, memories };
  }

  // --- forget previews ------------------------------------------------------

  async insertForgetPreview(p: {
    userId: string;
    namespace: string;
    memoryIds: string[];
    now: Date;
    expiresAt: Date;
  }) {
    const { rows } = await this.sql.query<{ id: string }>(
      `INSERT INTO core.forget_previews (user_id, namespace, memory_ids, created_at, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [p.userId, p.namespace, p.memoryIds, p.now, p.expiresAt],
    );
    return rows[0]!.id;
  }

  /** Claims an unexpired, unapplied preview for this user (single use). */
  async claimForgetPreview(id: string, userId: string, now: Date) {
    if (!isUuid(id)) return null;
    const { rows } = await this.sql.query<{ namespace: string; memory_ids: string[] }>(
      `UPDATE core.forget_previews SET applied_at = $3
       WHERE id = $1 AND user_id = $2 AND applied_at IS NULL AND expires_at > $3 RETURNING namespace, memory_ids`,
      [id, userId, now],
    );
    return rows[0] ?? null;
  }

  // --- seeded preferences (labelled contingency) -----------------------------

  async getSeed(userId: string, field: string): Promise<unknown | undefined> {
    if (!isUuid(userId)) return undefined;
    const { rows } = await this.sql.query<{ value: unknown }>(
      `SELECT value FROM core.memory_seed_preferences WHERE user_id = $1 AND field = $2`,
      [userId, field],
    );
    return rows[0]?.value;
  }

  async setSeed(userId: string, field: string, value: unknown, now: Date): Promise<void> {
    await this.sql.query(
      `INSERT INTO core.memory_seed_preferences (user_id, field, value, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, field) DO UPDATE SET value = $3, created_at = $4`,
      [userId, field, JSON.stringify(value), now],
    );
  }

  // --- "delete everything about me" (P3's rows) ------------------------------

  async deleteUserRows(userId: string): Promise<number> {
    let n = 0;
    const run = async (text: string) => {
      const { rows } = await this.sql.query(`${text} RETURNING 1`, [userId]);
      n += rows.length;
    };
    // Decisions stay as minimal audit (IDs and field names only) but lose their link to deleted requests.
    await this.sql.query(
      `UPDATE core.context_decisions SET consent_request_id = NULL
       WHERE consent_request_id IN (SELECT id FROM core.consent_requests WHERE user_id = $1)`,
      [userId],
    );
    await run(`DELETE FROM core.forget_previews WHERE user_id = $1`);
    await run(`DELETE FROM core.memory_seed_preferences WHERE user_id = $1`);
    await run(`DELETE FROM core.consent_requests WHERE user_id = $1`);
    await run(`DELETE FROM core.consent_grants WHERE user_id = $1`);
    await run(`DELETE FROM core.memory_settings WHERE user_id = $1`);
    await run(`DELETE FROM core.memory_namespaces WHERE principal_kind = 'user' AND principal_id = $1`);
    return n;
  }
}
