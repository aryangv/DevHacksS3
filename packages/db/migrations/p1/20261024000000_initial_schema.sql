-- Initial schema: every table from harness-spec Section 8, verbatim, so other owners rarely need
-- migrations (spec 18.3 item 4). One database, three schemas (core, mcp, vault).
-- Table ownership for FUTURE additive migrations (spec 18.6 rule 3):
--   P1: core.audit_events, core.agent_tasks, core.coordination_events, core.pending_approvals, core.messages
--   P2: core.users, core.external_identities, core.auth_challenges, core.nudges, core.conversations, core.conversation_members
--   P3: core.memory_settings, core.consent_grants
--   P4: mcp.*, vault.*
-- DO NOT EDIT after it has been applied anywhere; add a new timestamped file in your owner folder.

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
-- (see 20261024000100_roles_grants.sql)
