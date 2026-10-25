-- P2 (front door) — additive migration on top of p1/20261024000000_initial_schema.sql (harness-spec §4.3, §8).
-- Owner: P2. Never edit another owner's migration; additive changes only after M0 (§18.6).

-- Transport: iMessage via BlueBubbles. external_id is the iMessage handle address: a phone number
-- (E.164) or an Apple ID email.

-- When this person last messaged the bot (DM or a group the bot is in). Null = never.
ALTER TABLE core.external_identities ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;
CREATE INDEX IF NOT EXISTS external_identities_user ON core.external_identities (user_id) WHERE user_id IS NOT NULL;

-- One verification attempt started from the onboarding page (§4.3 steps 3–5), "inverted OTP"
-- self-built (§16 open decision 3): the page shows a short code, the person texts it to the bot
-- FROM the address being verified, and the inbound webhook matches (address, code). Only the code's
-- hash is stored. browser_token_hash binds the attempt to the browser that started it: only that
-- browser may exchange an approved attempt for a web session (browser events are never trusted alone).
CREATE TABLE core.verification_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_identity_id uuid NOT NULL REFERENCES core.external_identities(id),
  challenge_id uuid REFERENCES core.auth_challenges(id),
  origin_conversation_id uuid REFERENCES core.conversations(id),
  provider text NOT NULL DEFAULT 'imessage_code' CHECK (provider IN ('imessage_code')),
  code_hash text NOT NULL,
  address text NOT NULL,
  display_name text,
  browser_token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','expired','failed')),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_sessions_identity ON core.verification_sessions (external_identity_id, created_at DESC);
CREATE INDEX verification_sessions_pending ON core.verification_sessions (address) WHERE status = 'pending';

-- Signed-in web sessions (onboarding, connections, consent settings, approval page). Only a hash of
-- the cookie token is stored. Created only after a server-confirmed phone verification.
CREATE TABLE core.web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX web_sessions_user ON core.web_sessions (user_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS conversation_members_identity ON core.conversation_members (external_identity_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.verification_sessions, core.web_sessions TO campus_app, campus_gateway;
