-- P3 (Memory) — additive migration on top of p1/20261024000000_initial_schema.sql (harness-spec §8).
-- Owner: P3. Never edit another owner's migration; additive changes only after M0 (§18.6).

-- Task-scoped grants: "ask for each use" classes (precise location, health, finances)
-- need a grant bound to one task; §8's consent_grants has no column for that.
ALTER TABLE core.consent_grants ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES core.agent_tasks(id);
CREATE INDEX IF NOT EXISTS consent_grants_live ON core.consent_grants (user_id, purpose) WHERE revoked_at IS NULL;

-- ContextResult.needs_consent → consentRequestId (§5.7). Resolved on the consent page (P2 UI).
-- task_id is NULL for disclose checks that arrive without a task (e.g. a tool result in a group reply).
CREATE TABLE core.consent_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),
  task_id uuid REFERENCES core.agent_tasks(id),
  requester_agent_id text NOT NULL,
  purpose text NOT NULL,
  audience_kind text NOT NULL CHECK (audience_kind IN ('group','agent')),
  audience_id text NOT NULL,
  fields text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX consent_requests_user_task ON core.consent_requests (user_id, task_id);
CREATE INDEX consent_requests_pending ON core.consent_requests (user_id) WHERE status = 'pending';

-- Every broker decision: the trace view (§12) and the source for rate/probing limits.
-- Field names and parameter hashes only — never values.
CREATE TABLE core.context_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  mode text NOT NULL CHECK (mode IN ('request','disclose')),
  task_id uuid,
  requester_agent_id text NOT NULL,
  subject_user_id uuid,
  purpose text,
  audience_kind text,
  audience_id text,
  fields text[] NOT NULL DEFAULT '{}',
  field_params jsonb NOT NULL DEFAULT '{}',
  decision text NOT NULL CHECK (decision IN ('approved','needs_consent','denied')),
  stage text,
  reason_code text,
  consent_request_id uuid REFERENCES core.consent_requests(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_decisions_requester_time ON core.context_decisions (requester_agent_id, created_at);
CREATE INDEX context_decisions_probe ON core.context_decisions (task_id, subject_user_id) WHERE decision = 'approved';

-- Provisioned Supermemory namespaces (buckets + supportingContext applied).
CREATE TABLE core.memory_namespaces (
  namespace text PRIMARY KEY,
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','group')),
  principal_id uuid NOT NULL,
  bucket_version integer NOT NULL,
  sensitive_enabled boolean NOT NULL DEFAULT false,
  provisioned_at timestamptz NOT NULL DEFAULT now()
);

-- Deletions Supermemory has not completed. It refuses to delete a document that is
-- still processing (while it is already searchable), so deletes are queued and
-- retried, and reads hide anything queued here.
CREATE TABLE core.memory_cleanup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('document','memory')),
  target_id text NOT NULL,
  reason text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  UNIQUE (namespace, target_kind, target_id)
);
CREATE INDEX memory_cleanup_due ON core.memory_cleanup (next_attempt_at) WHERE done_at IS NULL;

-- "Forget X" previews (§5.8): exactly what was shown is what gets applied.
CREATE TABLE core.forget_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users(id),
  namespace text NOT NULL,
  memory_ids text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz
);

-- Contingency (§13): pre-seeded preferences served through the same broker when
-- Supermemory indexing lags. Always labelled as seeded in traces.
CREATE TABLE core.memory_seed_preferences (
  user_id uuid NOT NULL REFERENCES core.users(id),
  field text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, field)
);
