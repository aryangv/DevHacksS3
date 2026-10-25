// @campus/context — owner: P3 (memory).
//
// Implements: MemoryStore (Supermemory v5 wrapper), ContextBroker, ConsentService, BucketProvisioner,
// MemoryPolicy — see @campus/contracts interfaces/p3.ts, schemas/context.ts (named field registry)
// and harness-spec Section 5.
// Tables (P3-owned): core.memory_settings, core.consent_grants. New columns → db/migrations/p3/.
//
// To plug into the pipeline, export:
//   export const createContextModule: ContextModuleFactory = (deps) => ({ memoryStore, broker, consent, buckets, memoryPolicy })
// then flip USE_REAL_MEMORY=true at integration point I2.
//
// Import rule: only @campus/contracts and files inside this package.
export {};
