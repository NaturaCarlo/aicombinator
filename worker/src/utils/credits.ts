/**
 * Standard Token system helpers.
 *
 * All token balance mutations go through these functions to ensure
 * the credit_events ledger and credit_balances stay in sync.
 *
 * Units: standard tokens. 1M standard tokens = $1.
 * Formula: standard_tokens = raw_tokens * model_multiplier.
 * Cached tokens: raw_tokens * multiplier * 0.1 (1/10th cost).
 */

import type { Env, CreditEventType } from "../types.js";
import { generateId } from "../provisioning/config-builder.js";

// ─── Core credit operations ──────────────────────────────────

/**
 * Grant credits to a user (subscription renewal, manual top-up, free tier grant).
 * Inserts a credit_event and upserts credit_balances atomically.
 */
export async function grantCredits(
  env: Env,
  userId: string,
  amount: number,
  type: CreditEventType,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<{ balance: number; eventId: string }> {
  const eventId = generateId();
  const metaJson = metadata ? JSON.stringify(metadata) : null;

  // Atomic increment — no read-then-write race.
  // Insert event with placeholder balance_after, then update it to the
  // actual post-mutation value to avoid races with concurrent batches.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO credit_balances (user_id, balance, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         balance = balance + ?,
         updated_at = datetime('now')`,
    ).bind(userId, amount, amount),

    env.DB.prepare(
      `INSERT INTO credit_events (id, user_id, type, amount, balance_after, description, metadata)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).bind(eventId, userId, type, amount, description, metaJson),

    env.DB.prepare(
      `UPDATE credit_events SET balance_after = (SELECT balance FROM credit_balances WHERE user_id = ?) WHERE id = ?`,
    ).bind(userId, eventId),
  ]);

  const balanceAfter = await getBalance(env, userId);
  return { balance: balanceAfter, eventId };
}

/**
 * Deduct credits from a user (agent turn cost).
 * Returns the new balance, clamping to zero if the ledger is already lower
 * than the requested deduction.
 */
export async function deductCredits(
  env: Env,
  userId: string,
  amount: number,
  description: string,
  companyId?: string,
  agentId?: string,
): Promise<{ balance: number; eventId: string; deducted: number }> {
  const eventId = generateId();
  const safeAmount = Math.max(0, amount);

  // Atomic decrement clamped to zero — no read-then-write race.
  // Insert event with placeholder balance_after, then update it to the
  // actual post-mutation value to avoid races with concurrent batches.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO credit_balances (user_id, balance, updated_at)
       VALUES (?, 0, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         balance = MAX(0, balance - ?),
         updated_at = datetime('now')`,
    ).bind(userId, safeAmount),

    env.DB.prepare(
      `INSERT INTO credit_events (id, user_id, company_id, agent_id, type, amount, balance_after, description, metadata)
       VALUES (?, ?, ?, ?, 'deduct', ?, 0, ?, NULL)`,
    ).bind(
      eventId,
      userId,
      companyId || null,
      agentId || null,
      -safeAmount,
      description,
    ),

    env.DB.prepare(
      `UPDATE credit_events SET balance_after = (SELECT balance FROM credit_balances WHERE user_id = ?) WHERE id = ?`,
    ).bind(userId, eventId),
  ]);

  const balanceAfter = await getBalance(env, userId);
  return { balance: balanceAfter, eventId, deducted: safeAmount };
}

/**
 * Get the current credit balance for a user.
 */
export async function getBalance(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT balance FROM credit_balances WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ balance: number }>();

  return row?.balance ?? 0;
}

/**
 * Get credit event history for a user.
 */
export async function getCreditHistory(
  env: Env,
  userId: string,
  limit = 50,
  offset = 0,
): Promise<{
  events: Array<{
    id: string;
    type: CreditEventType;
    amount: number;
    balance_after: number;
    description: string | null;
    company_id: string | null;
    company_name: string | null;
    created_at: string;
  }>;
  total: number;
}> {
  const [eventsResult, countResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ce.id, ce.type, ce.amount, ce.balance_after, ce.description, ce.company_id, c.name as company_name, ce.created_at
       FROM credit_events ce
       LEFT JOIN companies c ON ce.company_id = c.id
       WHERE ce.user_id = ?
       ORDER BY ce.created_at DESC LIMIT ? OFFSET ?`,
    ).bind(userId, limit, offset),
    env.DB.prepare(
      `SELECT COUNT(*) as total FROM credit_events WHERE user_id = ?`,
    ).bind(userId),
  ]);

  return {
    events: (eventsResult.results as any[]) || [],
    total: (countResult.results?.[0] as any)?.total ?? 0,
  };
}

// ─── Auto-refill ─────────────────────────────────────────────

/**
 * Check if a user's balance is below their auto-refill threshold
 * and trigger a Stripe charge if so.
 *
 * Returns true if a refill was triggered.
 */
export async function checkAutoRefill(
  env: Env,
  userId: string,
): Promise<boolean> {
  const sub = await env.DB.prepare(
    `SELECT stripe_customer_id, auto_refill_enabled, auto_refill_threshold, auto_refill_amount
     FROM subscriptions WHERE user_id = ? AND status = 'active'`,
  )
    .bind(userId)
    .first<{
      stripe_customer_id: string | null;
      auto_refill_enabled: number;
      auto_refill_threshold: number;
      auto_refill_amount: number;
    }>();

  if (!sub || !sub.auto_refill_enabled || !sub.stripe_customer_id) {
    return false;
  }

  const balance = await getBalance(env, userId);
  if (balance >= sub.auto_refill_threshold) {
    return false;
  }

  // 1M tokens = $1.00 = 100 cents
  const amountCents = Math.ceil((sub.auto_refill_amount / 1_000_000) * 100);

  const params = new URLSearchParams();
  params.set("amount", amountCents.toString());
  params.set("currency", "usd");
  params.set("customer", sub.stripe_customer_id);
  params.set("confirm", "true");
  params.set("off_session", "true");
  params.set("automatic_payment_methods[enabled]", "true");
  params.set("metadata[user_id]", userId);
  params.set("metadata[type]", "auto_refill");
  params.set("metadata[credits]", sub.auto_refill_amount.toString());

  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    console.error("Auto-refill PaymentIntent failed:", await res.text());
    return false;
  }

  // Credits will be added when the payment_intent.succeeded webhook fires
  return true;
}

// ─── Error class ─────────────────────────────────────────────

export class CreditError extends Error {
  public currentBalance: number;
  public requested: number;

  constructor(message: string, currentBalance: number, requested: number) {
    super(message);
    this.name = "CreditError";
    this.currentBalance = currentBalance;
    this.requested = requested;
  }
}
