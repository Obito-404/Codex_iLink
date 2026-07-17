ALTER TABLE queued_turns
  ADD COLUMN context_token TEXT NOT NULL DEFAULT '';

ALTER TABLE dispatch_intents
  ADD COLUMN context_token TEXT NOT NULL DEFAULT '';

ALTER TABLE dispatch_intents
  ADD COLUMN completed_at_ms INTEGER
  CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms);

CREATE INDEX dispatch_intents_active
  ON dispatch_intents (completed_at_ms, status, thread_id);
