ALTER TABLE inbound_messages
ADD COLUMN accepted_at_ms INTEGER NOT NULL DEFAULT 0
CHECK (accepted_at_ms >= 0);

UPDATE inbound_messages
SET accepted_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER);

CREATE INDEX dispatch_intents_turn_id
  ON dispatch_intents (turn_id)
  WHERE turn_id IS NOT NULL;

CREATE INDEX inbound_messages_terminal_retention
  ON inbound_messages (accepted_at_ms)
  WHERE body IS NULL;

CREATE INDEX notification_routes_expiry
  ON notification_routes (expires_at_ms);

CREATE INDEX outbox_confirmed_retention
  ON outbox (confirmed_at_ms)
  WHERE status = 'confirmed';
