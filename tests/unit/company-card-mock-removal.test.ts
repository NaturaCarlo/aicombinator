/**
 * Tests for m3-remove-mock-data feature
 *
 * VAL-PORTFOLIO-001: No mock data on company cards
 * VAL-PORTFOLIO-002: Cards show name, status, spend, remaining
 * VAL-PORTFOLIO-003: Portfolio loads without errors (build check)
 * VAL-PORTFOLIO-004: Empty portfolio shows empty state with CTA
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const DASHBOARD_SRC = path.join(__dirname, "../../dashboard/src");

function readComponent(relPath: string): string {
  return fs.readFileSync(path.join(DASHBOARD_SRC, relPath), "utf-8");
}

describe("Company Card Mock Data Removal (m3-remove-mock-data)", () => {
  const cardSrc = readComponent("components/company-card.tsx");

  describe("VAL-PORTFOLIO-001: No mock data functions", () => {
    it("should NOT have getMockData function", () => {
      expect(cardSrc).not.toMatch(/function\s+getMockData/);
    });

    it("should NOT have hashCode function", () => {
      expect(cardSrc).not.toMatch(/function\s+hashCode/);
    });

    it("should NOT have seededRandom function", () => {
      expect(cardSrc).not.toMatch(/function\s+seededRandom/);
    });

    it("should NOT call getMockData", () => {
      expect(cardSrc).not.toMatch(/getMockData\s*\(/);
    });

    it("should NOT have Sparkline component", () => {
      expect(cardSrc).not.toMatch(/function\s+Sparkline/);
      expect(cardSrc).not.toMatch(/<Sparkline\s/);
    });

    it("should NOT have fake earnings display", () => {
      // No mock.earned or "Earned" label from mock data
      expect(cardSrc).not.toMatch(/mock\.earned/);
    });

    it("should NOT have fake growth percentage", () => {
      // No mock.growthPct reference
      expect(cardSrc).not.toMatch(/mock\.growthPct/);
      expect(cardSrc).not.toMatch(/growthPct/);
    });

    it("should NOT have fake turns count", () => {
      // No mock.turns reference
      expect(cardSrc).not.toMatch(/mock\.turns/);
    });

    it("should NOT have TrendingUp/TrendingDown icons for fake growth", () => {
      expect(cardSrc).not.toMatch(/<TrendingUp/);
      expect(cardSrc).not.toMatch(/<TrendingDown/);
    });

    it("should NOT have SVG sparkline elements", () => {
      expect(cardSrc).not.toMatch(/<svg\s/);
      expect(cardSrc).not.toMatch(/<path\s/);
    });
  });

  describe("VAL-PORTFOLIO-002: Cards show real data only", () => {
    it("should display company name", () => {
      expect(cardSrc).toMatch(/company\.name/);
    });

    it("should display status badge", () => {
      expect(cardSrc).toMatch(/<StatusBadge/);
    });

    it("should display token spend (spentCents)", () => {
      expect(cardSrc).toMatch(/company\.spentCents/);
    });

    it("should NOT display per-company remaining (unified token display)", () => {
      // Per-company remaining removed to avoid mismatch with billing-API balance
      // Account-wide balance shown on portfolio header instead
      expect(cardSrc).not.toMatch(/company\.budgetCents\s*-\s*company\.spentCents/);
      expect(cardSrc).not.toMatch(/Tokens left/i);
    });

    it("should use formatTokenCount for formatting token values", () => {
      expect(cardSrc).toMatch(/formatTokenCount/);
    });
  });
});

describe("Portfolio Page Inline CompanyCard (m3-remove-mock-data)", () => {
  const portfolioSrc = readComponent("components/portfolio/portfolio-page.tsx");

  describe("Portfolio inline CompanyCard shows spend only (unified token display)", () => {
    it("should NOT display per-company remaining tokens", () => {
      // Per-company remaining removed to avoid mismatch with billing-API balance
      expect(portfolioSrc).not.toMatch(/budgetCents\s*-\s*spentCents/);
      expect(portfolioSrc).not.toMatch(/tokens remaining/i);
    });

    it("should display company spend", () => {
      expect(portfolioSrc).toMatch(/spentCents/);
    });

    it("should have a StatusBadge", () => {
      expect(portfolioSrc).toMatch(/<StatusBadge/);
    });
  });

  describe("VAL-PORTFOLIO-004: Empty state", () => {
    it("should show 'No companies yet' message for empty portfolio", () => {
      expect(portfolioSrc).toMatch(/No companies yet/);
    });

    it("should have a 'Get Started' CTA linking to /launch", () => {
      expect(portfolioSrc).toMatch(/Get Started/);
      expect(portfolioSrc).toMatch(/\/launch/);
    });
  });
});
