# Agent Harness Specification — Campus Agent Network

> **Audience:** an implementing coding agent / senior engineer.
> **Owner of this spec:** the harness developer on a four-person hackathon team.
> **Date:** 2026-10-24.
> **Status:** design spec for a 24-hour hackathon MVP. Nothing is built yet.
> **Scope of this document:** the **agent harness** — the deterministic runtime that drives every conversation — plus its three major subsystems: (1) auth + the turn pipeline, (2) context/memory via Supermemory v5, (3) a custom MCP tool catalog with a permission system and credential vault.

---

## 0. How to use this spec (instructions to the implementing agent)

1. **Read all of it before writing code.** Sections 1–3 are context and principles; sections 4–8 are the build; 9–12 are cross-cutting; 13–16 are plan, tests, risks and open items.
2. **The harness is the driver; the model is an executor.** This is the central design principle (Section 2). When in doubt, move a decision out of the model and into deterministic code.
3. **Do not invent provider capabilities.** Section 3 lists what was verified in vendor docs and what was *not*. Anything in the "Unverified" list must be checked against current docs before you rely on it. If a capability can't be confirmed, build behind an interface and say so in code comments and in the README.
4. **Honesty rule (from the product contract):** a sandbox/test transaction is never labeled as a production order, receipt or delivery.
5. **Ask before assuming** on the items in Section 16 (open decisions). Defaults are given so you can proceed if no answer arrives.
6. **Never** put secrets, tokens, service-role keys or API keys in code, logs, chat transcripts, prompts, memory or the repo. Use environment variables / a secret store.
7. Keep module boundaries as specified so four developers can work in parallel; shared contracts (Section 9) are frozen in hour 0–1. **Section 18 says who owns what and how to avoid merge conflicts.**

---

## 1. Product context

### 1.1 What is being built
A student coordination assistant that lives in **iMessage**. Students talk to it in 1:1 chats and in group chats. Each student has a logical **personal agent** (their authorized context + connected accounts). Each group has a logical **group agent** (shared context and decisions). The group agent can ask members' personal agents to evaluate plans; personal agents return only approved, minimal answers. When an authorized user agrees, the system can perform an action (order, book, reserve, pay) through a supported provider and report a **verified** result back to the original conversation.

### 1.2 Hackathon framing
- Event: Cubbie Hackathon ("teach Cubbie a new trick"). **Track 1** (a Cubbie Skill: a folder with `SKILL.md` in a public GitHub repo + a short public demo video) is **mandatory** and unlocks **Track 2** (agent-to-agent coordination) and **Track 3** (group chat assistant). Tracks 2 and 3 may use any messaging app and any open-source framework.
- Track 1 is judged mainly on public votes and social engagement; Tracks 2/3 are judged privately on what the team shows. Exact dates/deadlines were "still being finalized" on the site; confirm with organizers (Discord). **Do not guess dates.**
- This harness primarily targets Tracks 2 and 3 and must be independent of the Cubbie Skill (owned by another developer).

### 1.3 Decisions already made (treat as fixed unless the owner says otherwise)
- **iMessage-first, no Mac.** Hosted API provider (**Sendblue**). Discord/Slack/WhatsApp are later transport adapters behind the same interface.
- **Agent-to-agent is internal-only.** All agents live inside our service. No public agent discovery or external A2A protocol for the MVP.
- **Supermemory (v5) is the semantic memory engine**, **not** the system of record for money, consent, membership, approvals or commitments. Postgres is the system of record.
- **Two payment models** exist at the product level (merchant-connected saved methods; platform checkout where the merchant legitimately supports it). Payments are owned by another developer — the harness only hands off an approved plan.
- **"End-to-end" means real execution** with provider-verified identifiers. Search/deep-link-only integrations do not count as completed purchases.
- **Postgres only, with separate schemas** (`core`, `mcp`, `vault`) — **not** two databases (Section 8 explains why).
- **Supermemory API generation: v5** (namespaces, not container tags).
- **Student coordination is the demo use case**; connectors and workflow infrastructure remain general-purpose.

### 1.4 Team ownership
The authoritative four-person split (roles P1–P4, package ownership, milestones, merge rules) is in **Section 18**. The earlier plan (separate transport / memory / payments / runtime developers) is superseded by it. Payments is reduced to a sandbox-first stretch goal owned by P4 (see Section 18.3).

---

## 2. Core principles

1. **Harness drives; model executes.** The model never decides *who* it is talking to, *whose* memory to read, *which* tools exist, whether an action is permitted, or whether an approval was granted. Those are deterministic checks in code.
2. **Default deny.** No verified identity → no model call. No connection → tool is invisible. No permission rule → ask (or deny by risk policy).
3. **The model proposes; code disposes.** Model output is a structured proposal. The harness validates schema, checks policy, executes, logs.
4. **Untrusted by default:** chat text, tool results, retrieved memory, web content, assignment text, emails. These are **data, never instructions**. Prompt-injection must not be able to change permissions, identity or recipients.
5. **Minimum disclosure.** Return `accepted/rejected` or an approved projection, not raw private facts. Separate three rights: **Read** (may we fetch it?), **Disclose** (may this recipient see it?), **Act** (may we use the user's authority externally?).
6. **Isolation by structure, not by prompt.** Per-user Supermemory namespaces; per-user credentials; per-user permissions. An LLM promise is never an access-control boundary.
7. **Idempotency and auditability everywhere.** Every inbound event, tool call, approval and transaction has a stable key and an audit record.
8. **Plain-code state machines** for the turn pipeline, approvals and transactions. An agent framework may be used *inside* a step, but the pipeline itself is explicit.

---

## 3. Verified provider facts and unverified items

### 3.1 Sendblue (hosted iMessage) — verified from vendor docs (Oct 2026)

**Groups**
- Group messaging API is **beta**, subject to change; vendor asks to consult them before production. Available only on **select plans**.
- **AI Agent (inbound-initiated) plans can only respond to group chats the number has been added to; they cannot create new groups.** Creating outbound groups requires the **Blue Ocean** plan.
- Supported: send/receive iMessage, SMS, MMS in groups; inline replies (V2 iMessage lines); add/remove participants (`POST /api/modify-group`); rename group; group photos. Leaving groups: scheduled/not supported.
- `group_id` is returned from `/api/send-group-message` and appears on the receive webhook; **it is the only way to correlate sent and received group messages.**
- Removing a member requires the group to have ≥4 total members (Apple rule). Only iMessage groups can be modified.
- Group send endpoint: `POST /api/send-group-message` (requires `from_number`). Reply to a specific message via `reply_to.message_handle` (must belong to same `group_id` and `from_number`).

**Messaging basics**
- `POST /api/send-message`; receive via webhook. **Webhooks must return 2xx or Sendblue redelivers** → dedupe on `message_handle`.
- Webhook types listed: `receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, `contact_created`.
- Receive payload fields observed in docs samples include: `message_handle`, `is_outbound`, `service` (iMessage/SMS/RCS), `from_number`, `sendblue_number`, `group_id`, `group_display_name`, `participants`, `status`, `send_style`, `opted_out`, `error_detail`.
- Once `from_number` is specified for the first message to a contact, keep using the same `from_number` for that contact (sticky line).
- Markdown is **not rendered** by iMessage (the official adapter strips it to plain text) → the model must output plain text.
- Inbound `media_url` values **expire after 30 days** → persist if needed.
- Rate: per-line burst up to ~10 requests/second; over-limit requests return **429** (not queued). Throttle client-side.

**First-contact / reply limits (important for auth nudges)**
- Before a contact has ever replied to a line, outbound messages to them from that line are restricted: **no media, links, phone numbers or emails; ≤300 characters; ≤6 sent/delivered messages;** one `pre_reply_override` per contact per line per day. Declines return HTTP 400 with `error_key` (`PRE_REPLY_CONTENT_BLOCKED`, `PRE_REPLY_LENGTH_EXCEEDED`, `PRE_REPLY_LIMIT_REACHED`, `PRE_REPLY_OVERRIDE_EXHAUSTED`), not 429.
- **Group messages are not subject to these pre-reply limits.** A message a contact sends in a group chat that includes the line **counts as a reply** to that line → a participant who has spoken in the group **can be sent a 1:1 message with a link immediately.**
- **AI Agent plan windows:** inbound limit 1,000 contacts/day/line; replying within **24 hours** of the contact's last message is unlimited; messaging first after the 24h window counts against a **200 contacts/day/line** follow-up limit. A separate hard safeguard exists of 150 consecutive outbound messages per line without a reply (cannot be disabled).
- Blue Ocean (outbound) limits: 50 new contacts/line/day, 15/hour (new = no conversation in last 30 days).
- **Free shared-line plans:** a recipient/participant must be **verified as a contact on your account** (dashboard) before their messages reach you / before adding them to a group. App Cards unavailable on free plan.

**Verify (phone-number verification) — "inverted OTP"**
- Flow: create a Verify **Service** (`POST /api/v2/verify/services`; `code_length` 4–8, default 6; `ttl_seconds` 60–3600, default 300; `use_customer_lines` default false) → create a **Verification** for E.164 `to` (`POST /api/v2/verify/services/{sid}/verifications`) → response includes `delivery_target { pool_number, code, sms_deep_link }` → **the user texts the code to `pool_number` from the phone number being verified** → status becomes `approved`. There is **no submit-code endpoint**; approval happens when Sendblue receives the inbound text.
- Statuses: `pending`, `approved`, `expired`, `canceled`. Poll `GET .../verifications/{vr_sid}` or use the **Verify webhook** (`type: "verify"` via `POST /api/account/webhooks`; one Verify webhook URL per account). Events: `verification.approved` (includes `phone`), `verification.expired`, `verification.canceled`.
- **Webhook signature:** header `X-Sendblue-Signature: t=<unix>,v1=<hex>`; `v1 = HMAC_SHA256(secret, "<t>.<raw_body>")`; verify against the **raw body** before parsing; reject if timestamp older than 5 minutes; use constant-time compare.
- With `use_customer_lines: true`, your own assigned numbers are used first (falls back to shared pool).
- Rate-limit `429` (with `Retry-After` possible); `503` if no verification line available. Repeated wrong codes can cool a number down.
- Optional hosted widget exists (origin-bound iframe). Browser events from the widget are forgeable: **always confirm status server-side** and check the Verification SID belongs to the expected signed-in user.

**Rich features**
- **Typing indicators work in 1:1 chats only, not groups.**
- **Tapback reactions:** `POST /api/send-reaction` (`from_number`, `message_handle`, `reaction`); iMessage only; only to received iMessage messages within roughly the last few days; some lines return `422 unsupported_on_this_line`; availability may need enablement by Sendblue. The docs read describe **sending** reactions only — **do not rely on tapbacks as an inbound approval signal.**
- **App Cards:** interactive only if the recipient has the matching iMessage app extension installed (otherwise a static layout); require a V2 line and an iMessage recipient; unavailable on free plan; one-to-one only; cannot be combined with media. **Not a viable approve/deny button for the MVP.**
- "iMessage link button" guide is an `sms:` link for **websites** to open Messages — not a bot-to-user button.
- SDKs exist for TypeScript and Python (`sendblue`, `sendblue_api`); a Chat SDK adapter (`chat-adapter-sendblue`) exists for TypeScript.

### 3.2 Supermemory v5 — verified from vendor docs

- **Namespaces** (formerly "container tags") are the isolation boundary. Container/namespace isolation is enforced as an authorization boundary; **metadata filters are optional slicing inside a namespace.** A request is scoped to **exactly one** namespace → reading personal + shared memory = two calls merged by the harness.
- Personal-agent pattern: one namespace per user. Company-agent pattern: a shared namespace + a personal namespace per member; metadata scopes within the shared one.
- SDK call shapes seen in v5 docs: `add(namespace, { content, metadata })`; `search(namespace, { query, filter, searchMode })` where `filter` uses `{ operator: "and"|"or", operands: [{ field, operator: "eq", value }] }`; `profile(namespace, { buckets? })` (REST: `POST /ns/{ns}/profile`); `profiles.getBuckets(ns)` (`GET /ns/{ns}/profile/buckets`); `profiles.setBuckets(ns, { buckets })` (`PUT`); `profiles.deleteBuckets(ns, { buckets })` (`DELETE`); `namespaces.update(ns, { supportingContext })` (`PATCH /ns/{ns}`).
- **Add document:** supply a new ID to create; **reuse an existing ID to append** new information while preserving history. Batch add: up to 600 text/URL documents per request. Files are processed asynchronously (don't assume immediately searchable).
- **Profiles:** return `static`, `dynamic` and `buckets`. **Buckets** are custom topical categories; an ingestion-time classifier assigns each memory to matching buckets; you do **not** tag memories with buckets manually. A built-in `preferences` bucket always exists. Org-level buckets are managed in the console; namespace-level buckets are add-only via API (name clash with an org bucket → `409`; org definition wins if added later). Reading a profile: omit `buckets` for all effective buckets, or pass up to 50 names. Bucket names: lowercase alphanumeric, may contain `-`/`_`, 1–64 chars; `static`/`dynamic` reserved; ≤50 per request; description ≤2,000 chars. `supportingContext` per namespace ≤1,500 chars (shapes extraction and bucket classification). Starter presets include `preferences, interests, goals, work, relationships, health, skills, finances, education, travel, values, projects`.
- Aggregated bucket entries have ids starting `aggregated_`; individual `dynamic` entries start with a `[YYYY-MM-DD]` date; v5 returns plain text (no `[Recent]/[Summary]` prefixes).
- **Forgetting:** forget by exact memory ID; semantic forget with dry-run preview; delete documents; delete/move a namespace.
- Docs index lists **namespace-scoped API keys** ("Org API keys, namespace-scoped keys").
- **Docs are mid-migration** (container tags/v4 → namespaces/v5). The legacy API used `containerTag(s)` and `AND/OR` filters with `key`/`value`; v5 uses namespaces and a different filter expression shape. **Pin the SDK version and follow only the v5 docs/migration guide.**

### 3.3 Unverified — must check before relying on them
- [ ] Which Sendblue **plan** the team has (free / AI Agent / Blue Ocean) and whether **group access** is enabled on it.
- [ ] Whether Verify is available on the team's plan, and whether `use_customer_lines` works for the team's lines.
- [ ] Whether **inbound** tapback reactions arrive as webhooks (docs read cover sending only).
- [ ] v5 **namespace naming rules** (legacy container-tag rules were: `a-zA-Z0-9_-.`, ≤64 chars, no spaces) — verify for v5.
- [ ] Whether the v5 **profile** endpoint supports metadata `filter` (legacy profile docs said yes; the v5 profile page read documents `buckets` only).
- [ ] Details of **namespace-scoped API keys** (can a key be limited to one namespace? how minted?). If yes, consider per-user keys for defense in depth.
- [ ] v5 metadata value constraints (flat values only: strings, numbers, booleans, string arrays — confirm).
- [ ] Composio coverage per needed toolkit; custom MCP servers needed where missing (Canvas LMS, GitHub, etc.).
- [ ] Whether the iMessage provider allows 1:1 DM to a group participant who has never spoken (assume **no** until they send a message).

---

## 4. Part 1 — The harness: pipeline, auth gate, agent runtime

### 4.1 Logical agents (not processes)
- `PersonalAgent(userId)` and `GroupAgent(groupId)` are **identities + context + task state**, instantiated on demand by one runtime. No always-on process or LLM session per user.
- Concurrency-sensitive state changes use DB transactions/row locks. Each conversation's messages are processed **serially** (per-conversation queue/lock).

### 4.2 Turn pipeline (deterministic, in order)

```
Sendblue webhook
  → [1] verify + normalize (InboundMessage)
  → [2] dedupe (platform, provider_message_id) + enqueue ; ack 2xx quickly
  → [3] per-conversation serialization
  → [4] identity resolution (external_identity → user | unverified)
  → [5] auth gate
  → [6] routing + invocation rules (DM→personal, group→group agent; mention/rule only)
  → [7] context assembly (broker + Supermemory v5)
  → [8] model step (structured proposals; filtered tools)
  → [9] tool gateway (per proposed call: connection → permission → risk policy → arg validation → execute → audit)
  → [10] approvals (ask-mode text reply; spend → web approval page: UI by P2, approval logic by P4)
  → [11] reply formatting (plain text) + send
  → [12] memory write (consent-checked) + audit
```

**Step details**

1. **Verify + normalize.** Verify webhook origin using whatever authentication Sendblue documents for the receive webhook (do not invent a signature scheme; Verify webhooks are HMAC-signed, receive webhook auth must be confirmed). Normalize to `InboundMessage` (Section 9). Keep the provider `group_id` authoritative.
2. **Dedupe.** `UNIQUE(platform, provider_message_id)`. Persist the raw event; return 2xx promptly; do work asynchronously.
3. **Serialize.** One in-flight turn per `conversation_id` (advisory lock or queue partition).
4. **Identity resolution.** Look up `external_identities(platform, external_id)`. Unknown → insert as `unverified`. Ensure the sender is a current member of the conversation (`conversation_members`); handle joins/leaves.
5. **Auth gate** (4.3).
6. **Routing + invocation.** DM → personal agent of that verified user. Group → group agent, **only** if mentioned/addressed or an enabled proactive rule matches. Otherwise store minimal metadata (if consented) and stop.
7. **Context assembly** (Section 5).
8. **Model step.** Provide: system prompt, injected `user_id`/`conversation_id` (never model-chosen), assembled context, and **only the tools allowed right now**. Output: structured proposals (tool calls, replies, permission-change requests).
9. **Tool gateway** (Section 6.5).
10. **Approvals.** `ask` → send a plain-text confirmation with a short code ("Reply YES 4821 to allow…"); accept only from the same verified user, same conversation, unexpired. **Spend and other money-moving actions never use text approval** — hand off to the payments approval web page.
11. **Reply.** Plain text only (no markdown). Respect pre-reply limits when messaging someone who has never replied. Throttle sends.
12. **Memory write + audit.** Only from verified, consenting users (Section 5.4). Always write audit events.

### 4.3 Auth model

**Goal:** every user individually authenticates. A user who is not authenticated **cannot talk to the agent**; if they address it, the agent **nudges** them to authenticate.

**Identity states** (`external_identities.status`): `unverified` → `verified` → `revoked`.

**What "authenticated" means:** the external identity (e.g., an iMessage phone number) is linked to an internal `user` **and** that link was proven by completing phone verification (Sendblue Verify inverted OTP, Section 3.1) through the web onboarding session. A phone-number match alone, or a chat message, is **never** payment/approval authority.

**Onboarding flow**
1. Unverified user addresses the agent (DM or group mention).
2. Harness **does not call the model** and **does not ingest** their message into memory. It sends a nudge (rules below) containing a link to the onboarding page, optionally with a pre-bound `challenge` token.
3. Onboarding web page creates a Sendblue **Verification** for the user's E.164 number (server-side; API keys never reach the browser) and shows `code` + `pool_number` + an `sms:` deep link.
4. User texts the code **from the number being verified**.
5. Verify webhook (`verification.approved`, signature checked, timestamp ≤5 min) → harness marks the identity `verified`, creates/links the `user`, records `verified_at`. Confirm the Verification SID matches the one issued for that onboarding session.
6. Harness sends a confirmation in the same conversation context ("You're set").
7. Later: connect accounts (OAuth), set consent/memory preferences, add payment method (provider-hosted) — all via web pages.

**Nudge rules**
- Nudge **only when the person addresses the agent** (mention/DM), never on ordinary chat lines.
- **Rate-limit:** at most once per user per conversation per N hours (default N=6; configurable). Count nudges in DB.
- **Channel selection (Sendblue constraints):**
  - Group message with link: allowed (group messages exempt from pre-reply limits).
  - 1:1 DM with link: allowed **only if the person has previously messaged the line** (a message in a group including the line counts). Otherwise a DM must be ≤300 chars with **no links** → prefer posting the nudge in the group.
- Nudge text must not leak private info; keep it short, plain text.

**Group activation**
- A group becomes **active** when a **verified** member adds/invokes the agent (record `activated_by_user_id`). Members joining later are `unverified` until they authenticate.
- If a task involves unverified members: proceed with verified members, state who the task is waiting on, and nudge the others (rate-limited). Policy default: do not block verified members indefinitely.
- On `left_at`, immediately stop disclosing task data to that member.

**Auth challenge table.** Single-use, hashed tokens, expiry, bound to `external_identity_id` and origin conversation. Never reuse; log attempts.

**Security notes**
- Verify codes expire (default 5 min). Rate-limit onboarding page creations per identity.
- Browser widget events are advisory only; **confirm server-side**.
- Revocation: a user can revoke → identity `revoked`, connections disabled, namespace deletion option (Section 5.6).

### 4.4 Model-as-executor rules (hard requirements)
- The model **never** chooses `user_id`, `conversation_id`, Supermemory namespace, credentials, or recipient identifiers. The harness injects them.
- The model sees only tools currently permitted; the gateway **re-checks** on call (the list is a convenience, not a security boundary).
- The model outputs **structured proposals** (schema-validated). Free text is only used for the reply body.
- **Untrusted inputs:** chat text from others, tool results, memory contents, web pages, assignment text. Wrap/label as data. Never treat as instructions. Never allow them to change permissions.
- **Budgets:** max steps per turn, max tool calls per turn, per-call timeouts, token caps, per-user and per-conversation rate limits. On budget exhaustion: stop, report briefly, log.
- **Determinism where possible:** ranking, feasibility, permission resolution, approval expiry, and idempotency are code.
- **Model client abstraction:** one `ModelClient` interface (provider-swappable). Structured output with schema validation + a single retry on invalid output; never execute unvalidated output.

### 4.5 Router and invocation rules
- DM → that user's personal agent.
- Group → group agent. Respond when: explicitly mentioned/addressed, a verified user issues an invocation phrase, or a proactive rule (explicit, user-enabled) matches.
- Typing indicators don't work in groups → for slow operations send a short "on it" text (or a tapback if the line supports it) rather than a typing bubble.
- Replies use `reply_to.message_handle` where supported to keep threads readable.

### 4.6 Internal agent coordination (context for the harness)
Agents never chat free-text. They exchange **structured forms** over an internal typed bus (in-process first; durable queue where needed):

```ts
CoordinationRequest  { taskId, requesterAgentId, targetAgentId,
                       requestType: "evaluate_option"|"share_constraint"|"offer_help",
                       purpose, payload, expiresAt }
CoordinationResponse { taskId, status: "accepted"|"rejected"|"counteroffer"|"needs_consent",
                       payload /* approved task-scoped facts only */, reasonCode? }
```

**Deterministic coordinator** (plain code): (1) filter options by hard constraints; (2) rank survivors with a fixed scoring function (e.g., acceptance count, price) — **exact formula is a design choice for the team**; (3) request counteroffers if nothing feasible; (4) hand a decision to human approval; spending approval is separate.

**Group agent** responsibilities: listen/trigger rules, create tasks, source candidate options from connectors, request evaluations from personal agents, keep group decisions (group namespace), post proposals/results to the original group. It **never** reads any user's private memory.

**Personal agent** responsibilities: evaluate proposals against its owner's authorized context; answer via approved projections only.

### 4.6.1 Group dinner vertical slice (acceptance target)
Group message → task → members' personal agents evaluate options privately → coordinator picks → proposal posted → payer approves exact quote on web page (P2 UI / P4 logic) → connector executes once → provider status verified → result posted to the **same** group. Mode A = live approved merchant transaction. Mode B (fallback) = real iMessage + real coordination + sandbox payment **labeled as simulated**.

### 4.7 Failure handling
- Webhook retries → dedupe. Model errors → apologize briefly, no partial side effects. Tool timeouts → mark outcome unknown, **reconcile before retry** for anything with side effects. Provider 429 → backoff with jitter; queue outbound sends.
- Crash recovery: persisted task state + idempotency keys allow safe resume.
- Poison messages: cap retries, dead-letter, alert.

---

## 5. Part 2 — Context management with Supermemory v5

### 5.1 Principles
- **Namespace per principal is the privacy wall.** `user_{uuid}` for private memory; `group_{uuid}` for group-shared memory. Use **internal stable UUIDs**, never display names or phone numbers, as namespace identifiers (names collide/change; phone numbers are PII).
- **Metadata is for slicing within a namespace, not for security.** A bug in a metadata filter must never expose another person's memory.
- **Supermemory is not the system of record.** Consent, membership, approvals, commitments, money and secrets live in Postgres.
- **The model never names a namespace.** A `ContextBroker` selects it after checking verified requester, membership, task purpose, consent, audience, fields, sensitivity and expiry.

### 5.2 Namespace and metadata layout

| Memory | Namespace | Suggested metadata (flat) |
|---|---|---|
| Personal preferences/facts/history | `user_{uuid}` | `source` (imessage/web/connector), `conversation_id`, `kind` (preference/fact/conversation/feedback), `visibility: private`, `author_user_id`, `ingested_by` |
| Group confirmed decisions | `group_{uuid}` | `author_user_id`, `task_id`, `kind: decision`, `decided_at` |
| Task-approved projections (optional) | `task_{uuid}` | `approved_fields`, `expires_at` |

Notes:
- The user's request to "tag every memory with the user's name": do it as **metadata `author_user_id` (UUID)** — redundant in a per-user namespace but essential in the group namespace for attribution, debugging and deletion. Use name only as content, not as a key.
- Verify v5 namespace naming rules and flat-metadata constraints (Section 3.3).
- Use **stable document IDs** per conversation/thread/task so that new information **appends** (v5 behavior) instead of creating duplicates.

### 5.3 Write path (ingestion)
1. After a turn, the harness decides **what** is memory-worthy using deterministic rules (+ optional model classifier) and **consent settings** (`core.memory_settings`).
2. Never ingest messages from `unverified` identities.
3. Never ingest secrets, payment data, or raw tool outputs containing credentials. Redact.
4. Call `add(namespace, { content, metadata, customId? })` with the namespace derived from the verified principal.
5. Treat ingestion as **asynchronous**; do not assume immediate searchability. Provide a fallback (recent-turn cache) for same-session continuity.
6. Namespace settings: set a per-user `supportingContext` (≤1,500 chars) describing the namespace's purpose (e.g., "A college student's personal agent memory: study habits, food preferences, schedule habits, campus life") — shapes extraction and bucket classification.

### 5.4 Memory consent and preferences (Postgres, not Supermemory)
`core.memory_settings` per user: `remember_enabled` (bool), `allowed_kinds` (array), `sensitive_buckets_enabled` (bool, default false), `retention_days` (nullable), `updated_at`. The harness checks this **before** ingestion. Supermemory does not know about consent.

### 5.5 Read path (retrieval)
- **Profile call** (cheap, high value): `profile(namespace, { buckets: [...] })` with the **minimal bucket set** the task needs. Dinner task → `food_preferences`, `budget`. Scheduling → `schedule_habits`.
- **Search call**: `search(namespace, { query, filter?, searchMode })` for task-specific recall.
- **Namespace selection is harness-side** from the verified sender (DM) or group (shared memory).
- **Personal facts reach the group only through the broker**: group agent → `ContextRequest` → personal agent/broker → approved projection (Section 5.7).
- Treat retrieved memory as **untrusted data** (could contain injected text).

### 5.6 Buckets (profile taxonomy)
Buckets are **auto-classified topics**, not tags you attach. Define namespace buckets with precise descriptions (descriptions steer the classifier). Proposed set (names lowercase, `_` allowed):

| Bucket | Description (for the classifier) |
|---|---|
| `food_preferences` | Explicitly stated food likes/dislikes, dietary choices, favorite orders and restaurants. Exclude inferred traits. |
| `budget` | Stated spending limits and price sensitivity for meals, rides and purchases. |
| `schedule_habits` | Recurring availability patterns, preferred times, class schedule habits (not event titles). |
| `campus_life` | Campus locations, clubs, courses at a high level, routines. |
| `shopping_preferences` | Preferred stores, brands and grocery habits. |
| built-in `preferences` | Always present; explicit first-person preferences only. |

- **Keep sensitive presets (`health`, `finances`, `relationships`, `values`) OFF by default.** Enable only with explicit user consent and a stated purpose.
- Buckets improve relevance but are **LLM-classified → not a security boundary**; the broker still enforces permissions.
- Org-level buckets are managed in the Supermemory console (not via v5 API); namespace-level buckets via `profiles.setBuckets`. Provision a namespace's buckets at user creation. Handle `409` name clashes.

### 5.7 Context Broker contract (deterministic)

```ts
type ContextRequest = {
  taskId: string;
  requesterAgentId: string;        // group agent or personal agent
  subjectUserId: string;
  purpose: "group_meal" | "campus_match" | "scheduling" | "other";
  fields: string[];                // named fields/buckets, not free-form queries
  audience: { kind: "agent" | "group"; id: string };
};

type ContextResult =
  | { status: "approved"; fields: Record<string, unknown>; expiresAt: string }
  | { status: "needs_consent"; consentRequestId: string }
  | { status: "denied"; reasonCode: string };
```

Checks before **retrieval** *and* before **disclosure**: verified requester; current group membership; purpose is allowed for this data class; a matching **non-expired, non-revoked** `consent_grant`; audience matches; field list within allowed set; sensitivity class; repeated-probing limits. Return **projections** (booleans, ranges, coarse values) not raw memory. Example: `accepts_option(restaurant_7, total=18.50)` instead of revealing a budget ceiling; `available_at(19:00)` instead of calendar titles.

### 5.8 Forgetting and deletion
- "Forget this" → exact forget by memory ID or semantic forget (dry-run first, show the user what will be removed, then apply).
- "Delete everything about me" → delete/move the user's namespace **and** DB rows (identities per policy, connections, credentials, memory settings, consent grants), with audit entries retained minimally. Revocation cannot undo disclosures already made or settled payments — say so.
- Group removal → stop disclosure immediately; group namespace content authored by the leaver handled per policy (default: keep decisions, delete leaver-authored personal facts on request).

### 5.9 Defense in depth (investigate)
- If v5 **namespace-scoped API keys** can be minted per user, use them so that even a harness bug cannot cross namespaces. Otherwise rely on broker + tests.
- Never expose Supermemory API keys to clients or logs. Server-side only.

---

## 6. Part 3 — MCP catalog, permissions and credential vault

### 6.1 Why a custom catalog
Composio does not cover everything needed (e.g., Canvas LMS, some GitHub flows — the owner wrote "Graphhub MCP"; interpreted as **GitHub** MCP — confirm). So build a **custom MCP catalog** (DB-backed) and put **both** Composio and custom MCP servers behind **one provider interface**. Composio becomes one provider among others.

```ts
interface ToolProvider {
  id: string;                                    // "composio" | "custom"
  listTools(serverId: string): Promise<ToolManifest[]>;
  callTool(serverId: string, tool: string, args: unknown, ctx: CallContext): Promise<ToolResult>;
  // credentials are resolved by the gateway and injected via ctx; the provider never reads the vault directly
}
```

Tool names exposed to the model are **namespaced** `server__tool` to avoid collisions.

### 6.2 Catalog data model (summary; DDL in Section 8)
- `mcp.servers`: global catalog entry (name, provider, transport/URL, auth type, OAuth config, status).
- `mcp.tools`: cached manifest per server (name, description, input-schema hash, **risk_class**, **default_mode**).
- `mcp.user_connections`: per user per server connection state, granted scopes.
- `mcp.oauth_states`: short-lived OAuth state + PKCE verifier (encrypted) + expiry + used-at.
- `vault.credentials`: encrypted tokens/keys (access, refresh, API key) linked to a connection.
- `mcp.tool_permissions`: per-user permission rules.
- `mcp.tool_calls`: audit log.

**Callbacks:** OAuth redirect URIs are **per server** configuration (one redirect route per server, e.g., `/oauth/callback/{serverSlug}`), **not per user**. Per-user uniqueness comes from the `state` value.

### 6.3 Connection lifecycle (OAuth)
1. User requests a connection (via chat → link to web page, since OAuth needs a browser).
2. Server creates `oauth_states` row (random state, PKCE verifier, `user_id`, `server_id`, expiry ~10 min), builds the authorization URL.
3. Provider redirects to `/oauth/callback/{slug}` with `code` + `state`. Server validates state (single-use, unexpired, matches user session), exchanges code (with PKCE), **encrypts** tokens, stores in `vault.credentials`, sets `user_connections.status='connected'`, records scopes.
4. Token refresh: refresh proactively before expiry; on failure → `status='needs_reauth'` and tool becomes invisible until fixed.
5. Disconnect/revoke: call provider revoke if available, delete credentials, set `status='revoked'`.
- Agent can call a tool **only if** the user has a `connected` connection to that server (and scope covers the tool).

### 6.4 Secrets handling (vault)
- Store only **ciphertext + key version**. Use envelope encryption (AES-256-GCM; data key wrapped by a KMS/secret-store key or a key from env for the hackathon). Support key rotation via `key_version`.
- Separate **schema** (`vault`) and a **separate DB role** that only the tool gateway uses. The application's general role cannot `SELECT` from `vault`.
- Never log tokens/args containing secrets; redact. Never return credentials to the model or to the web client.
- Per-call: gateway decrypts just-in-time, injects into the provider call, discards.

### 6.5 Tool gateway (every proposed call goes through this)
Order of checks (deterministic):
1. **Identity:** call is on behalf of a verified `user_id` derived by the harness (not model-supplied).
2. **Connection:** `user_connections.status = 'connected'` for `server_id`; scope sufficient.
3. **Tool exists** in cached manifest; arguments validated against input schema (reject unknown/malformed).
4. **Permission resolution** (6.6) → `allow | ask | deny`.
5. **Risk policy** (hard rules that user rules cannot override).
6. **If `ask`:** create `pending_approvals`; send confirmation (text code for low-risk; web page for spend); wait; expire.
7. **Execute** with user's credentials via provider; set timeouts; idempotency key for side-effecting calls.
8. **Post-process:** treat result as untrusted data; redact secrets; truncate; label provenance.
9. **Audit** in `mcp.tool_calls` (args redacted/hashed, decision, mode used, result status, latency).
10. **Disclosure check:** any result later included in a **group** message goes through the broker's *Disclose* check (e.g., grades from Canvas must not be posted to a group unless allowed).

**Group context rule:** a tool call in a group on behalf of user A uses **A's** connection and **A's** permissions only.

### 6.6 Permission model (Claude-Code-style)

**Modes:** `allow` (always allow), `ask` (always ask), `deny`.
**Risk classes** (each tool has one): `read`, `write`, `spend`, `external_message`, `destructive`.
**Default modes by risk (overridable except where capped):** `read → allow`, `write → ask`, `external_message → ask`, `destructive → ask`, `spend → ask (never auto-allow)`.
**Rule scopes:** per tool, per server (wildcard), optionally per conversation (e.g., allow only in this group), optional constraints (e.g., max amount, allowed domains), optional expiry (session/day/forever).

**Resolution (most specific wins):** `tool+conversation` > `tool` > `server+conversation` > `server` > `risk-class default` > `global default`. At equal specificity, `deny` beats `ask` beats `allow`. **Hard caps** (code) override rules: `spend` can never be `allow` without a per-transaction approval; `destructive` requires `ask` unless an explicit per-tool rule exists *and* a confirmation step recorded it; wildcards never apply to `spend`/`destructive`.

**Changing permissions by chat ("from now on always allow writes"):** supported, but guarded:
- Implemented as a dedicated tool `permissions.update` that the harness (not the model) authorizes.
- **Provenance:** accepted only when the triggering instruction is the **user's own 1:1 message** (not a group message, not tool output, not retrieved memory).
- **Confirmation** required for broad changes (server-wide, wildcard, risk-class-wide): show exactly what will change, require an explicit confirm.
- **Never** widens `spend` beyond per-transaction approval; never changes another user's permissions.
- Writes `mcp.tool_permissions` row with `source='user_dm'`, audit event, optional expiry.
- Provide natural-language **revoke/reset** ("ask me every time again", "revoke everything").
- Show the user their current rules on request in plain language.

**Approval channels**
- Low-risk `ask`: text reply code in the user's **1:1** chat (not in a group), bound to the exact pending action, short expiry, one-time.
- `spend` / money / sensitive: **authenticated web page** (approval UI by P2, approval logic by P4) with exact quote binding. Tapbacks/App Cards are **not** used (Section 3.1).

### 6.7 Prompt-injection posture for tools
- Tool descriptions and results are untrusted. Strip/neutralize instruction-like content in results before giving them to the model, or clearly delimit as data.
- Never let a tool result trigger a tool call without passing the full gateway; never let it change identity, namespace, recipients or permissions.
- Canvas/email/GitHub content may include adversarial text. Add tests (Section 14).

---

## 7. Messaging adapter (integration surface for the harness)

```ts
type Platform = "imessage" | "discord" | "slack" | "whatsapp";

type InboundMessage = {
  platform: Platform;
  providerMessageId: string;           // Sendblue message_handle
  providerConversationId: string;      // group_id for groups; sender number for DMs
  senderExternalId: string;            // E.164 for iMessage
  participantExternalIds: string[];
  isGroup: boolean;
  text: string;
  timestamp: string;
};

interface MessagingAdapter {
  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean;
  normalize(rawEvent: unknown): InboundMessage | null;
  sendDM(recipientId: string, text: string, opts?: { replyTo?: string }): Promise<{ messageId: string }>;
  sendGroup(conversationId: string, text: string, opts?: { replyTo?: string }): Promise<{ messageId: string }>;
}
```

Requirements: dedupe on `(platform, providerMessageId)`; keep sticky `from_number`; throttle sends; return 2xx fast; plain text outbound; persist inbound media only if needed (30-day expiry); handle join/leave events; keep an abstraction so Discord/Slack/WhatsApp adapters can be added later. A web simulator/Discord fallback must exist if group access is blocked (Gate A).

---

## 8. Database design (Postgres, one database, three schemas)

**Why one database with schemas:** PostgreSQL cannot enforce foreign keys across databases. Separate schemas inside one database give enforceable FKs, single-transaction consistency, and isolation through **roles/grants** (e.g., `vault` readable only by the gateway role).

Types are Postgres. Use UUID PKs (`gen_random_uuid()`), `timestamptz`, and `NOT NULL` where sensible. Adapt to your migration tool (Drizzle/SQLAlchemy/etc.).

```sql
CREATE SCHEMA core;  CREATE SCHEMA mcp;  CREATE SCHEMA vault;

-- ===================== core =====================
CREATE TABLE core.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES core.users(id),                 -- NULL until linked/verified
  platform text NOT NULL,
  external_id text NOT NULL,                              -- E.164 for iMessage
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified','revoked')),
  verified_at timestamptz,
  verify_sid text,                                        -- Sendblue Verification SID
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);

CREATE TABLE core.auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_identity_id uuid NOT NULL REFERENCES core.external_identities(id),
  token_hash text NOT NULL UNIQUE,
  origin_conversation_id uuid,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.nudges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_identity_id uuid NOT NULL REFERENCES core.external_identities(id),
  conversation_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON core.nudges (external_identity_id, conversation_id, sent_at DESC);

CREATE TABLE core.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL,
  provider_id text NOT NULL,                              -- Sendblue group_id or DM key
  type text NOT NULL CHECK (type IN ('dm','group')),
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active','archived')),
  activated_by_user_id uuid REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, provider_id)
);

CREATE TABLE core.conversation_members (
  conversation_id uuid NOT NULL REFERENCES core.conversations(id),
  external_identity_id uuid NOT NULL REFERENCES core.external_identities(id),
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (conversation_id, external_identity_id)
);

CREATE TABLE core.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES core.conversations(id),
  platform text NOT NULL,
  provider_message_id text NOT NULL,
  sender_external_identity_id uuid REFERENCES core.external_identities(id),
  body text,                                              -- minimal retention; consider redaction
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  UNIQUE (platform, provider_message_id)
);

CREATE TABLE core.memory_settings (
  user_id uuid PRIMARY KEY REFERENCES core.users(id),
  remember_enabled boolean NOT NULL DEFAULT true,
  allowed_kinds text[] NOT NULL DEFAULT '{preference,fact}',
  sensitive_buckets_enabled boolean NOT NULL DEFAULT false,
  retention_days integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.consent_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),
  purpose text NOT NULL,
  audience_kind text NOT NULL, audience_id text NOT NULL,
  allowed_fields text[] NOT NULL,
  expires_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL CHECK (owner_type IN ('user','group')),
  owner_id uuid NOT NULL,
  conversation_id uuid REFERENCES core.conversations(id),
  type text NOT NULL, status text NOT NULL,
  state_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.coordination_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES core.agent_tasks(id),
  from_agent text NOT NULL, to_agent text NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.pending_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),
  conversation_id uuid NOT NULL REFERENCES core.conversations(id),
  kind text NOT NULL CHECK (kind IN ('tool_ask','permission_change','spend_handoff')),
  proposal jsonb NOT NULL,                                -- exact action, redacted
  proposal_hash text NOT NULL,
  code_hash text,                                         -- for text approvals
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','expired')),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid, action text NOT NULL, resource text,
  policy_result text, detail jsonb,                       -- no secrets, no private values
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== mcp =====================
CREATE TABLE mcp.servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,                              -- e.g. 'canvas','github'
  display_name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('custom','composio')),
  transport text NOT NULL,                                -- 'stdio'|'streamable_http'|...
  base_url text,
  auth_type text NOT NULL CHECK (auth_type IN ('oauth2','api_key','none','composio_managed')),
  oauth_config jsonb,                                     -- authorize_url, token_url, scopes, client_id, client_secret_ref
  callback_path text,                                     -- /oauth/callback/{slug}
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mcp.tools (
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  name text NOT NULL,
  description text,
  input_schema_hash text,
  risk_class text NOT NULL CHECK (risk_class IN ('read','write','spend','external_message','destructive')),
  default_mode text NOT NULL CHECK (default_mode IN ('allow','ask','deny')),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, name)
);

CREATE TABLE mcp.user_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),        -- cross-schema FK: enforceable
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  status text NOT NULL CHECK (status IN ('pending','connected','needs_reauth','revoked')),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  connected_at timestamptz, last_used_at timestamptz,
  UNIQUE (user_id, server_id)
);

CREATE TABLE mcp.oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES core.users(id),
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  pkce_verifier_ciphertext bytea NOT NULL, key_version int NOT NULL,
  expires_at timestamptz NOT NULL, used_at timestamptz
);

CREATE TABLE mcp.tool_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  tool_name text,                                         -- NULL = whole server
  conversation_id uuid REFERENCES core.conversations(id), -- NULL = everywhere
  mode text NOT NULL CHECK (mode IN ('allow','ask','deny')),
  constraints jsonb NOT NULL DEFAULT '{}',
  source text NOT NULL CHECK (source IN ('default','user_dm','admin')),
  expires_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON mcp.tool_permissions (user_id, server_id) WHERE revoked_at IS NULL;

CREATE TABLE mcp.tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),
  conversation_id uuid REFERENCES core.conversations(id),
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  tool_name text NOT NULL,
  args_redacted jsonb, args_hash text,
  decision text NOT NULL, mode_used text, approval_id uuid REFERENCES core.pending_approvals(id),
  result_status text, latency_ms int,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== vault (restricted role) =====================
CREATE TABLE vault.credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES mcp.user_connections(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access_token','refresh_token','api_key')),
  ciphertext bytea NOT NULL, key_version int NOT NULL,
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, kind)
);
-- GRANT SELECT/INSERT/UPDATE on vault.* ONLY to the tool-gateway role; REVOKE from everything else.
```

**Cross-cutting (payments/transactions, owned by P4 as a stretch goal, shown for FK compatibility):** `quotes`, `approvals`, `transactions` (with `UNIQUE(idempotency_key)`) reference `core.users`/`core.agent_tasks`. Transaction states: `DRAFT → QUOTED → AWAITING_APPROVAL → AUTHORIZED → EXECUTING → CONFIRMED | NEEDS_RECONCILIATION → CONFIRMED/FAILED`; also `CANCELLED/EXPIRED`. Track payment state and fulfillment state separately; never assume payment success = fulfillment.

**Row-level safety:** every query in the harness takes `user_id` from the verified principal. Consider Postgres RLS for `mcp.*` and `core.memory_settings` as defense in depth.

---

## 9. Shared contracts (freeze in hour 0–1; publish fixtures)

`InboundMessage`, `ContextRequest/ContextResult`, `CoordinationRequest/CoordinationResponse`, `Quote`, `VerifiedAuthorization`, `ToolManifest`, `ToolProposal`, `PermissionRule`. Define once as schemas (Zod **or** Pydantic) and generate/mirror the other representation if the team mixes languages. No parallel edits without review. Provide mocks on day one: fake iMessage webhook, fake context response, fake checkout status, fake MCP server.

```ts
type ToolProposal = {
  proposalId: string;
  server: string; tool: string;      // namespaced server__tool is the model-visible name
  args: unknown;                     // validated against the manifest schema by the gateway
  rationale?: string;                // for logs only; never trusted
};

type PermissionRule = {
  userId: string; serverId: string; toolName?: string; conversationId?: string;
  mode: "allow" | "ask" | "deny";
  constraints?: Record<string, unknown>;
  expiresAt?: string;
};
```

Financial types (from the product plan): `Quote { id, connectorId, merchantId, currency, totalMinor, expiresAt, items[] }`; `VerifiedAuthorization { approvalId, userId, quoteId, maxTotalMinor, expiresAt }`; purchase calls take an idempotency key; reconcile status before retrying; never report "ordered"/"paid" until the provider confirms.

---

## 10. Repository layout (language-neutral; module boundaries matter)

```
campus-agent/
├── apps/
│   ├── api/          # webhooks (Sendblue receive + Verify), OAuth callbacks, approvals endpoints
│   ├── worker/       # per-conversation turn processing, coordination, transaction workers
│   └── web/          # onboarding, connections, consent settings, approval page (P2)
├── packages/
│   ├── contracts/    # shared schemas + fixtures
│   ├── messaging/    # adapter interface, sendblue adapter, (later) discord/slack/whatsapp
│   ├── identity/     # identities, verification, auth gate, nudges
│   ├── harness/      # router, turn pipeline, runtime, model client, budgets
│   ├── agents/       # personal/group agent logic, coordinator
│   ├── context/      # broker, consent, supermemory v5 client wrapper, buckets
│   ├── tools/        # catalog, gateway, permissions, providers (composio, custom), vault client
│   ├── approvals/    # text-code approvals, permission-change confirmation
│   ├── workflows/    # task state, negotiation, order (P4, stretch)
│   └── db/           # migrations, schema, roles/grants
├── tests/ (fixtures, permissions, integration, auth, injection, transactions)
├── docs/  README.md  .env.example (no real keys)
```

---

## 11. Configuration and secrets

Environment variables (names illustrative): `DATABASE_URL`, `DATABASE_URL_VAULT` (restricted role), `VAULT_KEY_ID`/`VAULT_MASTER_KEY` (dev only), `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_VERIFY_SERVICE_SID`, `SENDBLUE_VERIFY_WEBHOOK_SECRET`, `SUPERMEMORY_API_KEY`, `MODEL_API_KEY`, `COMPOSIO_API_KEY`, `APP_ORIGIN`, `OAUTH_REDIRECT_BASE`. Keep staging/sandbox credentials separate from anything live. Define a **spending ceiling** and who may authorize live test purchases.

---

## 12. Observability, privacy and safety requirements

- **Audit everything** (identity changes, nudges, permission changes, approvals, tool calls, context grants/denials) without logging secrets or private values.
- **Trace view** (optional, great for demo/judges): timeline of agent messages and allowed/denied context requests, values redacted.
- **PII minimization:** store phone numbers only in `external_identities`; use UUIDs elsewhere. Retention settings honored.
- **Consent first:** no ingestion from unverified users; explain that the bot remembers things; support "forget me".
- **Revocation** prevents future use; it cannot undo already-sent disclosures or settled payments — state this plainly.
- **Rate limits** per user/conversation on model calls, tool calls and nudges. **Abuse controls:** probing limits on context requests.
- **Never automate around a merchant restriction.** If a merchant doesn't permit programmatic purchase, present verified search/quote and a handoff, not a workaround.
- **Test users only** for demos; friends in demos must know a bot is involved.

---

## 13. Build plan (24-hour hackathon, with gates)

| Time | Deliverable | Gate |
|---|---|---|
| 0–1h | Repo, schemas frozen, env example, mocks, DB + schemas/roles; **confirm Sendblue plan & group access; confirm live-merchant path** | **Gate A:** can the provisioned line receive a real group message and reply to the same `group_id`? Capture a webhook fixture. If not → run the platform-independent flow in Discord/web simulator and keep the iMessage adapter + disclose the limitation. |
| 1–4h | Pipeline skeleton (webhook→dedupe→identity→auth gate→reply echo); Verify onboarding; fake tool provider; Supermemory v5 wrapper + namespace/bucket provisioning | Unverified users are blocked + nudged; verified users get replies |
| 4–8h | Model step with structured proposals; tool gateway + permission resolution; first real MCP (one provider) with OAuth + vault | **Submit the mandatory Cubbie Skill before the Track 1 cutoff** (owned elsewhere) |
| 8–12h | Context broker + consent; group agent ↔ personal agents (2+ users) with projection-only answers; text approvals; permission-change flow with provenance checks | No private-fact leakage in demo |
| 12–16h | Handoff to payments approval; second MCP (e.g., Canvas); trace view; memory settings + forget | Demo path works end to end (Mode A or labeled Mode B) |
| 16–20h | Error handling, idempotency, revocation, membership changes, reconciliation; freeze integrations | Freeze |
| 20–24h | Rehearse, fallback demo, submission | Show evidence, not assertions |

Contingencies: Sendblue group access blocked → Discord/web simulator; Supermemory indexing delayed → pre-seeded preferences through the same broker contract, labeled honestly; live merchant unavailable → sandbox clearly labeled as simulated.

---

## 14. Test plan (acceptance criteria)

**Auth / identity**
- [ ] Unverified sender → no model call, no memory ingestion, nudge sent (rate-limited).
- [ ] Nudge channel obeys Sendblue pre-reply rules (link only in group, or in DM after the person has messaged the line).
- [ ] Verify webhook: signature checked on raw body, ≤5-minute timestamp, replay rejected; SID matches the issued verification; `to` number matches.
- [ ] Wrong-number code does not verify; expired verification handled.
- [ ] Group join/leave updates membership; leavers stop receiving task data.
- [ ] Duplicate webhook deliveries produce one processed turn.

**Harness / model-as-executor**
- [ ] Model-proposed `user_id`/namespace/conversation is ignored/rejected.
- [ ] Invalid structured output is retried once then fails safe.
- [ ] Budgets enforced (steps, tool calls, time, tokens).
- [ ] Per-conversation serialization prevents races.

**Context / Supermemory v5**
- [ ] Per-user namespace isolation: user A's search never returns user B's memories (including adversarial queries).
- [ ] Unverified or non-consenting users' messages are never ingested.
- [ ] Group agent cannot read private namespaces; only approved projections returned.
- [ ] Bucket classification works; sensitive buckets disabled by default; profile reads request minimal buckets.
- [ ] Consent: approved / denied / needs_consent / expired / revoked behave correctly.
- [ ] Forget (exact + semantic dry-run) and delete-namespace flows work.
- [ ] Appending via stable document IDs doesn't duplicate.

**MCP / permissions / vault**
- [ ] Tool invisible when not connected; gateway rejects it anyway if proposed.
- [ ] OAuth: state single-use/expiring; PKCE verified; tokens encrypted at rest; refresh works; revocation works.
- [ ] Resolution precedence tests (specificity, deny-beats-allow, hard caps, wildcard exclusion for spend/destructive).
- [ ] "Always allow" via **1:1 DM** works and is audited; the same request from a **group** message, from a tool result, or from retrieved memory is **rejected**.
- [ ] Broad permission changes require confirmation; spend never becomes auto-allow.
- [ ] Text approvals: bound to exact action, same user, 1:1 chat, expiring, one-time; replay fails.
- [ ] Secrets never appear in logs, prompts, or responses.
- [ ] Tool results containing injected instructions do not alter identity, permissions, recipients or namespaces.
- [ ] Results from user A's connection are not disclosed to the group without a Disclose check.

**Transactions (P4 stretch goal; P1 harness integrates)**
- [ ] Exact approved quote → one provider transaction; duplicate approval/webhook → no second charge.
- [ ] Unknown outcome → reconciliation, not blind retry; sandbox clearly labeled.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sendblue group access not available on the plan | Gate A at hour 1; Discord/web simulator fallback; keep adapter interface |
| Pre-reply DM limits block nudges | Group nudges; DM only after the person has spoken |
| 24-hour window limits proactive messages | Prioritize messages within 24h; batch notifications; note limits in demo |
| Prompt injection via tool/memory content | Data labeling, gateway re-checks, provenance rules, tests |
| Metadata-filter bug leaks memory | Namespace-per-user isolation; optional per-user scoped keys; tests |
| Token leakage | Vault schema + restricted role, encryption, redaction, no logs |
| Supermemory docs/API drift (v4→v5) | Pin SDK version; follow v5 migration guide only |
| Over-scoping | Build one vertical slice first; many connectors only after one really executes |
| Free-plan contact verification friction | Pre-add the four test users as contacts |
| Legal/ToS of third-party purchasing | Use only approved integrations; label sandbox; do not circumvent |

---

## 16. Open decisions (ask the owner; defaults given)

1. **Language: Python or TypeScript?** *Default: TypeScript to match shared contracts (Zod) and the team's modular monolith.* Sendblue has SDKs for both. If Python, mirror contracts as Pydantic models and use FastAPI + a queue (Celery/RQ/Arq).
2. **Sendblue plan/group access?** *Default: assume AI Agent plan: replies only in groups the line was added to; no outbound group creation.*
3. **Is Verify available on the plan?** *Default: use it; if unavailable, fall back to a web-session code the user texts to the line, verified by the inbound `receive` webhook (same inverted flow, self-built).*
4. **Approval channel for low-risk `ask`:** *Default: text reply code in 1:1 chat.*
5. **"Graphhub MCP" = GitHub MCP?** *Default: yes.*
6. **Coordinator scoring formula:** *Default: hard-constraint filter, then rank by (acceptance count, price, distance).*
7. **Which MCPs are P0 for the demo?** *Default: one custom (Canvas or GitHub) + Composio for common apps.*
8. **Supermemory per-user scoped keys:** *Default: not used unless confirmed available.*
9. **Which LLM(s) back the model step?** *Default: provider-agnostic `ModelClient`; one provider for the MVP.*

---

## 17. Definition of done for the harness

A real iMessage message from an **unverified** user is blocked and nudged; after **Verify**, a verified user's message in a **group** is routed to the group agent; two or more personal agents answer with **projections only** (no private leakage); a tool call to a **connected** MCP server runs under that user's credentials with the correct **permission mode**; a chat-driven **"always allow"** change is accepted only from the user's own DM with confirmation, and is rejected from any untrusted source; spend-type actions hand off to the **authenticated approval page**; everything is **audited**, **idempotent**, and **tested**.

---

## 18. Four-person work split (low-conflict)

### 18.1 Design of the split
- **One person (P1) builds the spine first**: contracts, database, interfaces, fakes, the pipeline skeleton and a chat simulator. Everyone else builds **real implementations of interfaces** on top of it, so work is parallel and rarely touches the same files.
- **Ownership is by package.** One owner per package. Nobody edits a package they don't own; they open a request or a PR the owner reviews.
- **Packages depend only on `contracts` (interfaces and types), never on another package's implementation.** The real or fake implementation is chosen by configuration (dependency injection + feature flags). Enforce with an import-boundary lint rule.
- **Every interface ships with an in-memory fake on day one**, so the pipeline runs end to end from about hour 2 and each person swaps a fake for their real implementation without blocking anyone.
- P1 is the natural role for the harness owner. P2–P4 can be assigned by strength: P2 = web/API/integration, P3 = backend/data, P4 = security/OAuth/tooling.

### 18.2 Roles and package ownership

| Role | Name | Owns (write access) | Implements interfaces |
|---|---|---|---|
| **P1** | **Spine** (scaffolding, then core runtime) | `contracts/`, `db/` (core runtime tables, roles/grants, migration runner), `harness/`, `agents/`, root config, CI, `apps/worker/`, simulator CLI | `ModelClient`, `AuditLog`, `TurnPipeline`, `TaskStore`, `Coordinator`, `PersonalAgent`, `GroupAgent` |
| **P2** | **Front door** (transport, identity, auth gate, web UI) | `messaging/`, `identity/`, `apps/api/` webhook + Verify routes, `apps/web/` (onboarding, connections page, consent settings page, approval page UI) | `MessagingAdapter`, `IdentityService`, `AuthGate`, `NudgeService`, `MembershipService` |
| **P3** | **Memory** (context, consent, Supermemory v5) **+ mandatory Cubbie Skill** | `context/`, `hackathon/cubbie-skill/`, memory/consent migrations | `MemoryStore`, `ContextBroker`, `ConsentService`, `BucketProvisioner`, `MemoryPolicy` |
| **P4** | **Hands** (tool catalog, MCP, permissions, vault, approvals; payments stretch) | `tools/`, `approvals/`, `mcp.*` + `vault.*` migrations, OAuth callback routes, `workflows/order*` (stretch) | `ToolGateway`, `PermissionResolver`, `ToolProvider` (custom + Composio), `VaultClient`, `ApprovalService`, `ConnectionService` |

Rules: one owner per row; if two people need the same file, split the file or move one concern into the other's interface.

**Where the original concerns went**
- Auth gate, nudges, Verify, membership → P2.
- Context broker, consent, Supermemory, buckets, forgetting → P3.
- Tool gateway, permissions, OAuth, vault, text approvals → P4.
- Turn pipeline, model step, personal/group agents, deterministic coordinator, audit, task state → P1.
- Approval **web page**: UI shell and session handling → P2; approval **API/logic** (quote binding, one-time tokens) → P4.
- Payments/transaction engine → P4 **stretch**, sandbox first, clearly labeled; do not start before milestone M3 (Section 18.5).
- Mandatory Cubbie Skill → P3 (lightest early critical path; it is small and independent). **Submit it early; confirm the cutoff with organizers.**

### 18.3 P1 — Foundation checklist ("Scaffold Ready")
The scaffold is **done** when all of this exists on `main`. Target: **≤ 2 hours**, with **contracts published in the first 30–40 minutes** so others can start coding against them.

1. Monorepo with package skeletons per Section 10; workspace config; lint, format, typecheck; test runner; CI running them.
2. **Import-boundary lint rule**: packages may import only `contracts` (and their own files).
3. `docker-compose` with Postgres and Redis; `.env.example` with sections per owner (no real keys); typed config loader that **fails fast** on missing variables.
4. **Database:** all tables from Section 8 created in the initial migration (so others rarely need migrations), the three schemas, DB roles and grants (including the restricted `vault` role), a migration runner, and **migration folders per owner** (Section 18.6).
5. **`contracts/`:** schemas and types from Section 9 plus **interfaces** for every item in the "Implements interfaces" column above, error types, audit-action enum (additive, one file per owner), event names, and **fixtures** (sample Sendblue receive/group/Verify webhooks, sample tool manifests, sample consent grants).
6. **Fakes** for every interface (in-memory): fake messaging adapter, fake identity (all users verified), fake memory store, fake broker (approve all), fake tool provider, fake permission resolver, fake approvals (auto-approve for tests only), fake model client with scripted outputs.
7. **Dependency-injection container** + feature flags (`USE_REAL_MESSAGING`, `USE_REAL_IDENTITY`, `USE_REAL_MEMORY`, `USE_REAL_TOOLS`, `USE_REAL_MODEL`) selecting fake vs real.
8. **Turn pipeline skeleton** (Section 4.2) calling only interfaces: dedupe → serialize → identity → auth gate → route → context → model → tool gateway → approvals → reply → memory write → audit. Runs end to end on fakes.
9. **Chat simulator CLI**: push a fake DM or group message (and fixtures from Sendblue) through the pipeline and print the trace. This is everyone's test harness until real iMessage works.
10. Logger with **secret redaction**, request/turn IDs, per-conversation serialization utility, idempotent-insert helpers.
11. **CODEOWNERS** file mapping packages to P1–P4, and a PR template with a "contract change?" checkbox.
12. README: how to run, how to add a fake→real swap, the rules in 18.6.

**If the scaffold slips:** P2–P4 code against the contracts in Section 9 and the interface list above, using their own local fakes, and rebase when it lands. Nobody waits idle.

### 18.4 What P2, P3, P4 do in hours 0–2 (before the scaffold lands)
- **P2:** confirm Sendblue plan and group access (Gate A), add the four test users as contacts if on a free plan, capture real webhook fixtures (DM, group, Verify), start the Sendblue adapter and signature checking in isolation.
- **P3:** spike Supermemory v5 (create a namespace, add, search, profile, set buckets, forget); resolve the "unverified" items in Section 3.3 (naming rules, profile filters, scoped keys); start the Cubbie Skill.
- **P4:** build the vault encryption utility standalone, run a single OAuth flow spike (one provider), check Composio coverage for needed toolkits, draft the risk-class table for each planned tool.

### 18.5 Milestones and integration points

| Phase | Hours | P1 Spine | P2 Front door | P3 Memory | P4 Hands |
|---|---|---|---|---|---|
| **M0** | 0–2 | Scaffold Ready; contracts first | Gate A; fixtures; adapter spike | Supermemory v5 spike; Skill draft | Vault util; OAuth spike |
| **I1** | ~2 | Simulator runs end to end on fakes; announce | | | |
| **M1** | 2–5 | Real model client; structured proposals; audit; task store | Real Sendblue adapter; Verify + auth gate; nudge rules; dedupe | Namespace + bucket provisioning; real `MemoryStore`; memory settings | Catalog tables; gateway + permission resolver on fake provider; vault client |
| **I2** | ~5 | Flip flags: real identity, real memory, real tools into pipeline. First real DM through Sendblue (or Discord/web fallback if Gate A failed) | | | |
| **M2** | 5–9 | Personal + group agents; coordinator; group routing hooks | Group routing, membership, activation, join/leave; onboarding page | Consent + `ContextBroker` + projections; **submit Cubbie Skill** | OAuth callbacks; first real MCP; text-code approvals |
| **I3** | ~10 | Group task with two personal agents, projections only, end to end | | | |
| **M3** | 9–14 | Task persistence, retries, budgets, trace API | Connections page, consent page, approval page UI | Forget/delete flows, trace data, retention | Permission-change tool with provenance checks; second MCP; Composio provider |
| **I4** | ~14 | Full demo path rehearsed (Mode A or labeled Mode B) | | | |
| **M4** | 14–20 | Failure handling, reconciliation hooks, load/rate limits | Hardening, rate limits, error copy | Leakage tests, bucket tuning | Injection tests, token-refresh/revoke, **payments sandbox (stretch)** |
| **Freeze** | 20 | No new integrations; bug fixes only | | | |
| **Final** | 20–24 | Rehearse, fallback demo, submission | | | |

**Integration points (I1–I4):** the person named runs a short sync (≤10 min), flips the relevant flags on `main`, runs the simulator and the shared acceptance tests, and reports pass/fail in the team channel.

### 18.6 Conflict-avoidance rules
1. **Package ownership + CODEOWNERS.** Edit only your packages. Need a change elsewhere? Open a small PR to the owner or request it.
2. **Contract changes** (anything in `contracts/`): PR labeled `contract-change`, reviewed by all four within ~15 minutes, merged by P1. Additive changes preferred; no breaking renames after M0.
3. **Migrations:** one folder per owner (`db/migrations/p1/`, `p2/`, `p3/`, `p4/`) with timestamp-prefixed files. **Never edit another owner's migration.** After M0, migrations are **additive only** (new columns/tables/indexes). Table ownership by schema: runtime tables and `core.audit_events/agent_tasks/coordination_events/pending_approvals/messages` → P1; identity tables (`external_identities`, `auth_challenges`, `nudges`, `conversations`, `conversation_members`) → P2; `core.memory_settings`, `core.consent_grants` → P3; `mcp.*`, `vault.*` → P4.
4. **Root and shared files** (root config, lockfile, CI, `.env.example` structure): P1 only. Others add dependencies to their **own package manifest**; on lockfile conflicts, rebase and regenerate rather than hand-merging.
5. **`.env.example`:** each owner appends only inside their own commented section.
6. **Audit actions, error codes, event names:** each owner adds entries in their **own file** (e.g., `audit-actions.p2.ts`), re-exported by `contracts`. No two people edit the same enum file.
7. **Feature flags:** merge incomplete work to `main` **behind a flag**; real implementations default to off until their integration point.
8. **Trunk-based development:** short-lived branches, PRs under ~1 hour of work, rebase on `main` often, merge at least every 1–2 hours. Use separate git worktrees per person/branch (`feat/spine`, `feat/front-door`, `feat/memory`, `feat/hands`).
9. **Tests live with the owner** (each package's `tests/`). Cross-package acceptance tests live in `tests/integration/` and are **owned by P1**; others contribute test cases through PRs.
10. **No secrets in the repo or in any chat transcript.** Separate staging/sandbox keys from anything live.
11. **Review pairs for security-critical code:** P1 ↔ P4 (pipeline ↔ gateway/permissions), P2 ↔ P3 (auth gate ↔ consent/broker). Auth, permission-change, vault and context-broker PRs need the paired review before merge.

### 18.7 Dependency matrix (who calls whom, through which interface)

| Caller (package) | Calls | Interface | Provided by |
|---|---|---|---|
| `harness` (P1) | identity + auth gate | `IdentityService`, `AuthGate` | P2 |
| `harness` (P1) | send replies / nudges | `MessagingAdapter`, `NudgeService` | P2 |
| `harness` (P1) | context + memory | `ContextBroker`, `MemoryStore`, `MemoryPolicy` | P3 |
| `harness` (P1) | tools + permissions + approvals | `ToolGateway`, `PermissionResolver`, `ApprovalService` | P4 |
| `agents` (P1) | personal-agent answers via broker | `ContextBroker` | P3 |
| `identity` (P2) | audit | `AuditLog` | P1 |
| `context` (P3) | consent checks, membership | `ConsentService` (own), `MembershipService` | P3, P2 |
| `tools` (P4) | identity of the caller, conversation | `TurnContext` (injected) | P1 |
| `apps/web` (P2) | connection start, approval decision | `ConnectionService`, `ApprovalService` endpoints | P4 |
| `tools` (P4) | disclose-check before group output | `ContextBroker.disclose` | P3 |

### 18.8 Per-role deliverables and definition of done

**P1 — Spine**
- Scaffold Ready (18.3), then: real `ModelClient` with schema-validated structured output and a single retry; `TurnPipeline` with budgets, timeouts and per-conversation serialization; personal/group agents; deterministic `Coordinator` (hard-constraint filter, ranking, counteroffers); `TaskStore` and state persistence; audit writer; trace API; shared integration tests.
- **Done when:** a group task coordinates two personal agents on real implementations and posts a proposal to the same group; budgets and idempotency tests pass; nothing in the pipeline imports a concrete implementation.

**P2 — Front door**
- Real Sendblue adapter (webhook verify/normalize, throttled sends, sticky `from_number`, plain text, replies, group send); **Verify onboarding** (service, verification, signed webhook, SID/number checks); identity states; auth gate; **nudge service** with rate limits and the Sendblue pre-reply channel rules; group activation and membership; web pages: onboarding, connections list, consent settings, approval page UI.
- **Done when:** an unverified user who addresses the agent gets a nudge and no model call; after Verify they can talk to it; group join/leave is tracked; the Gate A fallback (Discord/web simulator) exists if group access is blocked.

**P3 — Memory (+ Cubbie Skill)**
- Supermemory v5 wrapper; per-user and per-group namespaces from UUIDs; bucket provisioning and `supportingContext`; consent-checked ingestion; profile and search with minimal buckets; `ContextBroker` (approve/deny/needs_consent, projections, disclose check); `memory_settings`; forgetting (exact + semantic dry-run) and namespace deletion; trace data; **Cubbie Skill submitted**.
- **Done when:** cross-user leakage tests pass, unverified/non-consenting users are never ingested, the group agent receives only projections, and the Skill is submitted.

**P4 — Hands**
- Catalog tables and tool manifest caching; `ToolProvider` for custom MCP servers and Composio; OAuth connection flow (state, PKCE, callback, refresh, revoke); vault with envelope encryption and restricted role; gateway (Section 6.5); permission resolver and hard caps; text-code approvals; chat-driven permission changes with provenance and confirmation; first real MCP (Canvas or GitHub) and a second; audit of every call. **Stretch (after M3):** Square sandbox order/payment, quote binding and one-time approval, labeled as sandbox.
- **Done when:** a tool is invisible without a connection, the resolution-precedence tests pass, "always allow" works from the user's own DM and is rejected from group messages, tool results and retrieved memory, and no secret appears in logs, prompts or responses.

### 18.9 Shared acceptance tests (owned by P1; each role must keep these green)
1. Unverified message → blocked + nudge (P2 + P1).
2. Verified DM → reply on real implementations (P1 + P2).
3. Group mention → group agent; two personal agents answer with projections only (P1 + P3).
4. Cross-user memory isolation under adversarial queries (P3).
5. Tool call without a connection is rejected even if the model proposes it (P4).
6. Permission change from a group message is rejected; from the user's DM is accepted after confirmation (P4).
7. Duplicate webhook → one processed turn (P1 + P2).
8. Secrets absent from logs and prompts (P1 + P4).

### 18.10 Rhythm
- **Hour 0 kickoff (15 min):** confirm roles, owners, language decision (Section 16), and who runs each integration point.
- **Every integration point (I1–I4):** 10-minute sync, flag flip, shared tests, report.
- **Blocked?** Post the blocker with the interface name; the owner replies within 15 minutes or provides a fake.
- **Hour 20:** freeze.

---

### Appendix A — Source pointers (for the implementing agent to verify)
- Sendblue: Groups (https://docs.sendblue.com/getting-started/groups/), Limits (https://docs.sendblue.com/limits/), Verify (https://docs.sendblue.com/api-v2/verify/), App Cards (https://docs.sendblue.com/api-v2/app-cards/), Reactions (https://docs.sendblue.com/api-v2/reactions/), Sending messages (https://docs.sendblue.com/getting-started/sending-messages/), Webhooks (https://docs.sendblue.com/getting-started/webhooks/).
- Supermemory: docs index (https://supermemory.ai/docs/llms.txt), Namespaces (https://supermemory.ai/docs/concepts/container-tags.md), Multi-tenancy (https://supermemory.ai/docs/concepts/multi-tenancy.md), Multi-tenancy examples (https://supermemory.ai/docs/concepts/multi-tenancy-examples.md), Profile buckets (https://supermemory.ai/docs/user-profiles/buckets.md), User profiles (https://supermemory.ai/docs/recall/user-profiles.md), v5 migration pages (listed in the index), API keys & auth (https://supermemory.ai/docs/authentication.md).
- Composio SDK: https://github.com/composiohq/composio ; LangGraph adapter: https://pypi.org/project/composio-langgraph/
- Cubbie Hackathon: https://hackathon.cubbie.ai/ ; kit: https://github.com/imaginix-inc/cubbie-hackathon-kit

### Appendix B — Glossary
- **Harness:** deterministic runtime that receives events, enforces auth/permissions/budgets, calls the model, executes tools.
- **Namespace (v5):** Supermemory isolation boundary (formerly container tag).
- **Bucket:** auto-classified topical slice of a profile.
- **Projection:** a minimal, approved answer derived from private data (e.g., yes/no) rather than the raw fact.
- **Inverted OTP:** verification where the user texts a code *to* the provider instead of receiving one.
- **MCP:** Model Context Protocol — a standard for exposing tools to AI agents.
