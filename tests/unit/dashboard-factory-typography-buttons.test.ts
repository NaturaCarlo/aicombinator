import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

// ─── VAL-DESIGN-009: Geist Sans Font Loading ───────────────────────

describe("Geist Sans Font Loading (VAL-DESIGN-009)", () => {
  it("layout.tsx imports Geist from next/font/google", () => {
    const layout = readFile("app/layout.tsx");
    expect(layout).toContain("Geist");
    expect(layout).toMatch(/from\s+["']next\/font\/google["']/);
  });

  it("layout.tsx applies --font-geist-sans variable to body", () => {
    const layout = readFile("app/layout.tsx");
    expect(layout).toContain("geistSans.variable");
  });

  it("globals.css sets --font-sans to var(--font-geist-sans)", () => {
    const css = readFile("app/globals.css");
    expect(css).toContain("--font-sans: var(--font-geist-sans)");
  });
});

// ─── VAL-DESIGN-010: Geist Mono Font Loading ───────────────────────

describe("Geist Mono Font Loading (VAL-DESIGN-010)", () => {
  it("layout.tsx imports Geist_Mono from next/font/google", () => {
    const layout = readFile("app/layout.tsx");
    expect(layout).toContain("Geist_Mono");
  });

  it("layout.tsx applies --font-geist-mono variable to body", () => {
    const layout = readFile("app/layout.tsx");
    expect(layout).toContain("geistMono.variable");
  });

  it("globals.css sets --font-mono to var(--font-geist-mono)", () => {
    const css = readFile("app/globals.css");
    expect(css).toContain("--font-mono: var(--font-geist-mono)");
  });
});

// ─── VAL-DESIGN-011: Uppercase Navigation Links ────────────────────

describe("Uppercase Navigation Links (VAL-DESIGN-011)", () => {
  it("sidebar nav links use uppercase class", () => {
    const sidebar = readFile("components/company/company-sidebar.tsx");
    // Nav link spans should have uppercase
    expect(sidebar).toContain("uppercase");
  });

  it("sidebar nav links use font-mono class", () => {
    const sidebar = readFile("components/company/company-sidebar.tsx");
    expect(sidebar).toContain("font-mono");
  });
});

// ─── VAL-DESIGN-012: Monospace Section Labels ──────────────────────

describe("Monospace Section Labels (VAL-DESIGN-012)", () => {
  it("section labels in globals.css use Geist Mono font", () => {
    const css = readFile("app/globals.css");
    // section-label class should use var(--font-geist-mono)
    expect(css).toContain(".section-label");
    expect(css).toMatch(/\.section-label[\s\S]*font-family:\s*var\(--font-geist-mono\)/);
  });

  it("section-label class has text-transform: uppercase", () => {
    const css = readFile("app/globals.css");
    expect(css).toMatch(/\.section-label[\s\S]*text-transform:\s*uppercase/);
  });
});

// ─── VAL-DESIGN-013: Heading Typography ────────────────────────────

describe("Heading Typography (VAL-DESIGN-013)", () => {
  it("globals.css contains heading-serif class using Instrument Serif for landing page headings", () => {
    const css = readFile("app/globals.css");
    // heading-serif uses Instrument Serif for the landing page (reverted from Geist)
    expect(css).toMatch(/\.heading-serif[\s\S]*font-family:\s*var\(--font-instrument-serif\)/);
  });
});

// ─── VAL-DESIGN-014 & VAL-DESIGN-015: Button Styles ────────────────

describe("Primary Button: Dark Fill Style (VAL-DESIGN-014)", () => {
  it("button default variant uses bg-primary (dark fill)", () => {
    const button = readFile("components/ui/button.tsx");
    expect(button).toMatch(/default.*bg-primary\b/);
  });

  it("button default variant does NOT use shadow classes", () => {
    const button = readFile("components/ui/button.tsx");
    // Shadow on default button should be absent
    const defaultLine = button.match(/default:\s*"([^"]+)"/);
    if (defaultLine) {
      expect(defaultLine[1]).not.toContain("shadow");
    }
  });
});

describe("Secondary/Outline Button Style (VAL-DESIGN-015)", () => {
  it("outline variant has border but no shadow", () => {
    const button = readFile("components/ui/button.tsx");
    const outlineLine = button.match(/outline:\s*\n?\s*"([^"]+)"/);
    if (outlineLine) {
      expect(outlineLine[1]).toContain("border");
      expect(outlineLine[1]).not.toContain("shadow");
    }
  });
});

// ─── VAL-DESIGN-016: Diagonal Stripe Hover Animation ───────────────

describe("Diagonal Stripe Hover Animation (VAL-DESIGN-016)", () => {
  it("globals.css contains diagonal stripe animation keyframes", () => {
    const css = readFile("app/globals.css");
    expect(css).toContain("@keyframes slideStripePattern");
  });

  it("globals.css has stripe-hover class with repeating-linear-gradient at 45deg", () => {
    const css = readFile("app/globals.css");
    expect(css).toContain("repeating-linear-gradient");
    expect(css).toContain("45deg");
  });

  it("button component references stripe hover pattern", () => {
    const button = readFile("components/ui/button.tsx");
    expect(button).toContain("stripe-hover");
  });
});

// ─── VAL-DESIGN-027: Orange Dot + Section Label Pattern ────────────

describe("Orange Dot + Section Label Pattern (VAL-DESIGN-027)", () => {
  it("globals.css has section-label class with orange dot pseudo-element", () => {
    const css = readFile("app/globals.css");
    // Should have .section-label::before with orange dot
    expect(css).toContain(".section-label");
    expect(css).toContain("#ee6018");
  });
});

// ─── VAL-DESIGN-033: Badge Styling — Monospace Uppercase ────────────

describe("Badge Styling: Monospace Uppercase (VAL-DESIGN-033)", () => {
  it("badge component includes font-mono class", () => {
    const badge = readFile("components/ui/badge.tsx");
    expect(badge).toContain("font-mono");
  });

  it("badge component includes uppercase class", () => {
    const badge = readFile("components/ui/badge.tsx");
    expect(badge).toContain("uppercase");
  });
});

// ─── VAL-DESIGN-037: Landing Page Fonts Scoped via CSS ────────────────────

describe("Landing Page Fonts Scoped (VAL-DESIGN-037 revised)", () => {
  it("layout.tsx imports Outfit for landing page", () => {
    const layout = readFile("app/layout.tsx");
    expect(layout).toContain("Outfit");
  });

  it("layout.tsx imports Instrument_Serif for landing page headings", () => {
    const layout = readFile("app/layout.tsx");
    expect(layout).toContain("Instrument_Serif");
  });

  it("layout.tsx imports Source_Serif_4 for landing page body serif text", () => {
    const layout = readFile("app/layout.tsx");
    expect(layout).toContain("Source_Serif_4");
  });

  it("layout.tsx body class includes all font CSS variables", () => {
    const layout = readFile("app/layout.tsx");
    expect(layout).toContain("sourceSerif4.variable");
    expect(layout).toContain("outfit.variable");
    expect(layout).toContain("instrumentSerif.variable");
  });

  it("globals.css scopes landing page fonts via .landing-page-scope class", () => {
    const css = readFile("app/globals.css");
    // Landing page fonts are scoped, not in :root
    expect(css).toMatch(/\.landing-page-scope[\s\S]*?--font-sans:\s*var\(--font-outfit\)/);
    expect(css).toMatch(/\.landing-page-scope[\s\S]*?--font-serif:\s*var\(--font-source-serif\)/);
  });
});

// ─── VAL-DESIGN-043: Reduced Motion Respect ────────────────────────

describe("Reduced Motion Respect (VAL-DESIGN-043)", () => {
  it("globals.css has prefers-reduced-motion media query that targets stripe animation", () => {
    const css = readFile("app/globals.css");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("stripe-hover");
  });
});
