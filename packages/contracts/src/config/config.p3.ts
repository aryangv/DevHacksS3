import { z } from "zod";
import { type ConfigSection, flag, flagDefaultOn, int, missingIf, optionalString } from "./shared";

// P3 (memory) configuration. Owned by P3; extend here.
const schema = z.object({
  USE_REAL_MEMORY: flag(),
  SUPERMEMORY_API_KEY: optionalString(),
  /** Override for tests/local fakes; defaults to https://api.supermemory.ai. */
  SUPERMEMORY_BASE_URL: optionalString(),
  /** Per-namespace scoped keys (spec 5.9). Turn off only if the plan cannot mint them. */
  SUPERMEMORY_SCOPED_KEYS: flagDefaultOn(),
  /** Worker: retry deletions Supermemory refused while documents were processing. */
  MEMORY_CLEANUP_INTERVAL_MS: int(10_000),
  /** Worker: enforce memory_settings.retention_days. */
  MEMORY_PURGE_INTERVAL_MS: int(60 * 60 * 1000),
});

export const configSectionP3: ConfigSection<typeof schema> = {
  owner: "P3",
  schema,
  required: (cfg, all) => [
    ...missingIf(cfg.USE_REAL_MEMORY, cfg, ["SUPERMEMORY_API_KEY"]),
    ...missingIf(cfg.USE_REAL_MEMORY, all, ["DATABASE_URL"]),
    // The broker reads tasks and consent rows from Postgres; the in-memory runtime store has neither.
    ...(cfg.USE_REAL_MEMORY && all.RUNTIME_STORE !== "postgres" ? ["RUNTIME_STORE=postgres"] : []),
  ],
  secrets: ["SUPERMEMORY_API_KEY"],
};
