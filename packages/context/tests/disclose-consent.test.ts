import { personalAgentId } from "@campus/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { HOUR, type Scenario, scenario, visibleText } from "./helpers";

let s: Scenario;
beforeEach(async () => {
  s = await scenario();
});

/** What P1's GroupAgent.discloseChecked sends before tool-derived text reaches the group. */
const groupDisclose = (dataClasses: string[], subjectUserId = s.alice) =>
  s.broker.disclose({
    subjectUserId,
    purpose: "other",
    audience: { kind: "group", id: s.groupAgent },
    dataClasses,
  });

describe("ContextBroker.disclose (spec 5.7, 6.5 step 10)", () => {
  it("withholds a user's tool result from the group until they consent, then allows it", async () => {
    expect(await groupDisclose(["tool:canvas__list_grades"])).toEqual({
      allowed: false,
      reasonCode: "consent_required",
    });
    const [pending] = await s.consent.listPending(s.alice);
    expect(pending!.summary).toMatch(/results from canvas \/ list_grades/);
    await s.consent.approve(pending!.id, s.alice);
    expect(await groupDisclose(["tool:canvas__list_grades"])).toEqual({ allowed: true });
    // ...for that tool only.
    expect(await groupDisclose(["tool:canvas__list_assignments"])).toMatchObject({ allowed: false });
  });

  it("never lets raw context fields reach a group; unknown classes are denied", async () => {
    expect(await groupDisclose(["meal.required_tags"])).toEqual({
      allowed: false,
      reasonCode: "field_not_allowed_for_purpose:meal.required_tags",
    });
    const r = await s.broker.disclose({
      subjectUserId: s.alice,
      purpose: "group_meal",
      audience: { kind: "group", id: s.groupAgent },
      dataClasses: ["meal.required_tags"],
    });
    expect(r).toEqual({ allowed: false, reasonCode: "not_shareable:meal.required_tags" });
    expect(await groupDisclose(["memory:raw"])).toEqual({
      allowed: false,
      reasonCode: "unknown_data_class:memory:raw",
    });
  });

  it("checks the subject: verified, and a current member of that group", async () => {
    expect(await groupDisclose(["tool:canvas__list_grades"], s.dan)).toEqual({
      allowed: false,
      reasonCode: "subject_unverified",
    });
    expect(await groupDisclose(["tool:canvas__list_grades"], s.olly)).toEqual({
      allowed: false,
      reasonCode: "subject_not_member",
    });
  });
});

describe("ConsentService", () => {
  const self = (userId: string) => ({ kind: "agent" as const, id: personalAgentId(userId) });

  it("hasActiveGrant: standing grants covering every field for that audience", async () => {
    expect(await s.consent.hasActiveGrant(s.alice, "group_meal", self(s.alice), ["meal.required_tags"])).toBe(
      false,
    );
    await s.consent.grant(s.alice, {
      purpose: "group_meal",
      fields: ["meal.required_tags"],
      audience: self(s.alice),
      ttlMs: HOUR,
    });
    expect(await s.consent.hasActiveGrant(s.alice, "group_meal", self(s.alice), ["meal.required_tags"])).toBe(
      true,
    );
    expect(
      await s.consent.hasActiveGrant(s.alice, "group_meal", self(s.alice), [
        "meal.required_tags",
        "meal.avoid_cuisines",
      ]),
    ).toBe(false);
    expect(await s.consent.hasActiveGrant(s.alice, "group_meal", self(s.bob), ["meal.required_tags"])).toBe(
      false,
    );
  });

  it("only the subject can approve or decline, and only once — even on a double submit", async () => {
    await s.broker.disclose({
      subjectUserId: s.alice,
      purpose: "other",
      audience: { kind: "group", id: s.groupAgent },
      dataClasses: ["tool:canvas__list_grades"],
    });
    const [req] = await s.consent.listPending(s.alice);
    await expect(s.consent.approve(req!.id, s.bob)).rejects.toThrow("consent request not found");
    const both = await Promise.allSettled([
      s.consent.approve(req!.id, s.alice),
      s.consent.approve(req!.id, s.alice),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await s.consent.listGrants(s.alice)).toHaveLength(1);
  });

  it("only the owner can revoke; grants are capped by class policy", async () => {
    const [g] = await s.consent.grant(s.alice, {
      purpose: "group_meal",
      fields: ["meal.price_band"],
      audience: { kind: "group", id: s.groupAgent },
      ttlMs: 10 * 365 * 24 * HOUR,
    });
    expect(Date.parse(g!.expiresAt!) - s.clock.now().getTime()).toBe(180 * 24 * HOUR);
    await expect(s.consent.revoke(g!.id, s.bob)).rejects.toThrow("grant not found");
    await s.consent.revoke(g!.id, s.alice);
  });

  it("memory settings: §8 defaults, validated updates, audited without values", async () => {
    expect(await s.consent.getMemorySettings(s.carol)).toEqual({
      userId: s.carol,
      rememberEnabled: true,
      allowedKinds: ["preference", "fact"],
      sensitiveBucketsEnabled: false,
      retentionDays: null,
    });
    await expect(s.consent.updateMemorySettings(s.carol, { retentionDays: -1 })).rejects.toThrow(
      "invalid retention",
    );
    expect(await s.consent.updateMemorySettings(s.carol, { retentionDays: 30 })).toMatchObject({
      retentionDays: 30,
    });
    expect(s.audit.events.at(-1)).toMatchObject({
      action: "memory.settings_updated",
      detail: { changed: ["retentionDays"] },
    });
    expect(visibleText(s.audit.events)).not.toMatch(/vegetarian/);
  });
});
