-- P3 (Memory) — additive. Group chat memory: every message in a group chat the assistant is in
-- (team decision, overriding harness-spec 5.3's "never ingest unverified" for group chats) is batched
-- into the group's Supermemory namespace by a worker job (~every 60 s).
-- One row per core.messages row already sent to Supermemory, so a batch is never sent twice.
CREATE TABLE core.group_memory_ingested (
  message_id uuid PRIMARY KEY REFERENCES core.messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'ingested' CHECK (outcome IN ('ingested','skipped')),
  ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_memory_ingested_conversation ON core.group_memory_ingested (conversation_id, ingested_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.group_memory_ingested TO campus_app, campus_gateway;
