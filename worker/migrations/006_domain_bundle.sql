-- Migration 006: custom-domain bundle quotes, orders, and inbox aliases

CREATE TABLE IF NOT EXISTS domain_bundle_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  domain_name TEXT NOT NULL,
  registration_cost_cents INTEGER NOT NULL,
  renewal_cost_cents INTEGER,
  email_bundle_credits INTEGER NOT NULL,
  domain_credits INTEGER NOT NULL,
  total_credits INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'quoted',
  provider_payload TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_domain_bundle_quotes_company
  ON domain_bundle_quotes (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_bundle_quotes_user
  ON domain_bundle_quotes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS domain_bundle_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  quote_id TEXT REFERENCES domain_bundle_quotes(id) ON DELETE SET NULL,
  domain_name TEXT NOT NULL,
  registration_cost_cents INTEGER NOT NULL,
  renewal_cost_cents INTEGER,
  email_bundle_credits INTEGER NOT NULL,
  domain_credits INTEGER NOT NULL,
  total_credits INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_purchase',
  registrar_order_id TEXT,
  cloudflare_zone_id TEXT,
  cloudflare_nameservers TEXT,
  dashboard_route_ids TEXT,
  agentmail_pod_id TEXT,
  agentmail_domain_id TEXT,
  error TEXT,
  metadata TEXT,
  last_sync_attempt_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_domain_bundle_orders_company
  ON domain_bundle_orders (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_bundle_orders_status
  ON domain_bundle_orders (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS company_email_aliases (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  alias_type TEXT NOT NULL,
  email_address TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'agentmail',
  inbox_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_email_aliases_type
  ON company_email_aliases (company_id, alias_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_email_aliases_email
  ON company_email_aliases (company_id, email_address);
