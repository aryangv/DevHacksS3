import { GoogleGenAI } from "@google/genai";
import {
  HarnessError,
  type Logger,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "@campus/contracts";

// Real ModelClient backed by the Gemini Interactions API (spec 4.4; open decision 16.9:
// provider-swappable behind ModelClient). As with the Anthropic client, schema validation and the
// single retry live in `callStructured`, so both providers give the same guarantees.

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/** Gemini 3.8 Flash supports low/medium/high thinking ("minimal" is rejected). */
const THINKING_LEVEL: Record<Effort, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

type InteractionsApi = Pick<GoogleGenAI, "interactions">;

export type GeminiModelClientOptions = {
  apiKey: string;
  model: string;
  effort: Effort;
  /** Constrain output with response_format (validation still happens in the harness). */
  structuredOutput: boolean;
  logger: Logger;
  /** Injected in tests; defaults to a real SDK client. */
  client?: InteractionsApi;
};

const statusOf = (err: unknown): number | undefined =>
  err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
    ? (err as { status: number }).status
    : undefined;

export class GeminiModelClient implements ModelClient {
  readonly id: string;
  private readonly client: InteractionsApi;
  private structuredOutput: boolean;

  constructor(private readonly opts: GeminiModelClientOptions) {
    this.id = `gemini:${opts.model}`;
    this.client = opts.client ?? new GoogleGenAI({ apiKey: opts.apiKey });
    this.structuredOutput = opts.structuredOutput;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.send(request, this.structuredOutput && !!request.outputSchema);
    } catch (err) {
      // A schema the API won't accept should not take the agent down: drop the constraint for this
      // process and rely on harness-side validation (which always runs).
      if (statusOf(err) === 400 && this.structuredOutput && request.outputSchema) {
        this.opts.logger.warn("structured output rejected by provider; continuing with validation only", {
          status: 400,
        });
        this.structuredOutput = false;
        try {
          return await this.send(request, false);
        } catch (retryErr) {
          throw this.mapError(retryErr);
        }
      }
      throw this.mapError(err);
    }
  }

  private async send(request: ModelRequest, useSchema: boolean): Promise<ModelResponse> {
    const interaction = await this.client.interactions.create(
      {
        model: this.opts.model,
        system_instruction: request.system,
        // Stateless: the harness sends the full turn history each call.
        input: request.messages.map((m) =>
          m.role === "user"
            ? { type: "user_input" as const, content: [{ type: "text" as const, text: m.content }] }
            : { type: "model_output" as const, content: [{ type: "text" as const, text: m.content }] },
        ),
        generation_config: {
          max_output_tokens: request.maxOutputTokens,
          thinking_level: THINKING_LEVEL[this.opts.effort],
        },
        ...(useSchema && request.outputSchema
          ? {
              response_format: {
                type: "text" as const,
                mime_type: "application/json" as const,
                schema: request.outputSchema.schema,
              },
            }
          : {}),
        // Don't keep chat content on the provider side (minimum disclosure, spec 2.5).
        store: false,
      },
      { timeout_ms: request.timeoutMs },
    );

    if (interaction.status === "failed" || interaction.status === "cancelled") {
      throw new HarnessError("model_unavailable", `model interaction ${interaction.status}`, {
        retryable: false,
      });
    }

    const text =
      interaction.output_text ??
      (interaction.steps ?? [])
        .flatMap((s) => (s.type === "model_output" ? (s.content ?? []) : []))
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");

    return {
      text,
      stopReason:
        interaction.status === "completed"
          ? "end"
          : interaction.status === "incomplete" || interaction.status === "budget_exceeded"
            ? "max_tokens"
            : "other",
      usage: {
        inputTokens: interaction.usage?.total_input_tokens ?? 0,
        outputTokens: interaction.usage?.total_output_tokens ?? 0,
      },
      model: interaction.model ?? this.opts.model,
    };
  }

  private mapError(err: unknown): unknown {
    if (err instanceof HarnessError) return err;
    const status = statusOf(err);
    if (status === 429)
      return new HarnessError("rate_limited", "model provider rate limited", { retryable: true, cause: err });
    if (status !== undefined && status >= 500) {
      return new HarnessError("model_unavailable", `model provider error ${status}`, {
        retryable: true,
        cause: err,
      });
    }
    if (status !== undefined) {
      return new HarnessError("model_unavailable", `model request failed with status ${status}`, {
        retryable: false,
        cause: err,
      });
    }
    return new HarnessError("model_unavailable", "model provider unreachable or timed out", {
      retryable: true,
      cause: err,
    });
  }
}
