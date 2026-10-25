import type { z } from "zod";
import { ConfigError } from "../errors";
import { registerSecretValues } from "../util/redact";
import { configSectionP1 } from "./config.p1";
import { configSectionP2 } from "./config.p2";
import { configSectionP3 } from "./config.p3";
import { configSectionP4 } from "./config.p4";

const sections = [configSectionP1, configSectionP2, configSectionP3, configSectionP4] as const;

export type AppConfig = z.infer<typeof configSectionP1.schema> &
  z.infer<typeof configSectionP2.schema> &
  z.infer<typeof configSectionP3.schema> &
  z.infer<typeof configSectionP4.schema>;

/** Fake vs real selection (spec 18.3 item 7). Real implementations default off until their integration point. */
export const FEATURE_FLAGS = [
  "USE_REAL_MESSAGING",
  "USE_REAL_IDENTITY",
  "USE_REAL_MEMORY",
  "USE_REAL_TOOLS",
  "USE_REAL_MODEL",
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

type AnySection = {
  owner: string;
  schema: z.ZodObject;
  required: (cfg: never, all: Record<string, unknown>) => string[];
  secrets: string[];
};

/**
 * Typed config loader (spec 18.3 item 3). Fails fast listing every missing/invalid variable name at once
 * (never their values) and registers secret values for log/prompt redaction.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const merged: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const section of sections as readonly AnySection[]) {
    const parsed = section.schema.safeParse(env);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${issue.path.join(".")} (${section.owner}): ${issue.message}`);
      }
      continue;
    }
    Object.assign(merged, parsed.data);
  }
  if (problems.length) throw new ConfigError(`Invalid configuration:\n  ${problems.join("\n  ")}`);

  const missing = new Set<string>();
  for (const section of sections as readonly AnySection[]) {
    for (const name of section.required(merged as never, merged)) missing.add(name);
  }
  if (missing.size) {
    const names = [...missing].sort();
    throw new ConfigError(`Missing required environment variables: ${names.join(", ")}`, names);
  }

  registerSecretValues(sections.flatMap((s) => s.secrets.map((name) => env[name])));
  return merged as AppConfig;
}

export function invocationNames(config: Pick<AppConfig, "AGENT_INVOCATION_NAMES">): string[] {
  return config.AGENT_INVOCATION_NAMES.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export { configSectionP1, configSectionP2, configSectionP3, configSectionP4 };
