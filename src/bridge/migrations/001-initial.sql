CREATE TABLE controller (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  bound_at_ms INTEGER NOT NULL CHECK (bound_at_ms >= 0),
  UNIQUE (account_id, user_id)
) STRICT;

CREATE TABLE ilink_state (
  account_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  context_token TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE inbound_messages (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  controller_user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  context_token TEXT NOT NULL,
  body TEXT,
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  UNIQUE (account_id, controller_user_id, message_id)
) STRICT;

CREATE TABLE bindings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  thread_id TEXT NOT NULL,
  project_path TEXT,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE notification_routes (
  event_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  delivered_at_ms INTEGER NOT NULL CHECK (delivered_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= delivered_at_ms)
) STRICT;

CREATE TABLE queued_turns (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE INDEX queued_turns_thread_fifo
  ON queued_turns (thread_id, id);

CREATE TABLE dispatch_intents (
  operation_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'unknown')),
  turn_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (status != 'accepted' OR turn_id IS NOT NULL),
  CHECK (status = 'pending' OR body IS NULL)
) STRICT;

CREATE TABLE outbox (
  client_id TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL,
  context_token TEXT NOT NULL,
  body TEXT,
  body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  confirmed_at_ms INTEGER,
  CHECK (status != 'confirmed' OR (body IS NULL AND confirmed_at_ms IS NOT NULL))
) STRICT;

CREATE INDEX outbox_pending_fifo
  ON outbox (status, created_at_ms, client_id);

CREATE TABLE bridge_runtime (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  arbitration_enabled INTEGER NOT NULL CHECK (arbitration_enabled IN (0, 1)),
  instance_id TEXT NOT NULL
) STRICT;

CREATE TABLE ilink_session (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  bot_id TEXT NOT NULL,
  controller_user_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  protected_token TEXT NOT NULL,
  FOREIGN KEY (bot_id, controller_user_id)
    REFERENCES controller (account_id, user_id)
) STRICT;

CREATE TABLE bridge_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  main_thread_id TEXT,
  selected_project_path TEXT
) STRICT;

INSERT INTO bridge_settings (singleton, main_thread_id, selected_project_path)
VALUES (1, NULL, NULL);
