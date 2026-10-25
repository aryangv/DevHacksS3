import type {
  Audience,
  ContextPurpose,
  ContextRequest,
  ContextResult,
  DiscloseRequest,
  DiscloseResult,
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

// Interfaces implemented by P3 (memory): MemoryStore, ContextBroker, ConsentService,
// BucketProvisioner, MemoryPolicy. The harness never passes a namespace — only a principal.

/** Supermemory v5 wrapper (spec 5.2–5.5). One principal → exactly one namespace. */
export interface MemoryStore {
  add(principal: MemoryPrincipal, write: MemoryWrite): Promise<{ id: string }>;
  search(
    principal: MemoryPrincipal,
    query: { query: string; limit?: number; filter?: MemoryMetadata },
  ): Promise<MemoryItem[]>;
  /** Minimal bucket set the task needs (spec 5.5). Omit buckets only when truly needed. */
  profile(principal: MemoryPrincipal, opts: { buckets?: string[] }): Promise<MemoryProfile>;
}

/** spec 5.7: deterministic checks before retrieval *and* before disclosure. Returns projections. */
export interface ContextBroker {
  requestContext(request: ContextRequest): Promise<ContextResult>;
  disclose(request: DiscloseRequest): Promise<DiscloseResult>;
}

/** spec 5.4 + consent grants. Postgres is the system of record, not Supermemory. */
export interface ConsentService {
  getMemorySettings(userId: string): Promise<MemorySettings>;
  hasActiveGrant(
    userId: string,
    purpose: ContextPurpose,
    audience: Audience,
    fields: string[],
  ): Promise<boolean>;
}

/** spec 5.6: provision namespace buckets + supportingContext at user/group creation. */
export interface BucketProvisioner {
  provisionUser(userId: string): Promise<void>;
  provisionGroup(conversationId: string): Promise<void>;
}

/** spec 5.3: decides what is memory-worthy given consent settings; redacts. */
export interface MemoryPolicy {
  evaluate(candidate: MemoryCandidate): Promise<MemoryPolicyDecision>;
}
