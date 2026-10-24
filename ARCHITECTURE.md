# Campus Agent Network — Architecture & 24-Hour Build Plan

> **Status:** Implementation proposal / hackathon MVP  
> **Last reviewed:** 2026-10-24  
> **Primary interface:** iMessage  
> **Team:** Four developers  
> **Goal:** A student coordination assistant with personal agents, group agents, internal agent-to-agent coordination, privacy-preserving memory, and **real, authorized end-to-end transactions**.

## 0. Product contract

Students can talk to an assistant in personal and group conversations. Each student has a logical personal agent with access to their own authorized context and connected accounts. Each group has a group agent with its own shared context. The group agent can ask members' personal agents to evaluate plans, share narrowly approved constraints, and coordinate tasks. Once an authorized user agrees, the assistant should be able to **perform** an action (order, pay, book, reserve) through a supported provider and return a **verified** confirmation.

**Decisions already made**

- **iMessage-first, no Mac** — use a hosted API provider; Discord/Slack/WhatsApp are later transport adapters.
- **Agent-to-agent is internal-only** — all agents exist inside our service; no public agent discovery or external A2A protocol is needed for the MVP.
- **Supermemory is the semantic memory engine**, not the system of record for money, consent, membership, or commitments.
- **Two payment models** — merchant-connected saved payment methods **and** platform-managed checkout where the merchant legitimately supports it.
- **End-to-end means real execution** — search/deep-link-only integrations do not count as completed purchases.
- **Student coordination is the hackathon use case**; connectors and workflow infrastructure remain general-purpose.

### Definition of success

1. A real iMessage group message triggers the correct group agent.
2. Two or more enrolled participants' personal agents evaluate a request through the internal coordination layer.
3. A private fact is **not** disclosed to the group, while the group still receives a useful result.
4. A group reaches a concrete decision and the intended payer confirms an exact quote in a secure authenticated UI.
5. One supported connector creates an order and processes a payment, with provider-side identifiers and independently checked status.
6. The assistant sends the actual confirmed result to the original conversation; retries do not duplicate purchases.
7. A mandatory Cubbie skill is submitted in time, independently of the wider prototype.

**Honesty rule:** A simulated payment/merchant sandbox is a valuable integration test, but is **not** a real purchase. Never label sandbox output as a production order, receipt, or delivery.

---

## 1. Architecture

Use a **TypeScript modular monolith + a background worker**, not microservices. Keep typed package boundaries to support four parallel developers.

```text
                     iMessage (primary)
                            |
               Hosted provider: Sendblue
                            |
                    Webhook adapter
                            |
           Message normalization / identity
                            |
                 Agent router / API
               /                    \
        Personal agent          Group agent
               \                    /
             Internal coordination bus
                            |
               Context/consent broker
                    /             \
             Supermemory        PostgreSQL
          semantic memories   operational state
                            |
                Workflow/transaction engine
                  |                   |
            BullMQ worker      Approval web UI
                  |
              Connector registry
           /       |         |       \
       Commerce   Calendar   Maps    Campus tools
           |
       Provider order + payment + status
                            |
               iMessage confirmation
```

**Components**

| Component | Responsibility | Must not do |
|---|---|---|
| Message adapter | Convert provider webhooks to one canonical message; send replies | Make privacy or spending decisions |
| Identity service | Associate verified platform accounts with internal user IDs | Treat a chat message as payment authorization |
| Personal agent | Interpret owner's request, consult authorized private memory/tools, evaluate proposals | Reveal raw private memory to a group |
| Group agent | Maintain shared decisions; initiate and manage coordination tasks | Read arbitrary user namespaces |
| Coordination bus | Deliver structured requests/offers/counters/results between **internal** logical agents | Send private payloads to unrelated participants |
| Context broker | Enforce scoped retrieval, disclosure, consent, and revocation | Rely on LLM promises as an access-control boundary |
| Transaction engine | Quote, approve, execute, verify, reconcile | Assume that payment success equals merchant fulfillment |
| Connector registry | Expose provider-specific capabilities and execution methods | Pretend `search` implies `purchase` |
| Supermemory | Searchable personal/group/task semantic context | Store authoritative payments, approvals, or secrets |
| Postgres | Canonical users, memberships, policies, tasks, events, quotes, transactions | Store raw card details |

**Recommended stack:** Node.js + TypeScript, Fastify, Zod, Postgres/Supabase + Drizzle, Supermemory v5, BullMQ + Redis, Next.js approval/onboarding UI, hosted Sendblue iMessage, and provider-specific payments (Stripe/Square where appropriate). Deploy API and worker as persistent services; deploy Next.js separately if convenient.

### Logical agents, not one process per user

`PersonalAgent(userId)` and `GroupAgent(groupId)` are identities + context + task state. They are instantiated on demand by the same runtime. Use database transactions/locks for concurrency-sensitive actions; do not create one always-running process or LLM session for every person.

---

## 2. Provider reality and integration order

### iMessage (hard dependency)

**Primary candidate: Sendblue**. Its group API supports receiving and sending group messages, including `group_id` for correlation, but group support is **beta and available on select plans**. An inbound-initiated agent line may reply after it is added to a group without permission to create arbitrary outbound groups. Obtain working access **before** assuming the flagship demo can run in iMessage.

- Docs: https://docs.sendblue.com/getting-started/groups
- API: https://docs.sendblue.com/api
- Group send: https://docs.sendblue.com/api/resources/groups/methods/send_message

**Gate A (hour 1):** Can our provisioned hosted line receive a real group message and send a reply to that *same* `group_id`? Capture a webhook fixture.

**If not:** Continue against a `MessagingAdapter` and run the integration demo in Discord or a web simulator while pursuing another hosted iMessage provider. Keep the product/design iMessage-first, but plainly disclose the blocker in the presentation. Do not spend the entire hackathon trying to implement an unsupported iMessage bridge on Windows.

### Commerce (hard dependency for a real transaction)

**Priority 1: Approved order-and-pay integration.** DoorDash's CLI and MCP are documented as **private beta**; individual CLI access is not equivalent to consumer-app reseller rights. Investigate beta/merchant access early but don't block on it.

- DoorDash overview: https://developer.doordash.com/en-US/docs/welcome/

**Priority 2: Real transaction with an authorized participating merchant.** Square Orders + Payments can power orders and payments **for a Square seller that has authorized your app**, including test-mode development first. A live Square payment at a real participating merchant is a real transaction; a Square sandbox payment is not.

- Square Orders API: https://developer.squareup.com/reference/square/orders
- Square sandbox: https://developer.squareup.com/docs/devtools/sandbox/overview

**Stripe:** Use Stripe Checkout/PaymentIntents where **our own authorized merchant checkout** accepts it; consider Connect only with an actual marketplace model and proper onboarding. Charging a card in Stripe does not, by itself, pay DoorDash/Uber/Airbnb on the user's behalf. Do not build a pooled custodial wallet for the hackathon.

### Connector priority matrix

| Priority | Connector | First realistic capability | Action path | Availability caveat |
|---|---|---|---|---|
| P0 | Hosted iMessage | Receive + reply in group and DM | Sendblue group/DM API | Beta; plan approval required |
| P0 | Authorized merchant checkout | Quote → approved live order + payment | Square seller integration or another approved commerce API | Requires merchant authorization |
| P0 | Supermemory | Scoped semantic search/write | v5 namespaced API | Backend broker required |
| P1 | Maps/Places | Restaurant discovery, distance | Search/lookup API | Not equivalent to booking |
| P1 | Google Calendar | Consent-based availability | OAuth API | Don't reveal event titles by default |
| P1 | DoorDash | Actual consumer food ordering | Official agentic API/CLI **if approved** | Private beta; individual vs platform restrictions |
| P2 | Uber/Uber Eats | Quote/search/deep-link or execution if granted | Provider-approved APIs | Permissions differ by API |
| P2 | Hotel/flight providers | Search/quote and authorized booking | Supplier-specific APIs | Live ticketing/booking access needed |
| P2 | Walmart/Grubhub/Waymo/Airbnb | Discover provider-approved capabilities | Per-provider adapter | Do not claim purchase support without proof |
| Later | Discord/Slack/WhatsApp | Messaging adapters | Official app/business APIs | Separate platform permissions/limits |

Implement many connectors *only after one connector really executes*. A `search`-only adapter remains useful but must never be represented as an end-to-end integration.

---

## 3. Identity, conversations, and messaging

**Identity model:** one internal `user_id`, many independently verified `external_identities`. Onboarding happens through a small authenticated website: phone-number verification, consent preferences, connect provider accounts, and optionally a payment method through provider-hosted pages. A phone-number match alone does **not** authorize a purchase.

```ts
type Platform = "imessage" | "discord" | "slack" | "whatsapp";

type InboundMessage = {
  platform: Platform;
  providerMessageId: string;
  providerConversationId: string;
  senderExternalId: string;
  participantExternalIds: string[];
  isGroup: boolean;
  text: string;
  timestamp: string;
};

interface MessagingAdapter {
  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean;
  normalize(rawEvent: unknown): InboundMessage | null;
  sendDM(recipientId: string, text: string): Promise<{ messageId: string }>;
  sendGroup(conversationId: string, text: string): Promise<{ messageId: string }>;
}
```

**Inbound pipeline**

1. Verify webhook origin using provider-supported authentication/signatures; do not invent a signature scheme if the provider doesn't offer one.
2. Normalize provider-specific fields; retain the authoritative `group_id` from the provider.
3. Deduplicate via `(platform, providerMessageId)` unique constraint.
4. Resolve verified sender and current group membership.
5. Persist event; acknowledge webhook promptly; enqueue orchestration job.
6. Route DM to personal agent, group message to group agent.
7. Reply only when mentioned, explicitly invoked, or an enabled proactive rule matches.

Store external chat messages only with an understandable consent and retention policy. Handle group joins/leaves; don't continue disclosing task data to former group participants.

---

## 4. Memory, permission, and privacy model

Supermemory v5 stores memories inside namespaces; only the trusted server receives credentials. Each API read is scoped to a single namespace. Define:

```text
user/{userId}/private        # Personal semantic memory
group/{groupId}/shared       # Allowed group chat facts, decisions
task/{taskId}/approved       # Explicitly approved task-specific projections
```

Supermemory docs: https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/container-tags.mdx

**Do not let group agents or LLM-generated tool arguments directly specify arbitrary `user/...` namespace IDs.** The context broker selects the namespace after checking verified requester, group membership, task purpose, consent, recipient audience, fields, sensitivity, and expiration.

### Three separate rights

1. **Read:** May this service retrieve the source fact for this purpose?
2. **Disclose:** May this specific result go to this recipient or group?
3. **Act:** May the system invoke an external action under this user's authority?

Example: A user may allow `available_at(19:00)` without sharing their private calendar event titles. A dinner task may ask `accepts_option(restaurant_7, total=18.50)` rather than revealing an individual's exact budget ceiling.

### Suggested policy categories

| Data/action | Default | Notes |
|---|---|---|
| Public or explicitly shared group decisions | Allow within the group | Respect retention and group changes |
| Dietary preference for meal planning | Ask once; allow standing purpose-scoped grant | Reveal preference, not medical explanation |
| Calendar availability | Share boolean/free slots only after consent | Do not disclose event titles |
| Precise location | Ask for each sensitive use | Prefer approximate proximity |
| Private documents, finances, health, messages | Deny by default | Separate explicit and narrowly scoped consent |
| External messages posted on behalf of user | Require appropriate authority | Show recipient/content for impactful messages |
| Purchases, bookings, commitments | Exact-transaction authorization | Payer and amount must be verified |

**Security requirements:** default deny; user-facing grant/revoke controls; no cross-user namespace fallback; expiring task grants; audit decisions; context minimization; limits on repeated probing; prompt-injection isolation; secret storage outside memory and logs. Revocation prevents future use, but cannot undo already-sent disclosures or settled payments.

### Core broker contract

```ts
type ContextRequest = {
  taskId: string;
  requesterAgentId: string;
  subjectUserId: string;
  purpose: "group_meal" | "campus_match" | "scheduling" | "other";
  fields: string[];
  audience: { kind: "agent" | "group"; id: string };
};

type ContextResult =
  | { status: "approved"; fields: Record<string, unknown>; expiresAt: string }
  | { status: "needs_consent"; consentRequestId: string }
  | { status: "denied"; reasonCode: string };

interface ContextBroker {
  requestContext(request: ContextRequest): Promise<ContextResult>;
}
```

The LLM can propose what it needs; deterministic code validates the purpose, recipient, data class, scope, and shape before retrieval **and** before disclosure.

---

## 5. Internal agent-to-agent coordination

All personal and group agents belong to this platform; there is no need for public agent cards or external protocols. Use a typed internal event bus (in-process initially, BullMQ where durable/async).

```ts
type CoordinationRequest = {
  taskId: string;
  requesterAgentId: string;
  targetAgentId: string;
  requestType: "evaluate_option" | "share_constraint" | "offer_help";
  purpose: string;
  payload: Record<string, unknown>;
  expiresAt: string;
};

type CoordinationResponse = {
  taskId: string;
  status: "accepted" | "rejected" | "counteroffer" | "needs_consent";
  // Only validated, approved task-scoped facts; never raw memory.
  payload: Record<string, unknown>;
  reasonCode?: string;
};
```

**Recommended algorithm**

1. Group agent creates a task with participants and objective.
2. Generate candidate options from connectors; don't infer all constraints from raw private memory.
3. Ask each personal agent to evaluate the options against authorized local context.
4. Broker limits any returned facts or boolean acceptance scores.
5. Deterministic coordinator checks hard constraints, ranks feasible options, and requests counters if needed.
6. Required users approve the chosen plan; spending approval remains separate.
7. Execute one task-specific transaction; persist a confirmed group decision.

**Future campus workflows sharing the same coordination engine:** matching people to resource loans, skill/team formation, urgent non-emergency assistance, study sessions, and shared bookings. For campus discovery, personal agents are **opt-in discoverable** by resource/skill/category; private memory does not imply public availability.

---

## 6. Transaction execution and payments

### Transaction states

```text
DRAFT -> QUOTED -> AWAITING_APPROVAL -> AUTHORIZED -> EXECUTING
                                                    |
                                        +-----------+----------+
                                        |                      |
                                   CONFIRMED           NEEDS_RECONCILIATION
                                                               |
                                                     CONFIRMED / FAILED
```

Any applicable state may also become `CANCELLED` or `EXPIRED` before the provider executes a non-reversible action. A payment state and an order/fulfillment state should be tracked separately.

**Approval binding:** Store the exact payer, quote snapshot/hash, merchant, items, currency, maximum authorized total, expiry, and one-time approval token. Re-quote or reauthorize after material changes. Approval occurs on authenticated web UI, not merely from an incoming iMessage text.

### Payment rails

- `merchant_saved_method`: delegate purchase through an approved provider account using that provider's permitted authentication flow. Do not collect or store raw card credentials.
- `platform_checkout`: use Stripe/Square for **a merchant that actually accepts your integration**. Do not claim a successful Stripe charge completed an unrelated DoorDash/Uber order.
- `sandbox`: separate test-mode rail that demonstrates flows without moving real money.

Avoid building custodial balances or pooled wallets during the hackathon. Limit MVP to one payer per purchase.

### Connector contract

```ts
type Capability = "search" | "quote" | "purchase" | "status" | "cancel";

type Quote = {
  id: string;
  connectorId: string;
  merchantId: string;
  currency: string;
  totalMinor: number;
  expiresAt: string;
  items: Array<{ sku: string; quantity: number }>;
};

type VerifiedAuthorization = {
  approvalId: string;
  userId: string;
  quoteId: string;
  maxTotalMinor: number;
  expiresAt: string;
};

interface CommerceConnector {
  id: string;
  capabilities: Capability[];
  search?(query: unknown): Promise<unknown>;
  quote?(input: unknown): Promise<Quote>;
  purchase?(
    quote: Quote,
    authorization: VerifiedAuthorization,
    idempotencyKey: string
  ): Promise<{ providerOrderId: string; providerPaymentId?: string; state: string }>;
  getStatus?(providerOrderId: string): Promise<unknown>;
  cancel?(providerOrderId: string): Promise<unknown>;
}
```

**Rules:**

- No purchase unless the connector advertises and truly implements `purchase`.
- Validate identity, approval, quote, expiry, spending cap, permissions, and provider capability at the server boundary.
- Persist intent **before** the outbound call; use a stable idempotency key and provider-side support where available.
- On timeout, **reconcile status before retrying**. Do not assume idempotence from our database alone.
- Do not report “ordered” until the provider confirms order acceptance; don't report “paid” until payment status is verified.
- Preserve cancellation/refund/partial-failure information and write audit events.

---

## 7. First complete vertical slice: group dinner

> **Demo script:** Three or four students in an actual iMessage group: “Can we order dinner? Keep it under $20 each.” Their personal agents privately evaluate options; the group agrees; one payer authorizes; a supported merchant receives the order and payment; the assistant posts the verified result to the group.

| Step | System behavior | Visible evidence |
|---|---|---|
| 1 | iMessage webhook creates task | Correct conversation ID in task timeline |
| 2 | Identity maps participants to platform users | Correct number of verified members |
| 3 | Group agent requests limited context | Permission requests in audit trace |
| 4 | Personal agents evaluate restaurant options | Different acceptance/constraints, no raw private facts |
| 5 | Coordinator picks agreed quote | Group proposal message |
| 6 | Payer receives authenticated private approval | Quote, merchant, amount, payment source |
| 7 | Connector executes purchase | Real merchant order and payment IDs |
| 8 | Worker confirms provider states | Verified status and reference in database |
| 9 | Group receives confirmation | Message in the **same** original group |

### First-slice acceptance tests

- [ ] Real hosted iMessage **group** send/receive verified on an eligible plan.
- [ ] Incoming event deduplicated even when provider retries.
- [ ] Group and each participant resolve to the correct IDs.
- [ ] Two different personal agents evaluate options.
- [ ] Unauthorized personal information is withheld; deny/consent behaviors are tested.
- [ ] A concrete proposal satisfies hard constraints and receives required consent.
- [ ] Payer signs in and approves an exact, unexpired quote.
- [ ] Transaction executes once, with valid provider-side status.
- [ ] Purchase record includes provider order/payment IDs and source of truth.
- [ ] Duplicate approval/webhook does **not** produce a second charge.
- [ ] Failed/uncertain provider response enters reconciliation, not blind retry.
- [ ] Group receives real status; sandbox transactions are visibly labeled as tests.

**Two demo modes:**

- **Mode A (target):** Live approved merchant transaction; real receipt/confirmation.
- **Mode B (transparent fallback):** Real iMessage + real personal/group coordination + Square sandbox order/payment. Label the transaction as simulated and show exactly where production authorization is needed.

---

## 8. Repo layout

```text
campus-agent/
├── apps/
│   ├── api/                         # Fastify; routes/webhooks, tasks, approvals, oauth
│   ├── worker/                      # BullMQ coordination and transaction workers
│   └── web/                         # Next.js onboarding, connections, approvals, task trace
├── packages/
│   ├── contracts/                   # Canonical types, Zod schemas, shared events
│   ├── messaging/                   # adapter.ts, sendblue.ts, future adapters
│   ├── identity/                    # verified identities, group membership
│   ├── agents/                      # personal, group, router, coordinator
│   ├── context/                     # broker, consent, policies, supermemory
│   ├── workflows/                   # task state, order, negotiation, approvals
│   ├── connectors/                  # registry; square, stripe, maps, others
│   └── db/                          # Drizzle schema/migrations
├── hackathon/
│   └── cubbie-skill/                # Mandatory first-track submission
├── tests/
│   ├── fixtures/                    # Provider payloads, sample member constraints
│   ├── permissions/
│   ├── integration/
│   └── transactions/
├── docs/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json                       # Optional
├── .env.example                     # No real keys
└── README.md
```

### Database tables (minimum)

| Table | Important fields / constraints |
|---|---|
| `users` | id, display_name, created_at |
| `external_identities` | user_id, platform, external_id, verified_at; UNIQUE(platform, external_id) |
| `conversations` | id, platform, provider_id, type; UNIQUE(platform, provider_id) |
| `conversation_members` | conversation_id, user_id, joined_at, left_at, role |
| `messages` | conversation_id, provider_message_id, sender_id, body, timestamp; UNIQUE(platform, provider_message_id) |
| `agent_tasks` | id, owner_type, owner_id, type, status, state_json |
| `coordination_events` | task_id, from_agent, to_agent, type, payload, timestamp |
| `consent_grants` | user_id, purpose, audience, allowed_fields, expires_at, revoked_at |
| `connections` | user_id, provider, scopes, encrypted_secret_ref, status |
| `quotes` | id, task_id, connector_id, amount_minor, currency, expires_at, snapshot_hash |
| `approvals` | id, quote_id, payer_id, status, approved_at, expires_at, one_time_token_hash |
| `transactions` | id, task_id, provider, external_order_id, external_payment_id, idempotency_key, status; UNIQUE(idempotency_key) |
| `audit_events` | actor_id, action, resource, policy_result, timestamp |

Never expose service-role database credentials, Supermemory API keys, or merchant secrets to clients or coding-agent chat transcripts.

---

## 9. Four parallel developer tracks

### Developer 1 — iMessage transport and identity (`feat/messaging`)

**Owns:** `packages/messaging`, `packages/identity`, webhook and outbound API routes.

- [ ] Secure Sendblue group-capable account or document specific access blocker.
- [ ] Create fixture from actual group webhook.
- [ ] Implement `MessagingAdapter`, `SendblueAdapter`, signature/auth verification as documented.
- [ ] Persist inbound events with idempotent insert.
- [ ] Verify user accounts and map participants to conversation members.
- [ ] Implement DM and group replies; add test for reply to original group.

**Done:** Real group text → normalized event → queued task → outbound group reply.

### Developer 2 — Memory, privacy, and consent (`feat/context`)

**Owns:** `packages/context`, memory client and consent policies.

- [ ] Implement namespaced Supermemory v5 wrapper.
- [ ] Create verified `ContextBroker` with Zod-checked responses.
- [ ] Add opt-in user preferences and task/grant purpose scoping.
- [ ] Add `approved`, `denied`, `needs_consent`, expired, revoked tests.
- [ ] Persist confirmed group decisions separately from speculative chat.
- [ ] Create audit trace showing *why* a request was allowed or denied, without leaking private values.

**Done:** Group agent gets only approved projections from multiple personal agents.

### Developer 3 — Payments and connectors (`feat/commerce`)

**Owns:** `packages/connectors`, `packages/workflows/order*`, payment approval API/UI.

- [ ] Implement typed connector registry with capability introspection.
- [ ] Integrate Square Orders/Payments sandbox with status verification.
- [ ] Pursue a permitted **live merchant transaction** path in parallel.
- [ ] Add Stripe test checkout only where business/merchant model is valid.
- [ ] Build quote approval page: authenticated payer, amount, merchant, expiry.
- [ ] Persist idempotency, reconcile unknown outcomes, add negative tests.

**Done:** Exact approved quote triggers one verifiable provider transaction; replay does not double-charge.

### Developer 4 — Agent coordination and mandatory skill (`feat/runtime`)

**Owns:** `packages/agents`, `packages/workflows/negotiation*`, `hackathon/cubbie-skill`.

- [ ] Submit an independently functioning Cubbie Skill before the Track 1 deadline.
- [ ] Implement DM/group agent routing and structured agent requests/responses.
- [ ] Build dinner task intake, option evaluation, hard-constraint filter, voting/approval.
- [ ] Build persisted group task timeline and decision-state transitions.
- [ ] Add campus resource-matching workflow after dinner vertical slice works.

**Done:** A group task coordinates 2+ distinct personal agents and produces an authorized executable proposal.

### Shared-team rules

1. **Hour 0–1:** Freeze `packages/contracts` with `InboundMessage`, `ContextRequest`, `CoordinationRequest`, `Quote`, and `VerifiedAuthorization` and publish fixtures. No parallel edits to those contracts without a quick team review.
2. Each human developer has one Git worktree/branch; coding-agent subagents work on isolated files and test suites.
3. Expose mocks for external dependencies on day one (fake iMessage webhook, fake context response, fake checkout status) so teams can integrate continuously.
4. Merge working vertical paths often; avoid waiting until hour 18 to integrate.
5. Keep staging/sandbox keys distinct from live purchasing credentials. Define a spending ceiling and who may authorize live test purchases.

```bash
# After initializing the repo, committing shared contracts, and creating main:
git worktree add ../campus-messaging -b feat/messaging
git worktree add ../campus-context -b feat/context
git worktree add ../campus-commerce -b feat/commerce
git worktree add ../campus-runtime -b feat/runtime
```

---

## 10. 24-hour sequence and hard gates

| Time | Deliverable | Gate / response |
|---|---|---|
| 0–1h | Repo, common contracts, env examples, secrets, test users | **Check group-capable Sendblue access and live merchant access immediately** |
| 1–4h | Messaging fixture+reply; Supermemory broker; sandbox order+payment; simple agent coordinator | Mock everything not yet accessible; do not block integration |
| 4–8h | End-to-end vertical slice in sandbox; mandatory Cubbie skill | **Submit required Skill before Track 1 deadline** |
| 8–12h | Real group agent with multi-user consent/negotiation, private approval, persistent state | Demo passes with no private leakage |
| 12–16h | Provider-verified payment/order, second campus workflow, optional connector | If live merchant unavailable, retain transparent sandbox mode |
| 16–20h | Error handling, duplicate detection, revocation, membership, reconciliation | Freeze integrations after this gate |
| 20–24h | Rehearse, prepare demo fallback, judge presentation, submission | Demonstrate actual evidence, not assertions |

**Kill switches and contingencies**

- If Sendblue group access is blocked, run the identical platform-independent flow in Discord/web while keeping iMessage adapter code and an explicit access limitation.
- If DoorDash/private beta access is blocked, focus on live participating-merchant integration plus Square sandbox.
- If a merchant cannot legally/permissibly execute a purchase, **do not automate around that restriction**. Present verified search/quote separately from checkout.
- If Supermemory indexing is delayed, fall back to pre-seeded user preferences through the same `ContextBroker` contract and label it honestly.
- If a real purchase is used for demo, select a low-cost transaction, obtain payer approval, and plan handling of cancellation/refunds and delivery location.

---

## 11. Judge-facing narrative

**What makes this more than an AI bot:**

1. **One conversation becomes a coordinated transaction.** No repeated manual transfer of preferences and payment logistics.
2. **Individuals retain agency.** The group does not receive the underlying private user memory.
3. **Agents genuinely negotiate.** Distinct owners, different constraints, structured accept/reject/counteroffer protocol.
4. **Transactions are verified.** Merchant/order/payment identifiers and outcomes are shown; uncertainty remains explicit.
5. **Extensible infrastructure.** Any approved connector can expose capabilities; transport adapters make the same engine portable.

### Secondary demo (same engine, different domain)

A student urgently needs a calculator. The group/campus workflow queries **opted-in** personal agents advertising loanable items, finds a compatible nearby person, asks both parties for consent, proposes a meeting location, and stores only the authorized handoff. No purchase is required; this demonstrates generality beyond dinner.

### Demo artifacts to retain

- Provider webhook payload fixture (redacted)
- Timeline of internal agent messages
- Approved vs denied context request trace
- Quote and approval screenshot (without sensitive payment data)
- Provider order/payment status response (redacted)
- Final message in the original group
- Automated duplicate-execution and privacy test results

---

## 12. Starting checklist

- [ ] Create repo and commit this `ARCHITECTURE.md`.
- [ ] Verify Sendblue iMessage **group API** eligibility and get an inbound/outbound test.
- [ ] Identify one realistically accessible **live** merchant payment+order path.
- [ ] Create accounts: Supermemory, Supabase, Redis host, Square sandbox, Stripe test, provider(s).
- [ ] Freeze shared TypeScript contracts and seed test users/group.
- [ ] Implement local end-to-end fixture before depending on any external integration.
- [ ] Submit required hackathon Skill early.
- [ ] Prove one purchase or explicitly mark demo checkout as sandbox.
- [ ] Run privacy, duplicate, authorization, and failed-transaction tests.
- [ ] Rehearse one coherent live demo, with a transparent fallback.

## Sources and implementation references

- [Sendblue group messaging: beta, plan access, group IDs](https://docs.sendblue.com/getting-started/groups)
- [Sendblue group message endpoint](https://docs.sendblue.com/api/resources/groups/methods/send_message)
- [Supermemory v5 API reference](https://api.supermemory.ai/reference)
- [Supermemory v5 namespaces](https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/container-tags.mdx)
- [DoorDash Developer Services (CLI/MCP private beta)](https://developer.doordash.com/en-US/docs/welcome/)
- [Square Orders API](https://developer.squareup.com/reference/square/orders)
- [Square Sandbox](https://developer.squareup.com/docs/devtools/sandbox/overview)

> **Scope note:** This document is an architecture and implementation plan, not a claim that the listed third-party provider accounts or restricted API permissions have already been provisioned. Validate provider access and terms before implementation or demo claims.
