-- Additive P4 metadata omitted from the Section 8 summary DDL.
-- Never alters P1's core.pending_approvals (it must already exist).
ALTER TABLE mcp.tools ADD COLUMN IF NOT EXISTS input_schema jsonb;
ALTER TABLE mcp.tools ADD COLUMN IF NOT EXISTS required_scopes text[] NOT NULL DEFAULT '{}';
ALTER TABLE mcp.tools ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;
ALTER TABLE mcp.tools ADD COLUMN IF NOT EXISTS trusted_argument_names text[] NOT NULL DEFAULT '{}';
ALTER TABLE mcp.tool_permissions ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE mcp.tool_calls ADD COLUMN IF NOT EXISTS turn_id text;
CREATE UNIQUE INDEX IF NOT EXISTS p4_tool_call_idempotency ON mcp.tool_calls(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS p4_tool_call_budget ON mcp.tool_calls(user_id,conversation_id,created_at) WHERE decision='execute';
CREATE TABLE IF NOT EXISTS mcp.permission_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),
  server_id uuid NOT NULL REFERENCES mcp.servers(id),
  risk_class text CHECK (risk_class IN ('read','write','spend','external_message','destructive')),
  mode text NOT NULL CHECK (mode IN ('allow','ask','deny')),
  source text NOT NULL CHECK (source IN ('default','user_dm','admin')),
  expires_at timestamptz, revoked_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mcp.approval_security (
  approval_id uuid PRIMARY KEY REFERENCES core.pending_approvals(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('text','web')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  consumed_at timestamptz
);
