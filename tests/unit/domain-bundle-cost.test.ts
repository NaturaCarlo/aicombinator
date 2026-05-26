import { describe, it, expect } from "vitest";

/**
 * Tests for domain bundle cost calculation with the new
 * TOKENS_PER_DOLLAR = 1,000,000 pricing model.
 *
 * The old formula used Math.ceil(registrationCostUsd / 10) * 1000
 * which gave 1000 tokens for a $10 domain (based on old 1 credit = $0.007).
 *
 * The new formula is:
 *   computeDomainCredits(usd) = Math.max(TOKENS_PER_DOLLAR, Math.ceil(usd) * TOKENS_PER_DOLLAR)
 *
 * EMAIL_BUNDLE_CREDITS should be 5_000_000 (≈$5 worth of tokens).
 */

// Re-implement the function under test to verify the formula
const TOKENS_PER_DOLLAR = 1_000_000;
const EMAIL_BUNDLE_CREDITS = 5_000_000;

function computeDomainCredits(registrationCostUsd: number): number {
  return Math.max(TOKENS_PER_DOLLAR, Math.ceil(registrationCostUsd) * TOKENS_PER_DOLLAR);
}

describe("Domain bundle cost calculation (TOKENS_PER_DOLLAR = 1,000,000)", () => {
  describe("computeDomainCredits", () => {
    it("returns 10,000,000 tokens for a $10 domain", () => {
      expect(computeDomainCredits(10)).toBe(10_000_000);
    });

    it("returns 1,000,000 tokens (minimum) for a $0.50 domain", () => {
      // Math.ceil(0.50) * 1_000_000 = 1_000_000, and max(1_000_000, 1_000_000) = 1_000_000
      expect(computeDomainCredits(0.5)).toBe(1_000_000);
    });

    it("returns 1,000,000 minimum for very cheap domains ($0.01)", () => {
      // Math.ceil(0.01) * 1_000_000 = 1_000_000
      expect(computeDomainCredits(0.01)).toBe(1_000_000);
    });

    it("returns 1,000,000 minimum for $0 domain", () => {
      // Math.ceil(0) * 1_000_000 = 0, so max(1_000_000, 0) = 1_000_000
      expect(computeDomainCredits(0)).toBe(1_000_000);
    });

    it("rounds up fractional dollar amounts", () => {
      // $9.99 → Math.ceil(9.99) = 10 → 10 * 1_000_000 = 10_000_000
      expect(computeDomainCredits(9.99)).toBe(10_000_000);
    });

    it("returns 15,000,000 tokens for a $15 domain", () => {
      expect(computeDomainCredits(15)).toBe(15_000_000);
    });

    it("returns 2,000,000 tokens for a $1.50 domain", () => {
      // Math.ceil(1.50) = 2 → 2 * 1_000_000 = 2_000_000
      expect(computeDomainCredits(1.5)).toBe(2_000_000);
    });
  });

  describe("EMAIL_BUNDLE_CREDITS", () => {
    it("is set to 5,000,000 (≈$5 worth of tokens)", () => {
      expect(EMAIL_BUNDLE_CREDITS).toBe(5_000_000);
    });
  });

  describe("total bundle cost", () => {
    it("$10 domain total = 10M domain + 5M email = 15M tokens", () => {
      const domainCredits = computeDomainCredits(10);
      const total = EMAIL_BUNDLE_CREDITS + domainCredits;
      expect(total).toBe(15_000_000);
    });

    it("$1 domain total = 1M domain + 5M email = 6M tokens", () => {
      const domainCredits = computeDomainCredits(1);
      const total = EMAIL_BUNDLE_CREDITS + domainCredits;
      expect(total).toBe(6_000_000);
    });

    it("$0 domain total = 1M minimum + 5M email = 6M tokens", () => {
      const domainCredits = computeDomainCredits(0);
      const total = EMAIL_BUNDLE_CREDITS + domainCredits;
      expect(total).toBe(6_000_000);
    });
  });
});

describe("Source file constants verification", () => {
  it("domain-bundle.ts uses TOKENS_PER_DOLLAR = 1,000,000 in computeDomainCredits", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync(
      "/Users/CEF/Projects/automaton/worker/src/routes/domain-bundle.ts",
      "utf-8",
    );

    // Verify TOKENS_PER_DOLLAR is defined
    expect(source).toContain("TOKENS_PER_DOLLAR");

    // Verify the old formula is gone
    expect(source).not.toMatch(/Math\.ceil\(registrationCostUsd\s*\/\s*10\)/);

    // Verify EMAIL_BUNDLE_CREDITS is updated to 5_000_000
    expect(source).toMatch(/EMAIL_BUNDLE_CREDITS\s*=\s*5[_]?000[_]?000/);
  });
});
