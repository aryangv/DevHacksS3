-- P4 only. Requires P1 Section 8 core tables; run using P1 migration runner.
CREATE SCHEMA IF NOT EXISTS mcp;
CREATE SCHEMA IF NOT EXISTS vault;

CREATE TABLE IF NOT EXISTS mcp.servers (
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

CREATE TABLE IF NOT EXISTS mcp.tools (
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  name text NOT NULL,
  description text,
  input_schema_hash text,
  risk_class text NOT NULL CHECK (risk_class IN ('read','write','spend','external_message','destructive')),
  default_mode text NOT NULL CHECK (default_mode IN ('allow','ask','deny')),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, name)
);

CREATE TABLE IF NOT EXISTS mcp.user_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),        -- cross-schema FK: enforceable
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  status text NOT NULL CHECK (status IN ('pending','connected','needs_reauth','revoked')),
  granted_scopes text[] NOT NULL DEFAULT '{}',
  connected_at timestamptz, last_used_at timestamptz,
  UNIQUE (user_id, server_id)
);

CREATE TABLE IF NOT EXISTS mcp.oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES core.users(id),
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  pkce_verifier_ciphertext bytea NOT NULL, key_version int NOT NULL,
  expires_at timestamptz NOT NULL, used_at timestamptz
);

CREATE TABLE IF NOT EXISTS mcp.tool_permissions (
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
CREATE INDEX IF NOT EXISTS p4_permission_lookup ON mcp.tool_permissions (user_id, server_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp.tool_calls (
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
CREATE TABLE IF NOT EXISTS vault.credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES mcp.user_connections(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access_token','refresh_token','api_key')),
  ciphertext bytea NOT NULL, key_version int NOT NULL,
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, kind)
);
