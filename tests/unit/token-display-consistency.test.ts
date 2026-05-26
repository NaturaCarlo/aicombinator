/**
 * Tests for m6-fix-token-display-consistency feature
 *
 * VAL-CROSS-013: Token balance consistent across displays
 *
 * Ensures portfolio company cards do NOT show per-company "remaining" tokens
 * (which conflicts with the dashboard's billing-API-based balance).
 * Only "company spend" is shown per-company, while account-wide balance
 * is shown at the top of the portfolio page from the billing API.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const DASHBOARD_SRC = path.join(__dirname, "../../dashboard/src");

function readComponent(relPath: string): string {
  return fs.readFileSync(path.join(DASHBOARD_SRC, relPath), "utf-8");
}

describe("Token Display Consistency (m6-fix-token-display-consistency)", () => {
  describe("Portfolio page company cards should NOT show per-company remaining tokens", () => {
    const portfolioSrc = readComponent("components/portfolio/portfolio-page.tsx");

    it("should NOT compute remaining from budgetCents - spentCents", () => {
      // The inline CompanyCard should not calculate remaining tokens
      expect(portfolioSrc).not.toMatch(/budgetCents\s*-\s*spentCents/);
    });

    it("should NOT display 'tokens remaining' label", () => {
      expect(portfolioSrc).not.toMatch(/tokens remaining/i);
    });

    it("should still display company spend (spentCents)", () => {
      expect(portfolioSrc).toMatch(/spentCents/);
    });

    it("should still show account-wide balance at the top from billing API", () => {
      // The portfolio page should show billing-API-based balance
      expect(portfolioSrc).toMatch(/availableCredits/);
    });
  });

  describe("Standalone company-card.tsx should NOT show per-company remaining tokens", () => {
    const cardSrc = readComponent("components/company-card.tsx");

    it("should NOT compute remaining from budgetCents - spentCents", () => {
      expect(cardSrc).not.toMatch(/budgetCents\s*-\s*spentCents/);
    });

    it("should NOT display 'Tokens left' label", () => {
      expect(cardSrc).not.toMatch(/Tokens left/i);
    });

    it("should NOT have a 'remaining' variable", () => {
      // Should not compute a remaining value at all
      expect(cardSrc).not.toMatch(/const\s+remaining\s*=/);
    });

    it("should still display company spend (spentCents)", () => {
      expect(cardSrc).toMatch(/company\.spentCents/);
    });

    it("should still display company name", () => {
      expect(cardSrc).toMatch(/company\.name/);
    });

    it("should still display status badge", () => {
      expect(cardSrc).toMatch(/<StatusBadge/);
    });
  });

  describe("Account-wide balance is single source of truth", () => {
    const portfolioSrc = readComponent("components/portfolio/portfolio-page.tsx");

    it("should use billing API for account balance display", () => {
      // Portfolio page should use useBilling hook
      expect(portfolioSrc).toMatch(/useBilling/);
    });

    it("should display account balance prominently", () => {
      // The balance display should reference availableCredits
      expect(portfolioSrc).toMatch(/availableCredits/);
      // And show label like 'available across your account'
      expect(portfolioSrc).toMatch(/available across your account/i);
    });
  });
});
