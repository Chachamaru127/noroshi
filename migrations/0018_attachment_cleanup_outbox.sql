CREATE TABLE IF NOT EXISTS attachment_cleanup_outbox (
  storage_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_outbox_created
  ON attachment_cleanup_outbox(created_at);
