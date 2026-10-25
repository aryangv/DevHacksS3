import { type ContextRequest, groupAgentId, parseContextFields, personalAgentId } from "@campus/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { HOUR, type Scenario, scenario, visibleText } from "./helpers";

let s: Scenario;

const PRIVATE = ["meal.max_price_per_person_minor", "meal.required_tags", "meal.avoid_cuisines"];

beforeEach(async () => {
  s = await scenario();
  await s.dm(s.alice, "I'm vegetarian and I keep dinner under $20.");
  await s.dm(s.alice, "I hate mexican food. My roommate is vegan.");
  await s.dm(s.bob, "I eat anything. My budget is $35.");
});

/** What P1's PersonalAgent.evaluateOptions sends: its own owner's fields, audience = itself. */
const selfAsk = (userId: string, fields = PRIVATE, extra: Partial<ContextRequest> = {}): ContextRequest => ({
  taskId: s.task,
  requesterAgentId: personalAgentId(userId),
  subjectUserId: userId,
  purpose: "group_meal",
  fields,
  audience: { kind: "agent", id: personalAgentId(userId) },
  ...extra,
});

/** What P1's PersonalAgent.shareConstraint sends: requester and audience = the group agent. */
const groupAsk = (
  userId: string,
  fields = ["meal.price_band"],
  extra: Partial<ContextRequest> = {},
): ContextRequest => ({
  taskId: s.task,
  requesterAgentId: s.groupAgent,
  subjectUserId: userId,
  purpose: "group_meal",
  fields,
  audience: { kind: "agent", id: s.groupAgent },
  ...extra,
});

const grantSelf = (userId: string, ttlMs = HOUR) =>
  s.consent.grant(userId, {
    purpose: "group_meal",
    fields: PRIVATE,
    audience: { kind: "agent", id: personalAgentId(userId) },
    ttlMs,
  });
const grantBand = (userId: string, audienceId = `group:${s.group}`) =>
  s.consent.grant(userId, {
    purpose: "group_meal",
    fields: ["meal.price_band"],
    audience: { kind: "group", id: audienceId },
    ttlMs: HOUR,
  });

describe("projections from the subject's own memory (P1 registry)", () => {
  it("derives every private field deterministically, validated by the contracts registry", async () => {
    await grantSelf(s.alice);
    const r = await s.broker.requestContext(selfAsk(s.alice));
    expect(r.status).toBe("approved");
    const { values, rejected } = parseContextFields(r.status === "approved" ? r.fields : {});
    expect(rejected).toEqual([]);
    // "My roommate is vegan" is about someone else: not attributed to Alice.
    expect(values).toEqual({
      "meal.max_price_per_person_minor": 2000,
      "meal.required_tags": ["vegetarian_friendly"],
      "meal.avoid_cuisines": ["mexican"],
    });
    expect(s.audit.events.find((e) => e.action === "context.granted")!.detail).toMatchObject({
      sources: { "meal.max_price_per_person_minor": "memory", "meal.required_tags": "memory" },
    });
  });

  it("omits what it cannot know instead of guessing (an unknown is no constraint)", async () => {
    await grantSelf(s.carol);
    expect(await s.broker.requestContext(selfAsk(s.carol))).toMatchObject({ status: "approved", fields: {} });
  });

  it("falls back to a seeded preference (§13 contingency) and labels it as seeded", async () => {
    await s.repo.setSeed(s.carol, "meal.required_tags", ["halal"], s.clock.now());
    await grantSelf(s.carol);
    expect(await s.broker.requestContext(selfAsk(s.carol))).toMatchObject({
      fields: { "meal.required_tags": ["halal"] },
    });
    expect(s.audit.events.at(-1)!.detail).toMatchObject({ sources: { "meal.required_tags": "seeded" } });
  });

  it("only coarse price bands go to the group", async () => {
    await grantBand(s.alice);
    await grantBand(s.bob);
    expect(await s.broker.requestContext(groupAsk(s.alice))).toMatchObject({
      fields: { "meal.price_band": "under_20" },
    });
    expect(await s.broker.requestContext(groupAsk(s.bob))).toMatchObject({
      fields: { "meal.price_band": "any" },
    });
  });
});

describe("consent states (§14)", () => {
  it("needs consent, dedupes the prompt, then approves once granted", async () => {
    const first = await s.broker.requestContext(selfAsk(s.alice));
    expect(first.status).toBe("needs_consent");
    expect(await s.broker.requestContext(selfAsk(s.alice))).toEqual(first);
    const [pending] = await s.consent.listPending(s.alice);
    expect(pending!.summary).toMatch(/^Let your assistant use your exact per-meal budget/);
    await s.consent.approve(pending!.id, s.alice);
    expect((await s.broker.requestContext(selfAsk(s.alice))).status).toBe("approved");
  });

  it("a decline is remembered — no nagging", async () => {
    await s.broker.requestContext(selfAsk(s.alice));
    await s.consent.decline((await s.consent.listPending(s.alice))[0]!.id, s.alice);
    expect(await s.broker.requestContext(selfAsk(s.alice))).toEqual({
      status: "denied",
      reasonCode: "consent_declined:meal.max_price_per_person_minor",
    });
  });

  it("expired and revoked grants stop working immediately", async () => {
    await grantSelf(s.alice, 60_000);
    expect((await s.broker.requestContext(selfAsk(s.alice))).status).toBe("approved");
    s.clock.advance(61_000);
    expect((await s.broker.requestContext(selfAsk(s.alice))).status).toBe("needs_consent");
    const grants = await grantSelf(s.alice);
    for (const g of grants) await s.consent.revoke(g.id, s.alice);
    expect((await s.broker.requestContext(selfAsk(s.alice))).status).toBe("needs_consent");
  });

  it("a `group:*` standing grant covers the user's other groups only while they are a member", async () => {
    await grantBand(s.alice, "group:*");
    const other = await s.createTask(s.otherGroup);
    const req = {
      ...groupAsk(s.alice),
      taskId: other,
      requesterAgentId: groupAgentId(s.otherGroup),
      audience: { kind: "agent" as const, id: groupAgentId(s.otherGroup) },
    };
    expect((await s.broker.requestContext(req)).status).toBe("approved");
    s.membership.leave(s.otherGroup, s.alice);
    expect(await s.broker.requestContext(req)).toEqual({
      status: "denied",
      reasonCode: "subject_not_member",
    });
  });

  it("approved results expire no later than the grant or 15 minutes", async () => {
    await grantSelf(s.alice, 5 * 60_000);
    const r = await s.broker.requestContext(selfAsk(s.alice));
    expect(r.status === "approved" && r.expiresAt).toBe(
      new Date(s.clock.now().getTime() + 5 * 60_000).toISOString(),
    );
  });
});

describe("registry rules: raw fields never leave the subject's own agent", () => {
  it("refuses raw fields to the group agent — never even prompts", async () => {
    await grantSelf(s.alice);
    expect(await s.broker.requestContext(groupAsk(s.alice, ["meal.required_tags"]))).toEqual({
      status: "denied",
      reasonCode: "not_shareable:meal.required_tags",
    });
    expect(await s.consent.listPending(s.alice)).toEqual([]);
  });

  it("a grant to the subject's own agent does not cover the group, and vice versa", async () => {
    await grantSelf(s.alice);
    expect((await s.broker.requestContext(groupAsk(s.alice))).status).toBe("needs_consent");
    await grantBand(s.bob);
    expect((await s.broker.requestContext(selfAsk(s.bob, ["meal.price_band"]))).status).toBe("needs_consent");
  });

  it("rejects raw-field grants to anyone but the user's own agent", async () => {
    await expect(
      s.consent.grant(s.alice, {
        purpose: "group_meal",
        fields: ["meal.required_tags"],
        audience: { kind: "group", id: `group:${s.group}` },
        ttlMs: HOUR,
      }),
    ).rejects.toThrow("field is not shareable");
  });
});

describe("requester, subject, audience and task checks", () => {
  beforeEach(async () => {
    await grantSelf(s.alice);
    await grantBand(s.alice);
  });

  it.each([
    [
      "another group's agent",
      () => ({
        ...groupAsk(s.alice),
        requesterAgentId: groupAgentId(s.otherGroup),
        audience: { kind: "agent" as const, id: groupAgentId(s.otherGroup) },
      }),
      "requester_not_task_group",
    ],
    [
      "an audience that isn't the requester",
      () => ({ ...selfAsk(s.alice), audience: { kind: "agent" as const, id: personalAgentId(s.bob) } }),
      "audience_mismatch",
    ],
    [
      "a group audience outside the task",
      () => ({ ...groupAsk(s.alice), audience: { kind: "group" as const, id: `group:${s.otherGroup}` } }),
      "audience_not_task_group",
    ],
    [
      "a peer's personal agent asking for raw fields",
      () => ({
        ...selfAsk(s.alice),
        requesterAgentId: personalAgentId(s.bob),
        audience: { kind: "agent" as const, id: personalAgentId(s.bob) },
      }),
      "not_shareable:meal.max_price_per_person_minor",
    ],
    [
      "an unknown task",
      () => ({ ...selfAsk(s.alice), taskId: "00000000-0000-4000-8000-000000000000" }),
      "task_not_found",
    ],
    ["an unverified subject", () => selfAsk(s.dan), "subject_unverified"],
    ["a verified non-member", () => selfAsk(s.olly), "subject_not_member"],
    [
      "a field outside the purpose",
      () => ({ ...selfAsk(s.alice), purpose: "scheduling" as const }),
      "field_not_allowed_for_purpose:meal.max_price_per_person_minor",
    ],
    ["an unknown field", () => selfAsk(s.alice, ["notes.raw_memory"]), "unknown_field:notes.raw_memory"],
    [
      "a malformed requester",
      () => ({ ...selfAsk(s.alice), requesterAgentId: "alice" }),
      "invalid_requester",
    ],
  ])("denies %s", async (_label, req, reasonCode) => {
    expect(await s.broker.requestContext(req())).toEqual({ status: "denied", reasonCode });
  });

  it("rejects model-proposed extra keys such as a namespace", async () => {
    const injected = { ...selfAsk(s.alice), namespace: `user_${s.bob}` } as ContextRequest;
    expect(await s.broker.requestContext(injected)).toEqual({
      status: "denied",
      reasonCode: "invalid_request",
    });
  });

  it("stops at members who left, inactive groups and finished tasks", async () => {
    s.membership.leave(s.group, s.alice);
    expect(await s.broker.requestContext(selfAsk(s.alice))).toEqual({
      status: "denied",
      reasonCode: "subject_not_member",
    });
    s.membership.add(s.group, s.alice);
    await s.sql.query(`UPDATE core.conversations SET status = 'inactive' WHERE id = $1`, [s.group]);
    expect(await s.broker.requestContext(groupAsk(s.alice))).toEqual({
      status: "denied",
      reasonCode: "group_inactive",
    });
    await s.sql.query(`UPDATE core.agent_tasks SET status = 'completed' WHERE id = $1`, [s.task]);
    expect(await s.broker.requestContext(selfAsk(s.alice))).toEqual({
      status: "denied",
      reasonCode: "task_inactive",
    });
  });

  it("rate-limits repeated requests from one agent", async () => {
    for (let i = 0; i < 60; i++) await s.broker.requestContext(selfAsk(s.alice));
    expect(await s.broker.requestContext(selfAsk(s.alice))).toEqual({
      status: "denied",
      reasonCode: "rate_limited",
    });
    s.clock.advance(61_000);
    expect((await s.broker.requestContext(selfAsk(s.alice))).status).toBe("approved");
  });
});

describe("isolation (§18.9-4) and trace (§12)", () => {
  it("resolving Alice reads only Alice's namespace; nothing of Bob's can surface", async () => {
    await grantSelf(s.alice);
    s.fake.calls.length = 0;
    const r = await s.broker.requestContext(selfAsk(s.alice));
    expect(new Set(s.fake.calls.map((c) => c.namespace))).toEqual(new Set([`user_${s.alice}`]));
    expect(visibleText(r)).not.toMatch(/3500|anything/);
  });

  it("records every decision with its stage and reason — never values", async () => {
    await s.broker.requestContext(selfAsk(s.alice));
    await s.broker.requestContext(groupAsk(s.alice, ["meal.required_tags"]));
    await grantSelf(s.alice);
    await s.broker.requestContext(selfAsk(s.alice));
    const trace = await s.trace(s.task);
    expect(trace.map((t) => [t.decision, t.stage, t.reasonCode])).toEqual([
      ["needs_consent", null, null],
      ["denied", "disclose", "not_shareable:meal.required_tags"],
      ["approved", null, null],
    ]);
    expect(visibleText(trace, s.audit.events)).not.toMatch(/vegetarian|mexican|2000|\$20/i);
  });
});
