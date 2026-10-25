import { z } from "zod";
import { type ConfigSection, flag, missingIf, optionalString } from "./shared";

// P3 (memory) configuration. Owned by P3; extend here.
const schema = z.object({
  USE_REAL_MEMORY: flag(),
  SUPERMEMORY_API_KEY: optionalString(),
});

export const configSectionP3: ConfigSection<typeof schema> = {
  owner: "P3",
  schema,
  required: (cfg, all) => [
    ...missingIf(cfg.USE_REAL_MEMORY, cfg, ["SUPERMEMORY_API_KEY"]),
    ...missingIf(cfg.USE_REAL_MEMORY, all, ["DATABASE_URL"]),
  ],
  secrets: ["SUPERMEMORY_API_KEY"],
};
