CREATE TABLE IF NOT EXISTS stripe_credit_grant_receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_key TEXT NOT NULL UNIQUE,
  payment_intent_id TEXT,
  checkout_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stripe_credit_grant_receipts_user
  ON stripe_credit_grant_receipts (user_id, created_at DESC);
