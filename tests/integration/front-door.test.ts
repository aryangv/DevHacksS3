// P2 contribution (owner of this folder: P1 — please review). The front door end to end on REAL
// implementations: BlueBubbles webhook route + adapter (against a fake BlueBubbles server), real
// identity/membership/auth gate/nudges, the web sign-up flow, real P3 memory (fake Supermemory over
// HTTP) and group chat ingestion — on Postgres (PGlite). Covers 18.9-1, 18.9-2, 18.9-7 and the v1
// goals: replies in 1:1 and group chats, memories learnt and used.
import { buildServer } from "@campus/api";
import { FakeSupermemory, serveFakeSupermemory } from "@campus/context/testing";
import type { FakeModelClient } from "@campus/contracts/fakes";
import { createPgliteClient, migrate } from "@campus/db";
import { BlueBubblesAdapter, BlueBubblesHttp } from "@campus/messaging";
import { type Container, buildContainer } from "@campus/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SECRET = "bb-webhook-secret-for-tests-0123456789";
const BOT = "+15550000000";
const AVERY = "+15550001001";
const BLAKE = "+15550001002";
const GROUP = "iMessage;+;chat-dinner";
const ORIGIN = "https://app.test";

type Sent = { path: string; body: Record<string, unknown> };

let c: Container;
let app: Awaited<ReturnType<typeof buildServer>>;
let sent: Sent[];
let fake: FakeSupermemory;
let smServer: { url: string; close(): Promise<void> };
let seq = 0;

beforeEach(async () => {
  sent = [];
  seq = 0;
  fake = new FakeSupermemory();
  smServer = await serveFakeSupermemory(fake);
  const sql = await createPgliteClient();
  await migrate(sql);
  const bbFetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    sent.push({ path: u.pathname, body });
    const data =
      u.pathname === "/api/v1/chat/new"
        ? { guid: `any;-;${(body.addresses as string[])[0]}`, messages: [{ guid: `out-${sent.length}` }] }
        : { guid: `out-${sent.length}` };
    return new Response(JSON.stringify({ status: 200, data }), { status: 200 });
  };
  const messaging = new BlueBubblesAdapter({
    http: new BlueBubblesHttp({
      baseUrl: "https://bb.test",
      password: "pw",
      fetch: bbFetch,
      maxPerSecond: 0,
    }),
    webhookSecret: SECRET,
    botAddresses: [BOT],
  });
  c = await buildContainer({
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      RUNTIME_STORE: "postgres",
      DATABASE_URL: "pglite://memory",
      USE_REAL_MESSAGING: "true",
      USE_REAL_IDENTITY: "true",
      BLUEBUBBLES_URL: "https://bb.test",
      BLUEBUBBLES_PASSWORD: "pw",
      BLUEBUBBLES_WEBHOOK_SECRET: SECRET,
      BLUEBUBBLES_BOT_ADDRESS: BOT,
      APP_ORIGIN: ORIGIN,
      USE_REAL_MEMORY: "true",
      SUPERMEMORY_API_KEY: fake.orgKey,
      SUPERMEMORY_BASE_URL: smServer.url,
    },
    overrides: { sql, messaging },
  });
  app = await buildServer(c);
});

afterEach(async () => {
  await app.close();
  await c.close();
  await smServer.close();
});

// ---- helpers ----------------------------------------------------------------------------------

function event(from: string, text: string, group?: { guid: string; members: string[] }) {
  seq += 1;
  return {
    type: "new-message",
    data: {
      guid: `in-${seq}`,
      text,
      isFromMe: false,
      itemType: 0,
      associatedMessageType: null,
      dateCreated: Date.now(),
      handle: { address: from },
      chats: [
        group
          ? { guid: group.guid, style: 43, participants: group.members.map((address) => ({ address })) }
          : { guid: `iMessage;-;${from}`, style: 45, participants: [] },
      ],
    },
  };
}

const post = (payload: unknown, token: string | null = SECRET) =>
  app.inject({
    method: "POST",
    url: `/webhooks/bluebubbles${token === null ? "" : `?token=${token}`}`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });

async function text(from: string, body: string, group?: { guid: string; members: string[] }) {
  const res = await post(event(from, body, group));
  expect(res.statusCode).toBe(200);
  const outcomes = await c.worker.drain();
  return { res: res.json() as { status: string }, outcomes };
}

const textsTo = (chatGuid: string) =>
  sent.filter(
    (s) =>
      s.body.chatGuid === chatGuid ||
      (s.body.addresses as string[] | undefined)?.[0] === chatGuid.split(";").pop(),
  );

const cookieFrom = (res: { headers: Record<string, unknown> }, name: string) => {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : [raw];
  const hit = all.find((x) => typeof x === "string" && x.startsWith(`${name}=`)) as string | undefined;
  return hit ? hit.split(";")[0]! : null;
};

/** Sign-up through the real web page + a texted code. Returns the session cookie. */
async function signUp(address: string, name: string, nudgeToken?: string) {
  const start = await app.inject({
    method: "POST",
    url: "/onboard/start",
    headers: { "content-type": "application/json", origin: ORIGIN },
    payload: JSON.stringify({ address, name, t: nudgeToken ?? null }),
  });
  expect(start.statusCode).toBe(200);
  const { code, sendTo } = start.json() as { code: string; sendTo: string };
  expect(sendTo).toBe(BOT);
  const verifyCookie = cookieFrom(start, "cv_verify")!;
  const pending = await app.inject({
    method: "GET",
    url: "/onboard/status",
    headers: { cookie: verifyCookie },
  });
  expect(pending.json()).toEqual({ status: "pending" });

  const codeMsg = await post(event(address, code));
  expect(codeMsg.json()).toEqual({ status: "verification" });

  const done = await app.inject({ method: "GET", url: "/onboard/status", headers: { cookie: verifyCookie } });
  expect(done.json()).toEqual({ status: "approved", next: "/me" });
  return cookieFrom(done, "cv_session")!;
}

// ---- tests ------------------------------------------------------------------------------------

describe("front door on real implementations (BlueBubbles + identity + memory)", () => {
  it("wires the real identity and memory modules", () => {
    expect(c.wiring.identity).toBe("real");
    expect(c.wiring.memory).toBe("real");
  });

  it("rejects webhooks without the URL secret (default deny) and audits it", async () => {
    expect((await post(event(AVERY, "hi"), null)).statusCode).toBe(401);
    expect((await post(event(AVERY, "hi"), "wrong")).statusCode).toBe(401);
    expect((await c.queue.counts()).pending ?? 0).toBe(0);
    const rejected = await c.audit.query({ action: "webhook.rejected", limit: 10 });
    expect(rejected).toHaveLength(2);
  });

  it("18.9-1: an unverified sender is blocked — no model call, no memory — and gets a sign-up link", async () => {
    const model = c.fakes.model as FakeModelClient;
    const { outcomes } = await text(AVERY, "I'm vegetarian, what can you do?");
    expect(outcomes[0]!.status).toBe("blocked_unverified");
    expect(model.requests).toHaveLength(0);
    expect(fake.namespaces()).toEqual([]);
    const [nudge] = textsTo(`iMessage;-;${AVERY}`);
    expect(nudge!.body.message).toMatch(/verify your number.*https:\/\/app\.test\/onboard\?t=/);
    const body = (await c.sql!.query<{ body: string | null }>(`SELECT body FROM core.messages`)).rows[0]!;
    expect(body.body).toBeNull(); // an unverified person's 1:1 text is not retained
  });

  it("sign-up: page → code texted from their number → verified, confirmed in iMessage, signed in", async () => {
    await text(AVERY, "hi");
    const token = String(textsTo(`iMessage;-;${AVERY}`)[0]!.body.message).split("t=")[1]!;
    const page = await app.inject({ method: "GET", url: `/onboard?t=${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'nonce-");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.body).not.toContain(AVERY); // the page never reveals whose link it is

    const csrf = await app.inject({
      method: "POST",
      url: "/onboard/start",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
      payload: JSON.stringify({ address: AVERY }),
    });
    expect(csrf.statusCode).toBe(403);

    const session = await signUp(AVERY, "Avery", token);
    expect(String(sent.at(-1)!.body.message)).toMatch(/^You're set, Avery!/);
    const me = await app.inject({ method: "GET", url: "/me", headers: { cookie: session } });
    expect(me.statusCode).toBe(200);
    expect(me.body).toContain("Hi, Avery");
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(303);
  });

  it("18.9-2 + memory: a verified DM gets a reply; what they said is learnt into their own namespace", async () => {
    const session = await signUp(AVERY, "Avery");
    const before = sent.length;
    const { outcomes } = await text(AVERY, "I'm vegetarian and my budget for dinner is $20.");
    expect(outcomes[0]!.status).toBe("replied");
    expect(sent.length).toBeGreaterThan(before);
    expect(sent.at(-1)!.body.chatGuid).toBe(`iMessage;-;${AVERY}`);

    const userId = (await c.identity.resolveSender("imessage", AVERY)).userId!;
    const docs = fake.documents(`user_${userId}`).filter((d) => d.id !== "ns_init");
    expect(docs.map((d) => d.content).join("\n")).toContain(
      "I'm vegetarian and my budget for dinner is $20.",
    );

    const memory = await app.inject({ method: "GET", url: "/me/memory", headers: { cookie: session } });
    expect(memory.statusCode).toBe(200);
    expect(memory.body).toContain("memory.write"); // the activity log shows the write
  });

  it("group: the agent replies in the same group when addressed; unverified members are nudged there", async () => {
    await signUp(AVERY, "Avery");
    const group = { guid: GROUP, members: [AVERY, BLAKE] };

    const chatter = await text(BLAKE, "lol did anyone finish the problem set", group);
    expect(chatter.outcomes[0]!.status).toBe("blocked_unverified"); // not addressed: no nudge either
    expect(textsTo(GROUP)).toHaveLength(0);

    const asked = await text(AVERY, "@agent hi everyone, what can you do?", group);
    expect(asked.outcomes[0]!.status).toBe("replied");
    expect(textsTo(GROUP).length).toBeGreaterThan(0);
    const conv = (
      await c.sql!.query<{ status: string }>(`SELECT status FROM core.conversations WHERE provider_id = $1`, [
        GROUP,
      ])
    ).rows[0]!;
    expect(conv.status).toBe("active");

    const before = textsTo(GROUP).length;
    await text(BLAKE, "@agent can you help me too?", group);
    const nudge = textsTo(GROUP).slice(before);
    expect(nudge).toHaveLength(1);
    expect(String(nudge[0]!.body.message)).toMatch(/verify your number/);
  });

  it("group chat memory: every line said in the group (verified or not) lands in the group's namespace", async () => {
    await signUp(AVERY, "Avery");
    const group = { guid: GROUP, members: [AVERY, BLAKE] };
    await text(AVERY, "thai food tonight sounds good to me", group);
    await text(BLAKE, "i'm down for thai too", group);
    await text(BLAKE, "my password is hunter2", group);

    expect(c.maintenance).not.toBeNull();
    await c.maintenance!.runAll();
    const conversationId = (
      await c.sql!.query<{ id: string }>(`SELECT id FROM core.conversations WHERE provider_id = $1`, [GROUP])
    ).rows[0]!.id;
    const docs = fake.documents(`group_${conversationId}`);
    const all = docs.map((d) => d.content).join("\n");
    expect(all).toContain("Avery: thai food tonight sounds good to me");
    expect(all).toContain("A member who hasn't signed up: i'm down for thai too");
    expect(all).not.toContain("hunter2"); // secrets are redacted
    expect(all).not.toContain(BLAKE); // never a phone number in memory
    const averyId = (await c.identity.resolveSender("imessage", AVERY)).userId!;
    expect(docs.find((d) => d.id === `chat_${conversationId}_${averyId}`)?.metadata).toMatchObject({
      author_user_id: averyId,
      kind: "conversation",
    });

    // A second run sends nothing again.
    const count = docs.length;
    await c.maintenance!.runAll();
    expect(fake.documents(`group_${conversationId}`)).toHaveLength(count);
    const done = (
      await c.sql!.query<{ n: string | number }>(`SELECT count(*) AS n FROM core.group_memory_ingested`)
    ).rows[0]!;
    expect(Number(done.n)).toBe(3);
  });

  it("18.9-7: a redelivered webhook produces one processed turn", async () => {
    await signUp(AVERY, "Avery");
    const e = event(AVERY, "hello there");
    expect((await post(e)).json()).toEqual({ status: "enqueued" });
    expect((await post(e)).json()).toEqual({ status: "duplicate" });
    expect(await c.worker.drain()).toHaveLength(1);
  });

  it("revoking verification on the web blocks the very next message", async () => {
    const session = await signUp(AVERY, "Avery");
    const r = await app.inject({
      method: "POST",
      url: "/me/revoke",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: session },
      payload: JSON.stringify({ deleteMemory: false }),
    });
    expect(r.json()).toMatchObject({ ok: true });
    const { outcomes } = await text(AVERY, "are you still there?");
    expect(outcomes[0]).toMatchObject({ status: "blocked_unverified", detail: { reason: "revoked" } });
    expect((await app.inject({ method: "GET", url: "/me", headers: { cookie: session } })).statusCode).toBe(
      303,
    );
  });
});
