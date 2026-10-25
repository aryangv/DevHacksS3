import {
  HarnessError,
  type ModelClient,
  type ModelMessage,
  ModelOutputInvalidError,
  type ModelRequest,
  type ModelResponse,
} from "@campus/contracts";
import { z } from "zod";

// Structured output with schema validation and exactly one retry (spec 4.4): never execute
// unvalidated output. On the second failure the caller fails safe.

/** JSON Schema for a provider's structured-output feature. */
export function toModelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return rewriteOneOf(json) as Record<string, unknown>;
}

function rewriteOneOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteOneOf);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k === "oneOf" ? "anyOf" : k] = rewriteOneOf(v);
  return out;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error("no JSON object in model output");
  }
}

export type StructuredResult<T> = { value: T; responses: ModelResponse[]; retried: boolean };

export async function callStructured<T>(
  client: ModelClient,
  request: Omit<ModelRequest, "outputSchema">,
  schema: z.ZodType<T>,
  opts: {
    schemaName: string;
    onInvalid?: (attempt: number, error: string) => void;
    extraValidate?: (value: T) => string | null;
  },
): Promise<StructuredResult<T>> {
  const outputSchema = { name: opts.schemaName, schema: toModelJsonSchema(schema) };
  const responses: ModelResponse[] = [];
  let messages: ModelMessage[] = request.messages;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client.complete({ ...request, messages, outputSchema });
    responses.push(response);
    if (response.stopReason === "refusal") {
      throw new HarnessError("model_refused", "model declined the request", { details: { attempt } });
    }

    let problem: string;
    try {
      const parsed = schema.safeParse(extractJson(response.text));
      if (parsed.success) {
        const extra = opts.extraValidate?.(parsed.data) ?? null;
        if (!extra) return { value: parsed.data, responses, retried: attempt > 1 };
        problem = extra;
      } else {
        problem = z.prettifyError(parsed.error);
      }
    } catch (err) {
      problem = err instanceof Error ? err.message : "unparseable output";
    }

    opts.onInvalid?.(attempt, problem);
    if (attempt === 2) break;
    messages = [
      ...request.messages,
      { role: "assistant", content: response.text.slice(0, 4000) || "(empty)" },
      {
        role: "user",
        content: `Your previous output was invalid: ${problem.slice(0, 1000)}\nReturn only a JSON object that matches the required schema exactly. Do not add fields.`,
      },
    ];
  }
  throw new ModelOutputInvalidError("model output failed schema validation twice", { attempts: 2 });
}
