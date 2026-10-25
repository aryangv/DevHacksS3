import Anthropic from "@anthropic-ai/sdk";
import {
  HarnessError,
  type Logger,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "@campus/contracts";

// Real ModelClient backed by the Claude API (spec 4.4; open decision 16.9: one provider for the MVP,
// behind the provider-neutral ModelClient interface). Schema validation + the single retry live in
// `callStructured`, not here, so any provider gets the same guarantees.

export type AnthropicModelClientOptions = {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Constrain output with output_config.format (validation still happens in the harness). */
  structuredOutput: boolean;
  logger: Logger;
  /** Injected in tests; defaults to a real SDK client. */
  client?: Pick<Anthropic, "beta">;
};

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export class AnthropicModelClient implements ModelClient {
  readonly id: string;
  private readonly client: Pick<Anthropic, "beta">;
  private structuredOutput: boolean;

  constructor(private readonly opts: AnthropicModelClientOptions) {
    this.id = `anthropic:${opts.model}`;
    // maxRetries covers 408/409/429/5xx + connection errors with backoff (SDK default behaviour).
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 });
    this.structuredOutput = opts.structuredOutput;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.send(request, this.structuredOutput && !!request.outputSchema);
    } catch (err) {
      // A schema the API won't accept should not take the agent down: drop the constraint for this
      // process and rely on harness-side validation (which always runs).
      if (err instanceof Anthropic.BadRequestError && this.structuredOutput && request.outputSchema) {
        this.opts.logger.warn("structured output rejected by provider; continuing with validation only", {
          status: err.status,
        });
        this.structuredOutput = false;
        return this.send(request, false);
      }
      throw this.mapError(err);
    }
  }

  private async send(request: ModelRequest, useSchema: boolean): Promise<ModelResponse> {
    const response = await this.client.beta.messages.create(
      {
        model: this.opts.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        thinking: { type: "adaptive" },
        output_config: {
          effort: this.opts.effort,
          ...(useSchema && request.outputSchema
            ? { format: { type: "json_schema" as const, schema: request.outputSchema.schema } }
            : {}),
        },
        // Server-side refusal fallback (opt-in; "default" routes by refusal category).
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      },
      { timeout: request.timeoutMs },
    );

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");

    const stop = response.stop_reason;
    return {
      text,
      stopReason:
        stop === "end_turn"
          ? "end"
          : stop === "max_tokens"
            ? "max_tokens"
            : stop === "refusal"
              ? "refusal"
              : "other",
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: response.model,
    };
  }

  private mapError(err: unknown): unknown {
    if (err instanceof Anthropic.RateLimitError) {
      return new HarnessError("rate_limited", "model provider rate limited", { retryable: true, cause: err });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return new HarnessError("model_unavailable", "model provider unreachable or timed out", {
        retryable: true,
        cause: err,
      });
    }
    if (err instanceof Anthropic.InternalServerError) {
      return new HarnessError("model_unavailable", `model provider error ${err.status}`, {
        retryable: true,
        cause: err,
      });
    }
    if (err instanceof Anthropic.APIError) {
      return new HarnessError("model_unavailable", `model request failed with status ${err.status}`, {
        retryable: false,
        cause: err,
      });
    }
    return err;
  }
}
