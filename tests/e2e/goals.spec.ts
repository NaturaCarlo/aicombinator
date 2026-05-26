import { test, expect } from "./fixtures.js";

test.describe("Goals Page", () => {
  test("navigates to goals page and renders", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/goals`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/goals/);
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
  });

  test("shows goals or empty state", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/goals`);
    await page.waitForLoadState("networkidle");
    const hasGoals = await page.getByText(/planned|in.progress|achieved/i).count();
    const hasEmptyState = await page.getByText(/no goals/i).count();
    expect(hasGoals + hasEmptyState).toBeGreaterThan(0);
  });
});
