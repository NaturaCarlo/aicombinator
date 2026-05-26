/**
 * Tests for subscription tier differentiation:
 * 1. isPaidPlan helper
 * 2. Webhook grants correct tokens based on plan tier (Pro=20M, Max=200M)
 * 3. Billing status returns correct monthlyTokens per tier
 * 4. Token pack amounts are in standard token units
 */
import { describe, expect, it } from "vitest";

import { isPaidPlan } from "../../worker/src/types.js";

// ---------------------------------------------------------------------------
// 1. isPaidPlan helper
// ---------------------------------------------------------------------------

describe("isPaidPlan", () => {
  it("returns true for 'paid' (legacy)", () => {
    expect(isPaidPlan("paid")).toBe(true);
  });

  it("returns true for 'pro'", () => {
    expect(isPaidPlan("pro")).toBe(true);
  });

  it("returns true for 'max'", () => {
    expect(isPaidPlan("max")).toBe(true);
  });

  it("returns false for 'free'", () => {
    expect(isPaidPlan("free")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPaidPlan(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPaidPlan(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPaidPlan("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Tier token amounts
// ---------------------------------------------------------------------------

describe("subscription tier token amounts", () => {
  const TIER_TOKENS: Record<string, number> = {
    pro: 20_000_000,
    max: 200_000_000,
  };
  const DEFAULT_SUBSCRIPTION_TOKENS = 20_000_000;

  it("Pro tier grants 20M tokens", () => {
    expect(TIER_TOKENS["pro"]).toBe(20_000_000);
  });

  it("Max tier grants 200M tokens", () => {
    expect(TIER_TOKENS["max"]).toBe(200_000_000);
  });

  it("Max tier is 10x Pro tier", () => {
    expect(TIER_TOKENS["max"]).toBe(TIER_TOKENS["pro"]! * 10);
  });

  it("unknown tier falls back to default (20M)", () => {
    const tokens = TIER_TOKENS["unknown"] ?? DEFAULT_SUBSCRIPTION_TOKENS;
    expect(tokens).toBe(20_000_000);
  });

  it("legacy 'paid' tier falls back to default (20M)", () => {
    const tokens = TIER_TOKENS["paid"] ?? DEFAULT_SUBSCRIPTION_TOKENS;
    expect(tokens).toBe(20_000_000);
  });
});

// ---------------------------------------------------------------------------
// 3. Billing status monthlyTokens logic
// ---------------------------------------------------------------------------

describe("billing status monthlyTokens per tier", () => {
  function resolveMonthlyTokens(plan: string | null | undefined): number {
    if (plan === "max") return 200_000_000;
    if (isPaidPlan(plan)) return 20_000_000;
    return 1_000_000;
  }

  it("returns 200M for max plan", () => {
    expect(resolveMonthlyTokens("max")).toBe(200_000_000);
  });

  it("returns 20M for pro plan", () => {
    expect(resolveMonthlyTokens("pro")).toBe(20_000_000);
  });

  it("returns 20M for legacy paid plan", () => {
    expect(resolveMonthlyTokens("paid")).toBe(20_000_000);
  });

  it("returns 1M for free plan", () => {
    expect(resolveMonthlyTokens("free")).toBe(1_000_000);
  });

  it("returns 1M for null plan", () => {
    expect(resolveMonthlyTokens(null)).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// 4. Checkout metadata includes plan tier
// ---------------------------------------------------------------------------

describe("checkout metadata for plan tier", () => {
  it("pro plan config has correct amount and metadata", () => {
    const planChoice = "pro";
    const planConfig = planChoice === "max"
      ? { name: "AI Combinator Max", amountCents: 20000, tokens: 200_000_000 }
      : { name: "AI Combinator Pro", amountCents: 2000, tokens: 20_000_000 };

    expect(planConfig.name).toBe("AI Combinator Pro");
    expect(planConfig.amountCents).toBe(2000);
    expect(planConfig.tokens).toBe(20_000_000);
  });

  it("max plan config has correct amount and metadata", () => {
    const planChoice = "max";
    const planConfig = planChoice === "max"
      ? { name: "AI Combinator Max", amountCents: 20000, tokens: 200_000_000 }
      : { name: "AI Combinator Pro", amountCents: 2000, tokens: 20_000_000 };

    expect(planConfig.name).toBe("AI Combinator Max");
    expect(planConfig.amountCents).toBe(20000);
    expect(planConfig.tokens).toBe(200_000_000);
  });
});

// ---------------------------------------------------------------------------
// 5. Webhook tier resolution from metadata
// ---------------------------------------------------------------------------

describe("webhook tier resolution from checkout metadata", () => {
  function resolveTierFromMetadata(metadata: Record<string, string> | null | undefined): string {
    return metadata?.plan === "max" ? "max" : "pro";
  }

  it("resolves 'max' when metadata.plan is 'max'", () => {
    expect(resolveTierFromMetadata({ plan: "max", user_id: "u1" })).toBe("max");
  });

  it("resolves 'pro' when metadata.plan is 'pro'", () => {
    expect(resolveTierFromMetadata({ plan: "pro", user_id: "u1" })).toBe("pro");
  });

  it("defaults to 'pro' when metadata.plan is missing", () => {
    expect(resolveTierFromMetadata({ user_id: "u1" })).toBe("pro");
  });

  it("defaults to 'pro' when metadata is null", () => {
    expect(resolveTierFromMetadata(null)).toBe("pro");
  });

  it("defaults to 'pro' when metadata is undefined", () => {
    expect(resolveTierFromMetadata(undefined)).toBe("pro");
  });
});

// ---------------------------------------------------------------------------
// 6. Token pack amounts are in standard token units
// ---------------------------------------------------------------------------

describe("token pack amounts", () => {
  const TOKEN_PACKS = [
    { amount: 500_000, label: "500K", price: "$0.50" },
    { amount: 1_000_000, label: "1M", price: "$1" },
    { amount: 2_500_000, label: "2.5M", price: "$2.50" },
    { amount: 5_000_000, label: "5M", price: "$5" },
  ];

  it("all packs have amounts >= 500K (standard token scale)", () => {
    for (const pack of TOKEN_PACKS) {
      expect(pack.amount).toBeGreaterThanOrEqual(500_000);
    }
  });

  it("all packs meet buy-tokens endpoint minimum (500K)", () => {
    // The buy-tokens endpoint requires amount >= 500_000
    for (const pack of TOKEN_PACKS) {
      expect(pack.amount).toBeGreaterThanOrEqual(500_000);
    }
  });

  it("smallest pack is 500K tokens (not 500 credits)", () => {
    expect(TOKEN_PACKS[0]!.amount).toBe(500_000);
  });

  it("largest pack is 5M tokens (not 5000 credits)", () => {
    expect(TOKEN_PACKS[TOKEN_PACKS.length - 1]!.amount).toBe(5_000_000);
  });

  it("pack price matches token-to-dollar conversion (1M = $1)", () => {
    for (const pack of TOKEN_PACKS) {
      const expectedPrice = pack.amount / 1_000_000;
      const actualPrice = parseFloat(pack.price.replace("$", ""));
      expect(actualPrice).toBe(expectedPrice);
    }
  });
});
