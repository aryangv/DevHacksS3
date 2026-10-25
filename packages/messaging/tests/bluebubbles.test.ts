import { HarnessError } from "@campus/contracts";
import { describe, expect, it } from "vitest";
import {
  BlueBubblesAdapter,
  BlueBubblesHttp,
  Throttle,
  WEBHOOK_TOKEN_HEADER,
  normalizeAddress,
} from "../src/index";

// Payload shapes follow the BlueBubbles server source (MessageSerializer / ChatSerializer, v1 API).
// All addresses are fictional (555).

const BOT = "+15550000000";
const SECRET = "test-webhook-secret-0123456789";
const PASSWORD = "bb-server-password";

type Call = { method: string; url: URL; body: Record<string, unknown> | null };

function fakeServer(
  respond: (c: Call) => { status?: number; json: unknown } = () => ({
    json: { status: 200, data: { guid: "out-1" } },
  }),
) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(url),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const r = respond(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  return { calls, fetch };
}

function adapter(
  server = fakeServer(),
  opts: Partial<ConstructorParameters<typeof BlueBubblesAdapter>[0]> = {},
) {
  return new BlueBubblesAdapter({
    http: new BlueBubblesHttp({
      baseUrl: "https://bb.test/",
      password: PASSWORD,
      fetch: server.fetch,
      maxPerSecond: 0,
    }),
    webhookSecret: SECRET,
    botAddresses: [BOT],
    ...opts,
  });
}

const dmEvent = (over: Record<string, unknown> = {}) => ({
  type: "new-message",
  data: {
    guid: "msg-dm-1",
    text: "hey, what can you do?",
    isFromMe: false,
    itemType: 0,
    associatedMessageType: null,
    dateCreated: Date.parse("2026-10-24T18:00:00.000Z"),
    handle: { address: "+15550001001", service: "iMessage" },
    chats: [{ guid: "iMessage;-;+15550001001", style: 45, chatIdentifier: "+15550001001", participants: [] }],
    ...over,
  },
});

const groupEvent = (
  over: Record<string, unknown> = {},
  participants: unknown[] = [
    { address: "+15550001001" },
    { address: "+15550001002" },
    { address: "Casey@Example.com" },
  ],
) => ({
  type: "new-message",
  data: {
    guid: "msg-group-1",
    text: "@agent dinner tonight? ￼",
    isFromMe: false,
    itemType: 0,
    dateCreated: Date.parse("2026-10-24T18:01:00.000Z"),
    handle: { address: "+15550001001" },
    chats: [{ guid: "iMessage;+;chat123", style: 43, displayName: "Dinner crew", participants }],
    ...over,
  },
});

describe("webhook authentication (BlueBubbles sends no signature: URL token)", () => {
  it("accepts only the exact secret, compared in constant time", () => {
    const a = adapter();
    expect(a.verifyWebhook({ [WEBHOOK_TOKEN_HEADER]: SECRET }, "{}")).toBe(true);
    expect(a.verifyWebhook({ [WEBHOOK_TOKEN_HEADER]: `${SECRET}x` }, "{}")).toBe(false);
    expect(a.verifyWebhook({ [WEBHOOK_TOKEN_HEADER]: "" }, "{}")).toBe(false);
    expect(a.verifyWebhook({}, "{}")).toBe(false);
  });
});

describe("normalize", () => {
  it("a 1:1 message keys the conversation on the sender's address", () => {
    expect(adapter().normalize(dmEvent())).toEqual({
      platform: "imessage",
      providerMessageId: "msg-dm-1",
      providerConversationId: "+15550001001",
      senderExternalId: "+15550001001",
      participantExternalIds: ["+15550001001"],
      isGroup: false,
      text: "hey, what can you do?",
      timestamp: "2026-10-24T18:00:00.000Z",
    });
  });

  it("a group message keys on the chat guid; participants normalized, bot excluded, attachment marks stripped", () => {
    const m = adapter().normalize(
      groupEvent({}, [
        { address: "+15550001001" },
        { address: "(555) 000-1002" },
        { address: "Casey@Example.com" },
        { address: BOT },
      ]),
    )!;
    expect(m.isGroup).toBe(true);
    expect(m.providerConversationId).toBe("iMessage;+;chat123");
    expect(m.participantExternalIds).toEqual(["+15550001001", "+15550001002", "casey@example.com"]);
    expect(m.text).toBe("@agent dinner tonight?");
  });

  it("tapbacks become reactions on the exact target message; their text is never used", () => {
    const a = adapter();
    const like = a.normalize(
      groupEvent({
        text: "Liked “Proposal: Thai Basil…”",
        associatedMessageType: "like",
        associatedMessageGuid: "p:0/out-42",
      }),
    )!;
    expect(like.text).toBe("");
    expect(like.reaction).toEqual({ type: "like", targetMessageId: "out-42", removed: false });
    expect(like.isGroup).toBe(true);
    expect(
      a.normalize(dmEvent({ associatedMessageType: "-like", associatedMessageGuid: "bp:out-42" }))!.reaction,
    ).toEqual({ type: "like", targetMessageId: "out-42", removed: true });
    expect(
      a.normalize(dmEvent({ associatedMessageType: 2001, associatedMessageGuid: "out-7" }))!.reaction,
    ).toMatchObject({ type: "like", removed: false }); // numeric ids on older servers
    expect(
      a.normalize(dmEvent({ associatedMessageType: "sticker", associatedMessageGuid: "p:0/x" })),
    ).toBeNull();
    expect(a.normalize(dmEvent({ associatedMessageType: "like" }))).toBeNull(); // no target
    expect(a.normalize(dmEvent())!.reaction).toBeUndefined();
  });

  it("ignores our own sends, group events, other webhook types and junk", () => {
    const a = adapter();
    expect(a.normalize(dmEvent({ isFromMe: true }))).toBeNull();
    expect(a.normalize(dmEvent({ itemType: 1 }))).toBeNull();
    expect(a.normalize({ ...dmEvent(), type: "updated-message" })).toBeNull();
    expect(a.normalize(dmEvent({ handle: { address: BOT } }))).toBeNull();
    expect(a.normalize(dmEvent({ chats: [] }))).toBeNull();
    expect(a.normalize(null)).toBeNull();
    expect(a.normalize("x")).toBeNull();
  });

  it("looks up group participants when the webhook left them out", async () => {
    const server = fakeServer((c) =>
      c.url.pathname === "/api/v1/chat/iMessage%3B%2B%3Bchat123"
        ? {
            json: {
              status: 200,
              data: { participants: [{ address: "+15550001001" }, { address: "+15550001003" }] },
            },
          }
        : { status: 404, json: {} },
    );
    const m = await adapter(server).normalizeWithLookup(groupEvent({}, []));
    expect(m!.participantExternalIds).toEqual(["+15550001001", "+15550001003"]);
    expect(server.calls[0]!.url.searchParams.get("with")).toBe("participants");
    expect(server.calls[0]!.url.searchParams.get("password")).toBe(PASSWORD);
  });
});

describe("sending", () => {
  it("a 1:1 send to someone not seen yet uses chat/new, then the learned chat guid", async () => {
    const server = fakeServer((c) =>
      c.url.pathname === "/api/v1/chat/new"
        ? { json: { status: 200, data: { guid: "any;-;+15550001009", messages: [{ guid: "sent-1" }] } } }
        : { json: { status: 200, data: { guid: "sent-2" } } },
    );
    const a = adapter(server);
    expect(await a.sendDM("+15550001009", "You're set!")).toEqual({ messageId: "sent-1" });
    expect(server.calls[0]!.body).toMatchObject({
      addresses: ["+15550001009"],
      message: "You're set!",
      method: "apple-script",
    });
    expect(typeof server.calls[0]!.body!.tempGuid).toBe("string");
    expect(await a.sendDM("+15550001009", "again")).toEqual({ messageId: "sent-2" });
    expect(server.calls[1]!.url.pathname).toBe("/api/v1/message/text");
    expect(server.calls[1]!.body).toMatchObject({ chatGuid: "any;-;+15550001009", message: "again" });
  });

  it("replies in a 1:1 chat it received from use that chat's guid", async () => {
    const server = fakeServer();
    const a = adapter(server);
    a.normalize(dmEvent());
    await a.sendDM("+15550001001", "hi");
    expect(server.calls[0]!.body).toMatchObject({ chatGuid: "iMessage;-;+15550001001", message: "hi" });
  });

  it("group sends go to the chat guid; inline replies only with the Private API", async () => {
    const server = fakeServer();
    await adapter(server).sendGroup("iMessage;+;chat123", "On it", { replyTo: "msg-group-1" });
    expect(server.calls[0]!.body).toEqual({
      chatGuid: "iMessage;+;chat123",
      tempGuid: server.calls[0]!.body!.tempGuid,
      message: "On it",
      method: "apple-script",
    });
    const s2 = fakeServer();
    await adapter(s2, { method: "private-api", inlineReplies: true }).sendGroup(
      "iMessage;+;chat123",
      "On it",
      {
        replyTo: "msg-group-1",
      },
    );
    expect(s2.calls[0]!.body).toMatchObject({ method: "private-api", selectedMessageGuid: "msg-group-1" });
  });

  it("failures are send_failed, never retried blindly, and never leak the password", async () => {
    const server = fakeServer(() => ({
      status: 500,
      json: { status: 500, error: { type: "iMessage Error", error: "x" } },
    }));
    const err = await adapter(server)
      .sendGroup("iMessage;+;chat123", "hi")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe("send_failed");
    expect((err as HarnessError).retryable).toBe(false);
    expect((err as HarnessError).details).toMatchObject({
      outcomeUnknown: true,
      errorType: "iMessage Error",
    });
    expect(JSON.stringify({ m: (err as Error).message, d: (err as HarnessError).details })).not.toContain(
      PASSWORD,
    );
    expect(server.calls).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("normalizeAddress: phones to E.164, emails lowercased, junk rejected", () => {
    expect(normalizeAddress("(555) 000-1001")).toBe("+15550001001");
    expect(normalizeAddress("1 555 000 1001")).toBe("+15550001001");
    expect(normalizeAddress("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeAddress(" Avery@Example.COM ")).toBe("avery@example.com");
    expect(normalizeAddress("12345")).toBeNull();
    expect(normalizeAddress("not an email@")).toBeNull();
  });

  it("Throttle spaces calls without dropping any", async () => {
    const slept: number[] = [];
    // Clock frozen at 0: three calls at once must wait 0, 500 and 1000 ms.
    const th = new Throttle(
      2,
      () => 0,
      async (ms) => {
        slept.push(ms);
      },
    );
    await Promise.all([th.wait(), th.wait(), th.wait()]);
    expect(slept).toEqual([500, 1000]);
  });
});
