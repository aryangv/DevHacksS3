# P4 read-only Composio integration

Implemented on `p4`, using `harness-spec.md` as the specification. No changes to P1/P2/P3, root configuration, shared contracts, or migrations. No commit, push, or merge.

## Status (2026-10-25)

- Existing baseline: 46 tests passed. Updated suite: 71 tests passed, zero failures. Typecheck, source-boundary lint and formatting checks pass.
- The existing provider uses **legacy direct execution** (`sdk.tools.execute`), not sessions. This implementation retains it. No Tool Router session, toolkit wildcard, remote workbench, proxy execution, purchase, reservation, booking, or payment is enabled.
- The key in `packages/tools/.env` loads. The file is ignored by Git and untracked. Its value and OAuth credentials were never printed. `USE_REAL_TOOLS=false` remains the default.
- All eight search schemas and the two Gmail slugs below were fetched successfully from the live Composio metadata API. Public schemas are captured in `tests/composio-schemas.json`; account data is never captured there.
- **Amazon live execution passed after the project key was updated.** The final bounded search returned `ok`, a successful call record and invoke/result audit events. The untruncated source response contained names, prices, ratings and URLs. Only result shape/boolean checks were printed, never credentials or source text. The previous API-access denial is resolved for direct tool execution.
- **Live Gmail was not executed.** No application user ID or application-owned Gmail connection is configured here. This branch contains only P4 packages and migrations, not P1's application database/runtime. The gateway returned `connection_required`. No Playground account was imported or reassigned.
- **A separate managed Gmail OAuth2 config is now created and verified.** It requests exactly `gmail.readonly`, has Tool Router/session use disabled, and its ID is stored as `COMPOSIO_GMAIL_AUTH_CONFIG_ID` in the ignored `.env`. The existing Playground config was unchanged. The initial optional tool-creation restriction produced HTTP 400; the documented managed-auth request with an explicit scope succeeded after removing that optional metadata. Application tool restrictions remain enforced by P4's explicit gateway/provider allowlists. Runtime still needs Connected accounts read/write, an approved `OAUTH_REDIRECT_BASE`, and the real app user's authenticated OAuth flow. No Gmail tokens were fetched or printed.

## Approved catalog and policies

`readOnlyComposioIntegrations({ searchId, gmailId, gmailAuthConfigId })` returns server rows and operator-only provider configuration. Use actual server UUIDs in Postgres. Merge these configs with Stage 1's existing integrations before constructing the single Composio provider.

Search toolkit `composio_search`, pinned version `20260903_00`:

- `COMPOSIO_SEARCH_AMAZON`
- `COMPOSIO_SEARCH_WALMART`
- `COMPOSIO_SEARCH_SHOPPING`
- `COMPOSIO_SEARCH_GOOGLE_MAPS`
- `COMPOSIO_SEARCH_FLIGHTS`
- `COMPOSIO_SEARCH_HOTELS`
- `COMPOSIO_SEARCH_TRIP_ADVISOR`
- `COMPOSIO_SEARCH_EVENT`

Gmail toolkit `gmail`, pinned version `20261018_00`:

- `GMAIL_FETCH_EMAILS`: inbox/search using Gmail query syntax; metadata by default, up to 20 messages per call. Request `verbose: true, include_payload: true` only when message content is needed for a summary.
- `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`: retrieve a message ID obtained from a real search result; `format: 'full'` for body-based summaries.

Both Gmail tools require `https://www.googleapis.com/auth/gmail.readonly`. The model never supplies `user_id`; P4 removes it from discovery schemas and injects `me` during execution. Every account check filters by the trusted application user ID, configured auth config and toolkit. Composio manages OAuth tokens/refresh; the P4 vault stores only its connected-account reference for this integration. Absent scope metadata fails closed.

All ten operations are `read`, default `allow`, still subject to user permission rules, approvals and hard gateway checks. Gmail is sensitive: an `ask` rule requires web approval. Gmail send, forward, reply, draft, delete, trash, label, settings and other tools are excluded; provider and gateway checks reject them even under wildcard allow. Other Stage 1 integrations retain their separately reviewed policies.

## P1 invocation interface

Continue using the existing dependency-injected `ToolGateway`:

```ts
const visible = await gateway.availableTools(ctx);
// Expose each manifest as modelName + inputSchema. Never expose provider SDK access.

const amazon = await gateway.execute(ctx, {
  proposalId: crypto.randomUUID(),
  server: 'composio_search',
  tool: 'COMPOSIO_SEARCH_AMAZON',
  args: { query: 'wireless bluetooth headphones', amazon_domain: 'amazon.com' },
});

const gmail = await gateway.execute(ctx, {
  proposalId: crypto.randomUUID(),
  server: 'gmail',
  tool: 'GMAIL_FETCH_EMAILS',
  args: { query: 'in:inbox is:unread', max_results: 5 },
});
```

`ctx: TurnContext` is constructed by the harness from verified identity, conversation and task state, never from model arguments. The local interface is in `src/ports.ts` pending P1's published contracts. Stable proposal IDs identify retries; a failed or successful executed proposal cannot be blindly replayed. Create a new deliberate proposal after a read-only transient failure. Existing per-user/conversation/turn budgets and timeouts remain active.

Before search discovery, explicitly enable public search for an authenticated application user:

```ts
await connections.connectPublicSearch(webSession, searchServerId);
```

This creates a per-user local connection; public search has no OAuth account and never uses the project key as a user's credential. Without a local connection, search remains invisible. Do not auto-enable it from model-controlled arguments.

Use `composioFromEnv(env)` in P1's real-tools dependency-injection branch. It requires `USE_REAL_TOOLS === 'true'` and `COMPOSIO_API_KEY`; absent/false flags fail closed. Persist returned server rows using P1's bootstrap/seed mechanism, instantiate `ComposioProvider`, and inject the same provider/config into `ConnectionService` and `ToolCatalog`, then into the existing gateway. Use the production Postgres store, restricted-role vault, real audit writer, real approval service and P3 disclosure broker. No HTTP routes or production DB are silently registered by the config helper.

Results retain the existing `GatewayResult` envelope:

- `ok`: source data plus `{ server, tool, untrusted: true }` provenance.
- `pending`: approval ID/channel; resume with the same proposal and approved ID.
- `connection_required`: safe reason code and authenticated connection flow below.
- `denied`, `error`, `unknown`: safe reason code. API-access denial does not masquerade as a user revocation. Rate limits use `composio_rate_limited`; upstream failures have sanitized codes and are audited. No unlimited retries.

P1 generates plain-text iMessage replies from source data. Preserve supplied names, prices, ratings, URLs, dates, destinations and other travel details. Missing values stay unknown; search links are not bookings. Fetch actual message content before claiming to summarize its body. Emails/tool results remain untrusted data, never instructions. Existing output redaction/truncation limits apply (16 KB); a truncated response is explicitly marked. Do not infer facts from omitted or truncated content. Group output still requires the existing broker disclosure check.

## Gmail OAuth handoff for P2's existing application

For a missing, expired/revoked or missing-credential connection:

```json
{
  "status": "connection_required",
  "reasonCode": "connection_unavailable",
  "connection": {
    "server": "gmail",
    "startPath": "/connections/gmail/start",
    "authenticationRequired": true
  }
}
```

`startPath` is the application route P2 must register, not a ready-made Composio OAuth URL. Surface an absolute link on the configured application origin in the user's own DM/connections UI. After authentication, require the existing CSRF-protected connect action and call `connectionHandlers(connections).start(trustedWebSession, gmailServerId)`. This returns `{ authorizationUrl, expiresAt }`. Redirect the authenticated browser to that URL. Keep it out of model context, group messages, access logs and audit payloads.

The existing `ConnectionService.initiate` calls `connectedAccounts.link` with `session.userId` and PRIVATE account type. It stores encrypted, short-lived, session-bound state and the issued account ID. P2 registers `/oauth/callback/gmail`, passes its authenticated session and callback query to the existing callback handler, and redacts query strings from access logs. Callback validates single-use state, user/session/account binding, ACTIVE upstream account and actual granted scopes before saving the connection. The browser must return with the same authenticated session. Reconnect uses the same flow; a revoked/expired connection is invisible until authorized again. Do not reuse a Playground user ID or copy raw Google tokens into the app.

## Reproduce checks

From `packages/tools`:

```powershell
npm test
npm run typecheck
npm run lint
npm run format:check
node scripts/inspect-composio.mjs
# Explicit external configuration; writes only the config ID to ignored .env after creation:
node scripts/configure-gmail.mjs --configure-gmail
# One fixed Amazon read through the real gateway, with in-memory stores/audit:
node scripts/live-readonly.mjs --live-readonly
```

The smoke script enables real tools only inside that bounded process; it does not edit the application's feature flag. It accepts no arbitrary tool/argument input, prints no source results or credentials, uses real gateway/permission/approval/provider code, and reports Gmail connection-required against its empty in-memory connection store. It cannot demonstrate a production Gmail connection. After P1 runtime wiring and user OAuth, run the Gmail proposal above in the application with that user's verified context; inspect status/count only, without logging email bodies. No unrestricted live execution is enabled.

Final retest after key replacement: all 71 tests, typecheck, lint and formatting checks passed. Amazon returned `ok` with audited success and source name/price/rating/URL fields. Gmail returned `connection_required`, with the auth config present and application user/connection still absent. `USE_REAL_TOOLS=false` remains explicitly set. End-to-end Gmail validation is the remaining live acceptance gate.

Windows sandbox blocked Node test subprocesses (`spawn EPERM`); the suite passed when run with the approved process permission. The temporary test-assertion failure during development was fixed; final suite is green.

## Files changed

- `src/composio-readonly.ts`: explicit policies, pins, server/config factory and hard tool restrictions.
- `src/providers.ts`: public-search execution, filtered discovery, Gmail `me` binding/read limits, tracing off, sanitized failure codes.
- `src/connections.ts`: explicit public-search connection; upstream outages/access denials do not revoke Gmail.
- `src/gateway.ts`: hard allowlist checks and structured connection-required result after auditing.
- `src/config.ts`, `src/index.ts`, `src/http-handlers.ts`: guarded env factory, public exports and existing handler extension.
- `.env.example`: Gmail auth-config and optional live app-user settings; default real tools off.
- `tests/composio-readonly.test.ts`, `tests/composio-schemas.json`: 25 new tests using verified provider schemas.
- `tests/providers.test.ts`: assert the new specific, sanitized account-owner-mismatch code.
- `scripts/inspect-composio.mjs`, `scripts/configure-gmail.mjs`, `scripts/live-readonly.mjs`: bounded metadata/config/smoke commands.
- `COMPOSIO-INTEGRATION.md`, `README.md`: integration guide and observed blockers.

## Provider references (capabilities only; project behavior follows harness-spec.md)

- [API-key permission areas](https://docs.composio.dev/kb/guide/platform-project-api-key-permissions)
- [Legacy direct execution](https://docs.composio.dev/docs/tools-direct/executing-tools)
- [Composio Search catalog](https://docs.composio.dev/toolkits/composio_search)
- [Gmail catalog](https://docs.composio.dev/toolkits/gmail)
