import { z } from "zod";
import { type ConfigSection, flag, int, missingIf, optionalString } from "./shared";

// P2 (front door) configuration. Owned by P2; extend here.
const schema = z.object({
  USE_REAL_MESSAGING: flag(),
  USE_REAL_IDENTITY: flag(),
  SENDBLUE_API_KEY_ID: optionalString(),
  SENDBLUE_API_SECRET: optionalString(),
  SENDBLUE_FROM_NUMBER: optionalString(),
  SENDBLUE_VERIFY_SERVICE_SID: optionalString(),
  SENDBLUE_VERIFY_WEBHOOK_SECRET: optionalString(),
  APP_ORIGIN: optionalString(),
  NUDGE_INTERVAL_HOURS: int(6),
});

export const configSectionP2: ConfigSection<typeof schema> = {
  owner: "P2",
  schema,
  required: (cfg, all) => [
    ...missingIf(cfg.USE_REAL_MESSAGING, cfg, [
      "SENDBLUE_API_KEY_ID",
      "SENDBLUE_API_SECRET",
      "SENDBLUE_FROM_NUMBER",
    ]),
    ...missingIf(cfg.USE_REAL_IDENTITY, cfg, [
      "SENDBLUE_VERIFY_SERVICE_SID",
      "SENDBLUE_VERIFY_WEBHOOK_SECRET",
      "APP_ORIGIN",
    ]),
    ...missingIf(cfg.USE_REAL_IDENTITY, all, ["DATABASE_URL"]),
  ],
  secrets: ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET", "SENDBLUE_VERIFY_WEBHOOK_SECRET"],
};
