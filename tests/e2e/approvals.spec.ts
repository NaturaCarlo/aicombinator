import { test, expect } from "./fixtures.js";

test.describe("Approvals Page", () => {
  test("navigates to approvals page and renders", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/approvals`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/approvals/);
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
  });

  test("shows pending and resolved sections or empty state", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/approvals`);
    await page.waitForLoadState("networkidle");
    const hasApprovals = await page.getByText(/pending|approved|rejected/i).count();
    const hasEmptyState = await page.getByText(/no approvals|no pending/i).count();
    expect(hasApprovals + hasEmptyState).toBeGreaterThan(0);
  });
});
