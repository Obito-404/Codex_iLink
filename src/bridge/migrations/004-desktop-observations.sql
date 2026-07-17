CREATE TABLE IF NOT EXISTS desktop_turn_observations (
  thread_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  stop_seen_at_ms INTEGER,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
) STRICT;
