CREATE TABLE IF NOT EXISTS stripe_credit_checkout_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  kind TEXT NOT NULL DEFAULT 'credit_purchase',
  credits INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  payment_intent_id TEXT,
  metadata TEXT,
  last_checked_at TEXT,
  completed_at TEXT,
  granted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stripe_credit_checkout_sessions_user
  ON stripe_credit_checkout_sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_credit_checkout_sessions_status
  ON stripe_credit_checkout_sessions (status, updated_at DESC);
