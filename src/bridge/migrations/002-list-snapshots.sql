CREATE TABLE list_snapshots (
  kind TEXT PRIMARY KEY CHECK (kind IN ('projects', 'sessions')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  project_path TEXT,
  page INTEGER,
  archived INTEGER CHECK (archived IN (0, 1)),
  has_next INTEGER CHECK (has_next IN (0, 1)),
  CHECK (
    (kind = 'projects' AND project_path IS NULL AND page IS NULL
      AND archived IS NULL AND has_next IS NULL)
    OR
    (kind = 'sessions' AND page IS NOT NULL AND page > 0
      AND archived IS NOT NULL AND has_next IS NOT NULL)
  )
) STRICT;

CREATE TABLE list_snapshot_items (
  kind TEXT NOT NULL,
  item_index INTEGER NOT NULL CHECK (item_index > 0),
  project_path TEXT,
  thread_id TEXT,
  archived INTEGER CHECK (archived IN (0, 1)),
  PRIMARY KEY (kind, item_index),
  FOREIGN KEY (kind) REFERENCES list_snapshots (kind) ON DELETE CASCADE,
  CHECK (
    (kind = 'projects' AND project_path IS NOT NULL
      AND thread_id IS NULL AND archived IS NULL)
    OR
    (kind = 'sessions' AND thread_id IS NOT NULL AND archived IS NOT NULL)
  )
) STRICT;
