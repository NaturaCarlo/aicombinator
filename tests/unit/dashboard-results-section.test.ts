import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

// ─── VAL-DASH-001: ResultsSection wired into HomeTab ──────────────

describe("VAL-DASH-001: ResultsSection wired into HomeTab", () => {
  const homeTab = readFile("components/company/home-tab.tsx");

  it("imports ResultsSection from results-section", () => {
    expect(homeTab).toMatch(/import\s+\{?\s*ResultsSection\s*\}?\s+from\s+['"]\.\/(results-section|\.\/results-section)['"]/);
  });

  it("renders <ResultsSection", () => {
    expect(homeTab).toContain("<ResultsSection");
  });

  it("passes artifacts prop to ResultsSection", () => {
    expect(homeTab).toMatch(/<ResultsSection[^>]*artifacts\s*=\s*\{/);
  });

  it("places ResultsSection between TasksSummary and AutomationsSection", () => {
    const tasksSummaryIdx = homeTab.indexOf("<TasksSummary");
    const resultsSectionIdx = homeTab.indexOf("<ResultsSection");
    const automationsIdx = homeTab.indexOf("<AutomationsSection");

    expect(tasksSummaryIdx).toBeGreaterThan(-1);
    expect(resultsSectionIdx).toBeGreaterThan(-1);
    expect(automationsIdx).toBeGreaterThan(-1);
    expect(resultsSectionIdx).toBeGreaterThan(tasksSummaryIdx);
    expect(resultsSectionIdx).toBeLessThan(automationsIdx);
  });
});

// ─── VAL-DASH-001: ResultsSection component exists and handles empty state ──

describe("VAL-DASH-001: ResultsSection empty state", () => {
  const resultsSection = readFile("components/company/results-section.tsx");

  it("ResultsSection component file exists", () => {
    expect(resultsSection).toBeTruthy();
  });

  it("shows empty state message when no artifacts", () => {
    expect(resultsSection).toContain("No artifacts yet");
  });

  it("shows description text in empty state", () => {
    expect(resultsSection).toMatch(/founder-viewable outputs|landing pages|creative assets/);
  });
});

// ─── VAL-DASH-002: ResultsSection displays kind badges ──────────────

describe("VAL-DASH-002: ResultsSection displays kind badges and titles", () => {
  const resultsSection = readFile("components/company/results-section.tsx");

  it("has kind label map for landing_page", () => {
    expect(resultsSection).toContain("landing_page");
    expect(resultsSection).toContain("Landing page");
  });

  it("has kind label map for creative_asset", () => {
    expect(resultsSection).toContain("creative_asset");
    expect(resultsSection).toContain("Creative asset");
  });

  it("renders artifact title", () => {
    expect(resultsSection).toContain("artifact.title");
  });

  it("renders kind badge with label", () => {
    expect(resultsSection).toMatch(/KIND_LABELS\[artifact\.kind\]/);
  });
});

// ─── VAL-DASH-011: Expand/collapse for 4+ artifacts ──────────────

describe("VAL-DASH-011: Expand/collapse for 4+ artifacts", () => {
  const resultsSection = readFile("components/company/results-section.tsx");

  it("slices first 3 artifacts for preview", () => {
    expect(resultsSection).toMatch(/\.slice\(0,\s*3\)/);
  });

  it("has expand/collapse state", () => {
    expect(resultsSection).toMatch(/useState\(false\)/);
    expect(resultsSection).toContain("expanded");
  });

  it("shows 'Show N more' button when more than 3 items", () => {
    expect(resultsSection).toMatch(/Show.*more/);
  });

  it("shows 'Show less' when expanded", () => {
    expect(resultsSection).toContain("Show less");
  });

  it("toggles expanded state on button click", () => {
    expect(resultsSection).toMatch(/setExpanded\(!expanded\)/);
  });
});
