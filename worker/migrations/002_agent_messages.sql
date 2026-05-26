-- Agent-to-agent messaging table for inter-agent communication
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'message',       -- message | task | approval_request | report
  subject TEXT,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',     -- low | normal | high | urgent
  status TEXT NOT NULL DEFAULT 'unread',       -- unread | read | acknowledged
  parent_message_id TEXT,                      -- for threading
  metadata TEXT,                               -- JSON for structured data
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_company ON agent_messages(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent_id, created_at);
