import { test, expect } from "./fixtures.js";

test.describe("Costs Page", () => {
  test("navigates to costs page and renders", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/costs`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/costs/);
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
  });

  test("shows cost summary cards", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/costs`);
    await page.waitForLoadState("networkidle");
    // Should show budget/spent/events cards or relevant cost info
    const hasCostInfo = await page.getByText(/budget|spent|cost|events/i).count();
    expect(hasCostInfo).toBeGreaterThan(0);
  });
});
