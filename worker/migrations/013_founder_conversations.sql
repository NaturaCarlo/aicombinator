CREATE TABLE IF NOT EXISTS founder_conversations (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  founder_message TEXT,
  ceo_reply       TEXT,
  status          TEXT NOT NULL DEFAULT 'complete',
  error           TEXT,
  grounded        INTEGER NOT NULL DEFAULT 0,
  agent_id        TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_founder_conversations_company_created
  ON founder_conversations(company_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_founder_conversations_company_kind
  ON founder_conversations(company_id, kind, created_at DESC);
