import { HarnessError } from "@campus/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { BOT, HOUR, type Setup, inbound, setup } from "./helpers";

// P2 (front door) on real Postgres (PGlite) with the real migrations.
// Covers spec 14 "Auth / identity" and 18.8 P2's definition of done at the service level.

let s: Setup;
beforeEach(async () => {
  s = await setup();
});

const AVERY = "+15550001001";
const BLAKE = "+15550001002";
const CASEY = "+15550001003";
const GROUP = "iMessage;+;chat123";

/** Sign someone up end to end: start on the web page, text the code from their own address. */
async function verify(address: string, name = "Avery") {
  const start = await s.verification.start({ address, displayName: name });
  const used = await s.verification.tryCode(inbound({ senderExternalId: address, text: start.code }));
  expect(used).toBe(true);
  return start;
}

describe("identity resolution (spec 4.2 step 4)", () => {
  it("an unknown sender becomes an unverified identity; no user id, no name", async () => {
    const r = await s.identity.resolveSender("imessage", AVERY);
    expect(r).toMatchObject({
      externalId: AVERY,
      status: "unverified",
      userId: null,
      displayName: null,
      hasMessagedLine: true,
    });
    expect((await s.identity.resolveSender("imessage", AVERY)).externalIdentityId).toBe(r.externalIdentityId);
    expect(s.audit.events.filter((e) => e.action === "identity.created")).toHaveLength(1);
  });

  it("group participants are created without counting as having messaged the bot", async () => {
    const r = await s.identity.ensureIdentity("imessage", BLAKE);
    expect(r.hasMessagedLine).toBe(false);
  });
});

describe("membership (spec 4.3 group activation, join/leave)", () => {
  it("a 1:1 chat is active at once; a group starts inactive until a verified member uses the agent", async () => {
    const dm = await s.membership.ensureConversation("imessage", AVERY, "dm");
    expect(dm.status).toBe("active");
    const g = await s.membership.ensureConversation("imessage", GROUP, "group");
    expect(g.status).toBe("inactive");
    const { userId } = (await s.identity.find("imessage", AVERY)) ?? { userId: null };
    expect(userId).toBeNull();
    await verify(AVERY);
    const avery = (await s.identity.find("imessage", AVERY))!;
    const active = await s.membership.activate(g.id, avery.userId!);
    expect(active).toMatchObject({ status: "active", activatedByUserId: avery.userId });
    expect((await s.membership.activate(g.id, avery.userId!)).activatedByUserId).toBe(avery.userId);
    expect(s.audit.events.filter((e) => e.action === "conversation.activated")).toHaveLength(1);
  });

  it("refuses to treat a group id as a 1:1 chat", async () => {
    await s.membership.ensureConversation("imessage", GROUP, "group");
    await expect(s.membership.ensureConversation("imessage", GROUP, "dm")).rejects.toBeInstanceOf(
      HarnessError,
    );
  });

  it("tracks joins, leaves and re-joins from the participant list", async () => {
    const g = await s.membership.ensureConversation("imessage", GROUP, "group");
    const first = await s.membership.syncParticipants(g.id, [AVERY, BLAKE, CASEY]);
    expect(first.joined).toHaveLength(3);
    expect(first.left).toEqual([]);
    const casey = (await s.identity.find("imessage", CASEY))!;

    const after = await s.membership.syncParticipants(g.id, [AVERY, BLAKE]);
    expect(after).toEqual({ joined: [], left: [casey.externalIdentityId] });
    expect(await s.membership.isActiveMember(g.id, casey.externalIdentityId)).toBe(false);
    expect((await s.membership.listActiveMembers(g.id)).map((m) => m.externalIdentityId)).not.toContain(
      casey.externalIdentityId,
    );

    const back = await s.membership.syncParticipants(g.id, [AVERY, BLAKE, CASEY]);
    expect(back.joined).toEqual([casey.externalIdentityId]);
    expect(await s.membership.isActiveMember(g.id, casey.externalIdentityId)).toBe(true);
  });

  it("a list naming only one person never removes everyone else (payload without participants)", async () => {
    const g = await s.membership.ensureConversation("imessage", GROUP, "group");
    await s.membership.syncParticipants(g.id, [AVERY, BLAKE, CASEY]);
    expect((await s.membership.syncParticipants(g.id, [AVERY])).left).toEqual([]);
    expect(await s.membership.listActiveMembers(g.id)).toHaveLength(3);
  });

  it("lists members with their verification status; only verified members expose a user id", async () => {
    const g = await s.membership.ensureConversation("imessage", GROUP, "group");
    await verify(AVERY, "Avery");
    await s.membership.syncParticipants(g.id, [AVERY, BLAKE]);
    const members = await s.membership.listActiveMembers(g.id);
    expect(members.map((m) => [m.status, m.userId !== null, m.displayName]).sort()).toEqual([
      ["unverified", false, null],
      ["verified", true, "Avery"],
    ]);
  });
});

describe("auth gate (default deny, spec 4.3)", () => {
  const conv = async () => s.membership.ensureConversation("imessage", AVERY, "dm");

  it("unverified: blocked, nudged only when they addressed the agent", async () => {
    const identity = await s.identity.resolveSender("imessage", AVERY);
    const conversation = await conv();
    expect(await s.authGate.check({ identity, conversation, addressed: true })).toEqual({
      kind: "block",
      reason: "unverified",
      nudge: true,
    });
    expect((await s.authGate.check({ identity, conversation, addressed: false })).kind).toBe("block");
    expect(await s.authGate.check({ identity, conversation, addressed: false })).toMatchObject({
      nudge: false,
    });
  });

  it("verified and active: allowed. Revoked or suspended: blocked, never nudged", async () => {
    await verify(AVERY);
    const conversation = await conv();
    let identity = await s.identity.resolveSender("imessage", AVERY);
    expect(await s.authGate.check({ identity, conversation, addressed: true })).toEqual({ kind: "allow" });

    await s.sql.query(`UPDATE core.users SET status = 'suspended' WHERE id = $1`, [identity.userId]);
    expect(await s.authGate.check({ identity, conversation, addressed: true })).toMatchObject({
      kind: "block",
      reason: "revoked",
      nudge: false,
    });

    await s.sql.query(`UPDATE core.users SET status = 'active' WHERE id = $1`, [identity.userId]);
    await s.identity.revokeUser(identity.userId!);
    identity = await s.identity.resolveSender("imessage", AVERY);
    expect(identity).toMatchObject({ status: "revoked", userId: null });
    expect(await s.authGate.check({ identity, conversation, addressed: true })).toEqual({
      kind: "block",
      reason: "revoked",
      nudge: false,
    });
  });
});

describe("nudges (spec 4.3 nudge rules)", () => {
  async function nudge(where: "group" | "dm" = "group") {
    const identity = await s.identity.resolveSender("imessage", BLAKE);
    const conversation =
      where === "group"
        ? await s.membership.ensureConversation("imessage", GROUP, "group")
        : await s.membership.ensureConversation("imessage", BLAKE, "dm");
    const msg = inbound({
      senderExternalId: BLAKE,
      providerConversationId: where === "group" ? GROUP : BLAKE,
      isGroup: where === "group",
      text: "@agent hi",
    });
    return s.nudges.maybeNudge({ identity, conversation, inbound: msg });
  }

  it("posts a short sign-up link in the group, as a reply to their message", async () => {
    expect(await nudge()).toEqual({ sent: true, channel: "group" });
    const [m] = s.messaging.sent;
    expect(m).toMatchObject({ kind: "group", to: GROUP });
    expect(m!.text).toMatch(
      /^Hi! I'm Campus Agent, an AI assistant in this chat\..*https:\/\/app\.test\/onboard\?t=[\w-]{40,}$/,
    );
    expect(m!.text).not.toContain(BLAKE);
  });

  it("is rate-limited per person per conversation (default 6 hours)", async () => {
    await nudge();
    expect(await nudge()).toEqual({ sent: false, reason: "rate_limited" });
    s.clock.advance(6 * HOUR + 1);
    expect((await nudge()).sent).toBe(true);
    expect(s.messaging.sent).toHaveLength(2);
    expect((await nudge("dm")).channel).toBe("dm"); // a different conversation has its own limit
  });

  it("stores only a hash of the link token", async () => {
    await nudge();
    const token = s.messaging.sent[0]!.text.split("t=")[1]!;
    const { rows } = await s.sql.query<{ token_hash: string }>(`SELECT token_hash FROM core.auth_challenges`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("never nudges verified people", async () => {
    await verify(BLAKE, "Blake");
    expect(await nudge()).toEqual({ sent: false, reason: "status_verified" });
  });
});

describe("verification: text a code to the bot (spec 4.3 steps 3–6)", () => {
  it("start: shows a code and the bot's address; nothing is verified yet", async () => {
    const r = await s.verification.start({ address: "(555) 000-1001", displayName: "Avery" });
    expect(r).toMatchObject({ address: AVERY, sendTo: BOT });
    expect(r.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(r.smsLink).toBe(`sms:${BOT}?&body=${r.code}`);
    expect((await s.identity.find("imessage", AVERY))!.status).toBe("unverified");
    await expect(s.verification.start({ address: "123" })).rejects.toMatchObject({ code: "invalid_phone" });
  });

  it("the code texted FROM that address verifies it, creates the user, confirms in the 1:1 chat", async () => {
    await verify(AVERY, "Avery");
    const r = (await s.identity.find("imessage", AVERY))!;
    expect(r).toMatchObject({ status: "verified", displayName: "Avery" });
    expect(r.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.messaging.sent.at(-1)).toMatchObject({ kind: "dm", to: AVERY });
    expect(s.messaging.sent.at(-1)!.text).toMatch(/^You're set, Avery!/);
    expect(s.audit.events.find((e) => e.action === "identity.verified")).toMatchObject({
      actorUserId: r.userId,
      detail: { newUser: true },
    });
  });

  it("from a nudge link: the group the nudge came from hears that they're verified", async () => {
    const identity = await s.identity.resolveSender("imessage", BLAKE);
    const conversation = await s.membership.ensureConversation("imessage", GROUP, "group");
    await s.nudges.maybeNudge({
      identity,
      conversation,
      inbound: inbound({ senderExternalId: BLAKE, providerConversationId: GROUP, isGroup: true }),
    });
    const token = s.messaging.sent[0]!.text.split("t=")[1]!;
    const start = await s.verification.start({ address: BLAKE, displayName: "Blake", challengeToken: token });
    await s.verification.tryCode(inbound({ senderExternalId: BLAKE, text: start.code.toLowerCase() }));
    expect(s.messaging.sent.map((m) => [m.kind, m.to])).toEqual([
      ["group", GROUP],
      ["dm", BLAKE],
      ["group", GROUP],
    ]);
    expect(s.messaging.sent.at(-1)!.text).toBe(
      "Thanks, Blake, you're verified. You can ask me things here now.",
    );
    const { rows } = await s.sql.query<{ used_at: unknown }>(`SELECT used_at FROM core.auth_challenges`);
    expect(rows[0]!.used_at).not.toBeNull();
  });

  it("a nudge token for someone else does not bind (the page never reveals whose it is)", async () => {
    const identity = await s.identity.resolveSender("imessage", BLAKE);
    const conversation = await s.membership.ensureConversation("imessage", GROUP, "group");
    await s.nudges.maybeNudge({
      identity,
      conversation,
      inbound: inbound({ senderExternalId: BLAKE, isGroup: true, providerConversationId: GROUP }),
    });
    const token = s.messaging.sent[0]!.text.split("t=")[1]!;
    await verify(CASEY, "Casey");
    const start = await s.verification.start({ address: AVERY, challengeToken: token });
    await s.verification.tryCode(inbound({ senderExternalId: AVERY, text: start.code }));
    expect(s.messaging.sent.filter((m) => m.kind === "group")).toHaveLength(1); // only the nudge itself
  });

  it("a code from a DIFFERENT address does not verify; the sender is told which address we saw", async () => {
    const start = await s.verification.start({ address: AVERY });
    expect(
      await s.verification.tryCode(inbound({ senderExternalId: "avery@example.com", text: start.code })),
    ).toBe(true);
    expect((await s.identity.find("imessage", AVERY))!.status).toBe("unverified");
    expect(s.messaging.sent.at(-1)).toMatchObject({ kind: "dm", to: "avery@example.com" });
    expect(s.messaging.sent.at(-1)!.text).toContain("came from avery@example.com");
    expect(s.messaging.sent.at(-1)!.text).not.toContain(AVERY);
  });

  it("codes in group chats, wrong codes and ordinary words are not consumed", async () => {
    const start = await s.verification.start({ address: AVERY });
    expect(
      await s.verification.tryCode(
        inbound({ isGroup: true, providerConversationId: GROUP, text: start.code }),
      ),
    ).toBe(false);
    expect(await s.verification.tryCode(inbound({ text: "THANKS" }))).toBe(false);
    expect(await s.verification.tryCode(inbound({ text: "what can you do?" }))).toBe(false);
    expect((await s.identity.find("imessage", AVERY))!.status).toBe("unverified");
  });

  it("expired codes do nothing, and only the newest code for an address works", async () => {
    const old = await s.verification.start({ address: AVERY });
    const fresh = await s.verification.start({ address: AVERY });
    expect(await s.verification.tryCode(inbound({ text: old.code }))).toBe(false);
    s.clock.advance(11 * 60_000);
    expect(await s.verification.tryCode(inbound({ text: fresh.code }))).toBe(false);
    expect(await s.verification.poll(fresh.verificationId, fresh.browserToken)).toEqual({
      status: "expired",
    });
    expect((await s.identity.find("imessage", AVERY))!.status).toBe("unverified");
  });

  it("a redelivered code message is still swallowed and verifies only once", async () => {
    const start = await verify(AVERY);
    const sent = s.messaging.sent.length;
    expect(await s.verification.tryCode(inbound({ text: start.code }))).toBe(true);
    expect(s.messaging.sent.length).toBe(sent);
    expect(s.audit.events.filter((e) => e.action === "identity.verified")).toHaveLength(1);
  });

  it("rate-limits attempts per address", async () => {
    for (let i = 0; i < 5; i++) await s.verification.start({ address: AVERY });
    await expect(s.verification.start({ address: AVERY })).rejects.toMatchObject({
      code: "verification_rate_limited",
    });
    s.clock.advance(HOUR + 1);
    await expect(s.verification.start({ address: AVERY })).resolves.toBeTruthy();
  });

  it("re-verifying a returning user signs them in to the same account", async () => {
    await verify(AVERY, "Avery");
    const userId = (await s.identity.find("imessage", AVERY))!.userId;
    await verify(AVERY, "Someone Else");
    expect((await s.identity.find("imessage", AVERY))!).toMatchObject({ userId, displayName: "Avery" });
  });
});

describe("web sessions: only the browser that started it, exactly once", () => {
  it("pending → approved with a session once; other browsers get nothing", async () => {
    const start = await s.verification.start({ address: AVERY, displayName: "Avery" });
    expect((await s.verification.poll(start.verificationId, start.browserToken)).status).toBe("pending");
    await expect(s.verification.poll(start.verificationId, "someone-elses-token")).rejects.toMatchObject({
      code: "verification_not_found",
    });
    await s.verification.tryCode(inbound({ text: start.code }));

    const first = await s.verification.poll(start.verificationId, start.browserToken);
    expect(first.status).toBe("approved");
    const token = first.status === "approved" ? first.session!.token : "";
    expect(await s.sessions.resolve(token)).toMatchObject({ displayName: "Avery" });
    const again = await s.verification.poll(start.verificationId, start.browserToken);
    expect(again).toMatchObject({ status: "approved", session: null });

    const { rows } = await s.sql.query(`SELECT * FROM core.web_sessions`);
    expect(JSON.stringify(rows)).not.toContain(token); // only the hash is stored
  });

  it("sessions end on sign-out, on expiry and when the user revokes verification", async () => {
    await verify(AVERY);
    const userId = (await s.identity.find("imessage", AVERY))!.userId!;
    const a = await s.sessions.create(userId, "test");
    const b = await s.sessions.create(userId, "test");
    await s.sessions.revoke(a.token);
    expect(await s.sessions.resolve(a.token)).toBeNull();
    expect(await s.sessions.resolve(b.token)).not.toBeNull();
    await s.identity.revokeUser(userId);
    expect(await s.sessions.resolve(b.token)).toBeNull(); // no verified identity left
    const c = await s.sessions.create(userId, "test");
    expect(await s.sessions.resolve(c.token)).toBeNull();
    expect(await s.sessions.resolve("garbage")).toBeNull();
    expect(await s.sessions.resolve(null)).toBeNull();
  });
});
