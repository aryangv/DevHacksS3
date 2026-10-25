import { ConfigError, ModuleNotImplementedError } from "@campus/contracts";
import { describe, expect, it } from "vitest";
import { buildContainer } from "../src/container";

describe("DI container + feature flags (spec 18.3 item 7)", () => {
  it("wires every slot with fakes by default", async () => {
    const c = await buildContainer({ env: { LOG_LEVEL: "error" } });
    expect(c.wiring).toEqual({
      runtimeStore: "fake",
      messaging: "fake",
      identity: "fake",
      memory: "fake",
      tools: "fake",
      model: "fake",
    });
    await c.close();
  });

  it("fails fast when a flag is on but the owner's factory export does not exist yet", async () => {
    const env = {
      LOG_LEVEL: "error",
      USE_REAL_MESSAGING: "true",
      SENDBLUE_API_KEY_ID: "x",
      SENDBLUE_API_SECRET: "y",
      SENDBLUE_FROM_NUMBER: "+15550000000",
    };
    await expect(buildContainer({ env })).rejects.toBeInstanceOf(ModuleNotImplementedError);
    await expect(buildContainer({ env })).rejects.toThrow(
      /@campus\/messaging does not export createMessagingAdapter/,
    );
  });

  it("fails fast on missing config for an enabled flag", async () => {
    await expect(buildContainer({ env: { USE_REAL_MODEL: "true" } })).rejects.toBeInstanceOf(ConfigError);
  });

  it("selects the real Claude model client when USE_REAL_MODEL is on", async () => {
    const c = await buildContainer({
      env: { LOG_LEVEL: "error", USE_REAL_MODEL: "true", MODEL_API_KEY: "test-key-not-used" },
    });
    expect(c.wiring.model).toBe("real");
    expect(c.model.id).toBe("anthropic:claude-opus-5-5");
    await c.close();
  });

  it("selects the Gemini model client with MODEL_PROVIDER=gemini", async () => {
    const c = await buildContainer({
      env: {
        LOG_LEVEL: "error",
        USE_REAL_MODEL: "true",
        MODEL_PROVIDER: "gemini",
        MODEL_API_KEY: "test-key-not-used",
      },
    });
    expect(c.model.id).toBe("gemini:gemini-3.8-flash");
    await c.close();
  });
});
