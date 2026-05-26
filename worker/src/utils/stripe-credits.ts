import type { Env } from "../types.js";
import { grantCredits } from "./credits.js";
import {
  fetchFromCompanySupervisor,
  resolveSupervisorBaseUrlByCompanyId,
} from "./supervisor-routing.js";
import { buildInternalContractHeaders } from "./internal-contract.js";

type StripeCreditGrantType = "credit_purchase" | "auto_refill";

interface StripeCheckoutSessionRecord {
  id: string;
  mode: string;
  payment_status?: string | null;
  payment_intent?: string | null;
  metadata?: Record<string, string | undefined> | null;
}

const CREDIT_RECONCILE_KV_PREFIX = "stripe:credit-reconcile:";
const CREDIT_RECONCILE_TTL_SECONDS = 20;

function buildGrantKey(
  paymentIntentId: string | null | undefined,
  checkoutSessionId: string | null | undefined,
): string | null {
  if (paymentIntentId) {
    return `pi:${paymentIntentId}`;
  }
  if (checkoutSessionId) {
    return `cs:${checkoutSessionId}`;
  }
  return null;
}

async function tryClaimStripeCreditGrant(
  env: Env,
  input: {
    userId: string;
    paymentIntentId?: string | null;
    checkoutSessionId?: string | null;
  },
): Promise<{ claimed: boolean; grantKey: string | null }> {
  const grantKey = buildGrantKey(input.paymentIntentId, input.checkoutSessionId);
  if (!grantKey) {
    return { claimed: true, grantKey: null };
  }

  try {
    await env.DB.prepare(
      `INSERT INTO stripe_credit_grant_receipts (
         id, user_id, grant_key, payment_intent_id, checkout_session_id
       )
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        input.userId,
        grantKey,
        input.paymentIntentId || null,
        input.checkoutSessionId || null,
      )
      .run();

    return { claimed: true, grantKey };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed")) {
      return { claimed: false, grantKey };
    }
    throw error;
  }
}

async function releaseStripeCreditGrantClaim(
  env: Env,
  userId: string,
  grantKey: string | null,
): Promise<void> {
  if (!grantKey) {
    return;
  }

  await env.DB.prepare(
    `DELETE FROM stripe_credit_grant_receipts WHERE user_id = ? AND grant_key = ?`,
  )
    .bind(userId, grantKey)
    .run();
}

async function stripeApiRequest<T>(
  env: Env,
  path: string,
): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Stripe API error (${res.status}): ${err}`);
  }

  return res.json() as Promise<T>;
}

async function hasExistingStripeCreditGrant(
  env: Env,
  paymentIntentId: string | null | undefined,
  checkoutSessionId?: string | null,
): Promise<boolean> {
  if (!paymentIntentId && !checkoutSessionId) {
    return false;
  }

  const row = await env.DB.prepare(
    `SELECT 1
     FROM credit_events
     WHERE (
       (?1 IS NOT NULL AND json_extract(metadata, '$.payment_intent_id') = ?1)
       OR (?2 IS NOT NULL AND json_extract(metadata, '$.checkout_session_id') = ?2)
     )
     LIMIT 1`,
  )
    .bind(paymentIntentId || null, checkoutSessionId || null)
    .first();

  return !!row;
}

/**
 * Notify all supervisors for a user's companies that credits were purchased.
 * Deduplicates by supervisor origin URL so each unique supervisor receives
 * exactly one POST per grant event — even when multiple companies share
 * the same supervisor (e.g. the shared VM).
 * Non-fatal — if the supervisor is unreachable, we log and continue.
 */
export async function notifySupervisorsOfCreditGrant(
  env: Env,
  userId: string,
  amount: number,
): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id FROM companies WHERE user_id = ? AND state NOT IN ('dead', 'failed')`,
    )
      .bind(userId)
      .all<{ id: string }>();

    if (!results || results.length === 0) {
      return;
    }

    // Resolve supervisor base URLs for all companies and deduplicate
    const urlResolutions = await Promise.all(
      results.map(async (company) => {
        const baseUrl = await resolveSupervisorBaseUrlByCompanyId(env, company.id);
        return { companyId: company.id, baseUrl };
      }),
    );

    const notifiedUrls = new Set<string>();
    const body = JSON.stringify({ user_id: userId, amount });

    await Promise.allSettled(
      urlResolutions.map(async ({ companyId, baseUrl }) => {
        if (!baseUrl) {
          return;
        }

        // Skip if we've already notified this supervisor origin
        if (notifiedUrls.has(baseUrl)) {
          return;
        }
        notifiedUrls.add(baseUrl);

        try {
          await fetch(`${baseUrl}/credits/purchased`, {
            method: "POST",
            headers: buildInternalContractHeaders({
              "Content-Type": "application/json",
              "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
            }),
            body,
          });
        } catch (err) {
          console.error(
            `[supervisor-routing] fetch failed for ${baseUrl}/credits/purchased:`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
  } catch (err) {
    console.error(
      "[stripe-credits] Failed to notify supervisors of credit grant:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function ensureStripeCreditsGranted(
  env: Env,
  input: {
    userId: string;
    credits: number;
    type: StripeCreditGrantType;
    paymentIntentId?: string | null;
    checkoutSessionId?: string | null;
    amountCents?: number | null;
  },
): Promise<boolean> {
  const claim = await tryClaimStripeCreditGrant(env, {
    userId: input.userId,
    paymentIntentId: input.paymentIntentId,
    checkoutSessionId: input.checkoutSessionId,
  });
  if (!claim.claimed) {
    return false;
  }

  try {
    const alreadyGranted = await hasExistingStripeCreditGrant(
      env,
      input.paymentIntentId,
      input.checkoutSessionId,
    );
    if (alreadyGranted) {
      return false;
    }

    const eventType = input.type === "auto_refill" ? "refill" as const : "grant" as const;
    const tokenDisplay = input.credits >= 1_000_000
      ? `${(input.credits / 1_000_000).toFixed(1)}M`
      : input.credits.toLocaleString();
    const description =
      input.type === "auto_refill"
        ? `Auto-refill — ${tokenDisplay} standard tokens`
        : `Purchased ${tokenDisplay} standard tokens`;

    await grantCredits(env, input.userId, input.credits, eventType, description, {
      payment_intent_id: input.paymentIntentId || null,
      checkout_session_id: input.checkoutSessionId || null,
      amount_cents: input.amountCents ?? null,
    });

    // Notify supervisors so their local SQLite balance updates immediately
    await notifySupervisorsOfCreditGrant(env, input.userId, input.credits);

    return true;
  } catch (error) {
    await releaseStripeCreditGrantClaim(env, input.userId, claim.grantKey);
    throw error;
  }
}

export async function reconcileRecentStripeCreditPurchases(
  env: Env,
  userId: string,
  stripeCustomerId: string | null | undefined,
): Promise<{ grantedCredits: number; sessionsRecovered: number }> {
  if (!stripeCustomerId || !env.STRIPE_SECRET_KEY) {
    return { grantedCredits: 0, sessionsRecovered: 0 };
  }

  const kvKey = `${CREDIT_RECONCILE_KV_PREFIX}${userId}`;
  const recentlyChecked = await env.AUTOMATON_KV.get(kvKey);
  if (recentlyChecked) {
    return { grantedCredits: 0, sessionsRecovered: 0 };
  }
  await env.AUTOMATON_KV.put(kvKey, "1", { expirationTtl: CREDIT_RECONCILE_TTL_SECONDS });

  const payload = await stripeApiRequest<{ data?: StripeCheckoutSessionRecord[] }>(
    env,
    `/checkout/sessions?limit=10&customer=${encodeURIComponent(stripeCustomerId)}&payment_status=paid`,
  );

  let grantedCredits = 0;
  let sessionsRecovered = 0;

  for (const session of payload.data ?? []) {
    if (session.mode !== "payment") {
      continue;
    }

    const type = session.metadata?.type;
    const credits = Number.parseInt(session.metadata?.credits || "", 10);
    const metadataUserId = session.metadata?.user_id;

    if (metadataUserId !== userId || !credits || Number.isNaN(credits)) {
      continue;
    }
    if (type !== "credit_purchase" && type !== "auto_refill") {
      continue;
    }

    const granted = await ensureStripeCreditsGranted(env, {
      userId,
      credits,
      type,
      paymentIntentId: session.payment_intent || null,
      checkoutSessionId: session.id,
    });

    if (granted) {
      grantedCredits += credits;
      sessionsRecovered += 1;
    }
  }

  return { grantedCredits, sessionsRecovered };
}
