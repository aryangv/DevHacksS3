-- P1 runtime additions (additive): durable inbound queue, trace columns on audit_events,
-- optimistic-concurrency version on agent_tasks.

-- Durable inbound queue (spec 4.2 steps 2–3, 4.7): dedupe on (platform, provider_message_id),
-- per-conversation FIFO, retries with backoff, dead-letter for poison messages.
-- `message` holds the normalized InboundMessage (contains phone numbers: purge done rows per retention).
CREATE TABLE core.inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  platform text NOT NULL,
  provider_message_id text NOT NULL,
  conversation_key text NOT NULL,
  message jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts int NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (platform, provider_message_id)
);
CREATE INDEX inbound_events_open_idx ON core.inbound_events (conversation_key, seq) WHERE status IN ('pending','processing');
CREATE INDEX inbound_events_pending_idx ON core.inbound_events (seq) WHERE status = 'pending';

-- Trace view support: query a turn's or conversation's timeline in insertion order.
ALTER TABLE core.audit_events ADD COLUMN turn_id uuid;
ALTER TABLE core.audit_events ADD COLUMN conversation_id uuid;
ALTER TABLE core.audit_events ADD COLUMN seq bigserial;
CREATE INDEX audit_events_turn_idx ON core.audit_events (turn_id, seq);
CREATE INDEX audit_events_conversation_idx ON core.audit_events (conversation_id, seq);

-- Optimistic concurrency for task state transitions.
ALTER TABLE core.agent_tasks ADD COLUMN version int NOT NULL DEFAULT 0;
CREATE INDEX agent_tasks_active_idx ON core.agent_tasks (conversation_id, type, created_at DESC);
CREATE INDEX coordination_events_task_idx ON core.coordination_events (task_id, created_at);

-- New sequences/tables are covered by the default privileges from the roles migration; be explicit anyway.
GRANT SELECT, INSERT, UPDATE, DELETE ON core.inbound_events TO campus_app, campus_gateway;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO campus_app, campus_gateway;
