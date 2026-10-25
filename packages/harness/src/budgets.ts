import {
  type AppConfig,
  BudgetExhaustedError,
  type Budgets,
  type Clock,
  HarnessError,
} from "@campus/contracts";

// Per-turn budgets (spec 4.4): max model steps, max tool calls, wall-clock deadline, token cap.

export function budgetsFromConfig(c: AppConfig): Budgets {
  return {
    maxModelSteps: c.TURN_MAX_MODEL_STEPS,
    maxToolCalls: c.TURN_MAX_TOOL_CALLS,
    turnTimeoutMs: c.TURN_TIMEOUT_MS,
    modelCallTimeoutMs: c.MODEL_CALL_TIMEOUT_MS,
    toolCallTimeoutMs: c.TOOL_CALL_TIMEOUT_MS,
    maxTokensPerTurn: c.TURN_MAX_TOKENS,
    maxOutputTokensPerCall: c.MODEL_MAX_OUTPUT_TOKENS,
  };
}

export const DEFAULT_BUDGETS: Budgets = {
  maxModelSteps: 4,
  maxToolCalls: 6,
  turnTimeoutMs: 90_000,
  modelCallTimeoutMs: 45_000,
  toolCallTimeoutMs: 15_000,
  maxTokensPerTurn: 150_000,
  maxOutputTokensPerCall: 4_096,
};

export class TurnBudget {
  modelSteps = 0;
  toolCalls = 0;
  tokens = 0;

  constructor(
    readonly limits: Budgets,
    readonly deadlineMs: number,
    private readonly clock: Clock,
  ) {}

  remainingMs(): number {
    return this.deadlineMs - this.clock.now().getTime();
  }

  /** Throws BudgetExhaustedError if another model step is not allowed. */
  beginModelStep(): void {
    if (this.remainingMs() <= 0) throw new BudgetExhaustedError("time");
    if (this.modelSteps >= this.limits.maxModelSteps) throw new BudgetExhaustedError("model_steps");
    if (this.tokens >= this.limits.maxTokensPerTurn) throw new BudgetExhaustedError("tokens");
    this.modelSteps += 1;
  }

  beginToolCall(): void {
    if (this.remainingMs() <= 0) throw new BudgetExhaustedError("time");
    if (this.toolCalls >= this.limits.maxToolCalls) throw new BudgetExhaustedError("tool_calls");
    this.toolCalls += 1;
  }

  addTokens(n: number): void {
    this.tokens += n;
  }

  /** Per-call timeout bounded by what is left of the turn. */
  callTimeout(perCallMs: number): number {
    return Math.max(1, Math.min(perCallMs, this.remainingMs()));
  }

  snapshot() {
    return {
      modelSteps: this.modelSteps,
      toolCalls: this.toolCalls,
      tokens: this.tokens,
      remainingMs: this.remainingMs(),
    };
  }
}

/** Reject after `ms`. The underlying work is not cancelled; side effects rely on idempotency keys. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HarnessError("turn_timeout", `${what} timed out after ${ms}ms`, { retryable: false })),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
