CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'application/octet-stream',
  r2_key TEXT NOT NULL,
  password_hash TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_expires ON files(expires_at);
