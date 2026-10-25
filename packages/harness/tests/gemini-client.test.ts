import { silentLogger } from "@campus/contracts";
import { describe, expect, it } from "vitest";
import { GeminiModelClient } from "../src/model/gemini-client";

const req = {
  system: "be brief",
  messages: [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: '{"proposals":[]}' },
    { role: "user" as const, content: "again" },
  ],
  maxOutputTokens: 100,
  timeoutMs: 1000,
  metadata: { turnId: "t", purpose: "test" },
};

const interaction = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  status: "completed",
  model: "gemini-3.8-flash",
  output_text: '{"proposals":[]}',
  usage: { total_input_tokens: 12, total_output_tokens: 7 },
  ...over,
});

const fakeClient = (impl: (p: Record<string, unknown>, o: Record<string, unknown>) => unknown) => {
  const calls: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      interactions: {
        create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.push({ params, options });
          return impl(params, options);
        },
      },
    },
  };
};

const make = (
  client: unknown,
  effort: "low" | "medium" | "high" | "xhigh" | "max" = "medium",
  structuredOutput = true,
) =>
  new GeminiModelClient({
    apiKey: "k",
    model: "gemini-3.8-flash",
    effort,
    structuredOutput,
    logger: silentLogger,
    client: client as never,
  });

describe("GeminiModelClient (mocked SDK)", () => {
  it("sends system instruction, full history, thinking level, schema and store:false; maps the response", async () => {
    const f = fakeClient(() => interaction());
    const out = await make(f.client).complete({
      ...req,
      outputSchema: { name: "x", schema: { type: "object" } },
    });
    expect(out).toEqual({
      text: '{"proposals":[]}',
      stopReason: "end",
      usage: { inputTokens: 12, outputTokens: 7 },
      model: "gemini-3.8-flash",
    });
    const { params, options } = f.calls[0]!;
    expect(params).toMatchObject({
      model: "gemini-3.8-flash",
      system_instruction: "be brief",
      generation_config: { max_output_tokens: 100, thinking_level: "medium" },
      response_format: { type: "text", mime_type: "application/json", schema: { type: "object" } },
      store: false,
    });
    expect(params.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "hi" }] },
      { type: "model_output", content: [{ type: "text", text: '{"proposals":[]}' }] },
      { type: "user_input", content: [{ type: "text", text: "again" }] },
    ]);
    expect(params).not.toHaveProperty("temperature");
    expect(options).toEqual({ timeout_ms: 1000 });
  });

  it("maps xhigh/max effort to Gemini's highest thinking level", async () => {
    const f = fakeClient(() => interaction());
    await make(f.client, "max").complete(req);
    expect(f.calls[0]!.params.generation_config).toMatchObject({ thinking_level: "high" });
  });

  it("falls back to model_output steps when output_text is absent, and reports truncation", async () => {
    const f = fakeClient(() =>
      interaction({
        output_text: undefined,
        status: "incomplete",
        steps: [{ type: "thought" }, { type: "model_output", content: [{ type: "text", text: "partial" }] }],
      }),
    );
    const out = await make(f.client).complete(req);
    expect(out).toMatchObject({ text: "partial", stopReason: "max_tokens" });
  });

  it("drops the schema constraint once if the provider rejects it (400)", async () => {
    const f = fakeClient((p) => {
      if (p.response_format) throw Object.assign(new Error("bad schema"), { status: 400 });
      return interaction();
    });
    const m = make(f.client);
    await m.complete({ ...req, outputSchema: { name: "x", schema: {} } });
    await m.complete({ ...req, outputSchema: { name: "x", schema: {} } });
    expect(f.calls.map((c) => "response_format" in c.params)).toEqual([true, false, false]);
  });

  it("maps 429 and 5xx to retryable errors and failed interactions to a non-retryable one", async () => {
    await expect(
      make(fakeClient(() => Promise.reject(Object.assign(new Error("x"), { status: 429 }))).client).complete(
        req,
      ),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    await expect(
      make(fakeClient(() => Promise.reject(Object.assign(new Error("x"), { status: 503 }))).client).complete(
        req,
      ),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      retryable: true,
    });
    await expect(
      make(fakeClient(() => interaction({ status: "failed" })).client).complete(req),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      retryable: false,
    });
  });
});
