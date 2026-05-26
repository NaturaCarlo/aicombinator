import { test, expect } from "./fixtures.js";

test.describe("Projects Page", () => {
  test("navigates to projects page and renders", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/projects`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/projects/);
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
  });

  test("shows projects or empty state", async ({ page, companyUrl }) => {
    await page.goto(`${companyUrl}/projects`);
    await page.waitForLoadState("networkidle");
    const hasProjects = await page.getByText(/planned|in.progress|completed/i).count();
    const hasEmptyState = await page.getByText(/no projects/i).count();
    expect(hasProjects + hasEmptyState).toBeGreaterThan(0);
  });
});
