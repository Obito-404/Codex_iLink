CREATE TABLE IF NOT EXISTS desktop_turn_observation_tombstones (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  stopped_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  PRIMARY KEY (thread_id, turn_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_desktop_observation_tombstones_expiry
ON desktop_turn_observation_tombstones (expires_at_ms);
