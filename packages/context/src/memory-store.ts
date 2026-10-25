import {
  type AuditLog,
  type BucketProvisioner,
  type Clock,
  HarnessError,
  type MemoryItem,
  type MemoryMetadata,
  type MemoryPrincipal,
  type MemoryProfile,
  type MemoryStore,
  type MemoryWrite,
} from "@campus/contracts";
import { redactSecrets } from "./memory-policy";
import { NO_EXPIRY, liveFilter } from "./read-path";
import type { ContextRepo } from "./repo";
import type { Filter, Metadata, NamespaceClient } from "./supermemory/client";
import type { Supermemory } from "./supermemory/keys";
import { type Namespace, namespaces } from "./supermemory/namespaces";
import type { ForgetPreview } from "./types";

// MemoryStore over Supermemory v5 (spec 5.2–5.5). One principal → exactly one namespace, derived
// here; no method takes a namespace. Beyond the contract interface it carries the forget/delete
// surface (spec 5.8) for P2's web pages and P1's worker jobs.

const FORGET_PREVIEW_TTL_MS = 15 * 60 * 1000;

type Deps = {
  supermemory: Supermemory;
  repo: ContextRepo;
  provisioner: BucketProvisioner;
  audit: AuditLog;
  clock: Clock;
};

export function namespaceFor(principal: MemoryPrincipal): Namespace {
  try {
    return principal.kind === "user"
      ? namespaces.user(principal.userId)
      : namespaces.group(principal.conversationId);
  } catch {
    throw new HarnessError("memory_access_denied", "principal id is not an internal uuid");
  }
}

/** Contract filters are flat equality; map to v5's expression and always add the live filter. */
function toFilter(filter: MemoryMetadata | undefined, now: Date): Filter {
  const operands: Filter[] = [liveFilter(now)];
  for (const [field, value] of Object.entries(filter ?? {})) {
    if (Array.isArray(value))
      for (const v of value) operands.push({ field, operator: "arrayContains", value: v });
    else operands.push({ field, operator: "eq", value });
  }
  return { operator: "and", operands };
}

export class DefaultMemoryStore implements MemoryStore {
  constructor(private readonly deps: Deps) {}

  async add(principal: MemoryPrincipal, write: MemoryWrite): Promise<{ id: string }> {
    const ns = namespaceFor(principal);
    if (principal.kind === "user") await this.deps.provisioner.provisionUser(principal.userId);
    else await this.deps.provisioner.provisionGroup(principal.conversationId);
    // Defense in depth: the policy already redacted, but direct callers get the same treatment.
    const { content } = redactSecrets(write.content);
    const metadata: Metadata = { ...write.metadata, kind: write.kind };
    if (typeof metadata.expires_at !== "number") metadata.expires_at = NO_EXPIRY;
    const res = await this.client(ns).add({
      content,
      metadata,
      dreaming: "instant",
      ...(write.customId ? { id: write.customId } : {}),
    });
    return { id: res.id };
  }

  async search(
    principal: MemoryPrincipal,
    query: { query: string; limit?: number; filter?: MemoryMetadata },
  ): Promise<MemoryItem[]> {
    const ns = namespaceFor(principal);
    const now = this.deps.clock.now();
    const pending = await this.deps.repo.pendingDeletions(ns);
    const hits = await this.client(ns).search({
      query: query.query.slice(0, 1000) || "*",
      searchMode: "hybrid",
      limit: Math.min(Math.max(query.limit ?? 5, 1), 50),
      filter: toFilter(query.filter, now),
    });
    return hits
      .filter((h) => !(h.documentId && pending.documents.has(h.documentId)) && !pending.memories.has(h.id))
      .map((h) => ({
        id: h.id,
        content: h.text,
        metadata: h.metadata as MemoryMetadata,
        score: h.similarity,
      }));
  }

  /** Minimal bucket set the task needs (spec 5.5). Expired entries are filtered server-side. */
  async profile(principal: MemoryPrincipal, opts: { buckets?: string[] }): Promise<MemoryProfile> {
    const ns = namespaceFor(principal);
    const pending = await this.deps.repo.pendingDeletions(ns);
    const p = await this.client(ns).profile({
      ...(opts.buckets ? { buckets: opts.buckets } : {}),
      filter: liveFilter(this.deps.clock.now()),
    });
    const keep = (entries: Array<{ id: string; memory: string }>) =>
      entries.filter((e) => !pending.memories.has(e.id)).map((e) => e.memory);
    return {
      static: keep(p.static),
      dynamic: keep(p.dynamic),
      buckets: Object.fromEntries(Object.entries(p.buckets).map(([b, e]) => [b, keep(e)])),
    };
  }

  // ---- forgetting and deletion (spec 5.8) ---------------------------------------------------

  async forgetMemory(actingUserId: string, memoryId: string): Promise<{ forgotten: boolean }> {
    const ns = namespaces.user(actingUserId);
    const { forgotten, failed } = await this.forget(ns, [memoryId], "user_forget");
    await this.auditForget(actingUserId, { mode: "exact", forgotten, failed });
    return { forgotten: forgotten + failed > 0 };
  }

  /** "Forget X": dry run first; the user sees exactly what applyForget will remove. */
  async previewForget(actingUserId: string, query: string): Promise<ForgetPreview> {
    const ns = namespaces.user(actingUserId);
    const now = this.deps.clock.now();
    const dry = await this.client(ns).semanticForget(query.slice(0, 2000), true);
    const matches = dry.matches.map((m) => ({ memoryId: m.id, text: m.memory }));
    const expiresAt = new Date(now.getTime() + FORGET_PREVIEW_TTL_MS);
    const previewId = await this.deps.repo.insertForgetPreview({
      userId: actingUserId,
      namespace: ns,
      memoryIds: matches.map((m) => m.memoryId),
      now,
      expiresAt,
    });
    return { previewId, matches, expiresAt: expiresAt.toISOString() };
  }

  /** Forgets exactly the previewed IDs (single use, owner-bound, expiring) — no drift. */
  async applyForget(actingUserId: string, previewId: string): Promise<{ forgotten: number; failed: number }> {
    const preview = await this.deps.repo.claimForgetPreview(previewId, actingUserId, this.deps.clock.now());
    const ns = namespaces.user(actingUserId);
    if (!preview || preview.namespace !== ns)
      throw new HarnessError("forget_preview_not_found", "forget preview not found");
    const result = preview.memory_ids.length
      ? await this.forget(ns, preview.memory_ids, "user_forget")
      : { forgotten: 0, failed: 0 };
    await this.auditForget(actingUserId, { mode: "semantic", ...result });
    return result;
  }

  /** P3's share of "delete everything about me". Identities/connections/credentials are P2/P4's. */
  async deleteUserMemory(actingUserId: string): Promise<{ namespaceDeleted: boolean; rowsDeleted: number }> {
    const { existed } = await this.deps.supermemory.deleteNamespace(namespaces.user(actingUserId));
    const rowsDeleted = await this.deps.repo.deleteUserRows(actingUserId);
    await this.deps.audit.record({
      action: "memory.deleted_user",
      actorUserId: actingUserId,
      resource: `user:${actingUserId}`,
      policyResult: "ok",
      // Plainly recorded: disclosures already made cannot be recalled.
      detail: { namespaceDeleted: existed, rowsDeleted, note: "prior disclosures cannot be recalled" },
    });
    return { namespaceDeleted: existed, rowsDeleted };
  }

  /** Group removal (spec 5.8 default): keep decisions; remove the leaver's other authored entries. */
  async removeMemberContent(
    conversationId: string,
    userId: string,
  ): Promise<{ removed: number; pending: number }> {
    const ns = namespaces.group(conversationId);
    const client = this.client(ns);
    const authored: Filter = {
      operator: "and",
      operands: [
        { field: "author_user_id", operator: "eq", value: userId },
        { field: "kind", operator: "neq", value: "decision" },
      ],
    };
    const d = await this.deleteDocs(
      ns,
      (await client.listDocuments(authored)).map((x) => x.id),
      `member_left:${userId}`,
    );
    const m = await this.forget(
      ns,
      (await client.listMemories(authored)).map((x) => x.id),
      `member_left:${userId}`,
    );
    await this.deps.audit.record({
      action: "memory.member_content_removed",
      actorUserId: userId,
      resource: `group:${conversationId}`,
      policyResult: "ok",
      detail: { removed: d.removed + m.forgotten, pending: d.failed + m.failed },
    });
    return { removed: d.removed + m.forgotten, pending: d.failed + m.failed };
  }

  /** Retention (memory_settings.retention_days). Worker job, e.g. hourly. */
  async purgeExpired(): Promise<{ removed: number; pending: number }> {
    const expired: Filter = { field: "expires_at", operator: "lt", value: this.deps.clock.now().getTime() };
    let removed = 0;
    let pending = 0;
    for (const name of await this.deps.repo.listNamespaces()) {
      const ns = name as Namespace;
      const client = this.client(ns);
      const d = await this.deleteDocs(
        ns,
        (await client.listDocuments(expired)).map((x) => x.id),
        "retention",
      );
      const m = await this.forget(
        ns,
        (await client.listMemories(expired)).map((x) => x.id),
        "retention",
      );
      removed += d.removed + m.forgotten;
      pending += d.failed + m.failed;
    }
    return { removed, pending };
  }

  /** Worker job (~every 10 s): retry deletes Supermemory refused while documents were processing. */
  async processPendingCleanup(limit = 50): Promise<{ removed: number; stillPending: number }> {
    const { repo } = this.deps;
    const now = this.deps.clock.now();
    let removed = 0;
    for (const item of await repo.dueCleanup(now, limit)) {
      const client = this.client(item.namespace as Namespace);
      let error: string | null;
      try {
        const failed =
          item.target_kind === "document"
            ? (await client.deleteDocuments([item.target_id])).failed
            : (await client.forgetMemories([item.target_id])).errors;
        error = failed.find((f) => !/not found/i.test(f.error))?.error ?? null;
      } catch (err) {
        error = err instanceof Error ? err.message : "delete_failed";
      }
      if (error === null) {
        await repo.markCleanupDone(item.id, now);
        removed++;
      } else {
        const attempts = item.attempts + 1;
        const backoff = Math.min(5_000 * 2 ** (attempts - 1), 5 * 60_000);
        await repo.rescheduleCleanup(item.id, attempts, new Date(now.getTime() + backoff), error);
      }
    }
    return { removed, stillPending: await repo.countPendingCleanup() };
  }

  // -------------------------------------------------------------------------------------------

  private client(ns: Namespace): NamespaceClient {
    return this.deps.supermemory.forNamespace(ns);
  }

  /** Anything Supermemory refuses is queued for retry and hidden from reads until it lands. */
  private async deleteDocs(ns: Namespace, ids: string[], reason: string) {
    if (!ids.length) return { removed: 0, failed: 0 };
    let refused: Array<{ id: string; error: string }>;
    let removed = 0;
    try {
      const res = await this.client(ns).deleteDocuments(ids);
      refused = res.failed.filter((f) => !/not found/i.test(f.error));
      removed = res.count + (res.failed.length - refused.length);
    } catch (err) {
      refused = ids.map((id) => ({ id, error: err instanceof Error ? err.message : "delete_failed" }));
    }
    await this.deps.repo.enqueueCleanup(
      refused.map((f) => ({
        namespace: ns,
        targetKind: "document" as const,
        targetId: f.id,
        reason,
        lastError: f.error,
      })),
      this.deps.clock.now(),
    );
    return { removed, failed: refused.length };
  }

  private async forget(ns: Namespace, ids: string[], reason: string) {
    if (!ids.length) return { forgotten: 0, failed: 0 };
    let refused: Array<{ id: string; error: string }>;
    let forgotten = 0;
    try {
      const res = await this.client(ns).forgetMemories(ids);
      refused = res.errors.filter((e) => !/not found/i.test(e.error));
      forgotten = ids.length - res.errors.length;
    } catch (err) {
      refused = ids.map((id) => ({ id, error: err instanceof Error ? err.message : "forget_failed" }));
    }
    await this.deps.repo.enqueueCleanup(
      refused.map((f) => ({
        namespace: ns,
        targetKind: "memory" as const,
        targetId: f.id,
        reason,
        lastError: f.error,
      })),
      this.deps.clock.now(),
    );
    return { forgotten, failed: refused.length };
  }

  private auditForget(userId: string, detail: Record<string, unknown>) {
    return this.deps.audit.record({
      action: "memory.forgotten",
      actorUserId: userId,
      resource: `user:${userId}`,
      policyResult: "ok",
      detail,
    });
  }
}
