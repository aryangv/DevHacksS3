// P2 contribution (owner of this folder: P1 — please review). The dev-only web iMessage simulator:
// messages typed on /dev/chat go through the REAL webhook route, BlueBubbles adapter + HTTP client,
// identity and pipeline, and the bot's replies come back through a fake BlueBubbles Server.
import { buildServer } from "@campus/api";
import { ConfigError, loadConfig } from "@campus/contracts";
import { createPgliteClient, migrate } from "@campus/db";
import { BlueBubblesAdapter, BlueBubblesHttp } from "@campus/messaging";
import { type Container, buildContainer } from "@campus/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  RUNTIME_STORE: "postgres",
  DATABASE_URL: "pglite://memory",
  USE_REAL_MESSAGING: "true",
  USE_REAL_IDENTITY: "true",
  DEV_SIMULATOR: "true",
  BLUEBUBBLES_URL: "http://localhost/dev/bluebubbles",
  BLUEBUBBLES_PASSWORD: "sim-pw",
  BLUEBUBBLES_WEBHOOK_SECRET: "sim-secret-0123456789",
  BLUEBUBBLES_BOT_ADDRESS: "+15555550100",
  APP_ORIGIN: "http://localhost",
};
const AVERY = "+15555550101";
const BLAKE = "+15555550102";
const CASEY = "+15555550103";

let c: Container;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeEach(async () => {
  const sql = await createPgliteClient();
  await migrate(sql);
  // The real adapter + HTTP client, whose "network" is this same server (the fake BlueBubbles).
  const fetchIntoApp = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const res = await app.inject({
      method: (init.method ?? "GET") as "GET" | "POST",
      url: u.pathname + u.search,
      headers: { "content-type": "application/json" },
      ...(typeof init.body === "string" ? { payload: init.body } : {}),
    });
    return new Response(res.body, { status: res.statusCode });
  };
  const messaging = new BlueBubblesAdapter({
    http: new BlueBubblesHttp({
      baseUrl: ENV.BLUEBUBBLES_URL,
      password: ENV.BLUEBUBBLES_PASSWORD,
      fetch: fetchIntoApp,
      maxPerSecond: 0,
    }),
    webhookSecret: ENV.BLUEBUBBLES_WEBHOOK_SECRET,
    botAddresses: [ENV.BLUEBUBBLES_BOT_ADDRESS],
  });
  c = await buildContainer({ env: ENV, overrides: { sql, messaging } });
  app = await buildServer(c);
});

afterEach(async () => {
  await app.close();
  await c.close();
});

type SimState = {
  messages: Array<{ id: string; chatGuid: string; from: string; text: string }>;
  chats: Array<{ guid: string }>;
};
const state = async () => (await app.inject({ method: "GET", url: "/dev/chat/state" })).json() as SimState;

describe("dev web iMessage simulator", () => {
  it("a message typed in the simulator goes through the real webhook and pipeline; the reply comes back", async () => {
    const send = await app.inject({
      method: "POST",
      url: "/dev/chat/send",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ from: AVERY, chatGuid: null, text: "hi, what can you do?" }),
    });
    expect(send.json()).toEqual({ webhook: 200, result: { status: "enqueued" } });
    const [outcome] = await c.worker.drain();
    expect(outcome!.status).toBe("blocked_unverified"); // the real auth gate ran
    const thread = (await state()).messages.filter((m) => m.chatGuid === `iMessage;-;${AVERY}`);
    expect(thread.map((m) => m.from)).toEqual([AVERY, "bot"]);
    expect(thread[1]!.text).toMatch(/verify your number.*http:\/\/localhost\/onboard\?t=/);
  });

  it("group chats can be created and are keyed by their chat guid", async () => {
    const g = await app.inject({
      method: "POST",
      url: "/dev/chat/group",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "Dinner crew", members: [AVERY, "+15555550102"] }),
    });
    const { guid } = g.json() as { guid: string };
    expect(guid).toMatch(/^iMessage;\+;sim-group-/);
    const send = await app.inject({
      method: "POST",
      url: "/dev/chat/send",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ from: AVERY, chatGuid: guid, text: "lol hi" }),
    });
    expect(send.json()).toMatchObject({ webhook: 200 });
    await c.worker.drain();
    const conv = (
      await c.sql!.query<{ type: string }>(`SELECT type FROM core.conversations WHERE provider_id = $1`, [
        guid,
      ])
    ).rows[0];
    expect(conv).toEqual({ type: "group" });
  });

  it("👍 on the bot's proposal (and only that message) confirms the group plan — no link, no text", async () => {
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json", ...headers },
        payload: JSON.stringify(body),
      });
    // Sign Avery and Blake up through the real page + a code texted in the simulator.
    for (const [address, name] of [
      [AVERY, "Avery"],
      [BLAKE, "Blake"],
    ] as const) {
      const start = await post("/onboard/start", { address, name }, { origin: ENV.APP_ORIGIN });
      await post("/dev/chat/send", {
        from: address,
        chatGuid: null,
        text: (start.json() as { code: string }).code,
      });
    }
    const { guid } = (
      await post("/dev/chat/group", { name: "Dinner", members: [AVERY, BLAKE, CASEY] })
    ).json() as {
      guid: string;
    };
    await post("/dev/chat/send", {
      from: AVERY,
      chatGuid: guid,
      text: "@agent can we order dinner tonight? under $20 each",
    });
    await c.worker.drain();
    const botLines = async () =>
      (await state()).messages.filter((m) => m.chatGuid === guid && m.from === "bot");
    const [onIt, proposal] = await botLines();
    expect(onIt!.text).toMatch(/^On it/);
    expect(proposal!.text).toMatch(/^Proposal: .*👍 this message to lock it in/);

    // A 👍 on a different bot message, or from someone unverified, changes nothing.
    await post("/dev/chat/react", { from: AVERY, messageId: onIt!.id });
    await post("/dev/chat/react", { from: CASEY, messageId: proposal!.id });
    await c.worker.drain();
    expect(await botLines()).toHaveLength(2);
    const task = async () =>
      (
        await c.sql!.query<{ status: string }>(
          `SELECT status FROM core.agent_tasks WHERE type = 'group_meal'`,
        )
      ).rows[0]!;
    expect((await task()).status).toBe("proposed");

    // Blake's 👍 on the proposal confirms it.
    await post("/dev/chat/react", { from: BLAKE, messageId: proposal!.id });
    await c.worker.drain();
    expect((await task()).status).not.toBe("proposed");
    expect((await botLines()).length).toBeGreaterThan(2);
    const reactions = await c.audit.query({ action: "coordination.reaction", limit: 10 });
    expect(reactions.map((e) => e.detail?.confirms)).toEqual([false, true]); // Casey's never reached the agent
  });

  it("answers only to direct localhost requests, never through a tunnel", async () => {
    const tunnelled = await app.inject({
      method: "GET",
      url: "/dev/chat",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(tunnelled.statusCode).toBe(404);
    const otherHost = await app.inject({
      method: "GET",
      url: "/dev/chat/state",
      headers: { host: "abc.ngrok-free.app" },
    });
    expect(otherHost.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/dev/chat" })).statusCode).toBe(200);
  });

  it("the fake BlueBubbles server requires the BlueBubbles password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/dev/bluebubbles/api/v1/message/text?password=wrong",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ chatGuid: `iMessage;-;${AVERY}`, message: "spoof" }),
    });
    expect(res.statusCode).toBe(401);
    expect((await state()).messages).toEqual([]);
  });

  it("is refused in production", () => {
    expect(() => loadConfig({ ...ENV, NODE_ENV: "production", TRACE_API_ENABLED: "false" })).toThrow(
      ConfigError,
    );
  });
});
