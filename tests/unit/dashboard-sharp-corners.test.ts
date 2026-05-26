import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

/**
 * Returns all rounded-* classes found in a file, excluding rounded-none.
 * Matches Tailwind patterns like rounded-sm, rounded-md, rounded-lg,
 * rounded-xl, rounded-2xl, rounded-full, rounded-[Npx], etc.
 */
function findRoundedClasses(content: string): string[] {
  const matches = content.match(/rounded-(?!none\b)\w+(\[\w+\])?/g);
  return matches ?? [];
}

// ─── VAL-SC-001: CSS variable --radius is 0 in :root ───────────────

describe("VAL-SC-001: CSS variable --radius is 0 in :root", () => {
  const css = readFile("app/globals.css");

  it("--radius is set to 0", () => {
    expect(css).toMatch(/--radius:\s*0\s*;/);
  });

  it("--radius-sm is set to 0", () => {
    expect(css).toMatch(/--radius-sm:\s*0\s*;/);
  });

  it("--radius-md is set to 0", () => {
    expect(css).toMatch(/--radius-md:\s*0\s*;/);
  });

  it("--radius-lg is set to 0", () => {
    expect(css).toMatch(/--radius-lg:\s*0\s*;/);
  });

  it("--radius-xl is set to 0", () => {
    expect(css).toMatch(/--radius-xl:\s*0\s*;/);
  });

  it("--radius-2xl is set to 0", () => {
    expect(css).toMatch(/--radius-2xl:\s*0\s*;/);
  });

  it("--radius-3xl is set to 0", () => {
    expect(css).toMatch(/--radius-3xl:\s*0\s*;/);
  });

  it("--radius-4xl is set to 0", () => {
    expect(css).toMatch(/--radius-4xl:\s*0\s*;/);
  });
});

// ─── VAL-SC-002: Card component has rounded-none ─────────────────

describe("VAL-SC-002: Card components render with 0 border-radius", () => {
  it("card.tsx uses rounded-none", () => {
    const card = readFile("components/ui/card.tsx");
    expect(card).toContain("rounded-none");
    expect(findRoundedClasses(card)).toHaveLength(0);
  });
});

// ─── VAL-SC-003: Button components render with 0 border-radius ───

describe("VAL-SC-003: Button components render with 0 border-radius", () => {
  it("button.tsx base styles use rounded-none", () => {
    const button = readFile("components/ui/button.tsx");
    expect(button).toContain("rounded-none");
    expect(findRoundedClasses(button)).toHaveLength(0);
  });
});

// ─── VAL-SC-004: Input elements render with 0 border-radius ─────

describe("VAL-SC-004: Input elements render with 0 border-radius", () => {
  it("input.tsx uses rounded-none", () => {
    const input = readFile("components/ui/input.tsx");
    expect(input).toContain("rounded-none");
    expect(findRoundedClasses(input)).toHaveLength(0);
  });

  it("textarea.tsx uses rounded-none", () => {
    const textarea = readFile("components/ui/textarea.tsx");
    expect(textarea).toContain("rounded-none");
    expect(findRoundedClasses(textarea)).toHaveLength(0);
  });
});

// ─── VAL-SC-005: Badge elements render with 0 border-radius ─────

describe("VAL-SC-005: Badge elements render with 0 border-radius", () => {
  it("badge.tsx uses rounded-none (not rounded-full)", () => {
    const badge = readFile("components/ui/badge.tsx");
    expect(badge).toContain("rounded-none");
    expect(findRoundedClasses(badge)).toHaveLength(0);
  });
});

// ─── VAL-SC-006: Dialog elements render with 0 border-radius ────

describe("VAL-SC-006: Dialog/modal elements render with 0 border-radius", () => {
  it("dialog.tsx uses rounded-none", () => {
    const dialog = readFile("components/ui/dialog.tsx");
    expect(dialog).toContain("rounded-none");
    expect(findRoundedClasses(dialog)).toHaveLength(0);
  });
});

// ─── VAL-SC-007: Org chart node cards render with 0 border-radius ──

describe("VAL-SC-007: Org chart node cards render with 0 border-radius", () => {
  it("org-chart.tsx uses rounded-none for node card", () => {
    const orgChart = readFile("components/company/org-chart.tsx");
    expect(orgChart).toContain("rounded-none");
    expect(findRoundedClasses(orgChart)).toHaveLength(0);
  });
});

// ─── VAL-SC-008: Chat message bubbles render with 0 border-radius ──

describe("VAL-SC-008: Chat message bubbles render with 0 border-radius", () => {
  it("ceo-chat-panel.tsx uses rounded-none for message bubbles", () => {
    const chat = readFile("components/company/ceo-chat-panel.tsx");
    expect(chat).toContain("rounded-none");
    expect(findRoundedClasses(chat)).toHaveLength(0);
  });
});

// ─── VAL-SC-009: No rounded Tailwind classes in app components ──

describe("VAL-SC-009: No rounded Tailwind classes in app components (except landing page)", () => {
  const appComponentFiles = [
    "components/company/compact-metrics.tsx",
    "components/company/agent-slide-over.tsx",
    "components/company/tasks-summary.tsx",
    "components/company/token-balance-card.tsx",
    "components/company/org-chart.tsx",
    "components/company/company-sidebar.tsx",
    "components/company/burn-rate-card.tsx",
    "components/company/agent-activity-feed.tsx",
    "components/company/results-section.tsx",
    "components/company/runtime-status-banner.tsx",
    "components/company/message-board.tsx",
    "components/company/finder-documents.tsx",
    "components/company/links-section.tsx",
    "components/company/automations-section.tsx",
    "components/company/metrics-summary.tsx",
    "components/company/documents-section.tsx",
    "components/company/activity-timeline.tsx",
    "components/company/agent-messages-tab.tsx",
    "components/company/import-companies-sh-modal.tsx",
    "components/company/invite-external-agent-modal.tsx",
    "components/theme-toggle.tsx",
    "components/activity-feed.tsx",
    "components/launch-form.tsx",
    "components/metrics-panel.tsx",
    "components/status-badge.tsx",
    "components/shared/sidebar-account-menu.tsx",
    "components/shared/account-menu-surface.tsx",
    "components/shared/page-shell.tsx",
    "components/portfolio/portfolio-page.tsx",
    "components/launch/launch-session-view.tsx",
    "components/launch/launch-idea-step.tsx",
    "components/launch/launch-progress.tsx",
  ];

  for (const file of appComponentFiles) {
    it(`${file} has no rounded-* classes (only rounded-none allowed)`, () => {
      const content = readFile(file);
      const remaining = findRoundedClasses(content);
      expect(remaining).toHaveLength(0);
    });
  }

  const appPageFiles = [
    "app/(app)/billing/page.tsx",
    "app/(app)/company/[id]/page.tsx",
    "app/(app)/company/[id]/settings/page.tsx",
    "app/(app)/company/[id]/team/page.tsx",
    "app/(app)/apply/page.tsx",
    "app/companies/page.tsx",
  ];

  for (const file of appPageFiles) {
    it(`${file} has no rounded-* classes (only rounded-none allowed)`, () => {
      const content = readFile(file);
      const remaining = findRoundedClasses(content);
      expect(remaining).toHaveLength(0);
    });
  }
});

// ─── Landing page untouched ─────────────────────────────────────

describe("Landing page STILL has its original rounded corners", () => {
  it("page.tsx retains rounded-full on buttons", () => {
    const page = readFile("app/page.tsx");
    expect(page).toContain("rounded-full");
  });

  it("page.tsx retains rounded-lg on images", () => {
    const page = readFile("app/page.tsx");
    expect(page).toContain("rounded-lg");
  });

  it("page.tsx retains rounded-xl on sections", () => {
    const page = readFile("app/page.tsx");
    expect(page).toContain("rounded-xl");
  });
});

// ─── CSS custom classes have border-radius: 0 ──────────────────

describe("CSS custom classes have border-radius: 0", () => {
  const css = readFile("app/globals.css");

  it(".card-clean has border-radius: 0", () => {
    const match = css.match(/\.card-clean\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });

  it(".btn-primary has border-radius: 0", () => {
    const match = css.match(/\.btn-primary\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });

  it(".btn-ghost has border-radius: 0", () => {
    const match = css.match(/\.btn-ghost\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });

  it(".pill has border-radius: 0", () => {
    const match = css.match(/\.pill\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });

  it(".feature-grid has border-radius: 0", () => {
    const match = css.match(/\.feature-grid\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });

  it(".gradient-border has border-radius: 0", () => {
    const match = css.match(/\.gradient-border\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });

  it(".section-label::before has border-radius: 0 (square dot)", () => {
    const match = css.match(/\.section-label::before\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });

  it(".markdown-rendered code has border-radius: 0", () => {
    const match = css.match(/\.markdown-rendered code\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });

  it(".markdown-rendered pre has border-radius: 0", () => {
    const match = css.match(/\.markdown-rendered pre\s*\{[^}]*border-radius:\s*([^;]+);/);
    expect(match).toBeTruthy();
    expect(match![1].trim()).toBe("0");
  });
});
