-- Migration 004: Credit system, billing, structured tasks, policies, cron
-- Phase 1 of the VM + Supervisor architecture migration

-- ─── Credit Balances ────────────────────────────────────────────
-- Denormalized balance per user for fast reads.
-- Source of truth: credit_events ledger. This table is a convenience cache.
CREATE TABLE IF NOT EXISTS credit_balances (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Credit Events (append-only ledger) ─────────────────────────
-- Every credit mutation is recorded here for audit trail.
CREATE TABLE IF NOT EXISTS credit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  type TEXT NOT NULL,          -- 'grant', 'deduct', 'refill', 'subscription', 'free_tier', 'expiry'
  amount INTEGER NOT NULL,     -- positive for grants, negative for deductions
  balance_after INTEGER NOT NULL,
  description TEXT,
  metadata TEXT,               -- JSON: extra context (stripe_payment_id, turn_id, etc.)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_credit_events_user
  ON credit_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_events_company
  ON credit_events (company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_events_agent
  ON credit_events (company_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_events_type
  ON credit_events (user_id, type);

-- ─── Subscriptions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  stripe_payment_method_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',   -- 'free', 'paid'
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'past_due', 'cancelled', 'trialing'
  current_period_start TEXT,
  current_period_end TEXT,
  auto_refill_enabled INTEGER NOT NULL DEFAULT 1,
  auto_refill_threshold INTEGER NOT NULL DEFAULT 1000,
  auto_refill_amount INTEGER NOT NULL DEFAULT 5000,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user
  ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe
  ON subscriptions (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer
  ON subscriptions (stripe_customer_id);

-- ─── Structured Tasks ───────────────────────────────────────────
-- Tasks give visibility into what agents are working on.
-- Different from issues: tasks are agent-created work items with artifacts.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'todo',  -- 'todo', 'in_progress', 'blocked', 'done', 'cancelled'
  blocked_on TEXT,                       -- task_id or free-text blocker description
  artifact TEXT,                         -- path or URL of deliverable
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL,              -- agent_id that created the task
  priority TEXT NOT NULL DEFAULT 'medium', -- 'critical', 'high', 'medium', 'low'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_company_status
  ON tasks (company_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner
  ON tasks (company_id, owner_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks (company_id, parent_task_id);

-- ─── Policies ───────────────────────────────────────────────────
-- Rules engine gating sensitive agent actions.
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = global default
  action TEXT NOT NULL,              -- tool or action name
  condition TEXT NOT NULL,           -- JSON: { type, field?, max?, window?, roles? }
  enforcement TEXT NOT NULL,         -- JSON: { type: 'require_approval'|'require_manager'|'deny'|'rate_limit'|'log_only' }
  reason TEXT,
  priority INTEGER NOT NULL DEFAULT 0, -- higher = evaluated first
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_policies_action
  ON policies (action, enabled);
CREATE INDEX IF NOT EXISTS idx_policies_company
  ON policies (company_id, action, enabled);

-- ─── Policy Counters ────────────────────────────────────────────
-- Rate limit tracking for policy enforcement.
CREATE TABLE IF NOT EXISTS policy_counters (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_counters_unique
  ON policy_counters (company_id, agent_id, action, window_start);

-- ─── Cron Tasks ─────────────────────────────────────────────────
-- Scheduled recurring agent work.
CREATE TABLE IF NOT EXISTS cron_tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL,              -- cron expression: "0 9 * * *"
  prompt TEXT NOT NULL,                -- what to tell the agent when fired
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_by TEXT NOT NULL,            -- agent_id that created this cron
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cron_tasks_company
  ON cron_tasks (company_id, enabled);
CREATE INDEX IF NOT EXISTS idx_cron_tasks_next_run
  ON cron_tasks (enabled, next_run_at);

-- ─── Extend companies table ─────────────────────────────────────
-- Add fields needed for the new architecture.
ALTER TABLE companies ADD COLUMN goal TEXT;
ALTER TABLE companies ADD COLUMN custom_domain TEXT;
ALTER TABLE companies ADD COLUMN container_id TEXT;

-- ─── Extend agents table ────────────────────────────────────────
-- Add blueprint reference and model tier.
ALTER TABLE agents ADD COLUMN blueprint_id TEXT;
ALTER TABLE agents ADD COLUMN model_tier TEXT NOT NULL DEFAULT 'haiku';
ALTER TABLE agents ADD COLUMN total_credits_consumed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN last_wake_at TEXT;
ALTER TABLE agents ADD COLUMN last_sleep_at TEXT;
ALTER TABLE agents ADD COLUMN department TEXT;

-- ─── Extend users table ─────────────────────────────────────────
-- Track subscription tier at user level.
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN max_companies INTEGER NOT NULL DEFAULT 1;

-- ─── Default Policies ───────────────────────────────────────────
-- Global defaults applied to all companies.
INSERT OR IGNORE INTO policies (id, company_id, action, condition, enforcement, reason, priority) VALUES
  ('pol_purchase_service', NULL, 'purchase_service', '{"type":"always"}', '{"type":"require_approval"}', 'Any purchase of external services requires user approval', 100),
  ('pol_topup_card', NULL, 'topup_card', '{"type":"threshold","field":"amount_cents","max":5000}', '{"type":"require_approval"}', 'Card top-ups over $50 require user approval', 90),
  ('pol_send_payment', NULL, 'send_payment', '{"type":"threshold","field":"amount_cents","max":1000}', '{"type":"require_approval"}', 'Payments over $10 require user approval', 90),
  ('pol_register_domain', NULL, 'register_domain', '{"type":"always"}', '{"type":"require_approval"}', 'Domain registration costs money and is hard to undo', 100),
  ('pol_expose_port', NULL, 'expose_port', '{"type":"always"}', '{"type":"require_manager"}', 'Exposing ports to the internet needs manager sign-off', 80),
  ('pol_email_hourly', NULL, 'send_email', '{"type":"rate_limit","max":50,"window":"1h"}', '{"type":"rate_limit"}', 'Prevent email spam and protect sender reputation', 70),
  ('pol_email_daily', NULL, 'send_email', '{"type":"rate_limit","max":200,"window":"24h"}', '{"type":"rate_limit"}', 'Daily email cap', 70),
  ('pol_provision_api_key', NULL, 'provision_api_key', '{"type":"always"}', '{"type":"require_approval"}', 'New API services may incur costs', 100),
  ('pol_account_rate', NULL, 'create_account', '{"type":"rate_limit","max":5,"window":"24h"}', '{"type":"rate_limit"}', 'Prevent mass account creation', 80),
  ('pol_account_log', NULL, 'create_account', '{"type":"always"}', '{"type":"log_only"}', 'All account creation is audit-logged', 50),
  ('pol_hire_custom', NULL, 'hire_agent_custom', '{"type":"always"}', '{"type":"require_approval"}', 'Custom agents need user approval (cost + risk)', 100),
  ('pol_hire_pool', NULL, 'hire_agent_pool', '{"type":"agent_role","roles":["specialist"]}', '{"type":"require_manager"}', 'Specialists cannot hire directly, must request through manager', 80),
  ('pol_delete_file', NULL, 'delete_file', '{"type":"always"}', '{"type":"log_only"}', 'All file deletions are audit-logged', 50),
  ('pol_drop_table', NULL, 'drop_table', '{"type":"always"}', '{"type":"deny"}', 'Database drops are always forbidden', 200),
  ('pol_rm_rf', NULL, 'rm_rf', '{"type":"always"}', '{"type":"deny"}', 'Recursive force-delete is always forbidden', 200);
