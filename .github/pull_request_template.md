## What

<!-- One or two sentences. Keep PRs under ~1 hour of work (spec 18.6 rule 8). -->

## Owner / package

- [ ] I only changed packages I own (or this PR is to the owner)
- Package(s):

## Contract change?

- [ ] **Yes — this touches `packages/contracts/`** → add the `contract-change` label; all four review within ~15 min; P1 merges. Additive only after M0 (no breaking renames).
- [ ] No

## Checklist

- [ ] Migrations (if any) are new timestamped files in my own `packages/db/migrations/<owner>/` folder; no edits to applied files
- [ ] Incomplete work is behind a `USE_REAL_*` flag (default off)
- [ ] `pnpm check` passes locally (lint, format, typecheck, tests)
- [ ] Shared acceptance tests (`tests/integration`) still green
- [ ] No secrets, tokens or real phone numbers in code, logs, fixtures or this description
- [ ] Security-critical paths reviewed by the pair (P1↔P4 pipeline/gateway, P2↔P3 auth gate/broker)
