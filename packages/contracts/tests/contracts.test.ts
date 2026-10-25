import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  InboundMessageSchema,
  KeyedMutex,
  ModelStepOutputSchema,
  REDACTED,
  clearRegisteredSecretsForTests,
  containsRegisteredSecret,
  createMemoryLogger,
  loadConfig,
  parseContextFields,
  redact,
  redactString,
  registerSecretValues,
  splitToolName,
} from "../src";
import { FakeMessagingAdapter, InMemoryInboundQueue, InMemoryTaskStore, validateArgs } from "../src/fakes";
import { diningManifests, sendblueReceiveDm, sendblueReceiveGroup } from "../src/fixtures";

afterEach(() => clearRegisteredSecretsForTests());

describe("schemas and fixtures", () => {
  it("normalizes Sendblue DM and group fixtures into valid InboundMessages", () => {
    const fake = new FakeMessagingAdapter();
    const dm = InboundMessageSchema.parse(fake.normalize(sendblueReceiveDm));
    expect(dm.isGroup).toBe(false);
    expect(dm.providerConversationId).toBe(sendblueReceiveDm.from_number);
    const group = InboundMessageSchema.parse(fake.normalize(sendblueReceiveGroup));
    expect(group.isGroup).toBe(true);
    expect(group.providerConversationId).toBe(sendblueReceiveGroup.group_id); // group_id stays authoritative
    expect(group.participantExternalIds).not.toContain(sendblueReceiveGroup.sendblue_number);
  });

  it("ignores outbound echoes", () => {
    expect(new FakeMessagingAdapter().normalize({ ...sendblueReceiveDm, is_outbound: true })).toBeNull();
  });

  it("rejects model output that tries to choose identity, namespace or conversation", () => {
    const ok = { proposals: [{ kind: "reply", text: "hi" }] };
    expect(ModelStepOutputSchema.safeParse(ok).success).toBe(true);
    for (const extra of [{ userId: "u1" }, { namespace: "user_x" }, { conversationId: "c1" }]) {
      expect(ModelStepOutputSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
      expect(
        ModelStepOutputSchema.safeParse({ proposals: [{ kind: "reply", text: "hi", ...extra }] }).success,
      ).toBe(false);
    }
    expect(
      ModelStepOutputSchema.safeParse({
        proposals: [{ kind: "tool_call", tool: "a__b", argsJson: "{}", rationale: null, recipient: "+1555" }],
      }).success,
    ).toBe(false);
  });

  it("keeps only registry fields with valid values from broker answers", () => {
    const { values, rejected } = parseContextFields({
      "meal.max_price_per_person_minor": 1500,
      "meal.required_tags": "not-an-array",
      "raw.memory": "I am allergic to…",
    });
    expect(values).toEqual({ "meal.max_price_per_person_minor": 1500 });
    expect(rejected.sort()).toEqual(["meal.required_tags", "raw.memory"]);
  });

  it("splits namespaced tool names", () => {
    expect(splitToolName("canvas__list_assignments")).toEqual({ server: "canvas", tool: "list_assignments" });
    expect(splitToolName("nope")).toBeNull();
  });

  it("validates tool args against manifest schemas (fake gateway subset)", () => {
    const schema = diningManifests[1]!.inputSchema;
    expect(validateArgs(schema, { optionId: "x" })).toEqual([]);
    expect(validateArgs(schema, {})).toContain("args.optionId is required");
    expect(validateArgs(schema, { optionId: "x", userId: "evil" })).toContain("args.userId is not allowed");
  });
});

describe("config loader", () => {
  it("defaults to all fakes with no env", () => {
    const c = loadConfig({});
    expect([
      c.USE_REAL_MESSAGING,
      c.USE_REAL_IDENTITY,
      c.USE_REAL_MEMORY,
      c.USE_REAL_TOOLS,
      c.USE_REAL_MODEL,
    ]).toEqual([false, false, false, false, false]);
    expect(c.RUNTIME_STORE).toBe("memory");
  });

  it("fails fast listing every missing variable for enabled flags, without values", () => {
    try {
      loadConfig({ USE_REAL_MODEL: "true", USE_REAL_TOOLS: "1", RUNTIME_STORE: "postgres" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const missing = (err as ConfigError).missing;
      expect(missing).toEqual(
        expect.arrayContaining([
          "MODEL_API_KEY",
          "DATABASE_URL",
          "DATABASE_URL_VAULT",
          "VAULT_MASTER_KEY",
          "APP_ORIGIN",
        ]),
      );
    }
  });

  it("rejects invalid enum values", () => {
    expect(() => loadConfig({ RUNTIME_STORE: "redis" })).toThrow(ConfigError);
  });

  it("registers configured secrets for redaction", () => {
    loadConfig({ SUPERMEMORY_API_KEY: "sm_live_supersecret_123" });
    expect(containsRegisteredSecret("key=sm_live_supersecret_123")).toBe(true);
    expect(redactString("key=sm_live_supersecret_123")).toBe(`key=${REDACTED}`);
  });
});

describe("redaction and logging", () => {
  it("redacts secret-looking keys and token shapes but keeps numeric counters", () => {
    registerSecretValues(["hunter2-very-secret"]);
    const out = redact({
      apiKey: "abc",
      nested: { authorization: "Bearer abcdefghijklmnop", note: "pw is hunter2-very-secret" },
      inputTokens: 120,
      text: "token sk-ant-abcdefghijklmnopqrstuv here",
    });
    expect(out).toEqual({
      apiKey: REDACTED,
      nested: { authorization: REDACTED, note: `pw is ${REDACTED}` },
      inputTokens: 120,
      text: `token ${REDACTED} here`,
    });
  });

  it("never writes secrets to log lines", () => {
    registerSecretValues(["s3cr3t-value-xyz"]);
    const { logger, lines } = createMemoryLogger();
    logger.child({ turnId: "t1" }).info("calling provider with s3cr3t-value-xyz", {
      headers: { Authorization: "Bearer zzzzzzzzzzzz" },
      password: "p",
    });
    expect(lines.join("\n")).not.toContain("s3cr3t-value-xyz");
    expect(lines.join("\n")).not.toContain("zzzzzzzzzzzz");
    expect(JSON.parse(lines[0]!).turnId).toBe("t1");
  });
});

describe("runtime utilities", () => {
  it("KeyedMutex serializes per key and runs different keys concurrently", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const task = (k: string, id: string, ms: number) =>
      m.run(k, async () => {
        log.push(`start ${id}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${id}`);
      });
    await Promise.all([task("a", "a1", 20), task("a", "a2", 1), task("b", "b1", 5)]);
    expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
    expect(log.indexOf("start b1")).toBeLessThan(log.indexOf("end a1"));
  });

  it("InMemoryInboundQueue dedupes and keeps one event in flight per conversation, FIFO", async () => {
    const q = new InMemoryInboundQueue();
    const msg = (id: string, conv: string) => ({
      platform: "imessage" as const,
      providerMessageId: id,
      providerConversationId: conv,
      senderExternalId: "+1",
      participantExternalIds: ["+1"],
      isGroup: false,
      text: id,
      timestamp: new Date().toISOString(),
    });
    expect((await q.enqueue(msg("m1", "A"))).inserted).toBe(true);
    expect((await q.enqueue(msg("m1", "A"))).inserted).toBe(false);
    await q.enqueue(msg("m2", "A"));
    await q.enqueue(msg("m3", "B"));
    const first = await q.claimNext();
    const second = await q.claimNext();
    expect(first?.message.providerMessageId).toBe("m1");
    expect(second?.message.providerMessageId).toBe("m3"); // m2 waits for m1
    expect(await q.claimNext()).toBeNull();
    await q.complete(first!.id);
    expect((await q.claimNext())?.message.providerMessageId).toBe("m2");
  });

  it("InMemoryTaskStore enforces optimistic concurrency", async () => {
    const s = new InMemoryTaskStore();
    const t = await s.create({
      ownerType: "group",
      ownerId: "g",
      conversationId: "c",
      type: "x",
      status: "a",
      state: {},
    });
    await s.update(t.id, { status: "b" }, 0);
    await expect(s.update(t.id, { status: "c" }, 0)).rejects.toMatchObject({ code: "task_conflict" });
  });
});
