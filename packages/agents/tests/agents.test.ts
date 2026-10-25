import { type CoordinationResponse, type MealOption, personalAgentId, silentLogger } from "@campus/contracts";
import {
  FakeContextBroker,
  FakeMemoryStore,
  InMemoryAuditLog,
  InMemoryTaskStore,
} from "@campus/contracts/fakes";
import { sampleMealOptions } from "@campus/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { InProcessCoordinationBus } from "../src/bus";
import { DeterministicCoordinator, TIMEOUT_REASON } from "../src/coordinator";
import { PersonalAgentImpl, PersonalAgentRegistry } from "../src/personal-agent";

const opt = (id: string, price: number, distance?: number): MealOption => ({
  id,
  name: id,
  cuisine: "x",
  pricePerPersonMinor: price,
  currency: "USD",
  tags: [],
  ...(distance !== undefined ? { distanceMeters: distance } : {}),
});
const verdict = (
  agent: string,
  accepted: string[] | null,
  status?: CoordinationResponse["status"],
  reasonCode?: string,
) => ({
  agentId: agent,
  response: {
    taskId: "t",
    status: status ?? (accepted && accepted.length ? "accepted" : "rejected"),
    payload: accepted ? { acceptedOptionIds: accepted } : {},
    ...(reasonCode ? { reasonCode } : {}),
  } as CoordinationResponse,
});

describe("DeterministicCoordinator (spec 4.6, open decision 16.6)", () => {
  const c = new DeterministicCoordinator();

  it("proposes the unanimous option, ranked by acceptance then price then distance", () => {
    const options = [opt("a", 1500, 100), opt("b", 1200, 900), opt("c", 1200, 300)];
    const d = c.decide({
      options,
      verdicts: [verdict("p1", ["a", "b", "c"]), verdict("p2", ["b", "c"])],
      groupBudgetPerPersonMinor: null,
    });
    expect(d).toMatchObject({ kind: "propose", option: { id: "c" }, acceptCount: 2, respondents: 2 });
  });

  it("applies the group budget as a hard constraint", () => {
    const d = c.decide({
      options: [opt("cheap", 900), opt("pricey", 2500)],
      verdicts: [verdict("p1", ["cheap", "pricey"])],
      groupBudgetPerPersonMinor: 2000,
    });
    expect(d).toMatchObject({ kind: "propose", option: { id: "cheap" } });
    expect(
      c.decide({ options: [opt("pricey", 2500)], verdicts: [], groupBudgetPerPersonMinor: 2000 }),
    ).toEqual({ kind: "no_options" });
  });

  it("asks for counteroffers when nothing is unanimous, reporting the best partial", () => {
    const d = c.decide({
      options: [opt("a", 1000), opt("b", 1100)],
      verdicts: [verdict("p1", ["a"]), verdict("p2", ["b"]), verdict("p3", ["b"])],
      groupBudgetPerPersonMinor: null,
    });
    expect(d).toMatchObject({
      kind: "counteroffer_needed",
      bestPartial: { option: { id: "b" }, acceptCount: 2 },
      respondents: 3,
    });
  });

  it("treats needs_consent, timeouts and malformed answers as pending, not as votes", () => {
    const d = c.decide({
      options: [opt("a", 1000)],
      verdicts: [
        verdict("p1", ["a"]),
        verdict("p2", null, "needs_consent"),
        verdict("p3", [], "rejected", TIMEOUT_REASON),
        { agentId: "p4", response: { taskId: "t", status: "accepted", payload: { yes: true } } },
      ],
      groupBudgetPerPersonMinor: null,
    });
    expect(d).toMatchObject({
      kind: "propose",
      option: { id: "a" },
      respondents: 1,
      pending: ["p2", "p3", "p4"],
    });
  });

  it("narrows options with the tightest counteroffer price band", () => {
    const counters = [
      {
        agentId: "p1",
        response: {
          taskId: "t",
          status: "counteroffer" as const,
          payload: { "meal.price_band": "under_15" },
        },
      },
      {
        agentId: "p2",
        response: { taskId: "t", status: "counteroffer" as const, payload: { "meal.price_band": "bogus" } },
      },
    ];
    expect(c.applyCounteroffers([opt("a", 1400), opt("b", 1600)], counters).map((o) => o.id)).toEqual(["a"]);
  });
});

describe("PersonalAgent.evaluate — projections only (spec 5.7)", () => {
  const userId = "00000000-0000-4000-8000-0000000000aa";
  const broker = new FakeContextBroker();
  broker.setFacts(userId, {
    "meal.max_price_per_person_minor": 1500,
    "meal.required_tags": ["vegetarian_friendly"],
    "meal.avoid_cuisines": ["mexican"],
    "meal.price_band": "under_15",
  });
  const deps = {
    runtime: {} as never,
    broker,
    memoryStore: new FakeMemoryStore(),
    audit: new InMemoryAuditLog(),
    logger: silentLogger,
    clock: { now: () => new Date("2026-10-24T00:00:00Z") },
    agentName: "A",
  };
  const agent = new PersonalAgentImpl(userId, deps);
  const base = {
    taskId: "t1",
    requesterAgentId: "group:g",
    targetAgentId: personalAgentId(userId),
    purpose: "group_meal",
    expiresAt: "2026-10-24T01:00:00Z",
  };

  it("answers with accepted option ids only — no budget, tags or cuisines", async () => {
    const res = await agent.evaluate({
      ...base,
      requestType: "evaluate_option",
      payload: { options: sampleMealOptions },
    });
    expect(res.status).toBe("accepted");
    expect(Object.keys(res.payload)).toEqual(["acceptedOptionIds"]);
    expect(res.payload.acceptedOptionIds).toEqual(["opt_thai_basil"]); // ≤$15, vegetarian-friendly, not mexican
    expect(JSON.stringify(res)).not.toMatch(/1500|vegetarian|mexican/);
    // It read its own owner's context with itself as the audience.
    expect(broker.requests.at(-1)).toMatchObject({
      subjectUserId: userId,
      audience: { kind: "agent", id: personalAgentId(userId) },
    });
  });

  it("shares only shareable coarse fields on share_constraint", async () => {
    const res = await agent.evaluate({
      ...base,
      requestType: "share_constraint",
      payload: { fields: ["meal.price_band", "meal.max_price_per_person_minor"] },
    });
    expect(res).toMatchObject({ status: "counteroffer", payload: { "meal.price_band": "under_15" } });
    expect(res.payload).not.toHaveProperty("meal.max_price_per_person_minor");
    const denied = await agent.evaluate({
      ...base,
      requestType: "share_constraint",
      payload: { fields: ["meal.max_price_per_person_minor"] },
    });
    expect(denied).toMatchObject({ status: "rejected", reasonCode: "field_not_shareable" });
  });

  it("reports needs_consent instead of guessing", async () => {
    broker.needsConsent.add(userId);
    const res = await agent.evaluate({
      ...base,
      requestType: "evaluate_option",
      payload: { options: sampleMealOptions },
    });
    broker.needsConsent.delete(userId);
    expect(res).toMatchObject({ status: "needs_consent", payload: {} });
  });

  it("rejects expired requests", async () => {
    const res = await agent.evaluate({
      ...base,
      expiresAt: "2026-10-23T00:00:00Z",
      requestType: "evaluate_option",
      payload: { options: sampleMealOptions },
    });
    expect(res).toMatchObject({ status: "rejected", reasonCode: "expired" });
  });

  it("refuses to serve a turn for a different principal", async () => {
    const ctx = {
      userId: "someone-else",
      agent: { kind: "personal", id: personalAgentId("someone-else") },
    } as never;
    await expect(
      agent.handleTurn(ctx, { text: "hi", senderDisplayName: null, history: [] }, {} as never),
    ).rejects.toThrow(/different principal/);
  });
});

describe("InProcessCoordinationBus", () => {
  it("persists request/response events and validates targets", async () => {
    const tasks = new InMemoryTaskStore();
    const task = await tasks.create({
      ownerType: "group",
      ownerId: "g",
      conversationId: "g",
      type: "group_meal",
      status: "collecting",
      state: {},
    });
    const broker = new FakeContextBroker();
    const deps = {
      runtime: {} as never,
      broker,
      memoryStore: new FakeMemoryStore(),
      audit: new InMemoryAuditLog(),
      logger: silentLogger,
      clock: { now: () => new Date("2026-10-24T00:00:00Z") },
      agentName: "A",
    };
    const bus = new InProcessCoordinationBus({
      personalAgents: new PersonalAgentRegistry(deps),
      tasks,
      audit: deps.audit,
      logger: silentLogger,
      clock: deps.clock,
      timeoutMs: 1000,
    });
    const res = await bus.request({
      taskId: task.id,
      requesterAgentId: "group:g",
      targetAgentId: "personal:u1",
      requestType: "evaluate_option",
      purpose: "group_meal",
      payload: { options: sampleMealOptions },
      expiresAt: "2026-10-24T01:00:00Z",
    });
    expect(res.status).toBe("accepted"); // no known constraints → everything acceptable
    const bad = await bus.request({
      taskId: task.id,
      requesterAgentId: "group:g",
      targetAgentId: "group:other",
      requestType: "evaluate_option",
      purpose: "group_meal",
      payload: {},
      expiresAt: "2026-10-24T01:00:00Z",
    });
    expect(bad).toMatchObject({ status: "rejected", reasonCode: "unknown_target" });
    expect((await tasks.listEvents(task.id)).map((e) => e.type)).toEqual([
      "request.evaluate_option",
      "response.accepted",
      "request.evaluate_option",
      "response.rejected",
    ]);
  });
});
