import type {
  BucketProvisioner,
  ConsentService,
  ContextBroker,
  MemoryPolicy,
  MemoryStore,
} from "../interfaces/p3";
import {
  type Audience,
  CONTEXT_FIELDS_BY_PURPOSE,
  type ContextPurpose,
  type ContextRequest,
  type ContextResult,
  type DiscloseRequest,
  type DiscloseResult,
  isContextFieldName,
} from "../schemas/context";
import type {
  MemoryCandidate,
  MemoryItem,
  MemoryMetadata,
  MemoryPolicyDecision,
  MemoryPrincipal,
  MemoryProfile,
  MemorySettings,
  MemoryWrite,
} from "../schemas/memory";
import { newId } from "../util/ids";
import { redactString } from "../util/redact";

// In-memory fakes for P3's interfaces. Real implementations: @campus/context (P3).

const principalKey = (p: MemoryPrincipal) =>
  p.kind === "user" ? `user_${p.userId}` : `group_${p.conversationId}`;

/** Per-principal isolation like real namespaces: a search only ever touches one principal's items. */
export class FakeMemoryStore implements MemoryStore {
  private readonly spaces = new Map<string, MemoryItem[]>();
  readonly writes: Array<{ principal: MemoryPrincipal; write: MemoryWrite }> = [];

  async add(principal: MemoryPrincipal, write: MemoryWrite): Promise<{ id: string }> {
    this.writes.push({ principal, write });
    const items = this.spaces.get(principalKey(principal)) ?? [];
    const existing = write.customId ? items.find((i) => i.id === write.customId) : undefined;
    if (existing) {
      existing.content = `${existing.content}\n${write.content}`;
      return { id: existing.id };
    }
    const item: MemoryItem = {
      id: write.customId ?? newId(),
      content: write.content,
      metadata: { ...write.metadata, kind: write.kind },
    };
    items.push(item);
    this.spaces.set(principalKey(principal), items);
    return { id: item.id };
  }

  async search(
    principal: MemoryPrincipal,
    query: { query: string; limit?: number; filter?: MemoryMetadata },
  ): Promise<MemoryItem[]> {
    const terms = query.query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2);
    const items = this.spaces.get(principalKey(principal)) ?? [];
    return items
      .filter((i) => !query.filter || Object.entries(query.filter).every(([k, v]) => i.metadata[k] === v))
      .map((i) => ({ ...i, score: terms.filter((t) => i.content.toLowerCase().includes(t)).length }))
      .filter((i) => (i.score ?? 0) > 0 || terms.length === 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, query.limit ?? 5);
  }

  async profile(principal: MemoryPrincipal, _opts: { buckets?: string[] }): Promise<MemoryProfile> {
    const items = this.spaces.get(principalKey(principal)) ?? [];
    return {
      static: items
        .filter((i) => i.metadata.kind === "preference" || i.metadata.kind === "fact")
        .map((i) => i.content),
      dynamic: items
        .filter((i) => i.metadata.kind === "conversation" || i.metadata.kind === "decision")
        .slice(-5)
        .map((i) => i.content),
      buckets: {},
    };
  }

  count(principal: MemoryPrincipal): number {
    return (this.spaces.get(principalKey(principal)) ?? []).length;
  }
}

/**
 * Spec 18.3: "fake broker (approve all)". Approves any registry field it has a seeded value for and
 * returns only registry fields (projections). Tests can force needs_consent / denied per user.
 */
export class FakeContextBroker implements ContextBroker {
  readonly requests: ContextRequest[] = [];
  readonly discloseRequests: DiscloseRequest[] = [];
  readonly needsConsent = new Set<string>();
  readonly denied = new Set<string>();
  readonly disclosureDenied = new Set<string>();

  constructor(private readonly facts: Map<string, Record<string, unknown>> = new Map()) {}

  setFacts(userId: string, values: Record<string, unknown>): void {
    this.facts.set(userId, values);
  }

  async requestContext(request: ContextRequest): Promise<ContextResult> {
    this.requests.push(request);
    if (this.denied.has(request.subjectUserId)) return { status: "denied", reasonCode: "fake_denied" };
    if (this.needsConsent.has(request.subjectUserId))
      return { status: "needs_consent", consentRequestId: `consent-${newId()}` };
    const allowed = new Set<string>(CONTEXT_FIELDS_BY_PURPOSE[request.purpose]);
    const values = this.facts.get(request.subjectUserId) ?? {};
    const fields: Record<string, unknown> = {};
    for (const f of request.fields) {
      if (isContextFieldName(f) && allowed.has(f) && f in values) fields[f] = values[f];
    }
    return { status: "approved", fields, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  }

  async disclose(request: DiscloseRequest): Promise<DiscloseResult> {
    this.discloseRequests.push(request);
    const blocked = request.dataClasses.find((d) => this.disclosureDenied.has(d));
    return blocked ? { allowed: false, reasonCode: `not_disclosable:${blocked}` } : { allowed: true };
  }
}

export class FakeConsentService implements ConsentService {
  private readonly settings = new Map<string, MemorySettings>();

  /** Defaults mirror core.memory_settings defaults (spec 8): remember on, kinds {preference,fact}. */
  async getMemorySettings(userId: string): Promise<MemorySettings> {
    return (
      this.settings.get(userId) ?? {
        userId,
        rememberEnabled: true,
        allowedKinds: ["preference", "fact"],
        sensitiveBucketsEnabled: false,
        retentionDays: null,
      }
    );
  }

  set(userId: string, patch: Partial<MemorySettings>): void {
    this.settings.set(userId, { ...this.settingsOrDefault(userId), ...patch });
  }

  private settingsOrDefault(userId: string): MemorySettings {
    return (
      this.settings.get(userId) ?? {
        userId,
        rememberEnabled: true,
        allowedKinds: ["preference", "fact"],
        sensitiveBucketsEnabled: false,
        retentionDays: null,
      }
    );
  }

  async hasActiveGrant(
    _userId: string,
    _purpose: ContextPurpose,
    _audience: Audience,
    _fields: string[],
  ): Promise<boolean> {
    return true;
  }
}

export class FakeBucketProvisioner implements BucketProvisioner {
  readonly provisioned: string[] = [];
  async provisionUser(userId: string): Promise<void> {
    this.provisioned.push(`user_${userId}`);
  }
  async provisionGroup(conversationId: string): Promise<void> {
    this.provisioned.push(`group_${conversationId}`);
  }
}

/** Consent-checked ingestion: user principals follow memory settings; group principals take decisions only. */
export class FakeMemoryPolicy implements MemoryPolicy {
  constructor(private readonly consent: ConsentService) {}

  async evaluate(candidate: MemoryCandidate): Promise<MemoryPolicyDecision> {
    const write = { ...candidate.write, content: redactString(candidate.write.content) };
    if (candidate.principal.kind === "group") {
      return write.kind === "decision"
        ? { ingest: true, write }
        : { ingest: false, reason: "group_non_decision" };
    }
    const settings = await this.consent.getMemorySettings(candidate.authorUserId);
    if (!settings.rememberEnabled) return { ingest: false, reason: "remember_disabled" };
    if (!settings.allowedKinds.includes(write.kind))
      return { ingest: false, reason: `kind_not_allowed:${write.kind}` };
    return { ingest: true, write };
  }
}
