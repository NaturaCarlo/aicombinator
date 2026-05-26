CREATE TABLE IF NOT EXISTS launch_session_turns (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  founder_message_id   TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  attempts             INTEGER NOT NULL DEFAULT 0,
  provider             TEXT,
  model                TEXT,
  duration_ms          INTEGER,
  last_error           TEXT,
  started_at           TEXT,
  completed_at         TEXT,
  prompt_chars         INTEGER,
  transcript_messages  INTEGER,
  status_code          INTEGER,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_session_turns_assistant
  ON launch_session_turns(assistant_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_session_turns_founder
  ON launch_session_turns(founder_message_id);

CREATE INDEX IF NOT EXISTS idx_launch_session_turns_session_created
  ON launch_session_turns(session_id, created_at ASC);
