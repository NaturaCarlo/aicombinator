PRAGMA defer_foreign_keys = on;

CREATE TABLE IF NOT EXISTS cost_events_new (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  billing_code TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO cost_events_new (
  id, company_id, agent_id, issue_id, project_id, billing_code,
  provider, model, input_tokens, output_tokens, cost_cents, occurred_at, created_at
)
SELECT
  id,
  company_id,
  agent_id,
  issue_id,
  project_id,
  billing_code,
  provider,
  model,
  input_tokens,
  output_tokens,
  cost_cents,
  occurred_at,
  created_at
FROM cost_events;

DROP TABLE cost_events;
ALTER TABLE cost_events_new RENAME TO cost_events;

CREATE INDEX IF NOT EXISTS idx_cost_events_company ON cost_events(company_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events(company_id, agent_id, occurred_at);

UPDATE companies
SET spent_cents = COALESCE((
  SELECT ABS(COALESCE(SUM(ce.amount), 0))
  FROM credit_events ce
  WHERE ce.company_id = companies.id
    AND ce.type = 'deduct'
), 0),
updated_at = datetime('now')
WHERE id IN (
  SELECT DISTINCT company_id
  FROM credit_events
  WHERE company_id IS NOT NULL
);

INSERT INTO cost_events (
  id,
  company_id,
  agent_id,
  issue_id,
  project_id,
  billing_code,
  provider,
  model,
  input_tokens,
  output_tokens,
  cost_cents,
  occurred_at,
  created_at
)
SELECT
  ce.id || '-backfill',
  ce.company_id,
  CASE
    WHEN ce.agent_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM agents a WHERE a.id = ce.agent_id
    ) THEN ce.agent_id
    ELSE NULL
  END,
  NULL,
  NULL,
  NULL,
  'anthropic',
  COALESCE(json_extract(ce.metadata, '$.model_tier'), 'unknown'),
  0,
  0,
  ABS(ce.amount),
  ce.created_at,
  ce.created_at
FROM credit_events ce
WHERE ce.type = 'deduct'
  AND ce.company_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM companies c WHERE c.id = ce.company_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cost_events existing
    WHERE existing.company_id = ce.company_id
      AND (
        (existing.agent_id IS NULL AND ce.agent_id IS NULL)
        OR existing.agent_id = ce.agent_id
      )
      AND existing.cost_cents = ABS(ce.amount)
      AND existing.occurred_at = ce.created_at
  );
