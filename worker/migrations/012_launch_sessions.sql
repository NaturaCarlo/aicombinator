CREATE TABLE IF NOT EXISTS launch_sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  mode              TEXT NOT NULL DEFAULT 'standard',
  input_name        TEXT,
  input_idea        TEXT NOT NULL,
  suggested_name    TEXT,
  brief_json        TEXT NOT NULL,
  readiness_json    TEXT NOT NULL,
  artifacts_json    TEXT,
  launched_company_id TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_launch_sessions_user_updated
  ON launch_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS launch_session_messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  options_json TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_launch_session_messages_session_created
  ON launch_session_messages(session_id, created_at ASC);
