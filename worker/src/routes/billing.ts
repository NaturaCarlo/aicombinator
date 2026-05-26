/**
 * Billing routes — Stripe subscription, token purchase, auto-refill.
 *
 * POST /api/billing/checkout      — Create Stripe Checkout session (Pro $20/mo or Max $200/mo)
 * POST /api/billing/portal        — Create Stripe Customer Portal session
 * GET  /api/billing/status        — Subscription + token balance + auto-refill
 * GET  /api/billing/pricing       — Model multipliers for standard token pricing
 * PATCH /api/billing/auto-refill  — Update auto-refill config
 * POST /api/billing/buy-tokens    — One-time token purchase (1M tokens = $1)
 * POST /api/billing/buy-credits   — Legacy alias for buy-tokens
 */

import type { Env } from "../types.js";
import { isPaidPlan } from "../types.js";
import { corsHeaders } from "../middleware/cors.js";
import { verifyClerkJwt, extractToken } from "../middleware/auth.js";
import { getBalance, getCreditHistory } from "../utils/credits.js";
import {
  ensureStripeCreditsGranted,
  reconcileRecentStripeCreditPurchases,
} from "../utils/stripe-credits.js";

/**
 * Standard Token model multipliers (Factory pricing).
 * Formula: standard_tokens = raw_tokens * multiplier
 * Cached tokens: raw_tokens * multiplier * 0.1
 */
const MODEL_MULTIPLIERS = {
  // 15 primary models
  "minimax-m2.5": 0.12,
  "gemini-3-flash": 0.2,
  "glm-4.7": 0.25,
  "kimi-k2.5": 0.25,
  "haiku-4-5": 0.4,
  "glm-5": 0.4,
  "gpt-5.2": 0.7,
  "gpt-5.2-codex": 0.7,
  "gpt-5.3-codex": 0.7,
  "gemini-3.1-pro": 0.8,
  "gpt-5.4": 1.0,
  "sonnet-4-5": 1.2,
  "sonnet-4-6": 1.2,
  "opus-4-5": 2.0,
  "opus-4-6": 2.0,
  // Legacy tier names (backward compatibility)
  haiku: 0.4,
  sonnet: 1.2,
  opus: 2.0,
  "gpt4o-mini": 0.1,
} as const;

// ─── Helpers ─────────────────────────────────────────────────

async function authenticateUser(request: Request, env: Env): Promise<string | null> {
  const token = extractToken(request);
  if (!token) return null;
  return verifyClerkJwt(token, env);
}

function jsonResponse(data: unknown, env: Env, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      ...corsHeaders(env),
      "Cache-Control": "private, no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

function errorResponse(message: string, env: Env, status = 400): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        ...corsHeaders(env),
        "Cache-Control": "private, no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
    },
  );
}

async function stripeRequest<T>(
  env: Env,
  method: string,
  path: string,
  body?: URLSearchParams,
): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body?.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe error (${res.status}): ${err}`);
  }

  return res.json() as Promise<T>;
}

interface StripeCheckoutSessionPayload {
  id: string;
  mode: string;
  payment_status?: string | null;
  status?: string | null;
  customer?: string | null;
  payment_intent?: string | null;
  amount_total?: number | null;
  metadata?: Record<string, string | undefined> | null;
}

function isCreditPurchaseType(type: string | undefined): type is "credit_purchase" | "auto_refill" {
  return type === "credit_purchase" || type === "auto_refill";
}

async function upsertStripeCreditCheckoutSession(
  env: Env,
  input: {
    sessionId: string;
    userId: string;
    stripeCustomerId: string | null;
    credits: number;
    amountCents: number;
    status: "created" | "returned" | "pending_payment" | "granted" | "failed";
    paymentIntentId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stripe_credit_checkout_sessions (
       id, user_id, stripe_customer_id, kind, credits, amount_cents, status,
       payment_intent_id, metadata, last_checked_at, updated_at
     )
     VALUES (?, ?, ?, 'credit_purchase', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       credits = excluded.credits,
       amount_cents = excluded.amount_cents,
       status = excluded.status,
       payment_intent_id = COALESCE(excluded.payment_intent_id, stripe_credit_checkout_sessions.payment_intent_id),
       metadata = COALESCE(excluded.metadata, stripe_credit_checkout_sessions.metadata),
       last_checked_at = datetime('now'),
       updated_at = datetime('now'),
       completed_at = CASE
         WHEN excluded.status IN ('granted', 'failed') THEN datetime('now')
         ELSE stripe_credit_checkout_sessions.completed_at
       END,
       granted_at = CASE
         WHEN excluded.status = 'granted' THEN datetime('now')
         ELSE stripe_credit_checkout_sessions.granted_at
       END`,
  )
    .bind(
      input.sessionId,
      input.userId,
      input.stripeCustomerId,
      input.credits,
      input.amountCents,
      input.status,
      input.paymentIntentId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    )
    .run();
}

async function fetchStripeCheckoutSession(
  env: Env,
  sessionId: string,
): Promise<StripeCheckoutSessionPayload> {
  return stripeRequest<StripeCheckoutSessionPayload>(
    env,
    "GET",
    `/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
}

async function finalizeStripeCreditCheckoutSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<{
  status: "granted" | "pending_payment" | "failed";
  balance: number;
  grantedCredits: number;
}> {
  const row = await env.DB.prepare(
    `SELECT id, stripe_customer_id, credits, amount_cents, status
     FROM stripe_credit_checkout_sessions
     WHERE id = ? AND user_id = ?`,
  )
    .bind(sessionId, userId)
    .first<{
      id: string;
      stripe_customer_id: string | null;
      credits: number;
      amount_cents: number;
      status: string;
    }>();

  const session = await fetchStripeCheckoutSession(env, sessionId);
  const type = session.metadata?.type;
  const credits = Number.parseInt(session.metadata?.credits || `${row?.credits ?? ""}`, 10);
  const metadataUserId = session.metadata?.user_id;

  if (
    session.mode !== "payment"
    || metadataUserId !== userId
    || !isCreditPurchaseType(type)
    || !credits
    || Number.isNaN(credits)
  ) {
    await upsertStripeCreditCheckoutSession(env, {
      sessionId,
      userId,
      stripeCustomerId: (session.customer as string | null | undefined) ?? row?.stripe_customer_id ?? null,
      credits: Number.isNaN(credits) ? row?.credits ?? 0 : credits,
      amountCents: typeof session.amount_total === "number" ? session.amount_total : row?.amount_cents ?? 0,
      status: "failed",
      paymentIntentId: (session.payment_intent as string | null | undefined) ?? null,
      metadata: {
        reason: "invalid_credit_session",
      },
    });

    return {
      status: "failed",
      balance: await getBalance(env, userId),
      grantedCredits: 0,
    };
  }

  const stripeCustomerId = (session.customer as string | null | undefined) ?? row?.stripe_customer_id ?? null;
  const amountCents = typeof session.amount_total === "number" ? session.amount_total : row?.amount_cents ?? credits;

  if (session.payment_status !== "paid") {
    await upsertStripeCreditCheckoutSession(env, {
      sessionId,
      userId,
      stripeCustomerId,
      credits,
      amountCents,
      status: "pending_payment",
      paymentIntentId: (session.payment_intent as string | null | undefined) ?? null,
      metadata: {
        stripeStatus: session.status ?? null,
        paymentStatus: session.payment_status ?? null,
      },
    });

    return {
      status: "pending_payment",
      balance: await getBalance(env, userId),
      grantedCredits: 0,
    };
  }

  await ensureStripeCreditsGranted(env, {
    userId,
    credits,
    type,
    paymentIntentId: (session.payment_intent as string | null | undefined) ?? null,
    checkoutSessionId: session.id,
    amountCents,
  });

  await upsertStripeCreditCheckoutSession(env, {
    sessionId,
    userId,
    stripeCustomerId,
    credits,
    amountCents,
    status: "granted",
    paymentIntentId: (session.payment_intent as string | null | undefined) ?? null,
    metadata: {
      paymentStatus: session.payment_status ?? null,
    },
  });

  return {
    status: "granted",
    balance: await getBalance(env, userId),
    grantedCredits: credits,
  };
}

/**
 * Ensure the user has a Stripe customer ID. Creates one if needed.
 */
async function ensureStripeCustomer(env: Env, userId: string): Promise<string> {
  // Check if subscription row exists with a customer ID
  const existing = await env.DB.prepare(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ stripe_customer_id: string | null }>();

  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  // Get user email from D1
  const user = await env.DB.prepare(
    `SELECT email, name FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{ email: string; name: string | null }>();

  if (!user) throw new Error("User not found");

  // Create Stripe customer
  const params = new URLSearchParams();
  params.set("email", user.email);
  if (user.name) params.set("name", user.name);
  params.set("metadata[user_id]", userId);

  const customer = await stripeRequest<{ id: string }>(
    env,
    "POST",
    "/customers",
    params,
  );

  // Upsert subscription row with the customer ID
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status)
     VALUES (?, ?, ?, 'free', 'active')
     ON CONFLICT(user_id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       updated_at = datetime('now')`,
  )
    .bind(crypto.randomUUID(), userId, customer.id)
    .run();

  return customer.id;
}

// ─── Route handlers ──────────────────────────────────────────

/**
 * POST /api/billing/checkout
 *
 * Creates a Stripe Checkout Session for a subscription plan.
 * Body: { plan?: "pro" | "max" } — defaults to "pro"
 *   Pro: $20/month = 20M standard tokens
 *   Max: $200/month = 200M standard tokens
 * Returns { url } for redirect.
 */
export async function handleBillingCheckout(
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await authenticateUser(request, env);
  if (!userId) return errorResponse("Unauthorized", env, 401);

  let planChoice: "pro" | "max" = "pro";
  try {
    const body = (await request.json()) as { plan?: string };
    if (body.plan === "max") planChoice = "max";
  } catch {
    // No body or invalid JSON — default to pro
  }

  const planConfig = planChoice === "max"
    ? { name: "AI Combinator Max", description: "200M standard tokens/month, up to 3 companies, dedicated VM entitlement, custom domain unlock", amountCents: 20000, tokens: 200_000_000 }
    : { name: "AI Combinator Pro", description: "20M standard tokens/month, up to 3 companies, dedicated VM entitlement, custom domain unlock", amountCents: 2000, tokens: 20_000_000 };

  try {
    const customerId = await ensureStripeCustomer(env, userId);

    // Check if already subscribed
    const sub = await env.DB.prepare(
      `SELECT plan, status FROM subscriptions WHERE user_id = ?`,
    )
      .bind(userId)
      .first<{ plan: string; status: string }>();

    if (isPaidPlan(sub?.plan) && sub?.status === "active") {
      return errorResponse("Already subscribed", env, 409);
    }

    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("mode", "subscription");
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][product_data][name]", planConfig.name);
    params.set(
      "line_items[0][price_data][product_data][description]",
      planConfig.description,
    );
    params.set("line_items[0][price_data][unit_amount]", planConfig.amountCents.toString());
    params.set("line_items[0][price_data][recurring][interval]", "month");
    params.set("line_items[0][quantity]", "1");
    params.set("success_url", `${env.FRONTEND_URL}/portfolio?billing=success`);
    params.set("cancel_url", `${env.FRONTEND_URL}/portfolio?billing=cancelled`);
    params.set("metadata[user_id]", userId);
    params.set("metadata[plan]", planChoice);
    params.set("subscription_data[metadata][user_id]", userId);
    params.set("subscription_data[metadata][plan]", planChoice);

    const session = await stripeRequest<{ id: string; url: string }>(
      env,
      "POST",
      "/checkout/sessions",
      params,
    );

    return jsonResponse({ url: session.url }, env);
  } catch (err) {
    console.error("Checkout error:", err);
    return errorResponse("Failed to create checkout session", env, 500);
  }
}

/**
 * POST /api/billing/portal
 *
 * Creates a Stripe Customer Portal session for managing subscription.
 * Returns { url } for redirect.
 */
export async function handleBillingPortal(
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await authenticateUser(request, env);
  if (!userId) return errorResponse("Unauthorized", env, 401);

  try {
    const customerId = await ensureStripeCustomer(env, userId);

    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("return_url", `${env.FRONTEND_URL}/dashboard`);

    const session = await stripeRequest<{ url: string }>(
      env,
      "POST",
      "/billing_portal/sessions",
      params,
    );

    return jsonResponse({ url: session.url }, env);
  } catch (err) {
    console.error("Portal error:", err);
    return errorResponse("Failed to create portal session", env, 500);
  }
}

/**
 * GET /api/billing/status
 *
 * Returns the user's subscription info, credit balance, auto-refill config,
 * and recent credit history.
 */
export async function handleBillingStatus(
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await authenticateUser(request, env);
  if (!userId) return errorResponse("Unauthorized", env, 401);

  const sub = await env.DB.prepare(
      `SELECT plan, status, stripe_subscription_id, current_period_start,
              current_period_end, auto_refill_enabled, auto_refill_threshold,
              auto_refill_amount, cancelled_at, stripe_customer_id
       FROM subscriptions WHERE user_id = ?`,
    )
      .bind(userId)
      .first<{
        plan: string;
        status: string;
        stripe_subscription_id: string | null;
        current_period_start: string | null;
        current_period_end: string | null;
        auto_refill_enabled: number;
        auto_refill_threshold: number;
        auto_refill_amount: number;
        cancelled_at: string | null;
        stripe_customer_id: string | null;
      }>();

  const pendingCheckoutRows = await env.DB.prepare(
    `SELECT id
     FROM stripe_credit_checkout_sessions
     WHERE user_id = ? AND status IN ('created', 'returned', 'pending_payment')
     ORDER BY created_at DESC
     LIMIT 10`,
  )
    .bind(userId)
    .all<{ id: string }>();

  for (const row of pendingCheckoutRows.results ?? []) {
    try {
      await finalizeStripeCreditCheckoutSession(env, userId, row.id);
    } catch (err) {
      console.error(`Failed to finalize checkout session ${row.id}:`, err);
    }
  }

  try {
    await reconcileRecentStripeCreditPurchases(env, userId, sub?.stripe_customer_id ?? null);
  } catch (err) {
    console.error(`Failed to reconcile Stripe credit purchases for ${userId}:`, err);
  }

  const [balance, history, user] = await Promise.all([
    getBalance(env, userId),
    getCreditHistory(env, userId, 20),
    env.DB.prepare(`SELECT plan, max_companies FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ plan: string; max_companies: number }>(),
  ]);

  return jsonResponse(
    {
      credits: {
        balance,
        history: history.events,
        totalEvents: history.total,
      },
      subscription: sub
        ? {
            plan: sub.plan,
            status: sub.status,
            currentPeriodStart: sub.current_period_start,
            currentPeriodEnd: sub.current_period_end,
            cancelledAt: sub.cancelled_at,
          }
        : { plan: "free", status: "active" },
      autoRefill: sub
        ? {
            enabled: !!sub.auto_refill_enabled,
            threshold: sub.auto_refill_threshold,
            amount: sub.auto_refill_amount,
          }
        : { enabled: false, threshold: 1_000_000, amount: 5_000_000 },
      entitlements: {
        monthlyTokens: sub?.plan === "max" ? 200_000_000
          : isPaidPlan(sub?.plan) ? 20_000_000
          : 1_000_000,
        runtimeTier: isPaidPlan(sub?.plan) ? "dedicated" : "shared",
        egressTier: isPaidPlan(sub?.plan) ? "residential" : "standard",
        customDomainIncluded: isPaidPlan(sub?.plan),
      },
      limits: {
        maxCompanies: user?.max_companies ?? 1,
      },
    },
    env,
  );
}

export async function handleBillingPricing(
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await authenticateUser(request, env);
  if (!userId) {
    return errorResponse("Unauthorized", env, 401);
  }

  return jsonResponse(
    {
      pricing: MODEL_MULTIPLIERS,
      unit: "standard_token_multiplier",
      formula: "standard_tokens = raw_tokens * multiplier",
      cached_discount: 0.1,
    },
    env,
  );
}

/**
 * PATCH /api/billing/auto-refill
 *
 * Update auto-refill settings.
 * Body: { enabled?: boolean, threshold?: number, amount?: number }
 */
export async function handleUpdateAutoRefill(
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await authenticateUser(request, env);
  if (!userId) return errorResponse("Unauthorized", env, 401);

  const body = (await request.json()) as {
    enabled?: boolean;
    threshold?: number;
    amount?: number;
  };

  // Validate
  if (body.threshold !== undefined && (body.threshold < 0 || body.threshold > 100_000_000)) {
    return errorResponse("Threshold must be between 0 and 100,000,000 tokens", env);
  }
  if (body.amount !== undefined && (body.amount < 100_000 || body.amount > 100_000_000)) {
    return errorResponse("Refill amount must be between 100,000 and 100,000,000 tokens", env);
  }

  // Check subscription exists
  const sub = await env.DB.prepare(
    `SELECT id, plan FROM subscriptions WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ id: string; plan: string }>();

  if (!sub) {
    return errorResponse("No subscription found", env, 404);
  }

  if (!isPaidPlan(sub.plan) && body.enabled) {
    return errorResponse("Auto-refill requires a paid subscription", env);
  }

  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (body.enabled !== undefined) {
    updates.push("auto_refill_enabled = ?");
    values.push(body.enabled ? 1 : 0);
  }
  if (body.threshold !== undefined) {
    updates.push("auto_refill_threshold = ?");
    values.push(body.threshold);
  }
  if (body.amount !== undefined) {
    updates.push("auto_refill_amount = ?");
    values.push(body.amount);
  }

  if (updates.length === 0) {
    return errorResponse("No fields to update", env);
  }

  updates.push("updated_at = datetime('now')");

  await env.DB.prepare(
    `UPDATE subscriptions SET ${updates.join(", ")} WHERE user_id = ?`,
  )
    .bind(...values, userId)
    .run();

  return jsonResponse({ updated: true }, env);
}

/**
 * POST /api/billing/buy-tokens
 *
 * One-time token purchase via Stripe Checkout.
 * Body: { amount: number } — number of standard tokens to buy (min 1_000_000, max 500_000_000)
 * Conversion: 1M tokens = $1 → amount in cents = amount / 1_000_000 * 100
 */
export async function handleBuyTokens(
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await authenticateUser(request, env);
  if (!userId) return errorResponse("Unauthorized", env, 401);

  const body = (await request.json()) as { amount: number };

  if (!body.amount || body.amount < 500_000 || body.amount > 500_000_000) {
    return errorResponse("Amount must be between 500,000 and 500,000,000 tokens", env);
  }

  // 1M tokens = $1.00 = 100 cents
  const amountCents = Math.ceil((body.amount / 1_000_000) * 100);

  try {
    const customerId = await ensureStripeCustomer(env, userId);
    const tokenDisplay = `${(body.amount / 1_000_000).toFixed(1)}M`;

    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("mode", "payment");
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][product_data][name]", "AI Combinator Tokens");
    params.set(
      "line_items[0][price_data][product_data][description]",
      `${tokenDisplay} standard tokens`,
    );
    params.set("line_items[0][price_data][unit_amount]", amountCents.toString());
    params.set("line_items[0][quantity]", "1");
    params.set("success_url", `${env.FRONTEND_URL}/billing?tokens=success&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${env.FRONTEND_URL}/billing?tokens=cancelled`);
    params.set("metadata[user_id]", userId);
    params.set("metadata[type]", "credit_purchase");
    params.set("metadata[credits]", body.amount.toString());
    params.set("payment_intent_data[metadata][user_id]", userId);
    params.set("payment_intent_data[metadata][type]", "credit_purchase");
    params.set("payment_intent_data[metadata][credits]", body.amount.toString());

    const session = await stripeRequest<{ id: string; url: string }>(
      env,
      "POST",
      "/checkout/sessions",
      params,
    );

    await upsertStripeCreditCheckoutSession(env, {
      sessionId: session.id,
      userId,
      stripeCustomerId: customerId,
      credits: body.amount,
      amountCents,
      status: "created",
    });

    return jsonResponse({ url: session.url }, env);
  } catch (err) {
    console.error("Buy tokens error:", err);
    return errorResponse("Failed to create payment session", env, 500);
  }
}

/**
 * POST /api/billing/buy-credits (legacy alias)
 * Redirects to handleBuyTokens for backward compatibility.
 */
export const handleBuyCredits = handleBuyTokens;

/**
 * POST /api/billing/credits/confirm
 *
 * Confirms a Stripe Checkout session after redirect and grants credits
 * deterministically for the exact paid session.
 */
export async function handleConfirmCreditPurchase(
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await authenticateUser(request, env);
  if (!userId) return errorResponse("Unauthorized", env, 401);

  const body = (await request.json()) as { sessionId?: string };
  const sessionId = body.sessionId?.trim();

  if (!sessionId) {
    return errorResponse("sessionId is required", env, 400);
  }

  try {
    const result = await finalizeStripeCreditCheckoutSession(env, userId, sessionId);
    return jsonResponse(result, env);
  } catch (err) {
    console.error("Confirm credit purchase error:", err);
    return errorResponse("Failed to confirm credit purchase", env, 500);
  }
}
