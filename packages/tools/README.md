# P4 tool security and integration handoff

Authoritative source: `harness-spec.md`, especially §§6, 8–12, 14, 17, 18.2–18.9.
Repository inspection found only the specification, architecture and README; branch `p4` was
clean. No P1 scaffold/contracts, core tables, roles, app routes, test runner, or teammate
implementations were available. The fallback in §18.3 applies. Root/shared files are untouched.

This is **stage 1: core tool infrastructure**, tested locally. It is not the full
P4 definition of done: live providers, actual Postgres security and teammate wiring
remain acceptance gates. Pre-commit review expanded the passing local suite to 46 tests.

## Run locally

Node 24.10+ (the installed SDK requires Node >=22.22.3). Dependencies are pinned in this
package manifest. P1 owns the future workspace/lockfile; none was created at repository root.

```powershell
npm install --prefix packages/tools --package-lock=false --ignore-scripts --no-audit --no-fund
npm --prefix packages/tools run typecheck
npm --prefix packages/tools run lint
npm --prefix packages/tools run format:check
npm --prefix packages/tools test
```

Tests use dummy values, a real MCP SDK in-memory protocol server, and P4-local fakes. They do
not call live services. `lint` is a package-local AST import-boundary/explicit-any/logging
check plus strict TypeScript checks in `typecheck`; no pre-existing repository ESLint config
exists. Provider credentials and actual Postgres checks remain separate live gates.

## Implemented behavior

- DB-backed catalog with actual discovered schemas/hashes, configurable five-minute TTL,
  explicit force refresh, atomic replacement/removal, reviewed tool allowlist and curated
  descriptions/risk/scope metadata. Expired manifests are never served after refresh failure.
  Empty catalogs are rediscovered on next access. Gateway checks active connection/scopes
  before discovery and again before execution. Disconnected tools never reach the model.
- `ToolProvider` retains the exact §6.1 `id/listTools/callTool` signatures. The custom adapter
  uses the official MCP SDK Streamable HTTP transport (SSE is handled by the SDK); no shell
  spawning or stdio is enabled. It advertises no sampling/elicitation capabilities. Discovery
  credentials travel through a per-request async-local scope because the published
  `listTools(serverId)` signature has no context parameter. Providers never import the vault.
- Composio uses raw schema discovery and single-tool execution, pinned toolkit versions,
  explicit `userId` and `connectedAccountId`, server-side ownership/status verification,
  private connections, no meta-tools/bulk execution/auto-upload, no telemetry or SDK logging.
  OAuth uses the current hosted `connectedAccounts.link` flow, not retired managed initiate.
- OAuth: random 256-bit state, hashed storage, encrypted S256 PKCE verifier/session binding,
  ten-minute expiry, atomic single use, per-server callback, exact authenticated session,
  vault token storage, proactive refresh within sixty seconds of expiry, refresh serialization,
  fail-closed `needs_reauth`, revocation even if upstream fails. Composio manages its upstream
  refresh; inactive/revoked managed accounts become unavailable. Requested scopes are never
  assumed granted. If managed-account scope metadata is unavailable, affected tools stay hidden.
- AES-256-GCM envelope encryption with fresh data key and independent IVs, wrapped by a
  versioned 256-bit environment key allowed by §6.4 for the hackathon. Authenticated context
  binds user/connection/kind/version; retain old keys for rotation. SQL vault client must
  initialize against a distinct non-superuser/non-BYPASSRLS role; it rejects app SELECT or
  app membership in the gateway role and checks connection ownership on every operation.
- Gateway injects identity/connection/authority; rejects forged fields and unknown/malformed
  arguments, applies permission/risk caps, exact approvals, persistent per-user/turn/conversation
  budgets, fifteen-second default timeout, persistent proposal dedupe, untrusted provenance,
  exact-credential and structured redaction, 16 KB output truncation, call/audit records.
  External-message recipients require operator-declared `trustedArgumentNames` and P1-injected
  `toolArgumentBindings`; those parameters are removed from model schemas and cannot be proposed.
- Permission precedence: tool+conversation > tool > server+conversation > server > risk
  default > global fallback. Equal tier: deny > ask > allow. All specified risk defaults are
  present, so the global fallback is normally unreachable. Expired/revoked rules are ignored.
  Constraints currently support integer `maxAmountMinor` against `args.amountMinor`, and exact
  HTTPS `allowedDomains` against `args.url`. Unknown/missing constraints fail closed, including
  rules in a winning specificity tier. Spend never auto-allows; wildcard rules do not apply
  to spend/destructive. Destructive auto-allow needs a confirmed per-tool rule.
- `PermissionResolver.proposeChange/applyChange` is the backend for `permissions.update`.
  Only P1-attested own DM provenance is accepted; all persistent changes (including broad
  server/risk rules) require explicit exact-action text confirmation. Includes expiry,
  risk-wide changes, list-current-rules and confirmed reset to ask. Spend grants are capped.
- Group outputs fail closed without `ContextBroker.disclose`; only its unexpired approved
  projection is returned. P1 must recheck before a later send, especially after membership/
  consent changes or queued delivery. Permission to read is never permission to disclose.
- Every tool attempt/decision, catalog refresh, permission/approval change, connection change,
  OAuth failure and credential operation uses the injected AuditLog. Arguments are hashed,
  never logged; rationale/provider errors are not persisted. No new audit infrastructure.

## Required P1 integration

No canonical contracts were changed or created. The local bridge types are in
`src/ports.ts` and `../approvals/src/ports.ts`. Replace their imports with P1's canonical
contracts after agreement; these unspecified method shapes are **provisional**, not claimed
to be published contracts. P1 should review this security-critical integration per §18.6.11.

| Shared surface | P4 expects / mapping |
|---|---|
| `ToolProposal` | Exact §9 fields; strict schema, no actor/session/connection fields |
| `PermissionRule` | §9 fields plus local persistence ID/source/confirmed/revoked metadata |
| `ToolManifest` | name, description, JSON input schema, risk class, default mode, required scopes; optional sensitive/trusted argument policy |
| `ToolProvider` | Exact §6.1 interface; credentials injected in `CallContext` |
| `TurnContext` | verified actor, conversation/group type, stable turn/task/agent IDs, purpose, verified private approval conversation; optional own-DM instruction provenance and trusted argument bindings |
| `AuditLog` | awaited `record({actorUserId, action, resource, policyResult, detail})`; map actions into P1's enum file and existing writer |
| `Sql` | parameterized `query`; `transaction(fn)` pinned to one connection, nested transactions/savepoints supported (catalog/policy methods may nest under a connection lock) |
| `ToolGateway` | `availableTools(ctx)` then `execute(ctx, proposal, approvalId?)`; preserve proposalId across resume/retry; never execute pending requests automatically |
| `PermissionResolver` | `resolve(ctx, connection, manifest, args?)`, confirmed propose/apply changes and current-rules listing |
| `ApprovalService` | `create/consume` structural port; use the P4 implementation in the approvals package; P1 parses/routs own-DM responses into `decideText` |
| `ConnectionService` | list/initiate/callback/revoke and server-only credential resolution; P2 receives only public handlers |
| `VaultClient` | server-only put/get/delete; never expose vault or provider clients as model tools |

P1's DI owns all concrete construction: instantiate `PostgresToolStore` using the application
pool; use a **separate restricted pool** for `PostgresVaultClient`, call `initialize`, construct
the cipher from env, approvals, providers, catalog, connection service, permission resolver,
gateway. `deliverApproval` must route only to the verified user's private DM or authenticated
private web page. Never put approval codes/tokens into model prompts. Keep `USE_REAL_TOOLS=false`
until integration gates pass. Do not import P2/P3 implementation classes into these packages.
P1 must keep immutable/provenance-protected contexts out of model-controlled data. P4 does not
reimplement identity or membership verification. P1 supplies approved session/recipient bindings.

`callStart` persists intent before network execution and atomically enforces budgets. Once an
execution starts, duplicate proposal IDs never execute again, including after process crashes.
Write failures/timeouts remain unknown; do not mint a new proposal ID to retry an uncertain
action. P1 must reconcile provider status before any fresh attempt. MCP metadata/HTTP retry
support is not advertised as provider-side idempotency; current shipped integrations are reads.

## P2 route wiring

Use `connectionHandlers(service)`; P2 retains route ownership, auth/session handling and CSRF.

| Route | Handler |
|---|---|
| `GET /api/connections` | `list(session)` |
| `POST /api/connections/:serverId` | `start(session, serverId)` |
| `DELETE /api/connections/:serverId` | `revoke(session, serverId)` |
| `GET /oauth/callback/:slug` | `callback(session, slug, query)` |

Use a fixed callback per server, not per user. Browser query parameters must never construct
the trusted session. Callback handlers return public status only. Remove code/state/token,
Authorization, cookies and request bodies from HTTP logs. Callback pages should use
`Referrer-Policy: no-referrer`, avoid third-party assets, and redirect to a clean URL afterward.
Preserve the initiating authenticated session through OAuth. Approval page wiring is documented
in the approvals README. `connectionHandlers` route installation is deliberately absent.

For future API-key catalog entries, `connectApiKey` requires an operator-installed
`verifyApiKey(server,key)` that proves scopes upstream; it never trusts browser scope claims.
No extra API-key provider was invented or added. Auth-none entries likewise still require an
explicit P1-provisioned user connection; no disconnected catalog-wide tools are exposed.

## Required P3 integration

Provide `ContextBroker.disclose` with the local structural signature: task/requester/subject,
purpose, named tool field, group audience, redacted candidate data -> §5.7 approved fields +
expiry / denied / needs_consent. P3 enforces current membership, consent, audience, purpose,
sensitivity and probing. This **additional disclose method has no published signature in the
spec**, so the exact local shape needs P1/P3 review; it does not change §5.7 requestContext.
Missing broker is a hard denial. Test doubles are local tests only, never default production DI.

## Database handoff

Only `packages/db/migrations/p4/` was created. P1 retains its migration runner and core setup.
Run files by timestamp after P1's Section 8 core migration (not executable on an empty DB):

1. `202610240001_catalog_vault.sql`: reuse/create exact `mcp.*`/`vault.credentials` tables.
2. `202610240002_security_metadata.sql`: additive manifest schemas/scopes/trusted arguments,
   confirmations, permission risk defaults, approval attempt/consumption data and call indexes.
3. `202610240003_vault_grants.sql`: supply agreed role names through
   `SET p4.app_role = '...'; SET p4.gateway_role = '...';` in the migration runner session.
   It fails on missing/unsafe roles. P1 creates roles and grants ordinary MCP/core table access.

P4 does **not** create/alter P1's `core.pending_approvals` or audit tables. Approval DML uses
the shared core table, as required. Gateway role gets vault CRUD + connection SELECT; general
app role gets no vault rights. Migration/DB owners and superusers remain trusted infrastructure.
`oauth_config` stores the camelCase `OAuthConfig` JSON structure from the local port, including
only a client secret **reference**, never its value. P1 must map its schema representation if
different. Run migration and real-role checks on Postgres before enabling production tools.

## Integrations/configuration

`plannedIntegrations` supplies the exact two planned entries and reviewed risk tables; it is
operator configuration, not an automatic DB/resource installer. P1 seeds/upserts these server
records through its setup using the returned objects and the agreed UUIDs. Current tool names
are verified against primary documentation; input schemas are discovered, never invented.

| Integration | Tools | Risk / grant | Authentication |
|---|---|---|---|
| Official GitHub MCP (custom provider) | `get_me`, `search_repositories` | read/allow; `read:user`; server forced read-only | GitHub OAuth app with PKCE; private vault; GitHub grant revoke |
| Composio Google Calendar | `GOOGLECALENDAR_FREE_BUSY_QUERY` | read/allow; calendar.freebusy scope; private availability, group projection only | Composio private hosted connect link + local state/session; pinned toolkit version |

Required env/config values are listed in `.env.example`. `DATABASE_URL` and
`DATABASE_URL_VAULT` must represent different DB roles. `VAULT_KEY_ID` is the positive integer
current key version; `VAULT_MASTER_KEY` or `VAULT_MASTER_KEY_V<n>` holds canonical base64 of 32
random bytes; keep old versions until all values/PKCE states have rotated/expired.
`APPROVAL_HASH_KEY` is an independent >=32-byte secret decoded by P1 before construction.
The client-secret resolver maps only the configured reference `GITHUB_CLIENT_SECRET`; it must
fail on missing configuration. Never pass arbitrary model-supplied env variable names into it.
`OAUTH_REDIRECT_BASE` must be an HTTPS origin (path `/`, no credentials/query/fragment).
Optional constructor settings: catalog TTL, gateway timeout/call budgets, approval TTL.

## Costs and external evidence

No cloud resources/accounts were created, billing enabled, transactions performed, or live
authenticated provider calls made. Only public documentation/package metadata was fetched
and open-source local dependencies installed. No service charges were incurred by this work.

| Service | Required for P4? | Potential cost/account | Local alternative / credentials |
|---|---|---|---|
| Composio | yes, provider + second integration | account/API key/auth config; free tier subject to quotas; paid usage/add-ons possible | injected SDK fake; real account + Google OAuth needed for live tests |
| PostgreSQL host | yes, same project DB | hosted plans may charge; no separate DB created | local Postgres + P1 tables/roles; general/restricted URLs needed |
| AWS KMS | optional, not used | keys/requests charge; no AWS SDK/resources added | §6.4 env-wrapped AES key for hackathon; explicit configured secret required |
| GitHub | yes, selected custom MCP | account/OAuth app + provider access/plan constraints to verify; do not assume entitlement | local official-SDK MCP fake; own OAuth credentials needed live |
| Google Calendar | yes, selected Composio toolkit | Google account/auth-config, quotas and possible provider requirements | fake schemas/account responses; real user consent needed live |
| Square/payments | gated stretch, excluded | no payment services/accounts/transactions used | not implemented; requires explicit authorization after M3 |

Primary references checked during implementation:

- [GitHub MCP configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
- [GitHub OAuth app code/PKCE flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub OAuth grant revocation](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization)
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
- [Composio connected accounts](https://docs.composio.dev/docs/auth-configuration/connected-accounts)
- [Composio TypeScript tools](https://docs.composio.dev/reference/sdk-reference/typescript/tools)
- [Composio Calendar tools](https://docs.composio.dev/toolkits/googlecalendar)
- [Composio pricing](https://landing.composio.dev/pricing)
- [Google free/busy authorization](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [AWS KMS cost guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/aws-kms-best-practices/cost.html)

These establish interfaces/capabilities, **not evidence of successful live authentication**.

## Remaining gates

Canonical contract mapping/DI, P2 session/CSRF/routes/private delivery, P3 real disclose checks,
P1 core migration + roles/runner, actual Postgres migration/locking/grant tests, GitHub OAuth
app credentials/remote MCP entitlement, Composio API/auth-config + exact toolkit version and
Google granted-scope metadata, live refresh/revoke/callback/invocation smoke tests. The complete
product has not been integrated or demonstrated. The two real provider adapters are implemented,
but their live integration acceptance gates remain blocked by credentials/infrastructure.

## Specification compliance

| Specification requirement | Status | Evidence / outstanding gate |
|---|---|---|
| §§6.1–6.2 catalog, namespacing, caching, providers | implemented locally | catalog/provider tests; real discovery needs credentials |
| §§6.3, 8 OAuth state/PKCE/callback/refresh/revoke | implemented locally | lifecycle + mocked transport tests; live OAuth blocked |
| §§6.4, 8 vault envelope encryption/roles | code + migrations implemented; infrastructure verification blocked | real crypto and role-adapter tests; actual Postgres role tests pending |
| §6.5 checks 1–5 identity/connection/schema/permission/risk | implemented locally | gateway and permission adversarial tests |
| §6.5 check 6 exact low-risk/web approvals | implemented locally | expiry/ownership/replay/provenance tests; P2 delivery/UI pending |
| §6.5 check 7 timeout/idempotency | implemented locally | budgets/concurrency/unknown-outcome tests; actual DB contention test pending |
| §6.5 checks 8–10 safe result/audit/disclosure | implemented locally | redaction/audit/fail-closed broker tests; P1/P3 integration pending |
| §6.6 precedence/ties/scopes/expiry/constraints/hard caps | implemented locally | precedence, risk and constraints tests |
| §6.6 own-DM permissions.update/confirm/revoke/list | implemented locally | persistence/provenance/risk/reset tests; P1 intent dispatch pending |
| §6.7 injection defenses | implemented locally | no trusted tool output, no model authority args, curated tool policy |
| §§8, 18.6 P4-only migrations | implemented; application blocked | no core/runner/role edits; P1 prerequisite tables absent |
| §§9–10, 18.2–18.3 contracts/import ownership/fallback | implemented under fallback | local ports only, AST boundary lint; canonical contracts pending |
| §§11–12 configuration/audit/privacy/limits | implemented locally | fail-fast keys, no credential logs, persistent budgets |
| §14 P4 tests; §18.9 tests 5/6/8 | implemented locally | executed P4 suites; P1 shared acceptance suite absent |
| §§18.4–18.5, 18.8 first custom + second integration | code complete; live verification blocked | GitHub + Composio Calendar configs/adapters; no claimed live success |
| §§18.7–18.9 real P1/P2/P3 integration | blocked | teammate interfaces/implementations absent; mappings above |
| §§8, 18.5, 18.8 payments/order stretch | intentionally not started | M3 prerequisites absent; no explicit authorization |

Full per-file inventory and observed check results are in `IMPLEMENTATION-REPORT.md`.
