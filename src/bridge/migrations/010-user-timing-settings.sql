ALTER TABLE bridge_settings
ADD COLUMN session_timeout_minutes INTEGER NOT NULL DEFAULT 30
CHECK (session_timeout_minutes BETWEEN 5 AND 1440);

ALTER TABLE bridge_settings
ADD COLUMN away_timeout_minutes INTEGER NOT NULL DEFAULT 5
CHECK (away_timeout_minutes BETWEEN 1 AND 60);

ALTER TABLE bindings
ADD COLUMN expiry_notified_at_ms INTEGER
CHECK (expiry_notified_at_ms IS NULL OR expiry_notified_at_ms >= expires_at_ms);
