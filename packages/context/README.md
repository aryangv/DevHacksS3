# @campus/context — P3 Memory

Supermemory v5 memory, consent and the deterministic Context Broker (harness-spec §5, §18.8 P3).
Implements the P3 interfaces in `@campus/contracts` (`interfaces/p3.ts`, `schemas/context.ts`).

## Turning it on

`createContextModule` is the `REAL_MODULES.context` factory. In `.env`:

```
USE_REAL_MEMORY=true
RUNTIME_STORE=postgres          # required: the broker reads tasks/consent from Postgres
DATABASE_URL=...                # postgres://… or pglite://…
SUPERMEMORY_API_KEY=...         # server only
# SUPERMEMORY_BASE_URL=         # optional override (tests point it at a local fake)
# SUPERMEMORY_SCOPED_KEYS=false # only if the plan cannot mint scoped keys
```

`pnpm db:migrate` applies `packages/db/migrations/p3/20261024120000_p3_context.sql` after P1's initial schema.

## What the pipeline gets (ContextModule)

| Slot | Implementation | Notes |
|---|---|---|
| `memoryStore` | `DefaultMemoryStore` | `user_{uuid}` / `group_{uuid}` from the principal; no method takes a namespace. Writes use `dreaming: "instant"`; reads filter expired and pending-deletion items. |
| `memoryPolicy` | `DefaultMemoryPolicy` | Unverified author → no; only the owner's own words in their namespace; groups keep `decision`s by current verified members; honours `memory_settings`; redacts secrets. |
| `broker` | `DefaultContextBroker` | Registry fields only. Raw fields (`meal.max_price_per_person_minor`, `meal.required_tags`, `meal.avoid_cuisines`) go **only** to the subject's own agent; `meal.price_band` / `availability.free_slots` to the task's group with consent. Values are derived from the subject's own memory by deterministic rules (or a seeded preference), validated by `CONTEXT_FIELDS`; unknown values are omitted. `disclose` gates `tool:<server>__<tool>` results before they reach a group. |
| `consent` | `DefaultConsentService` | `getMemorySettings`, `hasActiveGrant` (standing grants). |
| `buckets` | `DefaultBucketProvisioner` | Init doc → supportingContext → spec 5.6 buckets (never the built-in `preferences`); lazily on first write. |

Beyond the interfaces (cast to the class, or use `createContextServices`):
- consent page (P2): `consent.listPending / approve / decline / grant / revoke / listGrants / updateMemorySettings`
- forget/delete (spec 5.8): `memoryStore.previewForget → applyForget`, `forgetMemory`, `deleteUserMemory`, `removeMemberContent`
- worker jobs (P1): `memoryStore.processPendingCleanup()` every ~10 s, `memoryStore.purgeExpired()` hourly
- trace view: `contextTrace(repo, taskId)` — decisions with stage and reason, never values

## Conventions P3 relies on (please review, P1/P2)

- Grants: audience `agent` + `personal:<userId>` (own agent), `group` + `group:<conversationId>` or `group:*`
  (any group the user is currently in). Self-reads by a personal agent need a grant (as in `fixtures/consent.ts`);
  with none, the broker returns `needs_consent` and creates a consent request for P2's page.
- The factory receives no TaskStore/IdentityService, so `Directory` reads `core.agent_tasks`,
  `core.conversations` and `core.external_identities` (read-only) and uses `MembershipService.listActiveMembers`.
  If P1 adds those to `ContextModuleFactory` deps, swap the reads.
- `DiscloseResult` has no `needs_consent`; a missing grant returns `{ allowed: false, reasonCode: "consent_required" }`
  and files a consent request.
- P3-owned contract files touched: `audit-actions.p3.ts`, `error-codes.p3.ts`, `config.p3.ts` (additive).

## Verified against live Supermemory v5 (2026-10-24)

Namespaces `^[a-zA-Z0-9_:-]{1,100}$`; a namespace exists only after its first write (settings 404 before);
re-adding a document id appends; scoped keys (`POST /v3/auth/scoped-key`) are enforced (403 elsewhere) but can
delete their own namespace, so admin ops stay on the org key; the built-in `preferences` bucket can be silently
overwritten; `instant` dreaming forms memories in ~35 s vs >3 min; bucket classification and semantic forget are
not dependable per call; deleting a still-processing document is refused inside a 200 (queued + hidden + retried);
profile entries carry no metadata (expiry is filtered server-side via `expires_at`).

## Tests

```bash
pnpm vitest run packages/context                        # unit: real migrations on PGlite + FakeSupermemory
pnpm vitest run tests/integration/memory-real.test.ts   # P1's container + pipeline with USE_REAL_MEMORY=true
P3_LIVE=1 pnpm vitest run packages/context/tests/live   # real Supermemory (opt-in; key from repo-root .env)
```
