# P4 approvals

Backend logic only. No UI, messaging, identity, runtime, or competing audit writer.

`ApprovalService` implements the P4-local structural `ApprovalService` bridge used by tools.
`create` returns a six-digit code or a random 256-bit web token **only to trusted server code**.
P1/P2 deliver it privately; never include it in model context or trace details. Only keyed hashes
are stored. `decideText` parses an exact `YES 123456` / `NO 123456` from an injected verified
own-DM context; raw LLM output cannot grant approval. Five failed attempts lock the challenge.
Default expiry is five minutes (configurable up to ten). Approval is bound to the full proposal
with HMAC-SHA256; `consume` is single-use, including concurrent requests.

`PostgresApprovalStore` uses P1's existing `core.pending_approvals`; it does not create or alter
that table. P4's `mcp.approval_security` adds channel, attempt count, and one-time consumption.
Its transaction locks both rows. Supply P1's transactional SQL adapter; an audit adapter using
the same locked DB connection must not recursively lock approval rows.

P2 route wiring (authenticated server session; POST routes require CSRF protection):

| Route | Handler |
|---|---|
| `GET /api/approvals` | `approvalHandlers(service).pending(session)` |
| `POST /api/approvals/:id/decision` | `.decide(session, id, {token, approve, proposal})` |

Show the exact stored redacted proposal. Web token belongs in private page state or a URL
fragment, never in access-log query strings. The proposal sent back for confirmation must
match the original exact object; changing a quote, recipient, arguments, or actor fails.
For sensitive actions with redacted parameters, P1 must retain the exact server-side proposal
and pass that object into `decideWeb`; do not reconstruct secret parameters in the browser.

The generic `spend_handoff` kind can securely record a web approval for an exact proposal, but
**there is no payment/quote engine or spending execution**. Payment-specific quote validation,
provider reconciliation, and Square are gated stretch work, intentionally absent.

Run both P4 suites through `npm --prefix packages/tools test` from the repository root.
Tests/fakes are never exported from the production package.
