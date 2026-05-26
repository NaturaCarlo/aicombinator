/**
 * Virtual Card Management Routes
 *
 * Card lifecycle:
 *   - AI Combinator (admin) creates cards via Clerk-authed POST
 *   - Agents can check balance, get details, request top-ups, and escalate
 *   - Agent endpoints use companyId-based auth (same as heartbeat — no Clerk)
 *
 * Payment hierarchy: x402 → virtual card → escalate to AI Combinator
 */

import type { Env, VirtualCardRow } from "../types";
import { extractToken, verifyClerkJwt } from "../middleware/auth";
import { corsHeaders } from "../middleware/cors";
import { generateId } from "../provisioning/config-builder";
import { StripeClient } from "../integrations/stripe";

// ─── Admin: Create/assign a virtual card ──────────────────────

/**
 * POST /api/companies/:id/card
 * Body: { spending_limit_cents?: number }
 * Requires: Clerk JWT (admin/owner)
 */
export async function handleCreateCard(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const company = await env.DB.prepare(
    `SELECT id, name, user_id FROM companies WHERE id = ? AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<{ id: string; name: string; user_id: string }>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // Check if card already exists
  const existing = await env.DB.prepare(
    `SELECT id FROM virtual_cards WHERE company_id = ? AND status != 'cancelled'`,
  )
    .bind(companyId)
    .first();

  if (existing) {
    return Response.json(
      { error: "Company already has an active virtual card" },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  const body = (await request.json()) as {
    spending_limit_cents?: number;
  };

  const spendingLimitCents = body.spending_limit_cents || 10000; // $100 default

  // Create cardholder + card via Stripe Issuing API
  const stripe = new StripeClient(env);
  let stripeCardholder;
  let stripeCard;
  try {
    // Step 1: Create a cardholder
    stripeCardholder = await stripe.createCardholder(
      `AI Combinator - ${company.name}`,
      undefined,
      {
        company_id: companyId,
        agent_name: company.name,
      },
    );

    // Step 2: Create a virtual card for the cardholder
    stripeCard = await stripe.createCard(
      stripeCardholder.id,
      spendingLimitCents,
      "usd",
      {
        company_id: companyId,
        agent_name: company.name,
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown Stripe error";
    return Response.json(
      { error: "Failed to create card via Stripe", detail: message },
      { status: 502, headers: corsHeaders(env) },
    );
  }

  // Persist card in D1
  const cardId = generateId();
  await env.DB.prepare(
    `INSERT INTO virtual_cards (id, company_id, provider_card_id, cardholder_id, provider, last_four, card_brand, status, balance_cents, spending_limit_cents)
     VALUES (?, ?, ?, ?, 'stripe', ?, ?, 'active', 0, ?)`,
  )
    .bind(
      cardId,
      companyId,
      stripeCard.id,
      stripeCardholder.id,
      stripeCard.last4,
      stripeCard.brand || "visa",
      spendingLimitCents,
    )
    .run();

  // Log activity
  await env.DB.prepare(
    `INSERT INTO activity_log (id, company_id, type, summary) VALUES (?, ?, 'milestone', ?)`,
  )
    .bind(
      generateId(),
      companyId,
      `Virtual card issued (*${stripeCard.last4})`,
    )
    .run();

  return Response.json(
    {
      cardId,
      lastFour: stripeCard.last4,
      brand: stripeCard.brand,
      status: "active",
      spendingLimitCents,
    },
    { status: 201, headers: corsHeaders(env) },
  );
}

// ─── Agent/Admin: Get card info (masked) ──────────────────────

/**
 * GET /api/companies/:id/card
 * No auth required (agent-accessible, like heartbeat)
 */
export async function handleGetCard(
  _request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const card = await env.DB.prepare(
    `SELECT id, last_four, card_brand, status, balance_cents, spending_limit_cents, created_at
     FROM virtual_cards WHERE company_id = ? AND status != 'cancelled'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first<VirtualCardRow>();

  if (!card) {
    return Response.json({ hasCard: false }, { headers: corsHeaders(env) });
  }

  return Response.json(
    {
      hasCard: true,
      cardId: card.id,
      lastFour: card.last_four,
      brand: card.card_brand,
      status: card.status,
      balanceCents: card.balance_cents,
      spendingLimitCents: card.spending_limit_cents,
    },
    { headers: corsHeaders(env) },
  );
}

// ─── Agent: Get full card details for checkout ────────────────

/**
 * GET /api/companies/:id/card/details
 * No Clerk auth (agent-accessible). Returns sensitive card data.
 */
export async function handleGetCardDetails(
  _request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const card = await env.DB.prepare(
    `SELECT id, provider_card_id, status FROM virtual_cards
     WHERE company_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string; provider_card_id: string; status: string }>();

  if (!card) {
    return Response.json(
      { error: "No active card found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const stripe = new StripeClient(env);
  let details;
  try {
    details = await stripe.getCardDetails(card.provider_card_id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { error: "Failed to retrieve card details", detail: message },
      { status: 502, headers: corsHeaders(env) },
    );
  }

  return Response.json(
    {
      cardNumber: details.number,
      expiryMonth: String(details.exp_month).padStart(2, "0"),
      expiryYear: String(details.exp_year),
      cvv: details.cvc,
      lastFour: details.last4,
      brand: details.brand,
    },
    { headers: corsHeaders(env) },
  );
}

// ─── Agent: Check card balance ────────────────────────────────

/**
 * GET /api/companies/:id/card/balance
 */
export async function handleGetCardBalance(
  _request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const card = await env.DB.prepare(
    `SELECT id, provider_card_id, status FROM virtual_cards
     WHERE company_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string; provider_card_id: string; status: string }>();

  if (!card) {
    return Response.json(
      { error: "No active card found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const stripe = new StripeClient(env);
  let balance;
  try {
    balance = await stripe.getCardBalance(card.provider_card_id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { error: "Failed to check card balance", detail: message },
      { status: 502, headers: corsHeaders(env) },
    );
  }

  // Update cached balance in D1
  await env.DB.prepare(
    `UPDATE virtual_cards SET balance_cents = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(balance.availableCents, card.id)
    .run();

  return Response.json(
    {
      spendingLimitCents: balance.spendingLimitCents,
      totalSpentCents: balance.totalAuthorizedCents,
      availableCents: balance.availableCents,
      pendingCents: balance.pendingCents,
      currency: balance.currency,
    },
    { headers: corsHeaders(env) },
  );
}

// ─── Agent: Increase card spending limit ──────────────────────

/**
 * POST /api/companies/:id/card/topup
 * Body: { amount_cents: number }
 *
 * In Stripe Issuing, "topping up" means increasing the spending_limit
 * on the card. AI Combinator has pre-funded the Stripe account with
 * fiat — this just raises the limit the agent is allowed to spend.
 */
export async function handleCardTopup(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const card = await env.DB.prepare(
    `SELECT id, provider_card_id, status, spending_limit_cents, balance_cents
     FROM virtual_cards WHERE company_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(companyId)
    .first<VirtualCardRow>();

  if (!card) {
    return Response.json(
      { error: "No active card found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const body = (await request.json()) as { amount_cents: number };
  const amountCents = body.amount_cents;

  if (!amountCents || amountCents <= 0) {
    return Response.json(
      { error: "amount_cents must be a positive integer" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // New spending limit = current limit + requested increase
  const newSpendingLimitCents = card.spending_limit_cents + amountCents;

  // Update spending limit via Stripe
  const stripe = new StripeClient(env);
  try {
    await stripe.loadFunds(card.provider_card_id, newSpendingLimitCents);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { error: "Failed to update spending limit via Stripe", detail: message },
      { status: 502, headers: corsHeaders(env) },
    );
  }

  // Record top-up and update spending limit
  const topupId = generateId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO card_topups (id, card_id, company_id, usdc_amount, fiat_amount_cents, status)
       VALUES (?, ?, ?, '0', ?, 'confirmed')`,
    ).bind(topupId, card.id, companyId, amountCents),
    env.DB.prepare(
      `UPDATE virtual_cards SET spending_limit_cents = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(newSpendingLimitCents, card.id),
    env.DB.prepare(
      `INSERT INTO activity_log (id, company_id, type, summary) VALUES (?, ?, 'financial', ?)`,
    ).bind(
      generateId(),
      companyId,
      `Card spending limit increased by $${(amountCents / 100).toFixed(2)} to $${(newSpendingLimitCents / 100).toFixed(2)}`,
    ),
  ]);

  return Response.json(
    {
      topupId,
      amountCents,
      newSpendingLimitCents,
      newBalanceCents: newSpendingLimitCents,
      status: "confirmed",
    },
    { headers: corsHeaders(env) },
  );
}

// ─── Agent: Escalate purchase request ─────────────────────────

/**
 * POST /api/purchases/request
 * Body: { company_id, description, amount_cents?, url? }
 */
export async function handlePurchaseRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = (await request.json()) as {
    company_id: string;
    description: string;
    amount_cents?: number;
    url?: string;
  };

  if (!body.company_id || !body.description) {
    return Response.json(
      { error: "company_id and description are required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Verify company exists
  const company = await env.DB.prepare(
    `SELECT id, name FROM companies WHERE id = ?`,
  )
    .bind(body.company_id)
    .first<{ id: string; name: string }>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const requestId = generateId();
  const summaryAmount = body.amount_cents
    ? ` ($${(body.amount_cents / 100).toFixed(2)})`
    : "";

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO purchase_requests (id, company_id, description, amount_cents, url)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      requestId,
      body.company_id,
      body.description,
      body.amount_cents || null,
      body.url || null,
    ),
    env.DB.prepare(
      `INSERT INTO activity_log (id, company_id, type, summary) VALUES (?, ?, 'tool_call', ?)`,
    ).bind(
      generateId(),
      body.company_id,
      `Purchase request: ${body.description.slice(0, 100)}${summaryAmount}`,
    ),
  ]);

  return Response.json(
    {
      requestId,
      status: "pending",
      message:
        "Purchase request submitted to AI Combinator for review",
    },
    { status: 201, headers: corsHeaders(env) },
  );
}

// ─── Agent: Check purchase request status ─────────────────

/**
 * GET /api/companies/:id/purchases
 * Returns recent purchase requests for the company.
 * Query params: ?status=pending (optional filter)
 */
export async function handleGetPurchaseRequests(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");

  let query: string;
  let params: string[];

  if (statusFilter) {
    query = `SELECT id, description, amount_cents, url, status, admin_notes, created_at, resolved_at
             FROM purchase_requests WHERE company_id = ? AND status = ?
             ORDER BY created_at DESC LIMIT 20`;
    params = [companyId, statusFilter];
  } else {
    query = `SELECT id, description, amount_cents, url, status, admin_notes, created_at, resolved_at
             FROM purchase_requests WHERE company_id = ?
             ORDER BY created_at DESC LIMIT 20`;
    params = [companyId];
  }

  const results = await env.DB.prepare(query).bind(...params).all();

  return Response.json(
    { requests: results.results },
    { headers: corsHeaders(env) },
  );
}
