ALTER TABLE outbound_attachment_intents
ADD COLUMN snapshot_provenance TEXT NOT NULL DEFAULT 'legacy'
CHECK (snapshot_provenance IN ('legacy', 'staged-v1'));

CREATE TABLE protected_legacy_outbound_paths (
  path_key TEXT PRIMARY KEY
) STRICT;

INSERT OR IGNORE INTO protected_legacy_outbound_paths (path_key)
SELECT path_key
FROM outbound_attachment_intents
WHERE snapshot_provenance = 'legacy';

CREATE TRIGGER protect_legacy_outbound_path_before_delete
BEFORE DELETE ON outbound_attachment_intents
WHEN OLD.snapshot_provenance = 'legacy'
BEGIN
  INSERT OR IGNORE INTO protected_legacy_outbound_paths (path_key)
  VALUES (OLD.path_key);
END;
