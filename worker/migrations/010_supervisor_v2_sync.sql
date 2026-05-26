-- Migration 010: Supervisor V2 bootstrap/sync contract

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_milestones_company_status
  ON milestones(company_id, status, sort_order);

ALTER TABLE tasks ADD COLUMN milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;
ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN credits_spent REAL NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN turns_spent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN created_by TEXT;
ALTER TABLE tasks ADD COLUMN started_at TEXT;
ALTER TABLE tasks ADD COLUMN completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_company_milestone
  ON tasks(company_id, milestone_id, status);
