import { z } from "zod";
import { type ConfigSection, flag, flagDefaultOn, int, missingIf, optionalString } from "./shared";

// P1 (spine) configuration. Owners edit only their own section file.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** memory = in-process stores (simulator, tests); postgres = core.* tables via DATABASE_URL. */
  RUNTIME_STORE: z.enum(["memory", "postgres"]).default("memory"),
  /** postgres://… for node-postgres, or pglite://memory | pglite://./.data/pglite for local dev without Docker. */
  DATABASE_URL: optionalString(),
  /** Owner role used only by the migration runner. Defaults to DATABASE_URL. */
  DATABASE_URL_ADMIN: optionalString(),
  REDIS_URL: optionalString(),

  USE_REAL_MODEL: flag(),
  /** Which provider backs the real ModelClient (spec 16.9: provider-swappable). */
  MODEL_PROVIDER: z.enum(["anthropic", "gemini"]).default("anthropic"),
  /** API key for MODEL_PROVIDER (Anthropic key or Gemini API key). */
  MODEL_API_KEY: optionalString(),
  /** Defaults per provider: claude-opus-5-5 | gemini-3.8-flash. */
  MODEL_NAME: optionalString(),
  /** Reasoning effort. Gemini maps xhigh/max to its highest thinking level ("high"). */
  MODEL_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** Ask the provider to constrain output to the proposal JSON schema (validation happens regardless). */
  MODEL_STRUCTURED_OUTPUT: flagDefaultOn(),

  AGENT_DISPLAY_NAME: z.string().default("Campus Agent"),
  /** Comma-separated names that address the agent in a group (case-insensitive). */
  AGENT_INVOCATION_NAMES: z.string().default("@agent,agent,campus agent"),

  TURN_MAX_MODEL_STEPS: int(4),
  TURN_MAX_TOOL_CALLS: int(6),
  TURN_TIMEOUT_MS: int(90_000),
  MODEL_CALL_TIMEOUT_MS: int(45_000),
  TOOL_CALL_TIMEOUT_MS: int(15_000),
  TURN_MAX_TOKENS: int(150_000),
  MODEL_MAX_OUTPUT_TOKENS: int(4_096),
  RATE_LIMIT_USER_MODEL_CALLS_PER_10MIN: int(40),
  RATE_LIMIT_CONVERSATION_MODEL_CALLS_PER_10MIN: int(80),

  QUEUE_MAX_ATTEMPTS: int(5),
  WORKER_POLL_INTERVAL_MS: int(250),
  WORKER_CONCURRENCY: int(4),
  /** Run the queue worker inside the API process (required with RUNTIME_STORE=memory). */
  RUN_WORKER_IN_PROCESS: flag(),
  API_PORT: int(3000),
  TRACE_API_ENABLED: flagDefaultOn(),
  /** Bearer token for the trace API. Required in production when the trace API is enabled. */
  TRACE_API_TOKEN: optionalString(),

  /** Namespaced tool the group agent uses to source meal options (dinner slice). */
  GROUP_MEAL_OPTIONS_TOOL: z.string().default("dining__search_options"),
});

export const configSectionP1: ConfigSection<typeof schema> = {
  owner: "P1",
  schema,
  required: (cfg) => [
    ...missingIf(cfg.USE_REAL_MODEL, cfg, ["MODEL_API_KEY"]),
    ...missingIf(cfg.RUNTIME_STORE === "postgres", cfg, ["DATABASE_URL"]),
    ...missingIf(cfg.NODE_ENV === "production" && cfg.TRACE_API_ENABLED, cfg, ["TRACE_API_TOKEN"]),
  ],
  secrets: ["MODEL_API_KEY", "DATABASE_URL", "DATABASE_URL_ADMIN", "REDIS_URL", "TRACE_API_TOKEN"],
};
