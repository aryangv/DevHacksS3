# apps/web — owner: P2 (front door)

Server-rendered pages, mounted on the API server (one public URL for webhooks and pages):

| Page | What it does |
|---|---|
| `/onboard` | Sign up / sign in. The person enters their iMessage number (or Apple ID email), gets a 6-character code, and texts it to the bot **from that address**. The inbound webhook matches it; the page then signs them in. |
| `/me` | Verified addresses, group chats, sign out, revoke verification (optionally delete their memory). |
| `/me/memory` | What the assistant has learnt (their Supermemory profile, their groups' memory) and recent memory activity — the "memories are learnt and used" proof. |
| `/me/connections` | Connected tool accounts (P4's `ConnectionService`; built-in demo tools until P4 lands). |
| `/me/settings` | Memory on/off + retention, consent requests and grants (P3's consent service). |
| `/approve/:id` | Approval page shell. The approval logic (quote binding, one-time tokens) is P4's. |

Security: sessions only after a server-confirmed verification; cookies `HttpOnly`, `SameSite=Lax`
(`Secure` on https); state-changing calls are JSON POSTs that must carry our `Origin`; strict CSP with a
per-response script nonce; `no-referrer` (nudge links carry a token). No API key ever reaches the browser.

## Running everything without a Mac (dev simulator)

`/dev/chat` is a web page that acts like iMessage: pretend people, their 1:1 chats with the bot, and
group chats. A message typed there is posted (BlueBubbles-shaped) to the real `/webhooks/bluebubbles`
route; the bot's replies go out through the real BlueBubbles adapter to a fake BlueBubbles Server at
`/dev/bluebubbles`. Identity, sign-up, memory, the AI and tools are all real. Dev only: refused when
`NODE_ENV=production`, and the page only answers to requests made directly on `localhost`.

Add to `.env` (on top of your model / Supermemory keys), then `pnpm db:migrate` and `pnpm dev:api`:

```
RUNTIME_STORE=postgres
DATABASE_URL=pglite://./.data/pglite
RUN_WORKER_IN_PROCESS=true
USE_REAL_MESSAGING=true
USE_REAL_IDENTITY=true
USE_REAL_MEMORY=true
DEV_SIMULATOR=true
BLUEBUBBLES_URL=http://localhost:3000/dev/bluebubbles
BLUEBUBBLES_PASSWORD=sim-pw
BLUEBUBBLES_WEBHOOK_SECRET=any-long-random-string
BLUEBUBBLES_BOT_ADDRESS=+15555550100
APP_ORIGIN=http://localhost:3000
```

Open http://localhost:3000/dev/chat, pick a person, text the bot, follow the sign-up link it sends
(same browser), and send the code back as that person. "Run it now" runs the group-memory job
instead of waiting a minute.

Gemini's free tier allows only a handful of requests per minute (and ~20/day on some models): pick a
model with headroom via `MODEL_NAME` (e.g. `gemini-3.5-flash`). A temporary provider error is retried
once; after that the bot apologizes rather than guessing.

## Running v1 on real iMessage

The transport is **BlueBubbles**: a BlueBubbles Server on a Mac signed into the bot's Apple ID relays
iMessages to this API over webhooks, and sends our replies through Messages.app.

1. **Mac:** install BlueBubbles Server, sign Messages into the bot's Apple ID, set a server password,
   and turn on its built-in proxy (ngrok or Cloudflare). Its URL is `BLUEBUBBLES_URL`.
2. **This machine — `.env`:**

   ```
   RUNTIME_STORE=postgres
   DATABASE_URL=pglite://./.data/pglite      # or a real Postgres URL
   RUN_WORKER_IN_PROCESS=true                # PGlite can't be shared by two processes

   USE_REAL_MESSAGING=true
   USE_REAL_IDENTITY=true
   BLUEBUBBLES_URL=https://<bluebubbles-proxy-url>
   BLUEBUBBLES_PASSWORD=<server password>
   BLUEBUBBLES_WEBHOOK_SECRET=<long random string>
   BLUEBUBBLES_BOT_ADDRESS=+1XXXXXXXXXX      # the bot's iMessage number or Apple ID email
   APP_ORIGIN=https://<this-server's-public-url>

   USE_REAL_MEMORY=true
   SUPERMEMORY_API_KEY=...

   USE_REAL_MODEL=true                       # otherwise a keyword-matching fake answers
   MODEL_PROVIDER=anthropic                  # or gemini
   MODEL_API_KEY=...
   ```

3. `pnpm db:migrate`, then `pnpm dev:api`, then `ngrok http 3000` and put the ngrok URL in `APP_ORIGIN`
   (restart the API).
4. **BlueBubbles → Settings → API & Webhooks:** add a webhook for **New Messages** with URL
   `https://<APP_ORIGIN host>/webhooks/bluebubbles?token=<BLUEBUBBLES_WEBHOOK_SECRET>`.
   BlueBubbles does not sign webhooks; the token in the URL is what authenticates them.
5. Text the bot from your phone. You get a sign-up link; follow it, text the code, and you're in.
   Add the bot to a group chat and mention it ("@agent …" or any name in `AGENT_INVOCATION_NAMES`).

What to expect:
- **Unverified people** are never answered by the model. When they address the bot they get a sign-up
  link (at most once per chat every `NUDGE_INTERVAL_HOURS`). Their 1:1 texts are not kept.
- **Personal memory:** what a verified person tells the bot 1:1 goes to their own Supermemory namespace
  (preferences and facts), and their personal agent uses it by default.
- **Group memory:** everything said in a group the bot is in (by anyone) is batched into the group's
  namespace every `MEMORY_GROUP_INGEST_INTERVAL_MS` (60 s). Secrets are redacted; phone numbers are
  never written to memory; a verified member who turns memory off is left out.
- Supermemory takes roughly a minute to turn new text into searchable memories; `/me/memory` shows them
  once processed.

Known limits (BlueBubbles):
- `apple-script` sends can't reply in-thread or show typing; `private-api` needs the BlueBubbles
  Private API helper (SIP changes on the Mac). Inline replies are off by default.
- If iMessage on someone's phone sends from their email instead of their number, the bot sees the email.
  The sign-up page accepts either; if the code arrives from a different address than they typed, the
  bot tells them which address it saw.
- BlueBubbles doesn't retry failed webhooks, so a message that arrives while this server is down is missed.
- Leaving a group is detected from the participant list on the next message (not from the
  participant-left event yet); a 2-person-plus-bot group can't detect a leave this way.
