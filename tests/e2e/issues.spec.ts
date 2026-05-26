import { test, expect } from "./fixtures.js";

test.describe("Issues Page", () => {
  test("navigates to issues page and renders", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/issues`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/issues/);
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
  });

  test("shows issues list or empty state", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/issues`);
    await page.waitForLoadState("networkidle");
    const hasIssues = await page.getByText(/backlog|in.progress|done/i).count();
    const hasEmptyState = await page.getByText(/no issues|no tasks/i).count();
    expect(hasIssues + hasEmptyState).toBeGreaterThan(0);
  });
});
