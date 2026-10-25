import { demoGroupProviderId, demoUsers } from "@campus/contracts/fixtures";
import { Simulator } from "@campus/worker";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";

const env = { LOG_LEVEL: "error", NODE_ENV: "test" };

describe("api shell", () => {
  it("serves /healthz with the current wiring", async () => {
    const sim = await Simulator.create({ env });
    const app = await buildServer(sim.c);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, wiring: { model: "fake", tools: "fake" } });
    await app.close();
    await sim.c.close();
  });

  it("returns a turn's trace and a conversation timeline", async () => {
    const sim = await Simulator.create({ env });
    const app = await buildServer(sim.c);
    const members = demoUsers.map((u) => u.externalId);
    const t = await sim.group(
      demoGroupProviderId,
      demoUsers[0]!.externalId,
      members,
      "@agent dinner under $20?",
    );
    const turn = await app.inject({ method: "GET", url: `/trace/turns/${t.ingest.eventId}` });
    expect(turn.statusCode).toBe(200);
    const actions = (turn.json().events as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["turn.received", "coordination.request", "turn.completed"]),
    );
    const conv = await app.inject({
      method: "GET",
      url: `/trace/conversations/${t.outcomes[0]!.conversationId}`,
    });
    expect(conv.json().events.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/trace/turns/not-a-uuid" })).statusCode).toBe(400);
    await app.close();
    await sim.c.close();
  });

  it("requires the bearer token when one is configured", async () => {
    const sim = await Simulator.create({ env: { ...env, TRACE_API_TOKEN: "trace-token-for-tests" } });
    const app = await buildServer(sim.c);
    const url = "/trace/turns/11111111-1111-4111-8111-111111111111";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url, headers: { authorization: "Bearer wrong-token-value!!" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url, headers: { authorization: "Bearer trace-token-for-tests" } }))
        .statusCode,
    ).toBe(200);
    await app.close();
    await sim.c.close();
  });

  it("keeps the raw request body for webhook signature checks", async () => {
    const sim = await Simulator.create({ env });
    const app = await buildServer(sim.c);
    let seen: string | undefined;
    app.post("/echo", async (req) => {
      seen = req.rawBody;
      return { ok: true };
    });
    const body = '{"b":1,  "a":2}';
    await app.inject({
      method: "POST",
      url: "/echo",
      payload: body,
      headers: { "content-type": "application/json" },
    });
    expect(seen).toBe(body);
    await app.close();
    await sim.c.close();
  });
});
