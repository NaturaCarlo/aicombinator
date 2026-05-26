import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Read source files for structural assertions ─────────────────

const teamPagePath = path.resolve(
  __dirname,
  "../../dashboard/src/app/(app)/company/[id]/team/page.tsx",
);
const teamPageSource = fs.readFileSync(teamPagePath, "utf-8");

const sidebarPath = path.resolve(
  __dirname,
  "../../dashboard/src/components/company/company-sidebar.tsx",
);
const sidebarSource = fs.readFileSync(sidebarPath, "utf-8");

// ─── Tests ────────────────────────────────────────────────────────

describe("Team page sidebar restoration (VAL-DESIGN-020, VAL-TEAM-003)", () => {
  describe("CompanySidebar integration", () => {
    it("imports CompanySidebar component", () => {
      expect(teamPageSource).toContain("CompanySidebar");
      expect(teamPageSource).toMatch(
        /import\s+\{[^}]*CompanySidebar[^}]*\}\s+from/,
      );
    });

    it("renders CompanySidebar in the JSX", () => {
      expect(teamPageSource).toMatch(/<CompanySidebar[\s\n]/);
    });

    it("passes companyId, agents, and agentsLoading props to CompanySidebar", () => {
      expect(teamPageSource).toContain("companyId=");
      expect(teamPageSource).toContain("agents=");
      expect(teamPageSource).toContain("agentsLoading=");
    });
  });

  describe("Flex layout for sidebar + org chart", () => {
    it("has a flex container wrapping sidebar and content", () => {
      // The top-level wrapper should use flex layout
      expect(teamPageSource).toMatch(/className="[^"]*flex[^"]*"/);
    });

    it("org chart area uses flex-1 to fill remaining space", () => {
      // The org chart container should have flex-1
      expect(teamPageSource).toMatch(/className="[^"]*flex-1[^"]*"/);
    });
  });

  describe("Floating back link removed", () => {
    it("does not contain a 'Back to Dashboard' floating link", () => {
      // The old floating back-link text
      expect(teamPageSource).not.toMatch(/Dashboard<\/Link>/);
      expect(teamPageSource).not.toContain("ArrowLeft");
    });
  });

  describe("CompanySidebar nav active states", () => {
    it("sidebar determines active state from pathname for team page", () => {
      // Sidebar must detect /team as active
      expect(sidebarSource).toContain("/team");
      expect(sidebarSource).toMatch(/isTeamActive/);
    });

    it("active link uses accent-orange styling", () => {
      expect(sidebarSource).toContain("bg-accent-orange/10");
      expect(sidebarSource).toContain("text-accent-orange");
    });

    it("team link highlights when isTeamActive is true", () => {
      // The team link should conditionally apply the active class
      expect(sidebarSource).toMatch(
        /isTeamActive[\s\S]*?bg-accent-orange\/10.*?text-accent-orange/,
      );
    });
  });

  describe("Sidebar present on all company pages", () => {
    const dashboardPagePath = path.resolve(
      __dirname,
      "../../dashboard/src/app/(app)/company/[id]/page.tsx",
    );
    const dashboardPageSource = fs.readFileSync(dashboardPagePath, "utf-8");

    const settingsPagePath = path.resolve(
      __dirname,
      "../../dashboard/src/app/(app)/company/[id]/settings/page.tsx",
    );
    const settingsPageSource = fs.readFileSync(settingsPagePath, "utf-8");

    it("dashboard page includes CompanySidebar", () => {
      expect(dashboardPageSource).toContain("<CompanySidebar");
    });

    it("team page includes CompanySidebar", () => {
      expect(teamPageSource).toContain("<CompanySidebar");
    });

    it("settings page includes CompanySidebar", () => {
      expect(settingsPageSource).toContain("<CompanySidebar");
    });
  });

  describe("Sidebar structure (VAL-SIDEBAR-001 through VAL-SIDEBAR-005)", () => {
    it("sidebar has account menu trigger at bottom", () => {
      expect(sidebarSource).toContain("AccountMenuTrigger");
    });

    it("sidebar has account menu panel that expands on click", () => {
      expect(sidebarSource).toContain("AccountMenuPanel");
      expect(sidebarSource).toContain("showAccountMenu");
    });

    it("sidebar is hidden on mobile (hidden lg:flex)", () => {
      expect(sidebarSource).toMatch(/hidden\s+lg:flex/);
    });

    it("sidebar has 240px (w-60) width", () => {
      expect(sidebarSource).toContain("w-60");
    });
  });
});
