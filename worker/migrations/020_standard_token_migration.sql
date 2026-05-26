-- Migration: Scale credit balances from old credits to standard tokens.
--
-- Old system: 1 credit = $0.01.
-- New system: 1M standard tokens = $1.00.
-- Conversion: 1 old credit = $0.01 = 10,000 standard tokens (since $0.01 / ($1/1M) = 10,000).
--
-- This multiplies all existing balances and reserved_balances by 10,000.

UPDATE credit_balances
SET balance = balance * 10000,
    reserved_balance = reserved_balance * 10000,
    updated_at = datetime('now');

-- Scale credit reservation records
UPDATE credit_reservations
SET reserved_balance = reserved_balance * 10000,
    updated_at = datetime('now')
WHERE reserved_balance > 0;

-- Scale credit event amounts for historical accuracy
UPDATE credit_events
SET amount = amount * 10000,
    balance_after = balance_after * 10000;

-- Update auto-refill thresholds and amounts
UPDATE subscriptions
SET auto_refill_threshold = auto_refill_threshold * 10000,
    auto_refill_amount = auto_refill_amount * 10000,
    updated_at = datetime('now')
WHERE auto_refill_threshold > 0 OR auto_refill_amount > 0;
