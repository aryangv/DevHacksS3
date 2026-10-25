/**
 * HTTP-level fake of the Supermemory v5 API subset P3 uses, so tests exercise the
 * real client. It reproduces behaviour verified against the live API (2026-10-24):
 * - namespaces are created by the first document write; settings calls 404 before that;
 * - re-adding a document id appends content;
 * - scoped keys get 403 on any other namespace;
 * - deleting a still-processing document is refused in a 200 response's `errors`;
 * - semantic forget previews with dryRun, exact-ID forget removes from recall;
 * - metadata is copied from documents to their memories and filters apply to both.
 * Memory formation and bucket classification are simple keyword stand-ins.
 */

type Meta = Record<string, unknown>;
type Doc = {
  id: string;
  content: string;
  metadata: Meta;
  processing: boolean;
  taskType: string;
  createdAt: string;
};
type Mem = {
  id: string;
  docId: string;
  memory: string;
  metadata: Meta;
  forgotten: boolean;
  buckets: string[];
};
type Space = {
  docs: Map<string, Doc>;
  mems: Map<string, Mem>;
  buckets: Record<string, string>;
  supportingContext: string | null;
};

export type FakeSupermemoryOptions = {
  orgKey?: string;
  /** New documents stay "processing" (undeletable) until `settle()`. */
  simulateProcessing?: boolean;
  /** Org-level bucket names; namespace PUTs that include one get 409. */
  orgBuckets?: string[];
};

const BUCKET_WORDS: Record<string, RegExp> = {
  food_preferences:
    /\b(eat|food|vegetarian|vegan|meat|fish|allerg\w*|thai|pizza|sushi|dairy|gluten|halal|kosher|cuisine)\b/i,
  budget: /\$\d|\bbudget\b|\bspend\w*\b/i,
  schedule_habits: /\b(class|free|morning|evening|weekday|weekend|schedule)\b/i,
  campus_life: /\bcampus\b|\bclub\b|\bdorm\b|\blend\b/i,
  group_plans: /\b(decided|confirmed|plan)\b/i,
  health: /\b(diagnos\w*|condition|medication|celiac)\b/i,
};

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((w) => w.length > 2);

type FakeFilter = {
  field?: string;
  operator: string;
  value?: string | number | boolean;
  operands?: FakeFilter[];
};

/** Parsed JSON request body; only the fields the routes below read. */
type Body = {
  id?: string;
  content?: string;
  metadata?: Meta;
  taskType?: string;
  containerTag?: string;
  supportingContext?: string | null;
  buckets?: Record<string, string> | string[];
  filter?: FakeFilter;
  query?: string;
  dryRun?: boolean;
  ids?: string[];
  limit?: number;
  threshold?: number;
  searchMode?: string;
};

function matches(filter: FakeFilter | undefined, meta: Meta): boolean {
  if (!filter) return true;
  if (Array.isArray(filter.operands)) {
    return filter.operator === "and"
      ? filter.operands.every((f) => matches(f, meta))
      : filter.operands.some((f) => matches(f, meta));
  }
  const v = meta[filter.field ?? ""];
  const num = Number(filter.value);
  const str = String(filter.value);
  switch (filter.operator) {
    case "eq":
      return v === filter.value;
    case "neq":
      return v !== filter.value;
    case "gt":
      return typeof v === "number" && v > num;
    case "gte":
      return typeof v === "number" && v >= num;
    case "lt":
      return typeof v === "number" && v < num;
    case "lte":
      return typeof v === "number" && v <= num;
    case "contains":
      return typeof v === "string" && v.includes(str);
    case "notContains":
      return typeof v !== "string" || !v.includes(str);
    case "arrayContains":
      return Array.isArray(v) && v.includes(str);
    case "arrayNotContains":
      return !Array.isArray(v) || !v.includes(str);
    default:
      throw new Error(`fake: unsupported operator ${filter.operator}`);
  }
}

export class FakeSupermemory {
  readonly orgKey: string;
  readonly calls: Array<{
    method: string;
    path: string;
    namespace: string | null;
    auth: "org" | "scoped" | "invalid";
    body: Body | undefined;
  }> = [];
  private readonly spaces = new Map<string, Space>();
  private readonly scopedKeys = new Map<string, { id: string; namespace: string; revoked: boolean }>();
  private seq = 0;

  constructor(private readonly options: FakeSupermemoryOptions = {}) {
    this.orgKey = options.orgKey ?? "sm_org_test_key";
  }

  /** Pass as `fetch` to the real client. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const key = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    return this.handle(method, url, body, key);
  };

  settle() {
    for (const s of this.spaces.values()) for (const d of s.docs.values()) d.processing = false;
  }

  namespaces(): string[] {
    return [...this.spaces.keys()];
  }

  documents(namespace: string): Doc[] {
    return [...(this.spaces.get(namespace)?.docs.values() ?? [])];
  }

  memories(namespace: string, includeForgotten = false): Mem[] {
    return [...(this.spaces.get(namespace)?.mems.values() ?? [])].filter(
      (m) => includeForgotten || !m.forgotten,
    );
  }

  buckets(namespace: string): Record<string, string> | undefined {
    return this.spaces.get(namespace)?.buckets;
  }

  supportingContext(namespace: string): string | null | undefined {
    return this.spaces.get(namespace)?.supportingContext;
  }

  /** Simulate keys expiring or being revoked server-side. */
  revokeAllScopedKeys(): void {
    for (const k of this.scopedKeys.values()) k.revoked = true;
  }

  liveScopedKeys(): number {
    return [...this.scopedKeys.values()].filter((k) => !k.revoked).length;
  }

  // -------------------------------------------------------------------------

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private handle(method: string, url: URL, raw: Body | undefined, key: string): Response {
    const path = url.pathname;
    const body: Body = raw ?? {};

    // Auth.
    const scoped = this.scopedKeys.get(key);
    const auth = key === this.orgKey ? "org" : scoped && !scoped.revoked ? "scoped" : "invalid";
    const nsMatch = /^\/ns\/([^/]+)(\/.*)?$/.exec(path);
    const namespace = nsMatch ? decodeURIComponent(nsMatch[1]!) : null;
    this.calls.push({ method, path, namespace, auth, body: raw });
    if (auth === "invalid") return this.json(401, { error: "Unauthorized" });

    if (path === "/v3/auth/scoped-key" && method === "POST") {
      if (auth !== "org") return this.json(403, { error: "forbidden" });
      const id = `sk_${++this.seq}`;
      const newKey = `sm_scoped_${id}_${Math.random().toString(36).slice(2)}`;
      this.scopedKeys.set(newKey, { id, namespace: String(body.containerTag), revoked: false });
      return this.json(200, {
        key: newKey,
        id,
        containerTag: body.containerTag,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    }
    const revoke = /^\/v3\/auth\/scoped-key\/(.+)$/.exec(path);
    if (revoke && method === "DELETE") {
      for (const k of this.scopedKeys.values()) if (k.id === decodeURIComponent(revoke[1]!)) k.revoked = true;
      return this.json(200, { success: true });
    }

    if (!namespace) return this.json(404, { error: "not found" });
    if (!/^[a-zA-Z0-9_:-]{1,100}$/.test(namespace)) return this.json(400, { error: "invalid namespace" });
    if (auth === "scoped" && scoped!.namespace !== namespace) {
      return this.json(403, {
        error: `Invalid container tag "${namespace}". Access restricted to "${scoped!.namespace}"`,
      });
    }
    const rest = nsMatch![2] ?? "";
    const space = this.spaces.get(namespace);

    if (rest === "/document" && method === "POST") return this.addDocument(namespace, body);
    if (rest === "" && method === "DELETE") {
      if (!space) return this.json(404, { error: "Namespace not found" });
      this.spaces.delete(namespace);
      return this.json(200, {
        status: "deleted",
        namespace,
        deletedDocumentsCount: space.docs.size,
        deletedMemoriesCount: space.mems.size,
      });
    }
    if (!space) return this.json(404, { error: "Namespace not found" });

    if (rest === "" && method === "PATCH") {
      space.supportingContext = body.supportingContext ?? null;
      return this.json(200, {
        namespace,
        supportingContext: space.supportingContext,
        system: { createdAt: "", updatedAt: "" },
      });
    }
    if (rest === "/profile/buckets") {
      if (method === "GET") return this.json(200, { buckets: space.buckets });
      if (method === "PUT") {
        const incoming = Array.isArray(body.buckets) ? {} : (body.buckets ?? {});
        if (Object.keys(incoming).some((b) => this.options.orgBuckets?.includes(b)))
          return this.json(409, { error: "conflict" });
        Object.assign(space.buckets, incoming);
        return this.json(200, { buckets: space.buckets });
      }
      if (method === "DELETE") {
        for (const b of Array.isArray(body.buckets) ? body.buckets : []) delete space.buckets[b];
        return this.json(200, { buckets: space.buckets });
      }
    }
    if (rest === "/profile" && method === "POST") {
      const live = this.memories(namespace).filter((m) => matches(body.filter, m.metadata));
      const wanted = Array.isArray(body.buckets) ? body.buckets : Object.keys(space.buckets);
      const buckets: Record<string, Array<{ id: string; memory: string }>> = {};
      for (const b of wanted)
        if (b in space.buckets)
          buckets[b] = live.filter((m) => m.buckets.includes(b)).map((m) => ({ id: m.id, memory: m.memory }));
      return this.json(200, {
        profile: {
          static: [],
          dynamic: live.map((m) => ({ id: m.id, memory: `[2026-10-24] ${m.memory}` })),
          buckets,
        },
      });
    }
    if (rest === "/search" && method === "POST") return this.search(space, body);
    const list = /^\/list\/(documents|memories)$/.exec(rest);
    if (list && method === "POST") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const all =
        list[1] === "documents"
          ? [...space.docs.values()]
              .filter((d) => matches(body.filter, d.metadata))
              .map((d) => ({
                id: d.id,
                title: null,
                type: "text",
                summary: null,
                metadata: d.metadata,
                url: null,
                system: {
                  status: d.processing ? "queued" : "done",
                  dreamingStatus: "done",
                  createdAt: d.createdAt,
                  updatedAt: d.createdAt,
                },
              }))
          : this.memories(namespace)
              .filter((m) => matches(body.filter, m.metadata))
              .map((m) => ({ id: m.id, memory: m.memory, metadata: m.metadata }));
      const slice = all.slice((page - 1) * limit, page * limit);
      return this.json(200, {
        documents: list[1] === "documents" ? slice : [],
        chunks: [],
        memories: list[1] === "memories" ? slice : [],
        pagination: {
          currentPage: page,
          limit,
          totalItems: all.length,
          totalPages: Math.ceil(all.length / limit),
        },
      });
    }
    if (rest === "/document" && method === "DELETE") {
      let count = 0;
      const errors: Array<{ id: string; error: string }> = [];
      for (const id of body.ids ?? []) {
        const doc = space.docs.get(id);
        if (!doc) errors.push({ id, error: "Document not found" });
        else if (doc.processing) errors.push({ id, error: "Document is still processing" });
        else {
          space.docs.delete(id);
          for (const m of space.mems.values()) if (m.docId === id) space.mems.delete(m.id);
          count++;
        }
      }
      return this.json(200, { count, errors });
    }
    if (rest === "/memories" && method === "DELETE") {
      const errors: Array<{ id: string; error: string }> = [];
      const out: Array<{ id: string; memory: string }> = [];
      for (const id of body.ids ?? []) {
        const m = space.mems.get(id);
        if (!m || m.forgotten) errors.push({ id, error: "Memory not found" });
        else {
          m.forgotten = true;
          out.push({ id, memory: m.memory });
        }
      }
      return this.json(200, { count: out.length, errors, matches: out });
    }
    if (rest === "/memories/semantic" && method === "DELETE") {
      const q = tokens(body.query ?? "");
      const hit = this.memories(namespace).filter(
        (m) => q.filter((t) => tokens(m.memory).includes(t)).length >= Math.max(1, Math.ceil(q.length / 2)),
      );
      if (!body.dryRun) for (const m of hit) m.forgotten = true;
      return this.json(200, {
        count: hit.length,
        errors: [],
        matches: hit.map((m) => ({ id: m.id, memory: m.memory })),
      });
    }
    return this.json(404, { error: `fake: no route ${method} ${path}` });
  }

  private addDocument(namespace: string, body: Body): Response {
    const space = this.spaces.get(namespace) ?? {
      docs: new Map(),
      mems: new Map(),
      buckets: {},
      supportingContext: null,
    };
    this.spaces.set(namespace, space);
    const id = body.id ?? `doc_${++this.seq}`;
    const existing = space.docs.get(id);
    const doc: Doc = existing
      ? {
          ...existing,
          content: `${existing.content}\n\n--- ${body.content}`,
          metadata: body.metadata ?? existing.metadata,
          processing: !!this.options.simulateProcessing,
        }
      : {
          id,
          content: body.content,
          metadata: body.metadata ?? {},
          processing: !!this.options.simulateProcessing,
          taskType: body.taskType ?? "memory",
          createdAt: new Date().toISOString(),
        };
    space.docs.set(id, doc);
    if (doc.taskType !== "superrag") {
      // One memory per sentence of the *new* content; metadata copied from the document.
      for (const sentence of String(body.content)
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        const memId = `mem_${++this.seq}`;
        const buckets = Object.entries(BUCKET_WORDS)
          .filter(([b, re]) => b in space.buckets && re.test(sentence))
          .map(([b]) => b);
        space.mems.set(memId, {
          id: memId,
          docId: id,
          memory: sentence,
          metadata: { ...doc.metadata },
          forgotten: false,
          buckets,
        });
      }
    }
    return this.json(200, { id, status: "queued" });
  }

  private search(space: Space, body: Body): Response {
    const q = tokens(body.query ?? "");
    const score = (text: string) => {
      const words = new Set(tokens(text));
      return q.length ? q.filter((t) => words.has(t)).length / q.length : 0;
    };
    const threshold = body.threshold ?? 0.1;
    const results: Array<Record<string, unknown> & { similarity: number }> = [];
    if (body.searchMode !== "chunks") {
      for (const m of space.mems.values()) {
        if (m.forgotten || !matches(body.filter, m.metadata)) continue;
        const s = score(m.memory);
        if (s >= threshold)
          results.push({
            id: m.id,
            memory: m.memory,
            metadata: m.metadata,
            similarity: s,
            isLatest: true,
            isInference: false,
            system: { updatedAt: "" },
            included: { document: { id: m.docId } },
          });
      }
    }
    if (body.searchMode !== "memories") {
      for (const d of space.docs.values()) {
        if (!matches(body.filter, d.metadata)) continue;
        const s = score(d.content);
        if (s >= threshold)
          results.push({
            id: `chunk_${d.id}`,
            chunk: d.content,
            metadata: d.metadata,
            similarity: s,
            isLatest: true,
            isInference: false,
            system: { updatedAt: "" },
            included: { document: { id: d.id } },
          });
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return this.json(200, { results: results.slice(0, body.limit ?? 10), searchTime: 1 });
  }
}
