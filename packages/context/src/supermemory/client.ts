import { z } from "zod";
import type { Namespace } from "./namespaces";

/**
 * Supermemory v5 REST client (https://api.supermemory.ai, OpenAPI 5.0.0). Server-side only.
 *
 * Split by privilege:
 * - `NamespaceClient`: data plane for ONE namespace (add/search/profile/list/forget/delete docs).
 *   With scoped keys enabled it authenticates with a key Supermemory itself restricts
 *   to that namespace, so even a bug in our code cannot reach another user's memory
 *   (verified live: such a key gets 403 on any other namespace).
 * - `SupermemoryAdmin`: org key; provisioning, namespace deletion, key minting.
 *   Scoped keys can also delete their own namespace and edit buckets (verified live),
 *   so those operations are deliberately kept on the admin path.
 */

export type MetadataValue = string | number | boolean | string[];
export type Metadata = Record<string, MetadataValue>;

export type Filter =
  | { field: string; operator: "eq" | "neq"; value: string | number | boolean }
  | { field: string; operator: "gt" | "gte" | "lt" | "lte"; value: number }
  | { field: string; operator: "contains" | "notContains"; value: string }
  | { field: string; operator: "arrayContains" | "arrayNotContains"; value: string }
  | { operator: "and" | "or"; operands: Filter[] };

export type AddInput = {
  content: string;
  /** Stable caller ID. Re-using it APPENDS to the document (verified live). */
  id?: string;
  metadata?: Metadata;
  /** "superrag" = retrieval only, no memories formed. */
  taskType?: "memory" | "superrag";
  /** "instant" formed memories in ~35s in our tests; the default "dynamic" took >3 min. */
  dreaming?: "dynamic" | "instant";
  date?: string;
};

export type SearchInput = {
  query: string;
  filter?: Filter;
  searchMode?: "hybrid" | "memories" | "chunks";
  limit?: number;
  threshold?: number;
};

export type SearchHit = {
  id: string;
  text: string;
  kind: "memory" | "chunk";
  metadata: Record<string, unknown>;
  similarity: number;
  documentId: string | null;
};

export type ProfileEntry = { id: string; memory: string };
export type Profile = {
  static: ProfileEntry[];
  dynamic: ProfileEntry[];
  buckets: Record<string, ProfileEntry[]>;
};

export type DocumentSummary = { id: string; metadata: Record<string, unknown>; status: string };

export type ForgetResult = {
  count: number;
  errors: Array<{ id: string; error: string }>;
  matches: Array<{ id: string; memory: string }>;
};

/** Never carries a request/response body: bodies can echo private memory and errors reach logs. */
export class SupermemoryError extends Error {
  constructor(
    readonly status: number | "network",
    readonly operation: string,
  ) {
    super(`supermemory ${operation} failed (${status})`);
    this.name = "SupermemoryError";
  }
}

export type HttpOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
};

/** Shared transport: retries only idempotent calls on 429/5xx/network. */
export class SupermemoryHttp {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.supermemory.ai").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request(
    apiKey: string,
    method: string,
    path: string,
    body: unknown,
    operation: string,
    opts: { idempotent: boolean; okStatuses?: number[]; timeoutMs?: number },
  ): Promise<{ status: number; json: unknown }> {
    for (let attempt = 0; ; attempt++) {
      let status: number | "network";
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
        });
        if (res.ok || opts.okStatuses?.includes(res.status)) {
          const text = await res.text();
          return { status: res.status, json: text ? JSON.parse(text) : {} };
        }
        status = res.status;
      } catch {
        status = "network";
      }
      const transient = status === "network" || status === 429 || status >= 500;
      if (!opts.idempotent || !transient || attempt >= this.maxRetries)
        throw new SupermemoryError(status, operation);
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
}

const Entry = z.object({ id: z.string(), memory: z.string() });
const AddResponse = z.object({ id: z.string(), status: z.string() });
const SearchResponse = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      memory: z.string().optional(),
      chunk: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
      similarity: z.number(),
      included: z.object({ document: z.object({ id: z.string() }).optional() }).optional(),
    }),
  ),
});
const ProfileResponse = z.object({
  profile: z.object({
    static: z.array(Entry).default([]),
    dynamic: z.array(Entry).default([]),
    buckets: z.record(z.string(), z.array(Entry)).default({}),
  }),
});
const ListDocumentsResponse = z.object({
  documents: z.array(
    z.object({
      id: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
      system: z.object({ status: z.string() }),
    }),
  ),
  pagination: z.object({ totalPages: z.number() }),
});
const ListMemoriesResponse = z.object({
  memories: z.array(
    z.object({ id: z.string(), memory: z.string(), metadata: z.record(z.string(), z.unknown()).default({}) }),
  ),
  pagination: z.object({ totalPages: z.number() }),
});
const ForgetResponse = z.object({
  count: z.number(),
  errors: z.array(z.object({ id: z.string(), error: z.string() })).default([]),
  matches: z.array(z.object({ id: z.string(), memory: z.string() })).default([]),
});
const DeleteDocumentsResponse = z.object({
  count: z.number(),
  errors: z.array(z.object({ id: z.string(), error: z.string() })).default([]),
});
const BucketsResponse = z.object({ buckets: z.record(z.string(), z.string()) });
const ScopedKeyResponse = z.object({
  key: z.string(),
  id: z.string(),
  expiresAt: z.string().nullable().optional(),
});

export type KeySource = {
  /** Key to use for this namespace's data-plane calls. */
  keyFor(namespace: Namespace): Promise<string>;
  /** Called when that key was rejected (401): drop it so the next call re-mints. */
  invalidate(namespace: Namespace): void;
};

/** Data plane for exactly one namespace. No method takes a namespace argument. */
export class NamespaceClient {
  constructor(
    readonly namespace: Namespace,
    private readonly http: SupermemoryHttp,
    private readonly keys: KeySource,
  ) {}

  async add(input: AddInput): Promise<{ id: string; status: string }> {
    // Re-sending the same id appends; without an id a retry could duplicate.
    const res = await this.call(
      "POST",
      `/ns/${this.namespace}/document`,
      input,
      "add",
      input.id !== undefined,
    );
    return AddResponse.parse(res.json);
  }

  async search(input: SearchInput): Promise<SearchHit[]> {
    const res = await this.call(
      "POST",
      `/ns/${this.namespace}/search`,
      { ...input, include: { documents: true } },
      "search",
      true,
      [404],
    );
    if (res.status === 404) return []; // namespace not created yet (no writes)
    return SearchResponse.parse(res.json).results.map((r) => ({
      id: r.id,
      text: r.memory ?? r.chunk ?? "",
      kind: r.memory !== undefined ? ("memory" as const) : ("chunk" as const),
      metadata: r.metadata,
      similarity: r.similarity,
      documentId: r.included?.document?.id ?? null,
    }));
  }

  /** `buckets` omitted = every effective bucket; pass the minimal set (§5.5). */
  async profile(input: { buckets?: string[]; filter?: Filter } = {}): Promise<Profile> {
    const res = await this.call("POST", `/ns/${this.namespace}/profile`, input, "profile", true, [404]);
    if (res.status === 404) return { static: [], dynamic: [], buckets: {} };
    return ProfileResponse.parse(res.json).profile;
  }

  /** Every document matching `filter` (pages through results). */
  async listDocuments(filter?: Filter): Promise<DocumentSummary[]> {
    const out: DocumentSummary[] = [];
    for (let page = 1; ; page++) {
      const res = await this.call(
        "POST",
        `/ns/${this.namespace}/list/documents?page=${page}&limit=100`,
        { ...(filter ? { filter } : {}), include: { memoryCount: false } },
        "listDocuments",
        true,
        [404],
      );
      if (res.status === 404) return out;
      const parsed = ListDocumentsResponse.parse(res.json);
      out.push(...parsed.documents.map((d) => ({ id: d.id, metadata: d.metadata, status: d.system.status })));
      if (page >= parsed.pagination.totalPages) return out;
    }
  }

  /** Learned memories matching `filter` (metadata propagates from documents to memories — verified live). */
  async listMemories(
    filter?: Filter,
  ): Promise<Array<{ id: string; memory: string; metadata: Record<string, unknown> }>> {
    const out: Array<{ id: string; memory: string; metadata: Record<string, unknown> }> = [];
    for (let page = 1; ; page++) {
      const res = await this.call(
        "POST",
        `/ns/${this.namespace}/list/memories?page=${page}&limit=100`,
        filter ? { filter } : {},
        "listMemories",
        true,
        [404],
      );
      if (res.status === 404) return out;
      const parsed = ListMemoriesResponse.parse(res.json);
      out.push(...parsed.memories);
      if (page >= parsed.pagination.totalPages) return out;
    }
  }

  async forgetMemories(ids: string[]): Promise<ForgetResult> {
    const res = await this.call("DELETE", `/ns/${this.namespace}/memories`, { ids }, "forgetMemories", true);
    return ForgetResponse.parse(res.json);
  }

  async semanticForget(query: string, dryRun: boolean): Promise<ForgetResult> {
    // Model-driven on Supermemory's side: took >15 s live, so it gets a longer timeout.
    const res = await this.call(
      "DELETE",
      `/ns/${this.namespace}/memories/semantic`,
      { query, dryRun },
      "semanticForget",
      dryRun,
      [404],
      60_000,
    );
    if (res.status === 404) return { count: 0, errors: [], matches: [] };
    return ForgetResponse.parse(res.json);
  }

  /**
   * Supermemory answers 200 with per-document `errors` (e.g. "Document is still
   * processing") rather than failing the call. Those are returned, never dropped.
   */
  async deleteDocuments(
    ids: string[],
  ): Promise<{ count: number; failed: Array<{ id: string; error: string }> }> {
    let count = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.call(
        "DELETE",
        `/ns/${this.namespace}/document`,
        { ids: ids.slice(i, i + 100) },
        "deleteDocuments",
        true,
      );
      const parsed = DeleteDocumentsResponse.parse(res.json);
      count += parsed.count;
      failed.push(...parsed.errors);
    }
    return { count, failed };
  }

  private async call(
    method: string,
    path: string,
    body: unknown,
    operation: string,
    idempotent: boolean,
    okStatuses: number[] = [],
    timeoutMs?: number,
  ) {
    const key = await this.keys.keyFor(this.namespace);
    const opts = { idempotent, okStatuses, ...(timeoutMs ? { timeoutMs } : {}) };
    try {
      return await this.http.request(key, method, path, body, operation, opts);
    } catch (err) {
      if (err instanceof SupermemoryError && err.status === 401) {
        // Scoped key expired or was revoked: re-mint once.
        this.keys.invalidate(this.namespace);
        return this.http.request(await this.keys.keyFor(this.namespace), method, path, body, operation, opts);
      }
      throw err;
    }
  }
}

/** Org-key operations. Never handed to agents. */
export class SupermemoryAdmin {
  constructor(
    private readonly http: SupermemoryHttp,
    private readonly orgKey: string,
  ) {
    if (!orgKey) throw new Error("SUPERMEMORY_API_KEY is required");
  }

  /** Namespaces exist only after a first write; settings calls 404 before that (verified live). */
  async initNamespace(namespace: Namespace): Promise<void> {
    await this.http.request(
      this.orgKey,
      "POST",
      `/ns/${namespace}/document`,
      {
        id: "ns_init",
        content: "Campus agent memory namespace.",
        taskType: "superrag",
        metadata: { kind: "system" },
      },
      "initNamespace",
      { idempotent: true },
    );
  }

  async setSupportingContext(namespace: Namespace, supportingContext: string): Promise<void> {
    if (supportingContext.length > 1500) throw new Error("supportingContext exceeds 1500 characters");
    await this.http.request(
      this.orgKey,
      "PATCH",
      `/ns/${namespace}`,
      { supportingContext },
      "setSupportingContext",
      { idempotent: true },
    );
  }

  /** Returns the effective bucket map. 409 = clash with an org-level bucket (the org definition wins). */
  async putBuckets(
    namespace: Namespace,
    buckets: Record<string, string>,
  ): Promise<{ conflict: boolean; buckets: Record<string, string> }> {
    const res = await this.http.request(
      this.orgKey,
      "PUT",
      `/ns/${namespace}/profile/buckets`,
      { buckets },
      "putBuckets",
      {
        idempotent: true,
        okStatuses: [409],
      },
    );
    if (res.status === 409) return { conflict: true, buckets: {} };
    return { conflict: false, buckets: BucketsResponse.parse(res.json).buckets };
  }

  async deleteBuckets(namespace: Namespace, buckets: string[]): Promise<void> {
    await this.http.request(
      this.orgKey,
      "DELETE",
      `/ns/${namespace}/profile/buckets`,
      { buckets },
      "deleteBuckets",
      { idempotent: true },
    );
  }

  async getBuckets(namespace: Namespace): Promise<Record<string, string>> {
    const res = await this.http.request(
      this.orgKey,
      "GET",
      `/ns/${namespace}/profile/buckets`,
      undefined,
      "getBuckets",
      { idempotent: true },
    );
    return BucketsResponse.parse(res.json).buckets;
  }

  /** Deletes the namespace and all its content. Works even while documents are processing (verified live). */
  async deleteNamespace(namespace: Namespace): Promise<{ existed: boolean }> {
    const res = await this.http.request(
      this.orgKey,
      "DELETE",
      `/ns/${namespace}`,
      undefined,
      "deleteNamespace",
      {
        idempotent: true,
        okStatuses: [404],
      },
    );
    return { existed: res.status !== 404 };
  }

  /** Scoped key minting still lives on the v3 path and calls the namespace a `containerTag`. */
  async mintScopedKey(
    namespace: Namespace,
    expiresInDays = 1,
  ): Promise<{ key: string; id: string; expiresAt: Date | null }> {
    const res = await this.http.request(
      this.orgKey,
      "POST",
      "/v3/auth/scoped-key",
      { containerTag: namespace, name: `campus_${namespace}`, expiresInDays },
      "mintScopedKey",
      { idempotent: false },
    );
    const parsed = ScopedKeyResponse.parse(res.json);
    return {
      key: parsed.key,
      id: parsed.id,
      expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
    };
  }

  async revokeScopedKey(id: string): Promise<void> {
    await this.http.request(
      this.orgKey,
      "DELETE",
      `/v3/auth/scoped-key/${encodeURIComponent(id)}`,
      undefined,
      "revokeScopedKey",
      {
        idempotent: true,
        okStatuses: [404],
      },
    );
  }
}
