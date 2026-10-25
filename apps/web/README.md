# apps/web — owner: P2

Onboarding (Sendblue Verify), connections list, consent/memory settings and the approval page UI
(harness-spec 4.3, 18.2). The approval **logic** (quote binding, one-time tokens) is P4's
(`apps/api/src/routes/approvals.ts`, `@campus/approvals`).

Skeleton only: P2 picks the framework (ARCHITECTURE.md suggests Next.js). API keys never reach the
browser; browser/widget events are advisory — always confirm server-side.
