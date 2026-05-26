-- Agentmarket D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  idea TEXT NOT NULL,
  genesis_prompt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'provisioning',
  conway_sandbox_id TEXT,
  conway_api_key_encrypted TEXT,
  wallet_address TEXT,
  private_key_encrypted TEXT,
  inference_model TEXT NOT NULL DEFAULT 'openai/gpt-4.1',
  budget_cents INTEGER NOT NULL DEFAULT 500,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  public_visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_companies_user_id ON companies(user_id);
CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);
CREATE INDEX IF NOT EXISTS idx_companies_state ON companies(state);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_company ON activity_log(company_id, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  wallet_address TEXT NOT NULL,
  expected_usdc INTEGER NOT NULL,
  received_usdc INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);

-- ─── Virtual Card Payment Infrastructure ─────────────────────

CREATE TABLE IF NOT EXISTS virtual_cards (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  provider_card_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  cardholder_id TEXT,
  last_four TEXT NOT NULL,
  card_brand TEXT NOT NULL DEFAULT 'visa',
  status TEXT NOT NULL DEFAULT 'active',
  balance_cents INTEGER NOT NULL DEFAULT 0,
  spending_limit_cents INTEGER NOT NULL DEFAULT 10000,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_virtual_cards_company ON virtual_cards(company_id);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  description TEXT NOT NULL,
  amount_cents INTEGER,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  admin_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchase_requests_company ON purchase_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests(status);

CREATE TABLE IF NOT EXISTS card_topups (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES virtual_cards(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  usdc_amount TEXT NOT NULL,
  fiat_amount_cents INTEGER NOT NULL,
  exchange_rate TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_card_topups_card ON card_topups(card_id);

-- ─── Genesis Batch Applications ──────────────────────────────

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  -- Founder
  founder_name TEXT NOT NULL DEFAULT '',
  founder_bio TEXT NOT NULL DEFAULT '',
  agent_experience TEXT NOT NULL DEFAULT '',
  prev_projects TEXT NOT NULL DEFAULT '',
  founder_linkedin TEXT NOT NULL DEFAULT '',
  founder_github TEXT NOT NULL DEFAULT '',
  founder_twitter TEXT NOT NULL DEFAULT '',
  -- Idea
  company_name TEXT NOT NULL DEFAULT '',
  tagline TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  problem_statement TEXT NOT NULL DEFAULT '',
  target_customer TEXT NOT NULL DEFAULT '',
  -- Agent Blueprint
  agent_core_loop TEXT NOT NULL DEFAULT '',
  first_twenty_four_hours TEXT NOT NULL DEFAULT '',
  -- Meta
  admin_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_applications_user_id ON applications(user_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
