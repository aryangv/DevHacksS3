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
  messages: Array<{ chatGuid: string; from: string; text: string }>;
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
