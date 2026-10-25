// Dev-only web chat simulator (DEV_SIMULATOR=true; refused in production). Owner: P2.
//
// Lets the whole front door run without a Mac, and is the "web simulator" fallback spec 7 asks P2
// to keep for when real iMessage group access is unavailable:
//
//   /dev/chat          a chat page: pretend people, their 1:1 chats with the bot, group chats
//   /dev/bluebubbles/* a fake BlueBubbles Server (the v1 endpoints our adapter calls)
//
// Point BLUEBUBBLES_URL at <API origin>/dev/bluebubbles and everything else is the real thing:
// a message typed on the page is posted, BlueBubbles-shaped, to the real /webhooks/bluebubbles
// route (with the real secret), then flows through the real adapter, identity, auth gate, pipeline,
// memory and model; the bot's replies go out through the real adapter + HTTP client and land back
// here. Sign-up works too: open the link the bot sends, then send the code as that person.
//
// The page and its JSON endpoints answer only to requests made directly on localhost (never through
// a tunnel); the fake BlueBubbles endpoints require BLUEBUBBLES_PASSWORD like the real server.
import { randomUUID } from "node:crypto";
import type { Container } from "@campus/worker";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { csp, html, newNonce, page } from "./html";

type SimChat = { guid: string; isGroup: boolean; name: string; members: string[] };
type SimMessage = { id: string; chatGuid: string; from: string; text: string; at: number };
type Person = { name: string; address: string };

const BOT = "bot";
const E164 = /^\+[1-9]\d{7,14}$/;

class SimState {
  seq = 0;
  /** Unique per server run: message and group ids must never repeat across restarts (the app dedupes on them). */
  readonly run = randomUUID().slice(0, 8);
  readonly chats = new Map<string, SimChat>();
  readonly messages: SimMessage[] = [];
  readonly people: Person[] = [
    { name: "Avery", address: "+15555550101" },
    { name: "Blake", address: "+15555550102" },
    { name: "Casey", address: "+15555550103" },
    { name: "Devon", address: "+15555550104" },
  ];

  dm(address: string): SimChat {
    const guid = `iMessage;-;${address}`;
    let chat = this.chats.get(guid);
    if (!chat) {
      chat = { guid, isGroup: false, name: `1:1 ${this.nameOf(address)}`, members: [address] };
      this.chats.set(guid, chat);
    }
    return chat;
  }

  nameOf(address: string): string {
    return this.people.find((p) => p.address === address)?.name ?? address;
  }

  add(chatGuid: string, from: string, text: string): SimMessage {
    const m = { id: `sim-${this.run}-${++this.seq}`, chatGuid, from, text, at: Date.now() };
    this.messages.push(m);
    if (this.messages.length > 2000) this.messages.splice(0, this.messages.length - 2000);
    return m;
  }
}

const states = new WeakMap<Container, SimState>();
const stateOf = (c: Container) => {
  let s = states.get(c);
  if (!s) states.set(c, (s = new SimState()));
  return s;
};

/** Only requests made directly on this machine (no tunnel/proxy in between). */
function localOnly(req: FastifyRequest): boolean {
  const host = (req.headers.host ?? "").split(":")[0];
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
  return loopback && (host === "localhost" || host === "127.0.0.1") && !req.headers["x-forwarded-for"];
}

export async function registerDevSimulator(app: FastifyInstance, c: Container): Promise<void> {
  if (!c.config.DEV_SIMULATOR || c.config.NODE_ENV === "production") return;
  const s = stateOf(c);
  c.logger.warn("DEV_SIMULATOR is on: /dev/chat and a fake BlueBubbles at /dev/bluebubbles");

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!localOnly(req)) return reply.code(404).send({ error: "not found" });
  };
  const bbAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const pw = (req.query as Record<string, unknown>).password;
    if (!c.config.BLUEBUBBLES_PASSWORD || pw !== c.config.BLUEBUBBLES_PASSWORD)
      return reply.code(401).send({ status: 401, message: "Unauthorized", error: { type: "Unauthorized" } });
  };

  // ---- fake BlueBubbles Server (what BlueBubblesAdapter calls) -----------------------------------
  app.post<{ Body: { chatGuid?: string; message?: string } }>(
    "/dev/bluebubbles/api/v1/message/text",
    { preHandler: bbAuth },
    async (req) => {
      const guid = String(req.body?.chatGuid ?? "");
      if (!s.chats.has(guid) && guid.includes(";-;")) s.dm(guid.split(";-;")[1]!);
      const m = s.add(guid, BOT, String(req.body?.message ?? ""));
      return { status: 200, message: "Message sent!", data: { guid: m.id } };
    },
  );

  app.post<{ Body: { addresses?: string[]; message?: string } }>(
    "/dev/bluebubbles/api/v1/chat/new",
    { preHandler: bbAuth },
    async (req, reply) => {
      const address = req.body?.addresses?.[0];
      if (!address) return reply.code(400).send({ status: 400, error: { type: "Bad Request" } });
      const chat = s.dm(address);
      const m = s.add(chat.guid, BOT, String(req.body?.message ?? ""));
      return { status: 200, data: { guid: chat.guid, messages: [{ guid: m.id }] } };
    },
  );

  app.get<{ Params: { guid: string } }>(
    "/dev/bluebubbles/api/v1/chat/:guid",
    { preHandler: bbAuth },
    async (req, reply) => {
      const chat = s.chats.get(req.params.guid);
      if (!chat) return reply.code(404).send({ status: 404, error: { type: "Not Found" } });
      return {
        status: 200,
        data: { guid: chat.guid, participants: chat.members.map((address) => ({ address })) },
      };
    },
  );

  // ---- simulator page + JSON ----------------------------------------------------------------------
  app.get("/dev/chat/state", { preHandler: guard }, async () => ({
    bot: { address: c.config.BLUEBUBBLES_BOT_ADDRESS ?? "", name: c.config.AGENT_DISPLAY_NAME },
    people: s.people,
    chats: [...s.chats.values()],
    messages: s.messages,
    wiring: c.wiring,
  }));

  app.post<{ Body: { name?: string; address?: string } }>(
    "/dev/chat/person",
    { preHandler: guard },
    async (req, reply) => {
      const name = String(req.body?.name ?? "")
        .trim()
        .slice(0, 30);
      const address = String(req.body?.address ?? "").trim();
      if (!name || !E164.test(address))
        return reply.code(400).send({ error: "name and +E.164 number needed" });
      if (!s.people.some((p) => p.address === address)) s.people.push({ name, address });
      return { ok: true };
    },
  );

  app.post<{ Body: { name?: string; members?: string[] } }>(
    "/dev/chat/group",
    { preHandler: guard },
    async (req, reply) => {
      const members = [...new Set((req.body?.members ?? []).filter((m) => E164.test(m)))];
      if (members.length < 2) return reply.code(400).send({ error: "pick at least two people" });
      const guid = `iMessage;+;sim-group-${s.run}-${++s.seq}`;
      const name =
        String(req.body?.name ?? "")
          .trim()
          .slice(0, 40) || "Group chat";
      s.chats.set(guid, { guid, isGroup: true, name, members });
      return { guid };
    },
  );

  app.post<{ Body: { from?: string; chatGuid?: string | null; text?: string } }>(
    "/dev/chat/send",
    { preHandler: guard },
    async (req, reply) => {
      const from = String(req.body?.from ?? "");
      const text = String(req.body?.text ?? "").slice(0, 4000);
      if (!E164.test(from) || !text.trim())
        return reply.code(400).send({ error: "pick a person and type a message" });
      const chat = req.body?.chatGuid ? s.chats.get(req.body.chatGuid) : s.dm(from);
      if (!chat) return reply.code(404).send({ error: "unknown chat" });
      if (chat.isGroup && !chat.members.includes(from))
        return reply.code(400).send({ error: "not in that group" });
      const m = s.add(chat.guid, from, text);
      return deliver(chat, from, m, text, null);
    },
  );

  // A tapback, exactly as BlueBubbles reports one: associatedMessageType "like", the target's guid.
  app.post<{ Body: { from?: string; messageId?: string } }>(
    "/dev/chat/react",
    { preHandler: guard },
    async (req, reply) => {
      const from = String(req.body?.from ?? "");
      const target = s.messages.find((m) => m.id === req.body?.messageId);
      const chat = target ? s.chats.get(target.chatGuid) : undefined;
      if (!E164.test(from) || !target || !chat) return reply.code(404).send({ error: "unknown message" });
      if (!chat.members.includes(from)) return reply.code(400).send({ error: "not in that chat" });
      const m = s.add(
        chat.guid,
        from,
        `👍 to "${target.text.slice(0, 40)}${target.text.length > 40 ? "…" : ""}"`,
      );
      return deliver(chat, from, m, `Liked “${target.text.slice(0, 60)}”`, {
        type: "like",
        target: target.id,
      });
    },
  );

  /** Post to the real webhook exactly what a BlueBubbles Server posts for an incoming iMessage. */
  async function deliver(
    chat: SimChat,
    from: string,
    m: SimMessage,
    text: string,
    reaction: { type: string; target: string } | null,
  ) {
    const event = {
      type: "new-message",
      data: {
        guid: m.id,
        text,
        isFromMe: false,
        itemType: 0,
        associatedMessageType: reaction ? reaction.type : null,
        ...(reaction ? { associatedMessageGuid: `p:0/${reaction.target}` } : {}),
        dateCreated: m.at,
        handle: { address: from, service: "iMessage" },
        chats: [
          {
            guid: chat.guid,
            style: chat.isGroup ? 43 : 45,
            displayName: chat.isGroup ? chat.name : null,
            participants: chat.isGroup ? chat.members.map((address) => ({ address })) : [],
          },
        ],
      },
    };
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/bluebubbles?token=${encodeURIComponent(c.config.BLUEBUBBLES_WEBHOOK_SECRET ?? "")}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(event),
    });
    return { webhook: res.statusCode, result: res.json() as unknown };
  }

  app.post("/dev/chat/ingest", { preHandler: guard }, async () => {
    if (!c.maintenance) return { ran: false, reason: "real memory is off (USE_REAL_MEMORY=false)" };
    await c.maintenance.runAll();
    return { ran: true };
  });

  app.get("/dev/chat", { preHandler: guard }, async (_req, reply) => {
    const nonce = newNonce();
    const body = html` <h1>iMessage simulator <span class="pill status-warn">dev only</span></h1>
      <p class="small muted">
        Messages go through the real webhook, identity, memory and AI. Only the Mac is pretend.
      </p>
      <div class="card">
        <label for="who">You are</label>
        <select id="who"></select>
        <details>
          <summary class="small">Add a person</summary>
          <input id="pname" type="text" placeholder="Name" />
          <input id="paddr" type="tel" placeholder="+15555550105" />
          <button class="secondary" id="padd">Add</button>
        </details>
        <label>Chat</label>
        <div id="chats"></div>
        <details>
          <summary class="small">New group chat</summary>
          <input id="gname" type="text" placeholder="Group name" />
          <div id="gmembers"></div>
          <button class="secondary" id="gadd">Create group</button>
        </details>
      </div>
      <div class="card">
        <h2 id="title">Chat</h2>
        <div id="thread" style="max-height:55vh;overflow:auto"></div>
        <form id="composer">
          <input id="text" type="text" autocomplete="off" placeholder="Message" />
          <button type="submit">Send</button>
        </form>
        <p class="small status-bad" id="err"></p>
      </div>
      <div class="card">
        <p class="small muted">
          Group chat memory is batched every minute. <button class="secondary" id="ingest">Run it now</button>
          <span id="ingestResult" class="small"></span>
        </p>
        <p class="small muted" id="wiring"></p>
      </div>`;
    const script = `
let state = null, chat = null;
const $ = (id) => document.getElementById(id);
const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));
const who = () => $("who").value;
function el(tag, attrs, text) { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (text !== undefined) e.textContent = text; return e; }
function linkify(parent, text) {
  for (const part of text.split(/(https?:\\/\\/[^\\s]+)/g)) {
    if (/^https?:\\/\\//.test(part)) parent.append(el("a", { href: part, target: "_blank", rel: "noopener" }, part));
    else parent.append(document.createTextNode(part));
  }
}
function nameOf(addr) { if (addr === "bot") return state.bot.name; const p = state.people.find(p => p.address === addr); return p ? p.name : addr; }
function render() {
  const sel = $("who"), cur = sel.value;
  sel.replaceChildren(...state.people.map(p => el("option", { value: p.address, selected: p.address === cur }, p.name + " (" + p.address + ")")));
  const mine = [{ guid: null, name: "1:1 with " + state.bot.name }].concat(state.chats.filter(c => c.isGroup && c.members.includes(who())));
  $("chats").replaceChildren(...mine.map(c => { const b = el("button", { className: (c.guid === chat ? "" : "secondary") }, c.name); b.style.marginRight = "8px"; b.onclick = () => { chat = c.guid; render(); }; return b; }));
  $("gmembers").replaceChildren(...state.people.map(p => { const l = el("label", { className: "small" }); const cb = el("input", { type: "checkbox", value: p.address }); l.append(cb, " " + p.name); return l; }));
  const guid = chat || ("iMessage;-;" + who());
  const c = state.chats.find(x => x.guid === guid);
  $("title").textContent = c && c.isGroup ? c.name + " (" + c.members.map(nameOf).join(", ") + ")" : "1:1: " + nameOf(who()) + " and " + state.bot.name;
  const t = $("thread"), atBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 20;
  t.replaceChildren(...state.messages.filter(m => m.chatGuid === guid).map(m => {
    const row = el("div", { className: "card" }); row.style.margin = "6px 0"; row.style.padding = "8px 12px";
    if (m.from === "bot") row.style.borderColor = "var(--accent)";
    row.append(el("div", { className: "small muted" }, nameOf(m.from)));
    const body = el("div"); linkify(body, m.text); row.append(body);
    if (m.from === "bot") { const like = el("button", { className: "secondary", title: "Tapback 👍 as " + nameOf(who()) }, "👍");
      like.style.marginTop = "6px"; like.style.padding = "2px 10px";
      like.onclick = async () => { const r = await post("/dev/chat/react", { from: who(), messageId: m.id }); if (!r.ok) $("err").textContent = r.data.error || "failed"; refresh(); };
      row.append(like); }
    return row;
  }));
  if (atBottom) t.scrollTop = t.scrollHeight;
  $("wiring").textContent = "Wiring: " + Object.entries(state.wiring).map(([k, v]) => k + "=" + v).join(", ");
}
async function refresh() { state = await fetch("/dev/chat/state").then(r => r.json()); if (chat && !state.chats.some(c => c.guid === chat && c.members.includes(who()))) chat = null; render(); }
$("who").onchange = () => { chat = null; render(); };
$("composer").onsubmit = async (e) => { e.preventDefault(); $("err").textContent = ""; const text = $("text").value; if (!text.trim()) return;
  const r = await post("/dev/chat/send", { from: who(), chatGuid: chat, text }); if (!r.ok) $("err").textContent = r.data.error || "failed"; else $("text").value = ""; refresh(); };
$("padd").onclick = async () => { const r = await post("/dev/chat/person", { name: $("pname").value, address: $("paddr").value }); if (!r.ok) $("err").textContent = r.data.error; refresh(); };
$("gadd").onclick = async () => { const members = [...$("gmembers").querySelectorAll("input:checked")].map(i => i.value);
  const r = await post("/dev/chat/group", { name: $("gname").value, members }); if (!r.ok) { $("err").textContent = r.data.error; return; } chat = r.data.guid; refresh(); };
$("ingest").onclick = async () => { $("ingestResult").textContent = "running..."; const r = await post("/dev/chat/ingest"); $("ingestResult").textContent = r.data.ran ? "done" : (r.data.reason || "failed"); };
refresh(); setInterval(refresh, 1500);`;
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", csp(nonce))
      .header("cache-control", "no-store")
      .send(page({ title: "iMessage simulator", nonce, body, script }));
  });
}
