// Error codes owned by P1. Additive only.
export const ERROR_CODES_P1 = [
  "config_invalid",
  "model_output_invalid",
  "model_refused",
  "model_unavailable",
  "budget_exhausted",
  "rate_limited",
  "turn_timeout",
  "task_conflict",
  "task_not_found",
  "module_not_implemented",
  "queue_dead_lettered",
] as const;
