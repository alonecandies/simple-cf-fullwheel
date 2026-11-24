CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  moderator_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'applying', 'applied', 'conflict', 'failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS moderation_actions_one_queued_per_message_idx
  ON moderation_actions (message_id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS moderation_actions_message_created_at_idx
  ON moderation_actions (message_id, created_at DESC);
