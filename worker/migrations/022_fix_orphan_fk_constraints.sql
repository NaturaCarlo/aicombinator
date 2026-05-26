-- Fix orphaned foreign key constraints referencing dropped tables (issues, projects)
-- Migration 016 dropped issues and projects tables, but cost_events and issue_approvals
-- still have FK constraints referencing them, causing DELETE FROM companies to fail.

-- Recreate cost_events without FK references to issues/projects
CREATE TABLE IF NOT EXISTS cost_events_fixed (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  issue_id TEXT,
  project_id TEXT,
  billing_code TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO cost_events_fixed SELECT * FROM cost_events;
DROP TABLE cost_events;
ALTER TABLE cost_events_fixed RENAME TO cost_events;

CREATE INDEX IF NOT EXISTS idx_cost_events_company ON cost_events(company_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events(company_id, agent_id, occurred_at);

-- Drop issue_approvals (references both issues and approvals, but issues table is gone)
DROP TABLE IF EXISTS issue_approvals;

-- Recreate approvals without FK issues (approvals itself doesn't reference issues/projects
-- but just in case there's any constraint issue)
