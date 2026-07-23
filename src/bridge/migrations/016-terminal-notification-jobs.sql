CREATE TABLE terminal_notification_jobs (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  cwd TEXT,
  evidence TEXT NOT NULL
    CHECK (evidence IN ('managed-desktop', 'unmatched')),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= captured_at_ms),
  PRIMARY KEY (thread_id, turn_id)
) STRICT;

CREATE INDEX idx_terminal_notification_jobs_expiry
ON terminal_notification_jobs (expires_at_ms);
