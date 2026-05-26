-- Migration 001: Multi-Agent Orchestration
-- Adds Paperclip-style multi-agent support to Agentmarket

-- ─── Extend existing tables ─────────────────────────────────────

ALTER TABLE companies ADD COLUMN issue_prefix TEXT NOT NULL DEFAULT 'AIC';
ALTER TABLE companies ADD COLUMN issue_counter INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN budget_monthly_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN spent_monthly_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN require_board_approval_for_new_agents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN description TEXT;

ALTER TABLE activity_log ADD COLUMN actor_type TEXT;
ALTER TABLE activity_log ADD COLUMN actor_id TEXT;
ALTER TABLE activity_log ADD COLUMN action TEXT;
ALTER TABLE activity_log ADD COLUMN entity_type TEXT;
ALTER TABLE activity_log ADD COLUMN entity_id TEXT;
ALTER TABLE activity_log ADD COLUMN agent_id TEXT;
ALTER TABLE activity_log ADD COLUMN run_id TEXT;

-- ─── Agents ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',
  title TEXT,
  icon TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  reports_to TEXT REFERENCES agents(id) ON DELETE SET NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  adapter_config TEXT NOT NULL DEFAULT '{}',
  runtime_config TEXT NOT NULL DEFAULT '{}',
  permissions TEXT NOT NULL DEFAULT '{}',
  last_heartbeat_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_company_status ON agents(company_id, status);
CREATE INDEX IF NOT EXISTS idx_agents_reports_to ON agents(company_id, reports_to);

-- ─── Issues (Tasks) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  checkout_run_id TEXT,
  execution_run_id TEXT,
  execution_locked_at TEXT,
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  issue_number INTEGER NOT NULL,
  identifier TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_company_status ON issues(company_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(company_id, assignee_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(company_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(company_id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);

-- ─── Issue Comments ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_issue_comments_company ON issue_comments(company_id);

-- ─── Goals ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  level TEXT NOT NULL DEFAULT 'task',
  status TEXT NOT NULL DEFAULT 'planned',
  parent_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_goals_company ON goals(company_id);

-- ─── Projects ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  lead_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  color TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id);

-- ─── Approvals ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  requested_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  decision_note TEXT,
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approvals_company_status ON approvals(company_id, status, type);

-- ─── Approval Comments ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_comments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_comments_approval ON approval_comments(approval_id, created_at);

-- ─── Issue-Approval Junction ────────────────────────────────────

CREATE TABLE IF NOT EXISTS issue_approvals (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  linked_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  linked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (issue_id, approval_id)
);

CREATE INDEX IF NOT EXISTS idx_issue_approvals_approval ON issue_approvals(approval_id);

-- ─── Heartbeat Runs ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  invocation_source TEXT NOT NULL DEFAULT 'on_demand',
  trigger_detail TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  error_code TEXT,
  usage_json TEXT,
  result_json TEXT,
  context_snapshot TEXT,
  stdout_excerpt TEXT,
  stderr_excerpt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_agent ON heartbeat_runs(company_id, agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_status ON heartbeat_runs(agent_id, status);

-- ─── Agent Wakeup Requests ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_wakeup_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'on_demand',
  trigger_detail TEXT,
  reason TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  coalesced_count INTEGER NOT NULL DEFAULT 0,
  requested_by_actor_type TEXT,
  requested_by_actor_id TEXT,
  run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  finished_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wakeup_agent_status ON agent_wakeup_requests(company_id, agent_id, status);
CREATE INDEX IF NOT EXISTS idx_wakeup_requested ON agent_wakeup_requests(agent_id, requested_at);

-- ─── Agent Runtime State ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_runtime_state (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  adapter_type TEXT,
  session_id TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  last_run_id TEXT,
  last_run_status TEXT,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_state_company ON agent_runtime_state(company_id);

-- ─── Agent Task Sessions ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_task_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  adapter_type TEXT,
  task_key TEXT NOT NULL,
  session_params_json TEXT,
  session_display_id TEXT,
  last_run_id TEXT REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_sessions_unique ON agent_task_sessions(company_id, agent_id, task_key);

-- ─── Agent API Keys ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_api_keys (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'default',
  key_hash TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_keys_hash ON agent_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_agent_keys_agent ON agent_api_keys(company_id, agent_id);

-- ─── Cost Events ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_cost_events_company ON cost_events(company_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events(company_id, agent_id, occurred_at);
