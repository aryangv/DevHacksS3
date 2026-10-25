import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Supermemory, SupermemoryError, USER_BUCKETS } from "../src/index";
import { NamespaceClient, SupermemoryHttp } from "../src/supermemory/client";
import { namespaces } from "../src/supermemory/namespaces";
import { FakeSupermemory } from "../src/testing/index";
import { scenario } from "./helpers";

describe("namespaces (§5.1)", () => {
  it("uses user_{uuid} / group_{uuid} / task_{uuid}", () => {
    const id = randomUUID();
    expect(namespaces.user(id)).toBe(`user_${id}`);
    expect(namespaces.group(id)).toBe(`group_${id}`);
    expect(namespaces.task(id)).toBe(`task_${id}`);
  });

  it("refuses anything that is not an internal lowercase UUID", () => {
    for (const bad of [
      "alice",
      "+15551234567",
      "a:b",
      "x_y",
      randomUUID().toUpperCase(),
      `${randomUUID()}_private`,
      "",
    ]) {
      expect(() => namespaces.user(bad)).toThrow();
    }
  });
});

describe("scoped keys (§5.9 defense in depth)", () => {
  it("data-plane calls use a key locked to that namespace; admin calls use the org key", async () => {
    const s = await scenario();
    await s.dm(s.alice, "I'm vegetarian.");
    await s.memoryStore.search({ kind: "user", userId: s.alice }, { query: "food" });
    await s.memoryStore.profile({ kind: "user", userId: s.alice }, { buckets: ["food_preferences"] });
    const data = s.fake.calls.filter(
      (c) => /\/(search|profile|document)$/.test(c.path) && c.method === "POST" && !c.body?.taskType,
    );
    const admin = s.fake.calls.filter(
      (c) => c.method === "PATCH" || (c.method === "PUT" && c.path.endsWith("/buckets")),
    );
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((c) => c.auth === "scoped")).toBe(true);
    expect(admin.every((c) => c.auth === "org")).toBe(true);
    expect(s.fake.liveScopedKeys()).toBe(1); // minted once, reused
  });

  it("a bug that pairs one user's key with another user's namespace is stopped by Supermemory itself", async () => {
    const fake = new FakeSupermemory();
    const sm = new Supermemory({ apiKey: fake.orgKey, fetch: fake.fetch, maxRetries: 0 });
    const a = namespaces.user(randomUUID());
    const b = namespaces.user(randomUUID());
    await sm.forNamespace(b).add({ id: "x", content: "Bob is allergic to peanuts." });
    const aKey = await sm.admin.mintScopedKey(a);
    const buggy = new NamespaceClient(b, new SupermemoryHttp({ fetch: fake.fetch, maxRetries: 0 }), {
      keyFor: async () => aKey.key,
      invalidate: () => {},
    });
    const err = await buggy.search({ query: "peanuts" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupermemoryError);
    expect((err as SupermemoryError).status).toBe(403);
  });

  it("re-mints once when a scoped key is rejected, and dispose() revokes every key", async () => {
    const fake = new FakeSupermemory();
    const sm = new Supermemory({ apiKey: fake.orgKey, fetch: fake.fetch, maxRetries: 0 });
    const ns = namespaces.user(randomUUID());
    await sm.forNamespace(ns).add({ id: "a", content: "hello there friend" });
    // Revoke behind the cache's back (e.g. expired server-side).
    fake.revokeAllScopedKeys();
    const hits = await sm.forNamespace(ns).search({ query: "hello friend" });
    expect(hits.length).toBeGreaterThan(0);
    expect(fake.calls.filter((c) => c.path === "/v3/auth/scoped-key")).toHaveLength(2);
    expect(fake.liveScopedKeys()).toBe(1);
    await sm.dispose();
    expect(fake.liveScopedKeys()).toBe(0);
  });
});

describe("client behaviour", () => {
  it("returns per-document delete failures that Supermemory reports with HTTP 200", async () => {
    const fake = new FakeSupermemory({ simulateProcessing: true });
    const sm = new Supermemory({ apiKey: fake.orgKey, fetch: fake.fetch, maxRetries: 0 });
    const client = sm.forNamespace(namespaces.user(randomUUID()));
    await client.add({ id: "d1", content: "something" });
    await expect(client.deleteDocuments(["d1", "missing"])).resolves.toEqual({
      count: 0,
      failed: [
        { id: "d1", error: "Document is still processing" },
        { id: "missing", error: "Document not found" },
      ],
    });
  });

  it("re-adding a stable id appends instead of duplicating (§5.2)", async () => {
    const fake = new FakeSupermemory();
    const sm = new Supermemory({ apiKey: fake.orgKey, fetch: fake.fetch, maxRetries: 0 });
    const ns = namespaces.user(randomUUID());
    await sm.forNamespace(ns).add({ id: "conv_1", content: "First." });
    await sm.forNamespace(ns).add({ id: "conv_1", content: "Second." });
    expect(fake.documents(ns)).toHaveLength(1);
    expect(fake.documents(ns)[0]!.content).toContain("Second.");
  });

  it("errors carry status and operation only — no key, no body", async () => {
    const http = new SupermemoryHttp({
      maxRetries: 0,
      fetch: (async () =>
        new Response(JSON.stringify({ error: "user_x likes Thai food" }), { status: 400 })) as typeof fetch,
    });
    const err = await http
      .request("sm_secret", "POST", "/ns/x/search", {}, "search", { idempotent: true })
      .catch((e: Error) => e);
    expect(String(err)).not.toMatch(/sm_secret|Thai/);
  });

  it("retries transient failures only for idempotent calls", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify({ id: "a", status: "queued" }));
    }) as typeof fetch;
    const http = new SupermemoryHttp({ fetch: flaky, maxRetries: 2 });
    await http.request("k", "POST", "/x", {}, "add", { idempotent: true });
    expect(calls).toBe(2);
    calls = 0;
    await expect(http.request("k", "POST", "/x", {}, "add", { idempotent: false })).rejects.toBeInstanceOf(
      SupermemoryError,
    );
    expect(calls).toBe(1);
  });
});

describe("bucket provisioning (§5.6)", () => {
  it("creates the namespace first, then supportingContext and the default buckets — never the built-in 'preferences'", async () => {
    const s = await scenario();
    await s.provisioner.provisionUser(s.alice);
    const ns = `user_${s.alice}`;
    const order = s.fake.calls
      .filter((c) => c.namespace === ns)
      .map((c) => `${c.method} ${c.path.replace(ns, "{ns}")}`);
    expect(order.slice(0, 3)).toEqual([
      "POST /ns/{ns}/document",
      "PATCH /ns/{ns}",
      "PUT /ns/{ns}/profile/buckets",
    ]);
    expect(s.fake.documents(ns)[0]).toMatchObject({ id: "ns_init", taskType: "superrag" });
    expect(s.fake.supportingContext(ns)).toMatch(/college student/);
    expect(Object.keys(s.fake.buckets(ns)!).sort()).toEqual(Object.keys(USER_BUCKETS).sort());
    expect(s.fake.calls.some((c) => c.body?.buckets && "preferences" in c.body.buckets)).toBe(false);
  });

  it("is idempotent and keeps sensitive presets off until the user turns them on", async () => {
    const s = await scenario();
    await s.provisioner.provisionUser(s.alice);
    const before = s.fake.calls.length;
    await s.provisioner.provisionUser(s.alice);
    expect(s.fake.calls.length).toBe(before);
    const ns = `user_${s.alice}`;
    expect(s.fake.buckets(ns)).not.toHaveProperty("health");

    await s.consent.updateMemorySettings(s.alice, { sensitiveBucketsEnabled: true });
    expect(s.fake.buckets(ns)).toHaveProperty("health");
    await s.consent.updateMemorySettings(s.alice, { sensitiveBucketsEnabled: false });
    expect(s.fake.buckets(ns)).not.toHaveProperty("health");
  });

  it("skips buckets that clash with org-level ones (409: the org definition wins)", async () => {
    const s = await scenario({ fake: { orgBuckets: ["budget"] } });
    await s.provisioner.provisionUser(s.alice);
    const buckets = Object.keys(s.fake.buckets(`user_${s.alice}`)!);
    expect(buckets).not.toContain("budget");
    expect(buckets).toContain("food_preferences");
    expect(s.audit.events.find((e) => e.action === "memory.provisioned")?.detail).toMatchObject({
      skippedOrgClashes: ["budget"],
    });
  });
});
