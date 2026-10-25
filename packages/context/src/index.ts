// @campus/context — owner: P3 (memory).
//
// Implements MemoryStore (Supermemory v5), ContextBroker, ConsentService, BucketProvisioner and
// MemoryPolicy from @campus/contracts (interfaces/p3.ts, schemas/context.ts) — harness-spec Section 5.
// Plugged into the pipeline by `createContextModule` when USE_REAL_MEMORY=true.
//
// Import rule: only @campus/contracts and files inside this package.
import {
  type ContextModule,
  type ContextModuleFactory,
  HarnessError,
  type ModuleDeps,
  type MembershipService,
} from "@campus/contracts";
import { DefaultBucketProvisioner } from "./buckets";
import { DefaultContextBroker } from "./broker";
import { DefaultConsentService } from "./consent";
import { Directory } from "./directory";
import { DefaultMemoryPolicy } from "./memory-policy";
import { GroupChatIngestor } from "./group-chat";
import { DefaultMemoryStore } from "./memory-store";
import { ContextRepo } from "./repo";
import { Supermemory } from "./supermemory/keys";
import { contextTrace } from "./trace";

export {
  DefaultBucketProvisioner,
  GROUP_BUCKETS,
  PURPOSE_BUCKETS,
  SENSITIVE_BUCKETS,
  USER_BUCKETS,
} from "./buckets";
export { DefaultContextBroker } from "./broker";
export { DefaultConsentService } from "./consent";
export { Directory } from "./directory";
export { CLASS_POLICIES, classify, priceBandFor } from "./fields";
export { DefaultMemoryPolicy, redactSecrets } from "./memory-policy";
export { GroupChatIngestor, type GroupChatIngestResult } from "./group-chat";
export { DefaultMemoryStore, namespaceFor } from "./memory-store";
export { formatUntrusted } from "./read-path";
export { ContextRepo } from "./repo";
export { SupermemoryError } from "./supermemory/client";
export { Supermemory, type SupermemoryOptions } from "./supermemory/keys";
export { contextTrace, type TraceEntry } from "./trace";
export type * from "./types";

/**
 * Everything P3 provides, including the surface beyond the contract interfaces (consent page,
 * forget/delete, worker jobs, trace). `createContextModule` returns the contract-shaped subset.
 */
export async function createContextServices(
  deps: ModuleDeps & { membership: MembershipService; supermemory?: Supermemory },
) {
  if (!deps.sql)
    throw new HarnessError(
      "memory_unavailable",
      "USE_REAL_MEMORY needs DATABASE_URL (consent and broker state live in Postgres)",
    );
  const apiKey = deps.config.SUPERMEMORY_API_KEY;
  if (!deps.supermemory && !apiKey)
    throw new HarnessError("memory_unavailable", "SUPERMEMORY_API_KEY is not set");
  const { sql, audit, clock } = deps;
  const supermemory =
    deps.supermemory ??
    new Supermemory({
      apiKey: apiKey!,
      ...(deps.config.SUPERMEMORY_BASE_URL ? { baseUrl: deps.config.SUPERMEMORY_BASE_URL } : {}),
      scopedKeys: deps.config.SUPERMEMORY_SCOPED_KEYS,
      clock,
    });
  const repo = new ContextRepo(sql);
  const directory = new Directory(sql, deps.membership);
  const provisioner = new DefaultBucketProvisioner({ supermemory, repo, audit, clock });
  const consent = new DefaultConsentService({ repo, directory, provisioner, audit, clock });
  const memoryStore = new DefaultMemoryStore({ supermemory, repo, provisioner, audit, clock });
  return {
    supermemory,
    repo,
    directory,
    provisioner,
    consent,
    memoryPolicy: new DefaultMemoryPolicy({ consent, directory, clock }),
    memoryStore,
    groupChat: new GroupChatIngestor({ sql, memoryStore, audit, clock, logger: deps.logger }),
    broker: new DefaultContextBroker({ repo, supermemory, directory, audit, clock }),
    trace: (taskId: string) => contextTrace(repo, taskId),
    /** Revoke this process's scoped Supermemory keys (call on shutdown). */
    dispose: () => supermemory.dispose(),
  };
}

export type ContextServices = Awaited<ReturnType<typeof createContextServices>>;

/** DI entry point (REAL_MODULES.context): loaded by the worker/api container when USE_REAL_MEMORY=true. */
export const createContextModule: ContextModuleFactory = async (deps): Promise<ContextModule> => {
  const s = await createContextServices(deps);
  return {
    memoryStore: s.memoryStore,
    broker: s.broker,
    consent: s.consent,
    buckets: s.provisioner,
    memoryPolicy: s.memoryPolicy,
    maintenance: {
      processPendingCleanup: () => s.memoryStore.processPendingCleanup(),
      purgeExpired: () => s.memoryStore.purgeExpired(),
      ingestGroupChat: () => s.groupChat.ingestGroupChat(),
    },
  };
};
