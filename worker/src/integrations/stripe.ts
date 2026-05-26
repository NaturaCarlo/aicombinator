/**
 * Stripe Issuing API Client
 *
 * Handles virtual card creation, spending limit updates, balance checks,
 * and card detail retrieval via Stripe Issuing.
 *
 * AI Combinator deposits $5K fiat into Stripe. Cards are issued to agents
 * and spending limits are managed from that pre-funded pool.
 */

import type { Env } from "../types";

// ─── Request/Response types ───────────────────────────────────

export interface StripeCardholderResponse {
  id: string;
  name: string;
  email?: string;
  status: string;
  type: string;
  created: number;
}

export interface StripeCardCreateResponse {
  id: string;
  last4: string;
  brand: string;
  status: string;
  type: string;
  currency: string;
  spending_controls: {
    spending_limits: Array<{
      amount: number;
      interval: string;
      categories?: string[];
    }>;
  };
  created: number;
}

export interface StripeCardDetailsResponse {
  id: string;
  number: string;
  exp_month: number;
  exp_year: number;
  cvc: string;
  last4: string;
  brand: string;
  status: string;
}

export interface StripeCardResponse {
  id: string;
  last4: string;
  brand: string;
  status: string;
  spending_controls: {
    spending_limits: Array<{
      amount: number;
      interval: string;
    }>;
  };
  created: number;
}

// ─── Client ───────────────────────────────────────────────────

export class StripeClient {
  private secretKey: string;
  private baseUrl: string;

  constructor(env: Env) {
    this.secretKey = env.STRIPE_SECRET_KEY;
    this.baseUrl = "https://api.stripe.com/v1";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: URLSearchParams,
  ): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body ? body.toString() : undefined,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Stripe API error (${resp.status}): ${errText}`);
    }

    return resp.json() as Promise<T>;
  }

  /** Create a cardholder (required before creating a card). */
  async createCardholder(
    name: string,
    email?: string,
    metadata?: Record<string, string>,
  ): Promise<StripeCardholderResponse> {
    const params = new URLSearchParams();
    params.set("name", name);
    params.set("type", "individual");
    params.set("status", "active");
    if (email) params.set("email", email);

    // Stripe requires billing address for cardholders
    params.set("billing[address][line1]", "548 Market St");
    params.set("billing[address][city]", "San Francisco");
    params.set("billing[address][state]", "CA");
    params.set("billing[address][postal_code]", "94104");
    params.set("billing[address][country]", "US");

    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        params.set(`metadata[${k}]`, v);
      }
    }

    return this.request<StripeCardholderResponse>(
      "POST",
      "/issuing/cardholders",
      params,
    );
  }

  /** Create a new virtual card. Called by AI Combinator admin. */
  async createCard(
    cardholderId: string,
    spendingLimitCents: number,
    currency: string = "usd",
    metadata?: Record<string, string>,
  ): Promise<StripeCardCreateResponse> {
    const params = new URLSearchParams();
    params.set("cardholder", cardholderId);
    params.set("type", "virtual");
    params.set("currency", currency);
    params.set("status", "active");
    params.set("spending_controls[spending_limits][0][amount]", spendingLimitCents.toString());
    params.set("spending_controls[spending_limits][0][interval]", "all_time");

    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        params.set(`metadata[${k}]`, v);
      }
    }

    return this.request<StripeCardCreateResponse>(
      "POST",
      "/issuing/cards",
      params,
    );
  }

  /** Get sensitive card details (PAN, CVV, expiry) for checkout. */
  async getCardDetails(cardId: string): Promise<StripeCardDetailsResponse> {
    return this.request<StripeCardDetailsResponse>(
      "GET",
      `/issuing/cards/${cardId}?expand[]=number&expand[]=cvc`,
    );
  }

  /** Get card info including spending controls. */
  async getCard(cardId: string): Promise<StripeCardResponse> {
    return this.request<StripeCardResponse>(
      "GET",
      `/issuing/cards/${cardId}`,
    );
  }

  /**
   * Get card spending data.
   * Returns the spending limit and current authorization totals.
   */
  async getCardBalance(cardId: string): Promise<{
    spendingLimitCents: number;
    totalAuthorizedCents: number;
    availableCents: number;
    pendingCents: number;
    currency: string;
  }> {
    // Get card with spending controls
    const card = await this.getCard(cardId);

    const spendingLimit = card.spending_controls?.spending_limits?.[0]?.amount || 0;

    // Get authorizations to calculate current spending
    const authParams = new URLSearchParams();
    authParams.set("card", cardId);
    authParams.set("status", "pending");
    authParams.set("limit", "100");

    const pendingAuths = await this.request<{ data: Array<{ amount: number }> }>(
      "GET",
      `/issuing/authorizations?card=${cardId}&status=pending&limit=100`,
    );

    const pendingCents = pendingAuths.data.reduce(
      (sum, auth) => sum + auth.amount,
      0,
    );

    // Get completed transactions for total spend
    const transactions = await this.request<{ data: Array<{ amount: number }> }>(
      "GET",
      `/issuing/transactions?card=${cardId}&limit=100`,
    );

    // Stripe transaction amounts are negative for purchases
    const totalSpentCents = transactions.data.reduce(
      (sum, tx) => sum + Math.abs(tx.amount),
      0,
    );

    const totalAuthorizedCents = totalSpentCents + pendingCents;
    const availableCents = Math.max(0, spendingLimit - totalAuthorizedCents);

    return {
      spendingLimitCents: spendingLimit,
      totalAuthorizedCents,
      availableCents,
      pendingCents,
      currency: "usd",
    };
  }

  /**
   * Update spending limit on a card.
   * In Stripe Issuing, "loading funds" means increasing the spending_limit.
   */
  async loadFunds(
    cardId: string,
    newSpendingLimitCents: number,
  ): Promise<StripeCardResponse> {
    const params = new URLSearchParams();
    params.set("spending_controls[spending_limits][0][amount]", newSpendingLimitCents.toString());
    params.set("spending_controls[spending_limits][0][interval]", "all_time");

    return this.request<StripeCardResponse>(
      "POST",
      `/issuing/cards/${cardId}`,
      params,
    );
  }

  /** Freeze a card (prevent new transactions). */
  async freezeCard(cardId: string): Promise<void> {
    const params = new URLSearchParams();
    params.set("status", "inactive");
    await this.request<unknown>("POST", `/issuing/cards/${cardId}`, params);
  }

  /** Cancel a card permanently. */
  async cancelCard(cardId: string): Promise<void> {
    const params = new URLSearchParams();
    params.set("status", "canceled");
    await this.request<unknown>("POST", `/issuing/cards/${cardId}`, params);
  }
}
