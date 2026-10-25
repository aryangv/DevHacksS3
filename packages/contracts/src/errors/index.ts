import { ERROR_CODES_P1 } from "./error-codes.p1";
import { ERROR_CODES_P2 } from "./error-codes.p2";
import { ERROR_CODES_P3 } from "./error-codes.p3";
import { ERROR_CODES_P4 } from "./error-codes.p4";

export const ERROR_CODES = [
  ...ERROR_CODES_P1,
  ...ERROR_CODES_P2,
  ...ERROR_CODES_P3,
  ...ERROR_CODES_P4,
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Base error for all packages. `code` is stable; `message` must not contain secrets or private values. */
export class HarnessError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "HarnessError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export class ConfigError extends HarnessError {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super("config_invalid", message, { details: { missing } });
    this.name = "ConfigError";
  }
}

export class ModelOutputInvalidError extends HarnessError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("model_output_invalid", message, { details });
    this.name = "ModelOutputInvalidError";
  }
}

export class BudgetExhaustedError extends HarnessError {
  constructor(readonly budget: string) {
    super("budget_exhausted", `turn budget exhausted: ${budget}`, { details: { budget } });
    this.name = "BudgetExhaustedError";
  }
}

export class ModuleNotImplementedError extends HarnessError {
  constructor(moduleName: string, exportName: string) {
    super(
      "module_not_implemented",
      `${moduleName} does not export ${exportName}() yet. Keep its USE_REAL_* flag off until its integration point.`,
    );
    this.name = "ModuleNotImplementedError";
  }
}

export { ERROR_CODES_P1, ERROR_CODES_P2, ERROR_CODES_P3, ERROR_CODES_P4 };
