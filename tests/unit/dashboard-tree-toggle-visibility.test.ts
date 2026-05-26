import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const tasksSummaryPath = path.resolve(
  __dirname,
  "../../dashboard/src/components/company/tasks-summary.tsx"
);
const tasksSummary = fs.readFileSync(tasksSummaryPath, "utf-8");

// ─── VAL-DASH-003: Tree/list toggle icons are visually accessible ───

describe("VAL-DASH-003: Tree/list toggle icons are visually accessible", () => {
  it("toggle icons use h-4 w-4 (16px) or larger, not h-3 w-3", () => {
    // Find the toggle button section (List and GitBranch icons in the header)
    const listIconMatch = tasksSummary.match(/<List\s+className="([^"]+)"/);
    const gitBranchIconMatch = tasksSummary.match(/<GitBranch\s+className="([^"]+)"/);

    expect(listIconMatch).not.toBeNull();
    expect(gitBranchIconMatch).not.toBeNull();

    // Ensure icons are at least h-4 w-4 (not h-3 w-3)
    const listClasses = listIconMatch![1];
    const gitBranchClasses = gitBranchIconMatch![1];

    expect(listClasses).not.toMatch(/\bh-3\b/);
    expect(listClasses).not.toMatch(/\bw-3\b/);
    expect(gitBranchClasses).not.toMatch(/\bh-3\b/);
    expect(gitBranchClasses).not.toMatch(/\bw-3\b/);

    // Ensure they have at least h-4 w-4
    expect(listClasses).toMatch(/\bh-[4-9]\b|\bh-1[0-9]\b/);
    expect(listClasses).toMatch(/\bw-[4-9]\b|\bw-1[0-9]\b/);
    expect(gitBranchClasses).toMatch(/\bh-[4-9]\b|\bh-1[0-9]\b/);
    expect(gitBranchClasses).toMatch(/\bw-[4-9]\b|\bw-1[0-9]\b/);
  });

  it("list toggle button has title attribute", () => {
    // Find the List view toggle button
    expect(tasksSummary).toMatch(/title=["']List view["']/);
  });

  it("tree toggle button has title attribute", () => {
    expect(tasksSummary).toMatch(/title=["']Tree view["']/);
  });

  it("list toggle button has aria-label attribute", () => {
    expect(tasksSummary).toMatch(/aria-label=["']List view["']/);
  });

  it("tree toggle button has aria-label attribute", () => {
    expect(tasksSummary).toMatch(/aria-label=["']Tree view["']/);
  });
});

// ─── VAL-DASH-004: Tree/list toggle switches views on click ─────────

describe("VAL-DASH-004: Tree/list toggle switches views on click", () => {
  it("list button sets viewMode to list", () => {
    expect(tasksSummary).toMatch(/onClick=\{?\(\)\s*=>\s*setViewMode\(["']list["']\)/);
  });

  it("tree button sets viewMode to tree", () => {
    expect(tasksSummary).toMatch(/onClick=\{?\(\)\s*=>\s*setViewMode\(["']tree["']\)/);
  });

  it("active toggle has visual distinction via bg-accent-orange", () => {
    // The active toggle should have a clear bg-accent-orange class
    expect(tasksSummary).toMatch(/bg-accent-orange\/10/);
  });

  it("toggle buttons have text labels next to icons", () => {
    // Buttons should include text labels "List" and "Tree"
    // Look for the labels near the toggle buttons
    expect(tasksSummary).toMatch(/>\s*List\s*</);
    expect(tasksSummary).toMatch(/>\s*Tree\s*</);
  });
});
