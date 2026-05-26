/**
 * Tests for m3-token-display-clarity feature
 *
 * VAL-TOKEN-001: "Total used" label clarity (cumulative spend, neutral icon)
 * VAL-TOKEN-002: Card shows available, used, burn rate
 * VAL-TOKEN-003: Token formatting (M suffix for millions)
 * VAL-TOKEN-004: No animation on spent counter
 * VAL-TOKEN-005: Zero balance state (show "0" with "Add tokens" CTA)
 * VAL-BILLING-009: Billing page uses #ee6018 accent
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const DASHBOARD_SRC = path.join(__dirname, "../../dashboard/src");

function readComponent(relPath: string): string {
  return fs.readFileSync(path.join(DASHBOARD_SRC, relPath), "utf-8");
}

describe("Token Balance Card (m3-token-display-clarity)", () => {
  const src = readComponent("components/company/token-balance-card.tsx");

  describe("VAL-TOKEN-001: Total used icon clarity", () => {
    it("should NOT import Zap icon", () => {
      // Zap (lightning) implies active/energy, not cumulative spend
      expect(src).not.toMatch(/import\s+.*\bZap\b.*from\s+["']lucide-react["']/);
    });

    it("should NOT use <Zap in JSX", () => {
      expect(src).not.toMatch(/<Zap\s/);
    });

    it("should import a neutral icon for total used (BarChart3)", () => {
      expect(src).toMatch(/import\s+.*\bBarChart3\b.*from\s+["']lucide-react["']/);
    });

    it("should use BarChart3 icon in JSX for total used", () => {
      expect(src).toMatch(/<BarChart3\s/);
    });

    it("should have a label that clearly conveys cumulative lifetime spend", () => {
      // The label should say "Total used" or "Lifetime spend" - something clearly cumulative
      expect(src).toMatch(/Total used|Lifetime spend/i);
    });
  });

  describe("VAL-TOKEN-004: No counting animation on spent counter", () => {
    it("should NOT have any counting animation classes or inline styles on spent value", () => {
      // No animate-*, count-up, transition on the spent number
      expect(src).not.toMatch(/animate-count|count-up|countUp/);
    });

    it("should use static rendering for total used value (tabular-nums only)", () => {
      // The spent counter should use tabular-nums for alignment, but no animation
      expect(src).toMatch(/tabular-nums/);
    });
  });

  describe("VAL-TOKEN-005: Zero balance state", () => {
    it("should handle zero balance with Add tokens CTA", () => {
      // When availableCredits <= 0, the component should show "Add tokens" button
      expect(src).toMatch(/Add tokens/);
    });

    it("should link Add tokens CTA to /billing", () => {
      expect(src).toMatch(/href=["']\/billing["']/);
    });
  });

  describe("VAL-TOKEN-003: Token formatting with M suffix", () => {
    it("should use formatTokenCount for total spent display", () => {
      expect(src).toMatch(/formatTokenCount\(totalSpent\)/);
    });

    it("should use formatTokenCount for 24h display", () => {
      expect(src).toMatch(/formatTokenCount\(tokensLast24h\)/);
    });

    it("should use formatTokens or formatTokenCount for available tokens", () => {
      expect(src).toMatch(/formatTokens\(availableCredits\)/);
    });
  });
});

describe("Billing Page Accent Color (VAL-BILLING-009)", () => {
  const billingDir = path.join(DASHBOARD_SRC, "app/(app)/billing");

  it("should NOT contain any hardcoded #FF6600 in billing page", () => {
    const files = fs.readdirSync(billingDir);
    for (const file of files) {
      if (file.endsWith(".tsx") || file.endsWith(".ts")) {
        const content = fs.readFileSync(path.join(billingDir, file), "utf-8");
        expect(content).not.toMatch(/#FF6600/i);
      }
    }
  });

  it("billing page should use #ee6018 accent", () => {
    const page = readComponent("app/(app)/billing/page.tsx");
    // Should reference #ee6018 directly or use CSS variable
    expect(page).toMatch(/#ee6018|accent-orange|var\(--brand\)/);
  });
});
