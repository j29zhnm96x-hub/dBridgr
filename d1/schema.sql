CREATE TABLE IF NOT EXISTS sessions (
  code TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  host_client_id TEXT NOT NULL,
  host_last_seen_at INTEGER NOT NULL DEFAULT 0,
  guest_client_id TEXT,
  guest_last_seen_at INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  target_role TEXT NOT NULL,
  type TEXT NOT NULL,
  from_role TEXT NOT NULL,
  data TEXT,
  sent_at INTEGER NOT NULL,
  FOREIGN KEY (code) REFERENCES sessions(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_code_role_id ON messages (code, target_role, id);