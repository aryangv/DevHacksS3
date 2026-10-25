# Handoff: P2 front door + real group ordering (2026-10-25)

For the next coding agent picking this up. Read this, then `harness-spec.md` (the original spec) and
`ARCHITECTURE.md`. Several **team decisions override the spec**; they're listed below.

## Where things are

- Branch **`feat/front-door`**, pushed, **PR #3** open against `main` (not merged; don't merge until a
  live iMessage test passes). Main has P1 + P3 only.
- 4 commits on the branch: `cc2a371` (P2 core), `40426a3` (web simulator, model retry), `22a82d1`
  (👍 confirm, item-level group order), `774aeee` (Grubhub connector, payer approval, tracking).
- `pnpm check` is green: lint, format, typecheck, **228 tests** (1 skipped). CI on the PR passed for
  earlier commits (`check` + `migrate-postgres`).
- P4 (tools/approvals/vault, owner MonishC05) is on branch **`p4`**, stage 1, **not merged**, not wired.
  It uses its own local types (not `@campus/contracts`), exports no `createToolsModule` /
  `createApprovalsModule`, and its migrations use 12-digit timestamps (our runner needs 14).
- The user owns P2 and P3. P1 is Tarun (`@tarunchottera204`). Small P1 edits were allowed **if
  flagged** in the PR (they're listed in PR #3's description/comment).

## The demo the team wants (target)

In an iMessage **group chat**: people have told their personal agents their preferences over 1:1
chats; they ask questions answered by connectors (tool calls); then the bot assembles a **real** group
food order from what everyone likes (e.g. Taco Bell), one person pays, the bot tracks the split, and
the wow moment is the order actually being placed and showing "on the way" in a delivery app.
The user wants **as few external links as possible**: confirmations by 👍 tapback in chat.

## Team decisions that differ from the spec (also saved in agent memory)

1. **iMessage via BlueBubbles** (a Mac running BlueBubbles Server), not Sendblue. So no Sendblue
   Verify: sign-up is a self-built inverted OTP (person texts a 6-char code to the bot from their
   address; matched on the inbound webhook). BlueBubbles webhooks are unsigned → the registered URL
   carries `?token=<BLUEBUBBLES_WEBHOOK_SECRET>`.
2. **Personal agent reads its own user's Supermemory by default** (no consent grant). Sharing with
   groups/other agents still needs consent. (P3 broker change.)
3. **Group chats feed group memory with everything said** (verified or not), batched every ~60 s
   (`GroupChatIngestor`). Spec 5.3 "never ingest unverified" now applies to 1:1 chats only.
4. **Unofficial Grubhub** accepted by the user for real ordering (see the blocker below).
5. **👍 tapback** confirms a group plan (only a verified member's 👍 on exactly the proposal message).

## What's built (by area)

**P2 — messaging/identity/web** (`packages/messaging`, `packages/identity`, `apps/web`,
`apps/api/src/routes/webhooks.ts`, `packages/db/migrations/p2/`):
- `BlueBubblesAdapter`: webhook token auth, normalizes `new-message` (ignores own sends/group events),
  **tapbacks → `InboundMessage.reaction`** (`like`/`-like`, `p:0/<guid>` target), participant lookup,
  throttled sends, `chat/new` for first 1:1. Shapes checked against the BlueBubbles server source.
- Postgres `IdentityService`, `MembershipService` (joins/leaves/rejoins; ignores 1-name lists),
  default-deny `AuthGate`, rate-limited `NudgeService` (hashed single-use link tokens),
  `VerificationService` (code flow; browser-bound one-time session claim; address-mismatch notice;
  replay-safe), `WebSessionService`, revoke.
- Web pages served by the API: `/onboard`, `/me`, `/me/memory` (memory proof), `/me/connections`,
  `/me/settings`, **`/approve/:id`** (payer sees items/tax/fees/exact total, one tap → place).
  CSP nonce, Origin checks, HttpOnly cookies, no-referrer, return-after-login.
- **Dev web iMessage simulator** `/dev/chat` + fake BlueBubbles at `/dev/bluebubbles` (`DEV_SIMULATOR`,
  refused in production, localhost-only). Everything except the Mac is real, incl. 👍 buttons.

**P3 — memory** (`packages/context`): default self-read in `broker.ts`; `GroupChatIngestor`
(`group-chat.ts`, p3 migration `group_memory_ingested`); group buckets v2.

**P1 (flagged edits)** (`packages/harness`, `packages/agents`, `apps/worker`, `packages/contracts`):
- Pipeline keeps group message text for unverified senders; routes group reactions to the group
  agent (no activation, no nudge); `TurnIO.reply` returns the message id.
- One retry for transient model errors (`structured.ts`).
- Group agent: proposal sent via `io.reply` and its message id stored; 👍 on it confirms.
  On confirm: `dining__get_menu` → personal agents `choose_items` (private: dietary tags, own budget,
  group budget, favorites from own memory; returns item ids only) → order lines + split →
  **`dining__quote_order`** (real total) → **`dining__submit_order`** proposed through the gateway
  (spend → payer gets approval link) → status `awaiting_payment`. Never asks anyone to pay without an
  exact provider total. Falls back to the old handoff with test data.
- `OrderService` (`agents/src/orders.ts`): `approveAndPlace` (web approval → `gateway.executeApproved`
  → "Order placed …" in the group), `trackOrders` job every 30 s (preparing / on the way / delivered +
  split reminder). Unknown outcome → `needs_reconciliation`.
- Container: `DINING_PROVIDER=grubhub` wires the Grubhub connector into the dining tools; `c.orders`;
  maintenance scheduler runs memory jobs + `orders.track`. Test override `diningCaller`.

**Grubhub connector** (`packages/grubhub`, see its README): runs the unofficial `grubhub-mcp` 1.1.7
(Python, via `uvx`) over stdio. Maps search/menu/quote/submit/status. Menu uses `get_restaurant`
(~0.5 MB) not `get_menu` (~70 MB for Taco Bell → timeouts). UTF-8 env for the Python process.

## The blocker: Grubhub cannot place orders through grubhub-mcp

Verified live 2026-10-25 against `api-gtm.grubhub.com` (Grubhub's private app API):
- ✅ anonymous search near ASU (Taco Bell id `926742`), menus, item option groups.
- ❌ **Password login → 403** for two different accounts (Grubhub blocks this client's password login).
  ✅ **Email one-time-code login works** — done once for the demo account; session is in
  `.data/grubhub` (gitignored; renews ~30 days). **Do not ask for or store passwords.** Two passwords
  were pasted into the chat by the user — tell them to rotate them.
- ❌ **`create_cart` creates an EMPTY cart** (Grubhub ignores its line item; it even accepts fake ids),
  and **`add_to_cart` → 404** (`POST /carts/{id}/line_items`), signed in or not.
- ❌ No tool to set the cart's delivery address; carts report no charges/total.
- The demo account has **0 saved addresses and 0 payment methods** (the user must add both in the app).

Options presented to the user (they hadn't chosen yet):
1. Build our own Grubhub web-API client from a HAR of one real grubhub.com checkout (unofficial,
   fragile, checkout may have anti-bot/payment-tokenization steps). Same risk category the user
   accepted, but deeper.
2. Apply to **DoorDash developer access** (official; "agents for personal use" CLI beta) — only
   official route to a real order with in-app tracking.
3. **Labelled test order** for the guaranteed demo (spec Mode B): everything real except the final
   place-order, clearly marked as a test. Recommended as the fallback regardless.
The order pipeline is provider-agnostic (`dining__quote_order` / `submit_order` / `order_status`), so
any of these plugs in by implementing those tools.

## Other known gaps / small fixes

- **Restaurant name isn't passed to search**: "order taco bell" → `GroupMealParams` has only
  budget/cuisine/notes. Add a `restaurant` param (contract + group prompt + `fetchOptions` → `query`).
- Dish picker can pick snack-sized items on unfamiliar menus; prefer items near the median main price.
  Grubhub `get_menu_item` descriptions contain dietary text ("lacto-ovo") — could improve veg tags.
- Members who don't answer don't veto a plan; constraints said only in a group don't count for the
  person. (Discussed with the user; not built.)
- BlueBubbles `participant-left` events aren't handled (leaves detected from participant lists).
- **Payment in chat**: real buttons/Apple Pay in iMessage need Apple Messages for Business (not
  feasible). Spend approval is the web page; a 👍-in-DM payer approval was discussed but not built.
- **Gemini free tier** = 20 requests/model/day; the user's `.env` has `MODEL_PROVIDER=gemini`,
  `MODEL_NAME=gemini-3.5-flash`. A real demo needs billing enabled.
- Not tested on real iMessage yet (needs the Mac). The tapback payload format is from source, not a
  captured webhook.

## How to run

- Simulator (no Mac): see `apps/web/README.md` → "Running everything without a Mac". `.env` needs
  `RUNTIME_STORE=postgres`, `DATABASE_URL=pglite://./.data/pglite`, `RUN_WORKER_IN_PROCESS=true`,
  `USE_REAL_MESSAGING/IDENTITY/MEMORY=true`, `DEV_SIMULATOR=true`,
  `BLUEBUBBLES_URL=http://localhost:3000/dev/bluebubbles`, a password/secret/bot address,
  `APP_ORIGIN=http://localhost:3000`; then `pnpm db:migrate && pnpm dev:api`, open `/dev/chat`.
- Real iMessage: `apps/web/README.md` → "Running v1 on real iMessage".
- Grubhub: `DINING_PROVIDER=grubhub`, `DELIVERY_LATITUDE/LONGITUDE` (ASU ≈ 33.4242, -111.9281);
  session already in `.data/grubhub`. Needs `uv`/`uvx`.
- The user's `.env` already has `SUPERMEMORY_API_KEY` and a Gemini `MODEL_API_KEY` (never print them).

## Gotchas for this repo / machine

- Windows + Git Bash: long `python - <<'PY'` heredocs sometimes fail ("unexpected EOF"); write the
  script to the scratchpad and run it. Python writes CRLF unless `newline="\n"`; run prettier.
- PGlite file DBs can't be shared by two processes; a leftover dev server can hold port 3000 and slow
  the test suite (two slow tests time out under load) — stop it first.
- Simulator message ids must be unique across restarts (the app dedupes on them) — already handled.
- Import rule: packages import only `@campus/contracts` + their own files (ESLint enforced).
- Contract changes are additive; per-owner files (`*.p2.ts` etc.). Flag P1/P4 file edits in the PR.
- Honesty rule: never present a test/sandbox order as real.
