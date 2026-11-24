ALTER TABLE messages ADD COLUMN vector_indexed_at TEXT;

CREATE TABLE integration_usage (
  service TEXT PRIMARY KEY NOT NULL,
  period TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests >= 0)
);
