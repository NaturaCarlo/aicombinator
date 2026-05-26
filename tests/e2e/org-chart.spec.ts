import { test, expect } from "./fixtures.js";

test.describe("Org Chart Page", () => {
  test("navigates to org chart page and renders", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/org-chart`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/org-chart/);
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
  });

  test("shows org chart or empty state", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/org-chart`);
    await page.waitForLoadState("networkidle");
    const hasChart = await page.getByText(/agent|hierarchy|reports/i).count();
    const hasEmptyState = await page.getByText(/no agents/i).count();
    expect(hasChart + hasEmptyState).toBeGreaterThan(0);
  });
});
