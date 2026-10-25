import { fixedClock, loadConfig, personalAgentId, silentLogger } from "@campus/contracts";
import { InMemoryAuditLog } from "@campus/contracts/fakes";
import { afterAll, describe, expect, it } from "vitest";
import { createContextServices, Supermemory, SupermemoryError } from "../../src/index";
import { NamespaceClient, SupermemoryHttp } from "../../src/supermemory/client";
import { namespaces } from "../../src/supermemory/namespaces";
import { HOUR, TestMembership, createDb } from "../helpers";

/**
 * Real Supermemory v5, P3 end to end. Opt-in only — never runs in CI or a plain `pnpm test`:
 *   P3_LIVE=1 pnpm vitest run packages/context/tests/live
 * Reads SUPERMEMORY_API_KEY from the repo-root .env. Every namespace and scoped key it creates is removed.
 */
const LIVE = process.env.P3_LIVE === "1";
if (LIVE) {
  try {
    process.loadEnvFile(new URL("../../../../.env", import.meta.url));
  } catch {
    // fall back to the shell environment
  }
}
const apiKey = LIVE ? process.env.SUPERMEMORY_API_KEY : undefined;

const created: string[] = [];
let sm: Supermemory | undefined;
afterAll(async () => {
  if (!sm) return;
  for (const ns of created) await sm.deleteNamespace(ns as never).catch(() => undefined);
  await sm.dispose();
});

async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 180_000): Promise<T> {
  const start = Date.now();
  let last = await fn();
  while (!done(last) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 4000));
    last = await fn();
  }
  return last;
}

describe.skipIf(!apiKey)("Supermemory live (P3 on real implementations)", () => {
  it("DM → memory → registry projections → isolation → forget → delete", { timeout: 900_000 }, async () => {
    const { sql } = await createDb();
    const clock = fixedClock(new Date());
    sm = new Supermemory({ apiKey: apiKey!, clock });
    const membership = new TestMembership();
    const audit = new InMemoryAuditLog();
    const p3 = await createContextServices({
      config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" }),
      logger: silentLogger,
      sql,
      audit,
      clock: { now: () => new Date() },
      membership,
      supermemory: sm,
    });

    const one = async <T>(text: string, params: unknown[]) =>
      (await sql.query<{ id: string }>(text, params)).rows[0]!.id as T;
    const user = async (name: string) => {
      const id = await one<string>(`INSERT INTO core.users (display_name) VALUES ($1) RETURNING id`, [name]);
      await sql.query(
        `INSERT INTO core.external_identities (user_id, platform, external_id, status) VALUES ($1, 'imessage', $2, 'verified')`,
        [id, `+1555${Date.now()}${name}`],
      );
      return id;
    };
    const alice = await user("Alice");
    const bob = await user("Bob");
    const group = await one<string>(
      `INSERT INTO core.conversations (platform, provider_id, type, status) VALUES ('imessage', $1, 'group', 'active') RETURNING id`,
      [`live_${Date.now()}`],
    );
    membership.add(group, alice);
    membership.add(group, bob);
    const task = await one<string>(
      `INSERT INTO core.agent_tasks (owner_type, owner_id, conversation_id, type, status) VALUES ('group', $1, $1, 'group_meal', 'collecting') RETURNING id`,
      [group],
    );
    created.push(namespaces.user(alice), namespaces.user(bob), namespaces.group(group));

    const dm = async (userId: string, text: string) => {
      const d = await p3.memoryPolicy.evaluate({
        principal: { kind: "user", userId },
        authorUserId: userId,
        write: {
          content: text,
          kind: "preference",
          customId: `conv_dm_${userId}`,
          metadata: { source: "imessage" },
        },
      });
      expect(d.ingest).toBe(true);
      if (d.ingest) await p3.memoryStore.add({ kind: "user", userId }, d.write);
    };
    await dm(alice, "I'm vegetarian and I keep dinner under $20.");
    await dm(alice, "I hate mexican food.");
    await dm(bob, "I'm allergic to peanuts and my budget is $35.");

    // Stable id appends: both of Alice's messages are one document.
    const aliceNs = sm.forNamespace(namespaces.user(alice));
    expect(
      (await aliceNs.listDocuments({ field: "kind", operator: "eq", value: "preference" })).map((d) => d.id),
    ).toEqual([`conv_dm_${alice}`]);

    // Projections derived from real memory, to Alice's own agent.
    await p3.consent.grant(alice, {
      purpose: "group_meal",
      fields: ["meal.max_price_per_person_minor", "meal.required_tags", "meal.avoid_cuisines"],
      audience: { kind: "agent", id: personalAgentId(alice) },
      ttlMs: HOUR,
    });
    const self = () =>
      p3.broker.requestContext({
        taskId: task,
        requesterAgentId: personalAgentId(alice),
        subjectUserId: alice,
        purpose: "group_meal",
        fields: ["meal.max_price_per_person_minor", "meal.required_tags", "meal.avoid_cuisines"],
        audience: { kind: "agent", id: personalAgentId(alice) },
      });
    const r = await until(self, (x) => x.status === "approved" && Object.keys(x.fields).length === 3);
    expect(r).toMatchObject({
      status: "approved",
      fields: {
        "meal.max_price_per_person_minor": 2000,
        "meal.required_tags": ["vegetarian_friendly"],
        "meal.avoid_cuisines": ["mexican"],
      },
    });

    // Only the coarse band to the group.
    await p3.consent.grant(bob, {
      purpose: "group_meal",
      fields: ["meal.price_band"],
      audience: { kind: "group", id: `group:${group}` },
      ttlMs: HOUR,
    });
    const band = await until(
      () =>
        p3.broker.requestContext({
          taskId: task,
          requesterAgentId: `group:${group}`,
          subjectUserId: bob,
          purpose: "group_meal",
          fields: ["meal.price_band"],
          audience: { kind: "agent", id: `group:${group}` },
        }),
      (x) => x.status === "approved" && "meal.price_band" in x.fields,
    );
    expect(band).toMatchObject({ fields: { "meal.price_band": "any" } });
    expect(JSON.stringify([band, audit.events])).not.toMatch(/peanut|\$35|3500/);

    // Isolation: Alice's searches never return Bob's memory; and a key for Alice is refused on Bob's namespace.
    const hits = await p3.memoryStore.search(
      { kind: "user", userId: alice },
      { query: "peanuts allergy $35 Bob", limit: 50 },
    );
    expect(JSON.stringify(hits)).not.toMatch(/peanut/i);
    const aliceKey = await sm.admin.mintScopedKey(namespaces.user(alice));
    const buggy = new NamespaceClient(namespaces.user(bob), new SupermemoryHttp({ maxRetries: 0 }), {
      keyFor: async () => aliceKey.key,
      invalidate: () => {},
    });
    const err = await buggy.search({ query: "peanuts" }).catch((e: unknown) => e);
    await sm.admin.revokeScopedKey(aliceKey.id);
    expect((err as SupermemoryError).status).toBe(403);

    // Forget with preview (Supermemory's semantic matching is model-driven; fall back to exact-ID forget).
    // Projections can come from raw chunks within seconds; learned memories take longer to form.
    await until(
      () => aliceNs.listMemories(),
      (m) => m.length > 0,
    );
    const preview = await p3.memoryStore.previewForget(alice, "mexican food").catch((e: unknown) => {
      if (!(e instanceof SupermemoryError)) throw e;
      return null;
    });
    if (preview && preview.matches.length) {
      const applied = await p3.memoryStore.applyForget(alice, preview.previewId);
      expect(applied.forgotten + applied.failed).toBe(preview.matches.length);
    } else {
      const [m] = await aliceNs.listMemories();
      expect(await p3.memoryStore.forgetMemory(alice, m!.id)).toEqual({ forgotten: true });
    }

    // Delete everything about Alice.
    expect(await p3.memoryStore.deleteUserMemory(alice)).toMatchObject({ namespaceDeleted: true });
    expect(await sm.forNamespace(namespaces.user(alice)).search({ query: "vegetarian" })).toEqual([]);
  });
});
