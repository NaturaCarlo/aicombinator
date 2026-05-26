-- Migration 008: structured company telemetry for outreach, leads, meetings, and revenue

CREATE TABLE IF NOT EXISTS telemetry_records (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, -- 'outreach' | 'lead' | 'meeting' | 'revenue'
  status TEXT NOT NULL,
  channel TEXT,
  verification_level TEXT NOT NULL DEFAULT 'self_reported',
  subject_name TEXT,
  subject_email TEXT,
  subject_company TEXT,
  amount_cents INTEGER,
  currency TEXT,
  external_ref TEXT,
  evidence_ref TEXT,
  notes TEXT,
  metadata TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_company_kind
  ON telemetry_records(company_id, kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_company_verification
  ON telemetry_records(company_id, verification_level, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_company_agent
  ON telemetry_records(company_id, agent_id, occurred_at DESC);
