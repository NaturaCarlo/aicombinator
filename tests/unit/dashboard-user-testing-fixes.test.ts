import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

// ─── VAL-DESIGN-012: Section labels use Geist Mono ─────────────────

describe("Section Labels Use Geist Mono (VAL-DESIGN-012)", () => {
  const sectionComponents = [
    { file: "components/company/tasks-summary.tsx", label: "Tasks" },
    { file: "components/company/message-board.tsx", label: "Board" },
    { file: "components/company/results-section.tsx", label: "Artifacts" },
    { file: "components/company/products-section.tsx", label: "Products" },
    { file: "components/company/links-section.tsx", label: "Links" },
    { file: "components/company/ceo-chat-panel.tsx", label: "Chat" },
    { file: "components/company/activity-timeline.tsx", label: "Activity" },
    { file: "components/company/burn-rate-card.tsx", label: "Burn Rate" },
    { file: "components/company/metrics-summary.tsx", label: "Metrics" },
    { file: "components/company/token-balance-card.tsx", label: "Available tokens" },
    { file: "components/company/automations-section.tsx", label: "Automations" },
    { file: "components/company/finder-documents.tsx", label: "Documents" },
    { file: "components/company/documents-section.tsx", label: "Documents" },
    { file: "components/company/agent-slide-over.tsx", label: "Agent Details" },
  ];

  for (const { file, label } of sectionComponents) {
    it(`${file} uses section-label class for "${label}" header`, () => {
      const content = readFile(file);
      expect(content).toContain("section-label");
    });
  }

  it("section-label CSS class uses font-family: var(--font-geist-mono)", () => {
    const css = readFile("app/globals.css");
    expect(css).toMatch(/\.section-label[\s\S]*?font-family:\s*var\(--font-geist-mono\)/);
  });

  it("section-label CSS class uses text-transform: uppercase", () => {
    const css = readFile("app/globals.css");
    expect(css).toMatch(/\.section-label[\s\S]*?text-transform:\s*uppercase/);
  });
});

// ─── VAL-DESIGN-014: Primary button dark fill ───────────────────────

describe("Primary Button Dark Fill (VAL-DESIGN-014)", () => {
  it("--primary CSS variable resolves to dark color (#020202), not orange", () => {
    const css = readFile("app/globals.css");
    // In :root, --primary should be dark
    const rootBlock = css.match(/:root\s*\{[\s\S]*?\}/);
    expect(rootBlock).not.toBeNull();
    const primaryMatch = rootBlock![0].match(/--primary:\s*([^;]+);/);
    expect(primaryMatch).not.toBeNull();
    const primaryValue = primaryMatch![1].trim();
    // Should be a dark color, not orange
    expect(primaryValue).not.toContain("ee6018");
    expect(primaryValue).not.toContain("FF6600");
    expect(primaryValue).toMatch(/#0[0-2]/); // #020202 or similar dark
  });

  it("button default variant uses bg-primary", () => {
    const button = readFile("components/ui/button.tsx");
    expect(button).toMatch(/default.*bg-primary\b/);
  });
});

// ─── VAL-DESIGN-016: Diagonal stripe hover animation ────────────────

describe("Diagonal Stripe Hover Animation (VAL-DESIGN-016)", () => {
  it("stripe-hover class has ::after pseudo-element with position:absolute and inset:0", () => {
    const css = readFile("app/globals.css");
    const stripeAfter = css.match(/\.stripe-hover::after[\s\S]*?\}/);
    expect(stripeAfter).not.toBeNull();
    expect(stripeAfter![0]).toContain("position: absolute");
    expect(stripeAfter![0]).toContain("inset: 0");
  });

  it("stripe-hover ::after has opacity:0 by default", () => {
    const css = readFile("app/globals.css");
    const stripeAfter = css.match(/\.stripe-hover::after[\s\S]*?\}/);
    expect(stripeAfter).not.toBeNull();
    expect(stripeAfter![0]).toContain("opacity: 0");
  });

  it("stripe-hover:hover::after has opacity:1", () => {
    const css = readFile("app/globals.css");
    expect(css).toContain(".stripe-hover:hover::after");
    const hoverBlock = css.match(/\.stripe-hover:hover::after[\s\S]*?\}/);
    expect(hoverBlock).not.toBeNull();
    expect(hoverBlock![0]).toContain("opacity: 1");
  });

  it("stripe-hover has repeating-linear-gradient at 45deg", () => {
    const css = readFile("app/globals.css");
    expect(css).toContain("repeating-linear-gradient");
    expect(css).toMatch(/repeating-linear-gradient\(\s*45deg/);
  });

  it("button component includes stripe-hover class", () => {
    const button = readFile("components/ui/button.tsx");
    expect(button).toContain("stripe-hover");
  });
});

// ─── VAL-DESIGN-027: Orange dot + section label pattern on dashboard ─

describe("Orange Dot + Section Label on Dashboard (VAL-DESIGN-027)", () => {
  it("section-label::before creates orange dot with #ee6018 background", () => {
    const css = readFile("app/globals.css");
    const beforeBlock = css.match(/\.section-label::before[\s\S]*?\}/);
    expect(beforeBlock).not.toBeNull();
    expect(beforeBlock![0]).toContain("#ee6018");
    expect(beforeBlock![0]).toContain("border-radius: 0");
  });

  it("dashboard section components use section-label class (>=3 components)", () => {
    const sectionFiles = [
      "components/company/tasks-summary.tsx",
      "components/company/message-board.tsx",
      "components/company/results-section.tsx",
      "components/company/products-section.tsx",
      "components/company/links-section.tsx",
      "components/company/ceo-chat-panel.tsx",
      "components/company/activity-timeline.tsx",
    ];
    let count = 0;
    for (const file of sectionFiles) {
      const content = readFile(file);
      if (content.includes("section-label")) count++;
    }
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

// ─── VAL-DESIGN-032: No box-shadow on input elements ────────────────

describe("No Box Shadow on Input Elements (VAL-DESIGN-032)", () => {
  it("Input component uses shadow-none instead of shadow-xs", () => {
    const input = readFile("components/ui/input.tsx");
    expect(input).toContain("shadow-none");
    expect(input).not.toContain("shadow-xs");
  });

  it("Textarea component uses shadow-none instead of shadow-xs", () => {
    const textarea = readFile("components/ui/textarea.tsx");
    expect(textarea).toContain("shadow-none");
    expect(textarea).not.toContain("shadow-xs");
  });

  it("agent-slide-over inline inputs/selects do not have shadow-xs", () => {
    const slideOver = readFile("components/company/agent-slide-over.tsx");
    expect(slideOver).not.toContain("shadow-xs");
  });

  it("invite-external-agent-modal does not have shadow-xs", () => {
    const modal = readFile("components/company/invite-external-agent-modal.tsx");
    expect(modal).not.toContain("shadow-xs");
  });
});

// ─── VAL-DESIGN-033: Badge elements with data-slot, font-mono, uppercase ─

describe("Badge Elements (VAL-DESIGN-033)", () => {
  it("Badge component renders with data-slot='badge'", () => {
    const badge = readFile("components/ui/badge.tsx");
    expect(badge).toContain('data-slot="badge"');
  });

  it("Badge component has font-mono class", () => {
    const badge = readFile("components/ui/badge.tsx");
    expect(badge).toContain("font-mono");
  });

  it("Badge component has uppercase class", () => {
    const badge = readFile("components/ui/badge.tsx");
    expect(badge).toContain("uppercase");
  });
});

// ─── VAL-DESIGN-044: .card-clean uses token-based border-radius ─────

describe("Card-clean Token-based Border Radius (VAL-DESIGN-044)", () => {
  it(".card-clean does NOT use hardcoded border-radius: 1rem", () => {
    const css = readFile("app/globals.css");
    const cardCleanBlock = css.match(/\.card-clean\s*\{[\s\S]*?\}/);
    expect(cardCleanBlock).not.toBeNull();
    expect(cardCleanBlock![0]).not.toContain("border-radius: 1rem");
  });

  it(".card-clean uses border-radius: 0 for sharp corners", () => {
    const css = readFile("app/globals.css");
    const cardCleanBlock = css.match(/\.card-clean\s*\{[\s\S]*?\}/);
    expect(cardCleanBlock).not.toBeNull();
    expect(cardCleanBlock![0]).toContain("border-radius: 0");
  });

  it("no hardcoded border-radius: 1rem anywhere in globals.css", () => {
    const css = readFile("app/globals.css");
    expect(css).not.toMatch(/border-radius:\s*1rem/);
  });
});

// ─── Settings Page Section Labels ───────────────────────────────────

describe("Settings Page Section Labels (VAL-DESIGN-012 extension)", () => {
  it("settings page company label uses section-label class", () => {
    const settings = readFile("app/(app)/company/[id]/settings/page.tsx");
    expect(settings).toContain("section-label");
  });

  it("settings page sub-labels use font-mono for uppercase text", () => {
    const settings = readFile("app/(app)/company/[id]/settings/page.tsx");
    // Inline labels like "Public page", "Model", "Hosted domain" should have font-mono
    const publicPageLine = settings.match(/Public page[\s\S]{0,100}/);
    expect(publicPageLine).not.toBeNull();
    // The className for these labels should include font-mono
    const labelPattern = /font-mono.*uppercase|uppercase.*font-mono/;
    // Check that font-mono appears near these labels
    expect(settings).toMatch(/font-mono.*uppercase.*text-muted-foreground.*Public page/s);
  });
});
