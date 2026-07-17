CREATE TABLE pending_desktop_notifications (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  cwd TEXT,
  terminal_status TEXT NOT NULL
    CHECK (terminal_status IN ('completed', 'failed', 'interrupted')),
  PRIMARY KEY (thread_id, turn_id)
) STRICT;

