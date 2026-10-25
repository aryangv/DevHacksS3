<div align="center">

# 🎓 SYNQ

### Your group chat has 14 opinions, 3 dietary restrictions and 0 decisions.<br>We gave it a brain. And a conscience. And a spending cap.

**AI agents that live in your iMessage threads, quietly coordinate behind the scenes,<br>and actually get the group fed.**

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A522.12-339933?logo=node.js&logoColor=white)
![iMessage](https://img.shields.io/badge/lives%20in-iMessage-34C759?logo=apple&logoColor=white)
![Tests](https://img.shields.io/badge/tests-300%20passing-brightgreen)
![Built at](https://img.shields.io/badge/built%20at-DevHacks%20S3-ff69b4)

</div>

---

## 🍕 The problem

Every group chat, every Friday, around 7pm:

```
Avery:   where do we want to eat
Blake:   idk whatever's fine
Devon:   i'm down for anything
Casey:   not pizza
Blake:   ok so pizza?
Avery:   ...
         [47 messages later]
Devon:   i just made cereal
```

Somebody's secretly vegetarian. Somebody's broke but won't say it. Somebody "doesn't care" but very much
cares. Nobody wants to be the one fronting $60 and chasing Venmo requests for a week.

## ✨ The fix

**Every student gets a personal agent. Every group chat gets a group agent. They talk to each other so you
don't have to.**

```
Blake:   @agent dinner tonight? under $20 each
Agent:   Checked with everyone's agents 🤝
         Taco Bell (delivers in ~25 min) works for all 4 of you.
         ~$13 per person. 👍 this message to lock it in.
Avery:   👍
Agent:   Locked in. Picked items each of you will actually eat.
         Real total from Grubhub: $52.18 (tax, fees and tip included).
         Devon, you're paying, so I've sent you a private link to approve the exact amount.
         ...
Agent:   🌯 Order's on the way! Blake, Casey, Avery: you each owe Devon $13.05.
```

Notice what *didn't* happen: nobody announced Casey is vegetarian. Nobody said Avery's budget is $12. The
agents worked it out privately, and the group only saw the result.

## 🧠 How it works

<table>
<tr>
<td width="50%" valign="top">

### 🙋 Personal agent (your 1:1 chat)
Tell it once: *"I'm vegetarian, I hate cilantro, keep me under $15."*
It remembers (via [Supermemory](https://supermemory.ai)) and speaks up **for you** when the group plans.
It keeps your secrets and hands over only what's needed.

</td>
<td width="50%" valign="top">

### 👥 Group agent (your group chat)
Only talks when you **@mention** it, so it's not *that* friend.
It asks each member's personal agent *"does this work for you?"* and gets back a yes/no plus item picks.
Your diary stays with your agent.

</td>
</tr>
<tr>
<td valign="top">

### 🤝 Agent-to-agent, internally
Coordination happens on a private internal bus. Your private facts go into the decision and stay out of
the group thread, which only sees the result.

</td>
<td valign="top">

### 💸 Money with adult supervision
👍 confirms the **plan**. Only the payer can approve the **payment**, on a private page showing the
exact items, tax, fees and total. Money never moves because someone typed "yes lol".

</td>
</tr>
</table>

```
 iMessage ──► BlueBubbles ──► webhook ──► dedupe + queue ──► worker
                                                               │
                         identity + auth gate (unverified? no model, no memory)
                                                               │
                              ┌────────────────────────────────┴────────────┐
                        Personal agent                                Group agent
                              └──────────► internal coordination bus ◄──────┘
                                                               │
                              context broker (consent-checked memory)
                                                               │
                          tool gateway ──► approvals ──► Grubhub / Gmail / …
                                                               │
                                              reply in the original chat
```

## 🧰 Everything else it does

The dinner flow gets the spotlight, but a lot more is built underneath.

**📱 Signing up without passwords.** Text a 6-character code to the bot from your own number, and that's
it, you're verified. No app to install and no password to forget.

**🗂️ A dashboard for your agent** (`/me`):
- **Memory proof** (`/me/memory`): see exactly what your agent remembers about you. No mystery.
- **Settings** (`/me/settings`): turn memory off, set a retention period (e.g. forget after 30 days),
  approve or decline requests to share your info, and revoke any grant you've given.
- **Connections** (`/me/connections`): see which accounts your agent can use.
- **The nuclear option:** revoke your account and delete your memory in one click.

**🧠 Memory that behaves.**
- Your personal agent reads your own memory by default. Anything shared with a group or another agent
  needs your consent.
- The group agent remembers the group's own history. What's said in the group chat feeds group memory,
  batched about once a minute.
- Card numbers, codes and credentials are **redacted before anything is stored**. Your agent can't leak a
  secret it never kept.
- Background jobs enforce retention, so expired memories really do get deleted.

**✅ Two ways to approve.** Tap the link, or reply `YES 4821` in your 1:1 chat. Approval codes only work in
your own DM, never in the group.

**🔍 Receipts for everything.** Each turn is audited, and a trace API shows exactly what happened: what
was routed where, what the model proposed and which tools ran. Handy for debugging, and for proving the
bot didn't go rogue.

**🚦 Guardrails on cost too.** Per-turn budgets and rate limits keep a chatty group from burning through
the model bill, and a temporary model error gets one automatic retry.

**🔌 More connectors on deck.** A tool catalog with an encrypted credential vault, OAuth and per-tool
permissions is merged, with Gmail and Google Calendar (via Composio) and GitHub ready to plug in.

**🤖 Bring your own brain.** Runs on Claude or Gemini. Swap with one env var.

**🧪 Fakes all the way down.** Every module has an in-memory fake behind a feature flag, so the whole
system runs on a laptop with no Mac, no database and no API keys (`pnpm sim demo`).

## 🔒 The paranoid parts (we're proud of these)

The model is clever. We still don't trust it with anything important.

- **The LLM never picks who.** It can't choose the user, the conversation, the memory namespace, the
  credentials or the recipients. Those come from the pipeline, not from the prompt.
- **Strict JSON or bust.** Agent proposals are schema-validated. If the model sneaks in an extra
  `userId` field, the whole output is rejected.
- **No prompt-injected permission grants.** Permission changes count only when they come from your own
  DM, in your own words, before any tool output has been seen.
- **Spend tools are on a leash.** Approval is required, it's bound to the exact provider total (if the
  price changes, the order is refused), and there's a hard spending cap.
- **Default deny.** Unverified senders get a polite sign-up nudge, with no model call and no memory.
- **The vault is walled off.** The app's database role literally cannot read `vault.*`.
- **Idempotent everything.** Retries don't double-order your burritos.
- **Honesty rule.** Simulated or test transactions are always labelled as simulated. The bot only says
  "ordered" once the provider hands back a real order ID.

## 📊 Status: the honest version

It's a hackathon project, so here's exactly where things stand:

| Thing | Status |
|---|---|
| Turn pipeline, personal + group agents, coordination bus | ✅ Working, heavily tested |
| Memory with consent + forgetting (Supermemory v5) | ✅ Working |
| iMessage via BlueBubbles, sign-up by texted code, 👍 tapback confirms | ✅ Built · 🧪 tested in our web iMessage simulator; real-Mac run pending |
| Grubhub: search, menus, **real priced carts** with tax/fees/tip | ✅ Verified live |
| Grubhub: actually placing the order | ⛔ **Fails closed.** Checkout isn't verified yet, so nothing is charged and the group is told so |
| Payer approval page, delivery tracking, split reminders | ✅ Built |
| Web dashboard: memory proof, settings, consent grants, revoke | ✅ Built |
| Tool catalog, vault, OAuth, Composio (Gmail, Google Calendar), GitHub | 🔌 Merged, not yet wired into the pipeline |

> **About Grubhub:** this uses the unofficial [`grubhub-mcp`](https://github.com/aserper/grubhub-mcp)
> server, which talks to Grubhub's private app API. It is **not** an official integration and may break
> (or get an account blocked) at any time. Use a throwaway demo account. The order pipeline is
> provider-agnostic, so an official provider (hi, DoorDash 👋) can plug in by implementing three tools.

## 🚀 Quick start

You need Node ≥ 22.12 and pnpm 9 (`npx pnpm@9.12.3 …` works if pnpm isn't installed).

```bash
pnpm install
pnpm sim demo     # the whole dinner flow end to end, on fakes, with an audit trace
pnpm sim repl     # play god: "dm avery hi", "group blake @agent dinner under $20", "verify devon"
pnpm check        # lint + format + typecheck + all the tests
```

**Use a real model:** copy `.env.example` → `.env`, then set `USE_REAL_MODEL=true`,
`MODEL_PROVIDER=anthropic` (or `gemini`) and `MODEL_API_KEY=…`.

**Database:** no Docker? Run Postgres in WASM:

```bash
DATABASE_URL=pglite://./.data/pglite pnpm db:migrate
```

With Docker: `docker compose up -d && pnpm db:migrate`.

**Run the services:**

```bash
pnpm dev:api      # Fastify API: webhooks, approvals, web pages, trace API
pnpm dev:worker   # the queue worker (or use RUNTIME_STORE=memory to run it in-process)
```

No Mac handy for BlueBubbles? Turn on `DEV_SIMULATOR` and open `/dev/chat` for a fake iMessage UI with
working 👍 buttons. Everything except the Mac is real.

## 🗺️ What's in the box

| Package | What it does |
|---|---|
| `packages/harness` | Turn pipeline, router, agent runtime, budgets, rate limits, model clients (Claude / Gemini) |
| `packages/agents` | Personal + group agents, coordination bus, order tracking |
| `packages/messaging` | BlueBubbles iMessage adapter (incl. tapbacks) |
| `packages/identity` | Sign-up by texted code, membership, auth gate, nudges |
| `packages/context` | Supermemory memory layer, consent broker, forgetting |
| `packages/grubhub` | Interim Grubhub dining connector |
| `packages/tools` · `approvals` · `workflows` | Tool catalog, gateway, permissions, vault, OAuth, approvals |
| `packages/contracts` | Zod schemas and interfaces for every module, plus in-memory fakes |
| `packages/db` | Migrations, schema, Postgres repos |
| `apps/api` · `apps/worker` · `apps/web` | HTTP server, queue worker + simulator, web pages |

**Tech:** TypeScript · Node 22 · Fastify · Zod · Postgres / PGlite · Supermemory · BlueBubbles ·
Claude / Gemini · Composio · Vitest

## 📚 Go deeper

- [**Development guide**](docs/DEVELOPMENT.md): feature flags, swapping fakes for real modules, team rules
- [**ARCHITECTURE.md**](ARCHITECTURE.md): the big-picture design and the 24-hour build plan
- [**harness-spec.md**](harness-spec.md): the full build spec (bring snacks, it's long)
- [**Grubhub connector**](packages/grubhub/README.md): setup and what's verified

## ❓ FAQ

**Will it order food without asking me?**
No. The group 👍s a plan, then the payer approves the exact total privately. No approval, no order.

**Can the group agent read my private chats?**
No. It asks your personal agent, which answers with what's needed ("works for them, here's what they'd
order") and nothing else.

**Can someone prompt-inject it into buying 400 tacos?**
They can try. Spend tools need the payer's approval of the exact total, under a spending cap, and
permission changes made from inside a group chat don't count.

**Is the Grubhub integration official?**
Lol, no. See the warning above. We're upfront about that.

**Why iMessage?**
Because that's where the group chat already is. Nobody's downloading a new app to decide on tacos.

---

<div align="center">

Built in ~24 hours at **DevHacks S3** by four people, several agents and a frankly irresponsible amount of caffeine. ☕

*No burritos were harmed in the making of this README. Several were quoted.*

</div>
