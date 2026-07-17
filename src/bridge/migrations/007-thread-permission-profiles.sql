CREATE TABLE thread_permission_profiles (
  thread_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
