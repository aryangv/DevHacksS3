# Development guide — SYNQ

A student coordination assistant in iMessage: personal agents per student, a group agent per group chat,
private agent-to-agent coordination, and verified actions. Design: [ARCHITECTURE.md](../ARCHITECTURE.md);
build spec: [harness-spec.md](../harness-spec.md) (the source of truth for this repo).

This repo is a TypeScript modular monolith (pnpm workspaces). **P1 (Spine)** has landed the scaffold:
contracts, database, interfaces, in-memory fakes, the deterministic turn pipeline, agents, the
coordinator, a real Claude-backed `ModelClient`, a trace API and a chat simulator. P2–P4 build real
implementations of the interfaces and swap them in behind feature flags.

## Quick start

Requires Node ≥ 22.12 and pnpm 9 (`npx pnpm@9.12.3 …` works if pnpm isn't installed).

```bash
pnpm install
pnpm sim demo        # dinner vertical slice end to end on fakes, with audit trace
pnpm sim repl        # interactive: "dm avery hi", "group blake @agent dinner under $20", "verify devon"
pnpm check           # lint + format check + typecheck + all tests
```

To use a real model, copy `.env.example` → `.env` (gitignored; all `pnpm` run scripts load it) and set
`USE_REAL_MODEL=true`, `MODEL_PROVIDER=gemini` (or `anthropic`) and `MODEL_API_KEY=…`.

No Docker? Use Postgres-in-WASM: `DATABASE_URL=pglite://./.data/pglite pnpm db:migrate`.
With Docker: copy `.env.example` → `.env`, set the local passwords, then `docker compose up -d && pnpm db:migrate`.

Run services:

```bash
pnpm dev:api         # Fastify: /healthz, /trace/*, webhook/OAuth/approval route slots (P2/P4)
pnpm dev:worker      # queue worker (needs RUNTIME_STORE=postgres to share a queue with the API)
```

With `RUNTIME_STORE=memory` the API runs the worker in-process.

## Layout (spec Section 10) and owners (spec 18.2)

| Path | Owner | What |
|---|---|---|
| `packages/contracts` | P1 | Zod schemas (Section 9), interfaces for every role, error codes / audit actions / events (one file per owner), config loader, fixtures, in-memory fakes, logger with redaction, `KeyedMutex`, `insertIdempotent` |
| `packages/db` | P1 (+ per-owner migration folders) | Migration runner, Section 8 schema, roles/grants (`campus_app` cannot read `vault.*`), Postgres repos for P1 stores |
| `packages/harness` | P1 | Turn pipeline (4.2), router, agent runtime (model step → gateway → approvals), budgets, rate limits, structured output + single retry, `AnthropicModelClient`, queue worker |
| `packages/agents` | P1 | `PersonalAgent`, `GroupAgent`, in-process coordination bus, deterministic coordinator |
| `apps/worker` | P1 | DI container + feature flags, worker process, chat simulator |
| `apps/api` | P1 shell; P2 webhooks; P4 OAuth/approvals | HTTP server, trace API |
| `packages/messaging`, `packages/identity`, `apps/web` | P2 | iMessage via BlueBubbles, sign-up by texted code, auth gate, nudges, membership, web pages ([setup](../apps/web/README.md)) |
| `packages/context`, `hackathon/cubbie-skill` | P3 | Supermemory v5, broker, consent, buckets, forgetting; Cubbie Skill |
| `packages/tools`, `packages/approvals`, `packages/workflows` | P4 | Catalog, gateway, permissions, vault, OAuth, approvals; payments (stretch) |
| `tests/integration` | P1 (others contribute by PR) | Shared acceptance tests (18.9) |

**Import rule (enforced by ESLint):** a package may import only `@campus/contracts` and its own files.
Apps and `tests/` are composition roots and may import anything.

## How a turn flows

```
webhook (P2 route) → messaging.verifyWebhook + normalize → pipeline.ingest  [dedupe + enqueue, ack fast]
worker → claimNext (one in-flight turn per conversation, FIFO) → pipeline.processEvent:
  identity + membership → auth gate (unverified: no model, no memory, rate-limited nudge)
  → route (DM → personal agent; group → group agent only when addressed)
  → text approval reply? ("YES 4821" in a 1:1)
  → agent: context (memory/broker) → model step (strict JSON proposals, 1 retry) → tool gateway → approvals
  → plain-text reply → consent-checked memory write → audit
```

The model never picks the user, conversation, namespace, credentials or recipients. Proposals are
schema-validated (extra keys such as `userId` invalidate the output). Permission changes are honoured
only from the user's own DM, when their own words ask for it, before any tool output was seen.
Money never moves on a chat message: confirming a group plan sends the payer a private web link.

## Swapping a fake for a real implementation

1. Implement the interfaces from `packages/contracts/src/interfaces/p<N>.ts` in your package.
2. Export the factory named in `REAL_MODULES` (`packages/contracts/src/module-factories.ts`):

   | Flag | Package | Export |
   |---|---|---|
   | `USE_REAL_MESSAGING` | `@campus/messaging` | `createMessagingAdapter(deps)` |
   | `USE_REAL_IDENTITY` | `@campus/identity` | `createIdentityModule(deps)` → `{ identity, membership, authGate, nudges }` |
   | `USE_REAL_MEMORY` | `@campus/context` | `createContextModule(deps)` → `{ memoryStore, broker, consent, buckets, memoryPolicy }` |
   | `USE_REAL_TOOLS` | `@campus/approvals` + `@campus/tools` | `createApprovalsModule(deps)`, `createToolsModule(deps)` → `{ gateway, permissions, connections, vault? }` |
   | `USE_REAL_MODEL` | built in (`@campus/harness`) | `MODEL_PROVIDER=anthropic` → `AnthropicModelClient`; `MODEL_PROVIDER=gemini` → `GeminiModelClient` (both need `MODEL_API_KEY`) |

   `deps` carries `config`, `logger` (redacting), `sql` (app role), `audit`, `clock`, plus what your
   module needs (`messaging`, `membership`, `sqlVault`, `approvals`, `broker`).
3. Add required env vars to your own section in `packages/contracts/src/config/config.p<N>.ts` and `.env.example`.
4. Flip the flag at your integration point (I1–I4), run `pnpm sim demo` and `pnpm test`.

If a flag is on but the export is missing, startup fails with a clear `module_not_implemented` error.

## Team rules (spec 18.6)

1. Edit only packages you own (CODEOWNERS); otherwise open a small PR to the owner.
2. `packages/contracts` changes: label `contract-change`, all four review (~15 min), P1 merges; additive only after M0.
3. Migrations: `packages/db/migrations/<owner>/YYYYMMDDHHMMSS_description.sql`; never edit another owner's or an applied file (the runner checksums them).
4. Root config, lockfile, CI, `.env.example` structure: P1. Add dependencies to your own package manifest; on lockfile conflicts rebase and regenerate.
5. `.env.example`: edit only your section.
6. Audit actions, error codes, event names: add to your own `*.p<N>.ts` file.
7. Merge incomplete work behind a flag (default off).
8. Trunk-based: short branches, PRs under ~1 hour, rebase often.
9. Tests live with the owner; cross-package acceptance tests live in `tests/integration` (P1).
10. No secrets in the repo or chat transcripts.
11. Paired review for security-critical code: P1↔P4 (pipeline↔gateway), P2↔P3 (auth gate↔broker).

## Verified vs unverified (spec 3.3)

Built behind interfaces because they are not yet confirmed: Supermemory v5 naming rules, profile filters
and scoped keys (P3); Composio coverage (P4).

**Team decisions that differ from the spec:** iMessage goes through **BlueBubbles** (a Mac running
BlueBubbles Server) instead of Sendblue, so sign-up uses a self-built "text this code to the bot" flow
instead of Sendblue Verify (spec 16 open decision 3). BlueBubbles payload shapes were checked against its
server source; BlueBubbles webhooks are unsigned, so the webhook URL carries a secret. A personal agent
reads its own user's memory by default, and group chats feed the group's memory with everything said
there (spec 5.3 kept for 1:1 chats only). `packages/contracts/src/fixtures/sendblue.ts` is now unused by P2.

**Honesty rule:** sandbox/test transactions are always labelled as simulated, never as real orders.
