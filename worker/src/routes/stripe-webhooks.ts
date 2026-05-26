/**
 * Stripe Webhook Handler
 *
 * POST /api/webhooks/stripe
 *
 * Handles:
 *   checkout.session.completed    → activate subscription + grant 5000 credits
 *   invoice.paid                  → monthly renewal, grant 5000 credits
 *   invoice.payment_failed        → notify user, start grace period
 *   customer.subscription.deleted → downgrade to free
 *   payment_intent.succeeded      → credit purchase / auto-refill
 */

import type { Env } from "../types.js";
import { corsHeaders } from "../middleware/cors.js";
import { applyPaidPlanCompanyEntitlements } from "../utils/company-contract.js";
import { grantCredits } from "../utils/credits.js";
import { ensureStripeCreditsGranted, notifySupervisorsOfCreditGrant } from "../utils/stripe-credits.js";
import { ensureDedicatedVmForUser } from "../utils/dedicated-vm.js";

/** Token grants per subscription tier */
const TIER_TOKENS: Record<string, number> = {
  pro: 20_000_000,
  max: 200_000_000,
};
/** Fallback for legacy subscriptions without tier metadata */
const DEFAULT_SUBSCRIPTION_TOKENS = 20_000_000;
const PAID_MAX_COMPANIES = 3;

async function resumePausedCompanies(env: Env, userId: string): Promise<void> {
  // Deliberately disabled.
  // Automatic mass-resume was reviving old paused companies after any credit purchase,
  // including audit/test companies. Founders should explicitly resume the company they want.
  void env;
  void userId;
}

/**
 * POST /api/webhooks/stripe
 */
export async function handleStripeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json(
      { error: "Missing stripe-signature header" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const body = await request.text();

  // Verify webhook signature
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return Response.json(
      { error: "Webhook secret not configured" },
      { status: 500, headers: corsHeaders(env) },
    );
  }

  const isValid = await verifyStripeSignature(
    body,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!isValid) {
    return Response.json(
      { error: "Invalid webhook signature" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const event = JSON.parse(body) as {
    type: string;
    data: { object: Record<string, any> };
  };

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(env, event.data.object);
        break;

      case "invoice.paid":
        await handleInvoicePaid(env, event.data.object);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(env, event.data.object);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(env, event.data.object);
        break;

      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(env, event.data.object);
        break;

      default:
        // Unhandled event type — acknowledge receipt
        break;
    }
  } catch (err) {
    console.error(`Stripe webhook error (${event.type}):`, err);
    // Return 200 to prevent Stripe retries on processing errors
    // (we log the error and can investigate)
  }

  return Response.json({ received: true }, { headers: corsHeaders(env) });
}

// ─── Event Handlers ──────────────────────────────────────────

/**
 * checkout.session.completed
 *
 * Fired when a user completes the Stripe Checkout flow.
 * For subscription checkouts: activate subscription, grant credits.
 * For one-time payments: credits are handled via payment_intent.succeeded.
 */
async function handleCheckoutCompleted(
  env: Env,
  session: Record<string, any>,
): Promise<void> {
  const userId = session.metadata?.user_id;
  if (!userId) return;

  if (session.mode === "payment") {
    const credits = parseInt(session.metadata?.credits, 10);
    const type = session.metadata?.type as string | undefined;
    if (credits && !Number.isNaN(credits) && (type === "credit_purchase" || type === "auto_refill")) {
      await ensureStripeCreditsGranted(env, {
        userId,
        credits,
        type,
        paymentIntentId: (session.payment_intent as string | null | undefined) ?? null,
        checkoutSessionId: session.id as string | undefined,
        amountCents: typeof session.amount_total === "number" ? session.amount_total : null,
      });
      await resumePausedCompanies(env, userId);
    }
    return;
  }

  if (session.mode === "subscription") {
    const subscriptionId = session.subscription as string;
    const customerId = session.customer as string;

    // Determine plan tier from checkout session metadata
    const planTier: string = session.metadata?.plan === "max" ? "max" : "pro";
    const tokensToGrant = TIER_TOKENS[planTier] ?? DEFAULT_SUBSCRIPTION_TOKENS;
    const tierLabel = planTier === "max" ? "Max" : "Pro";
    const tokenDisplay = `${tokensToGrant / 1_000_000}M`;

    // Fetch subscription details from Stripe
    const res = await fetch(
      `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
      {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      },
    );
    const sub = (await res.json()) as Record<string, any>;

    // Update subscription row — store plan tier ('pro' or 'max')
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, plan, status, current_period_start, current_period_end)
       VALUES (?, ?, ?, ?, ?, 'active', datetime(?, 'unixepoch'), datetime(?, 'unixepoch'))
       ON CONFLICT(user_id) DO UPDATE SET
         stripe_subscription_id = excluded.stripe_subscription_id,
         stripe_customer_id = excluded.stripe_customer_id,
         plan = excluded.plan,
         status = 'active',
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         updated_at = datetime('now')`,
    )
      .bind(
        crypto.randomUUID(),
        userId,
        subscriptionId,
        customerId,
        planTier,
        sub.current_period_start,
        sub.current_period_end,
      )
      .run();

    // Update user plan + max_companies
    await env.DB.prepare(
      `UPDATE users SET plan = ?, max_companies = ?, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(planTier, PAID_MAX_COMPANIES, userId)
      .run();
    await applyPaidPlanCompanyEntitlements(env, userId);
    await ensureDedicatedVmForUser(env, userId);

    // Grant tier-specific subscription tokens
    await grantCredits(
      env,
      userId,
      tokensToGrant,
      "subscription",
      `${tierLabel} subscription activated — ${tokenDisplay} standard tokens`,
      { stripe_subscription_id: subscriptionId },
    );
    await notifySupervisorsOfCreditGrant(env, userId, tokensToGrant);
    await resumePausedCompanies(env, userId);
  }
}

/**
 * invoice.paid
 *
 * Fired on successful monthly invoice payment (renewal).
 * Grant the monthly credit allotment.
 */
async function handleInvoicePaid(
  env: Env,
  invoice: Record<string, any>,
): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  if (!subscriptionId) return;

  // Find user and plan tier by subscription ID
  const sub = await env.DB.prepare(
    `SELECT user_id, plan FROM subscriptions WHERE stripe_subscription_id = ?`,
  )
    .bind(subscriptionId)
    .first<{ user_id: string; plan: string }>();

  if (!sub) return;

  // Skip the first invoice (credits already granted in checkout.session.completed)
  const billingReason = invoice.billing_reason as string;
  if (billingReason === "subscription_create") return;

  // Determine tokens based on stored plan tier
  // Also check Stripe subscription metadata as fallback
  let planTier = sub.plan;
  if (!TIER_TOKENS[planTier]) {
    // Legacy "paid" or unknown — fetch from Stripe subscription metadata
    try {
      const stripeRes = await fetch(
        `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
        { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
      );
      const stripeSub = (await stripeRes.json()) as Record<string, any>;
      if (stripeSub.metadata?.plan === "max" || stripeSub.metadata?.plan === "pro") {
        planTier = stripeSub.metadata.plan;
        // Update stored plan tier for future lookups
        await env.DB.prepare(
          `UPDATE subscriptions SET plan = ?, updated_at = datetime('now') WHERE stripe_subscription_id = ?`,
        ).bind(planTier, subscriptionId).run();
      }
    } catch {
      // Non-fatal: fall back to default
    }
  }

  const tokensToGrant = TIER_TOKENS[planTier] ?? DEFAULT_SUBSCRIPTION_TOKENS;
  const tierLabel = planTier === "max" ? "Max" : "Pro";
  const tokenDisplay = `${tokensToGrant / 1_000_000}M`;

  // Update period dates
  const periodStart = invoice.period_start;
  const periodEnd = invoice.period_end;
  if (periodStart && periodEnd) {
    await env.DB.prepare(
      `UPDATE subscriptions SET
         status = 'active',
         current_period_start = datetime(?, 'unixepoch'),
         current_period_end = datetime(?, 'unixepoch'),
         updated_at = datetime('now')
       WHERE stripe_subscription_id = ?`,
    )
      .bind(periodStart, periodEnd, subscriptionId)
      .run();
  }

  // Grant tier-specific monthly tokens
  await grantCredits(
    env,
    sub.user_id,
    tokensToGrant,
    "subscription",
    `${tierLabel} monthly renewal — ${tokenDisplay} standard tokens`,
    { invoice_id: invoice.id },
  );
  await notifySupervisorsOfCreditGrant(env, sub.user_id, tokensToGrant);
  await applyPaidPlanCompanyEntitlements(env, sub.user_id);
  await ensureDedicatedVmForUser(env, sub.user_id);
  await resumePausedCompanies(env, sub.user_id);
}

/**
 * invoice.payment_failed
 *
 * Mark subscription as past_due. User gets a 3-day grace period.
 */
async function handleInvoicePaymentFailed(
  env: Env,
  invoice: Record<string, any>,
): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  if (!subscriptionId) return;

  await env.DB.prepare(
    `UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now')
     WHERE stripe_subscription_id = ?`,
  )
    .bind(subscriptionId)
    .run();
}

/**
 * customer.subscription.deleted
 *
 * Subscription cancelled or expired. Downgrade to free.
 */
async function handleSubscriptionDeleted(
  env: Env,
  subscription: Record<string, any>,
): Promise<void> {
  const subscriptionId = subscription.id as string;

  const sub = await env.DB.prepare(
    `SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?`,
  )
    .bind(subscriptionId)
    .first<{ user_id: string }>();

  if (!sub) return;

  // Downgrade subscription
  await env.DB.prepare(
    `UPDATE subscriptions SET
       plan = 'free',
       status = 'cancelled',
       cancelled_at = datetime('now'),
       updated_at = datetime('now')
     WHERE stripe_subscription_id = ?`,
  )
    .bind(subscriptionId)
    .run();

  // Downgrade user
  await env.DB.prepare(
    `UPDATE users SET plan = 'free', max_companies = 1, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(sub.user_id)
    .run();
}

/**
 * payment_intent.succeeded
 *
 * Handles credit purchases and auto-refill payments.
 * Credits are specified in metadata.
 */
async function handlePaymentIntentSucceeded(
  env: Env,
  paymentIntent: Record<string, any>,
): Promise<void> {
  const userId = paymentIntent.metadata?.user_id;
  const credits = parseInt(paymentIntent.metadata?.credits, 10);
  const type = paymentIntent.metadata?.type as string | undefined;

  if (!userId || !credits || isNaN(credits)) return;
  if (type !== "credit_purchase" && type !== "auto_refill") return;

  await ensureStripeCreditsGranted(env, {
    userId,
    credits,
    type,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
  });
  await resumePausedCompanies(env, userId);
}

// ─── Stripe Signature Verification ──────────────────────────

/**
 * Verify Stripe webhook signature using HMAC-SHA256.
 *
 * Stripe signs with: "t=<timestamp>,v1=<signature>"
 * Signed payload: "<timestamp>.<body>"
 */
async function verifyStripeSignature(
  body: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  // Parse signature header
  const parts = signatureHeader.split(",");
  let timestamp = "";
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  // Check timestamp is within 5 minutes
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false;

  // Compute expected signature
  const signedPayload = `${timestamp}.${body}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload),
  );

  // Convert to hex
  const computed = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison (best effort in JS)
  return signatures.some((sig) => sig === computed);
}
