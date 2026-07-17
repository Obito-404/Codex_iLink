CREATE TABLE outbound_attachment_intents (
  operation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'image', 'video')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (turn_id, call_id),
  UNIQUE (turn_id, path_key)
) STRICT;

CREATE INDEX outbound_attachment_intents_operation
  ON outbound_attachment_intents (operation_id, created_at_ms, call_id);
