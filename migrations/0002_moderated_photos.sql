ALTER TABLE messages
  ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'
  CHECK (status IN ('pending', 'approved', 'rejected', 'unavailable'));

ALTER TABLE messages
  ADD COLUMN image_key TEXT;

CREATE INDEX IF NOT EXISTS messages_status_created_at_idx
  ON messages (status, created_at DESC);
