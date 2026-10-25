// P1 runtime acceptance (harness-spec 14 "Harness / model-as-executor"), plus a Postgres-backed run.
import type { ModelClient, ModelRequest, ModelResponse } from "@campus/contracts";
import { FakeModelClient } from "@campus/contracts/fakes";
import { createPgliteClient, migrate } from "@campus/db";
import { Simulator } from "@campus/worker";
import { describe, expect, it } from "vitest";
import { ALL_MEMBERS, AVERY, BLAKE, CASEY, GROUP, TEST_ENV, actions, makeSim } from "./helpers";

describe("model-as-executor", () => {
  it("invalid structured output is retried once, then fails safe with no side effects", async () => {
    const model = FakeModelClient.scripted([
      {
        proposals: [
          { kind: "tool_call", tool: "dining__place_order", argsJson: '{"optionId":"x"}', rationale: null },
        ],
        userId: "attacker",
      },
    ]);
    const sim = await makeSim({ model });
    const t = await sim.dm(AVERY.externalId, "order me food");
    expect(model.requests).toHaveLength(2);
    expect(t.outcomes[0]!.status).toBe("failed_safe");
    expect(sim.c.fakes.toolProvider!.calls).toHaveLength(0);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toMatch(/didn't do anything/);
    expect(actions(t.trace).filter((a) => a === "model.invalid_output")).toHaveLength(2);
    await sim.c.close();
  });

  it("the gateway gets the harness's user id, never one from the model", async () => {
    const model = FakeModelClient.scripted([
      {
        proposals: [
          {
            kind: "tool_call",
            tool: "canvas__list_assignments",
            argsJson: JSON.stringify({ userId: BLAKE.userId }),
            rationale: null,
          },
        ],
      },
      { proposals: [{ kind: "reply", text: "ok" }] },
    ]);
    const sim = await makeSim({ model });
    await sim.dm(AVERY.externalId, "show Blake's assignments");
    expect(sim.c.fakes.toolProvider!.calls).toHaveLength(0); // unknown arg rejected by schema validation
    expect(model.requests[1]!.messages.at(-1)!.content).toContain("tool_args_invalid");
    await sim.c.close();
  });

  it("budgets stop runaway tool loops and report briefly", async () => {
    const model = new FakeModelClient(() => ({
      proposals: [{ kind: "tool_call", tool: "canvas__list_assignments", argsJson: "{}", rationale: null }],
    }));
    const sim = await makeSim({ model, env: { TURN_MAX_MODEL_STEPS: "3", TURN_MAX_TOOL_CALLS: "10" } });
    const t = await sim.dm(AVERY.externalId, "loop forever");
    expect(model.requests).toHaveLength(3);
    expect(t.outcomes[0]!.status).toBe("budget_exhausted");
    expect(actions(t.trace)).toContain("turn.budget_exhausted");
    expect(t.sent[0]!.text).toMatch(/more steps than I'm allowed/);
    await sim.c.close();
  });

  it("tool-call budget is enforced separately", async () => {
    const model = new FakeModelClient(() => ({
      proposals: Array.from({ length: 4 }, () => ({
        kind: "tool_call",
        tool: "canvas__list_assignments",
        argsJson: "{}",
        rationale: null,
      })),
    }));
    const sim = await makeSim({ model, env: { TURN_MAX_TOOL_CALLS: "2" } });
    await sim.dm(AVERY.externalId, "check four times");
    expect(sim.c.fakes.toolProvider!.calls).toHaveLength(2);
    await sim.c.close();
  });
});

describe("approvals (ask mode)", () => {
  it("a write tool asks via a 1:1 text code; YES executes exactly once", async () => {
    const model = FakeModelClient.scripted([
      {
        proposals: [
          {
            kind: "tool_call",
            tool: "canvas__submit_comment",
            argsJson: '{"assignmentId":"a1","text":"done!"}',
            rationale: null,
          },
        ],
      },
      { proposals: [{ kind: "reply", text: "I asked you to approve that." }] },
    ]);
    const sim = await makeSim({ model });
    const t = await sim.dm(AVERY.externalId, "comment 'done!' on my assignment");
    expect(sim.c.fakes.toolProvider!.calls).toHaveLength(0);
    const prompt = t.sent.find((m) => /Reply YES \d{4}/.test(m.text))!;
    expect(prompt.to).toBe(AVERY.externalId);
    const code = /YES (\d{4})/.exec(prompt.text)![1];
    const yes = await sim.dm(AVERY.externalId, `yes ${code}`);
    expect(yes.outcomes[0]!.status).toBe("approval_resolved");
    expect(sim.c.fakes.toolProvider!.calls).toHaveLength(1);
    expect(sim.c.fakes.toolProvider!.calls[0]!.idempotencyKey).toBeDefined();
    await sim.dm(AVERY.externalId, `yes ${code}`);
    expect(sim.c.fakes.toolProvider!.calls).toHaveLength(1);
    await sim.c.close();
  });

  it("approval prompts for a group-triggered call go to the requester's 1:1 chat, and a group YES does nothing", async () => {
    const model = FakeModelClient.scripted([
      {
        proposals: [
          {
            kind: "tool_call",
            tool: "canvas__submit_comment",
            argsJson: '{"assignmentId":"a1","text":"hi"}',
            rationale: null,
          },
        ],
      },
      { proposals: [{ kind: "reply", text: "Check your DMs." }] },
    ]);
    const sim = await makeSim({ model });
    const t = await sim.group(GROUP, AVERY.externalId, ALL_MEMBERS, "@agent post a comment for me");
    const prompt = t.sent.find((m) => /YES \d{4}/.test(m.text))!;
    expect(prompt).toMatchObject({ kind: "dm", to: AVERY.externalId });
    const code = /YES (\d{4})/.exec(prompt.text)![1];
    await sim.group(GROUP, AVERY.externalId, ALL_MEMBERS, `@agent YES ${code}`);
    expect(sim.c.fakes.toolProvider!.calls).toHaveLength(0);
    await sim.c.close();
  });
});

describe("per-conversation serialization", () => {
  it("never runs two turns of one conversation at once, but runs conversations in parallel", async () => {
    const inFlight = new Map<string, number>();
    let maxPerConversation = 0;
    let maxOverall = 0;
    let overall = 0;
    const model: ModelClient = {
      id: "slow",
      async complete(req: ModelRequest): Promise<ModelResponse> {
        const key = /conv-(\w)/.exec(req.messages[0]!.content)?.[1] ?? "?";
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        overall += 1;
        maxPerConversation = Math.max(maxPerConversation, inFlight.get(key)!);
        maxOverall = Math.max(maxOverall, overall);
        await new Promise((r) => setTimeout(r, 25));
        inFlight.set(key, inFlight.get(key)! - 1);
        overall -= 1;
        return {
          text: JSON.stringify({ proposals: [{ kind: "reply", text: "ok" }] }),
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "slow",
        };
      },
    };
    const sim = await makeSim({ model, env: { WORKER_CONCURRENCY: "4", WORKER_POLL_INTERVAL_MS: "5" } });
    for (let i = 0; i < 3; i++) {
      await sim.c.pipeline.ingest({
        platform: "imessage",
        providerMessageId: `a${i}`,
        providerConversationId: AVERY.externalId,
        senderExternalId: AVERY.externalId,
        participantExternalIds: [AVERY.externalId],
        isGroup: false,
        text: `conv-A ${i}`,
        timestamp: new Date().toISOString(),
      });
      await sim.c.pipeline.ingest({
        platform: "imessage",
        providerMessageId: `b${i}`,
        providerConversationId: BLAKE.externalId,
        senderExternalId: BLAKE.externalId,
        participantExternalIds: [BLAKE.externalId],
        isGroup: false,
        text: `conv-B ${i}`,
        timestamp: new Date().toISOString(),
      });
    }
    sim.c.worker.start();
    const deadline = Date.now() + 5_000;
    while (((await sim.c.queue.counts()).done ?? 0) < 6 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    await sim.c.close();
    expect((await sim.c.queue.counts()).done).toBe(6);
    expect(maxPerConversation).toBe(1);
    expect(maxOverall).toBe(2);
  });
});

describe("Postgres runtime store (PGlite)", () => {
  it("runs the dinner slice with tasks, coordination events, messages and audit persisted", async () => {
    const sql = await createPgliteClient();
    await migrate(sql);
    const sim = await Simulator.create({
      env: { ...TEST_ENV, RUNTIME_STORE: "postgres", DATABASE_URL: "pglite://memory" },
      overrides: { sql },
    });
    expect(sim.c.wiring.runtimeStore).toBe("real");

    const ask = await sim.group(
      GROUP,
      AVERY.externalId,
      ALL_MEMBERS,
      "@agent dinner tonight? under $20 each",
      { messageId: "pg-1" },
    );
    expect(ask.sent.at(-1)!.text).toContain("Thai Basil");
    const dup = await sim.group(
      GROUP,
      AVERY.externalId,
      ALL_MEMBERS,
      "@agent dinner tonight? under $20 each",
      { messageId: "pg-1" },
    );
    expect(dup.ingest.status).toBe("duplicate");
    await sim.group(GROUP, CASEY.externalId, ALL_MEMBERS, "@agent confirm");

    const tasks = await sql.query<{ status: string; version: number }>(
      "SELECT status, version FROM core.agent_tasks",
    );
    expect(tasks.rows).toEqual([expect.objectContaining({ status: "handed_off" })]);
    const events = await sql.query<{ type: string; payload: Record<string, unknown> }>(
      "SELECT type, payload FROM core.coordination_events",
    );
    expect(
      events.rows
        .filter((r) => r.type.startsWith("response."))
        .every((r) => Object.keys(r.payload).every((k) => k === "acceptedOptionIds")),
    ).toBe(true);
    const inbound = await sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.inbound_events WHERE status = 'done'",
    );
    expect(inbound.rows[0]!.n).toBe(2);
    const msgs = await sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.messages WHERE sender_external_identity_id IS NULL",
    );
    expect(msgs.rows[0]!.n).toBeGreaterThan(0); // outbound replies logged
    const trace = await sim.c.audit.query({ turnId: ask.ingest.eventId });
    expect(actions(trace)).toEqual(
      expect.arrayContaining([
        "turn.received",
        "coordination.request",
        "coordination.response",
        "coordination.decision",
        "turn.completed",
      ]),
    );
    await sim.c.close();
    await sql.close();
  });
});
