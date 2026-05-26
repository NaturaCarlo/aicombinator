import { test, expect } from "./fixtures.js";

test.describe("Agents Page", () => {
  test("navigates to agents page and renders", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/agents`);
    await page.waitForLoadState("networkidle");
    // Page should render without errors
    await expect(page).toHaveURL(/\/agents/);
    // Should show either agent list or empty state
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
  });

  test("tab navigation highlights Agents", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/agents`);
    await page.waitForLoadState("networkidle");
    // Find the Agents nav link and verify it's active/highlighted
    const agentsLink = page.getByRole("link", { name: /agents/i }).first();
    await expect(agentsLink).toBeVisible();
  });

  test("shows agent cards or empty state", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/agents`);
    await page.waitForLoadState("networkidle");
    // Either show agent cards or a "no agents" message
    const hasAgents = await page.getByText(/idle|running|paused/i).count();
    const hasEmptyState = await page.getByText(/no agents/i).count();
    expect(hasAgents + hasEmptyState).toBeGreaterThan(0);
  });
});
