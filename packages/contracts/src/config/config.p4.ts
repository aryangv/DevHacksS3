import { z } from "zod";
import { type ConfigSection, flag, int, missingIf, optionalString } from "./shared";

// P4 (hands) configuration. Owned by P4; extend here.
const schema = z.object({
  USE_REAL_TOOLS: flag(),
  /** Restricted role: the only one allowed to read vault.* (spec 6.4). */
  DATABASE_URL_VAULT: optionalString(),
  VAULT_KEY_ID: optionalString(),
  /** Dev only. Use a KMS/secret store outside the hackathon. */
  VAULT_MASTER_KEY: optionalString(),
  COMPOSIO_API_KEY: optionalString(),
  OAUTH_REDIRECT_BASE: optionalString(),
  /** Spending ceiling for any live test purchase, minor units (spec 11). */
  SPENDING_CEILING_MINOR: int(3000),
});

export const configSectionP4: ConfigSection<typeof schema> = {
  owner: "P4",
  schema,
  required: (cfg, all) => [
    ...missingIf(cfg.USE_REAL_TOOLS, cfg, [
      "DATABASE_URL_VAULT",
      "VAULT_KEY_ID",
      "VAULT_MASTER_KEY",
      "OAUTH_REDIRECT_BASE",
    ]),
    ...missingIf(cfg.USE_REAL_TOOLS, all, ["DATABASE_URL", "APP_ORIGIN"]),
  ],
  secrets: ["DATABASE_URL_VAULT", "VAULT_MASTER_KEY", "COMPOSIO_API_KEY"],
};
