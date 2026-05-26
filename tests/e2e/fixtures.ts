import { test as base, type Page, expect } from "@playwright/test";

const APP_BASE_URL = process.env.APP_BASE_URL || "https://aicombinator.live";
const TEST_COMPANY_ID = process.env.TEST_COMPANY_ID || "";

export const test = base.extend<{
  companyUrl: string;
}>({
  companyUrl: async ({}, use) => {
    await use(`${APP_BASE_URL}/company/${TEST_COMPANY_ID}`);
  },
});

export { expect };

// ─── Page Object Models ────────────────────────────────────

export class AgentsPage {
  constructor(private page: Page, private baseUrl: string) {}

  async goto() {
    await this.page.goto(`${this.baseUrl}/agents`);
    await this.page.waitForLoadState("networkidle");
  }

  async getAgentCards() {
    return this.page.locator("[data-testid='agent-card'], .agent-card, [class*='card']").all();
  }

  async hasContent(text: string) {
    return this.page.getByText(text).isVisible();
  }
}

export class IssuesPage {
  constructor(private page: Page, private baseUrl: string) {}

  async goto() {
    await this.page.goto(`${this.baseUrl}/issues`);
    await this.page.waitForLoadState("networkidle");
  }

  async hasContent(text: string) {
    return this.page.getByText(text).isVisible();
  }
}

export class ApprovalsPage {
  constructor(private page: Page, private baseUrl: string) {}

  async goto() {
    await this.page.goto(`${this.baseUrl}/approvals`);
    await this.page.waitForLoadState("networkidle");
  }

  async hasContent(text: string) {
    return this.page.getByText(text).isVisible();
  }
}

export class GoalsPage {
  constructor(private page: Page, private baseUrl: string) {}

  async goto() {
    await this.page.goto(`${this.baseUrl}/goals`);
    await this.page.waitForLoadState("networkidle");
  }

  async hasContent(text: string) {
    return this.page.getByText(text).isVisible();
  }
}

export class ProjectsPage {
  constructor(private page: Page, private baseUrl: string) {}

  async goto() {
    await this.page.goto(`${this.baseUrl}/projects`);
    await this.page.waitForLoadState("networkidle");
  }

  async hasContent(text: string) {
    return this.page.getByText(text).isVisible();
  }
}

export class CostsPage {
  constructor(private page: Page, private baseUrl: string) {}

  async goto() {
    await this.page.goto(`${this.baseUrl}/costs`);
    await this.page.waitForLoadState("networkidle");
  }

  async hasContent(text: string) {
    return this.page.getByText(text).isVisible();
  }
}

export class OrgChartPage {
  constructor(private page: Page, private baseUrl: string) {}

  async goto() {
    await this.page.goto(`${this.baseUrl}/org-chart`);
    await this.page.waitForLoadState("networkidle");
  }

  async hasContent(text: string) {
    return this.page.getByText(text).isVisible();
  }
}
