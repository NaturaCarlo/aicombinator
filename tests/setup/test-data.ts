import { ApiClient } from "./api-client.js";
import { TEST_COMPANY_ID } from "./constants.js";

interface CreatedEntity {
  type: "agent" | "issue" | "goal" | "project" | "approval";
  id: string;
}

export class TestDataManager {
  private created: CreatedEntity[] = [];

  constructor(
    private api: ApiClient,
    private companyId: string = TEST_COMPANY_ID,
  ) {}

  async createAgent(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = {
      name: `Test Agent ${Date.now()}`,
      role: "test",
      ...overrides,
    };
    const data = await this.api.post<{ agent: Record<string, unknown> }>(
      `/api/companies/${this.companyId}/agents`,
      payload,
    );
    this.created.push({ type: "agent", id: data.agent.id as string });
    return data.agent;
  }

  async createIssue(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = {
      title: `Test Issue ${Date.now()}`,
      ...overrides,
    };
    const data = await this.api.post<{ issue: Record<string, unknown> }>(
      `/api/companies/${this.companyId}/issues`,
      payload,
    );
    this.created.push({ type: "issue", id: data.issue.id as string });
    return data.issue;
  }

  async createGoal(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = {
      title: `Test Goal ${Date.now()}`,
      ...overrides,
    };
    const data = await this.api.post<{ goal: Record<string, unknown> }>(
      `/api/companies/${this.companyId}/goals`,
      payload,
    );
    this.created.push({ type: "goal", id: data.goal.id as string });
    return data.goal;
  }

  async createProject(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = {
      name: `Test Project ${Date.now()}`,
      ...overrides,
    };
    const data = await this.api.post<{ project: Record<string, unknown> }>(
      `/api/companies/${this.companyId}/projects`,
      payload,
    );
    this.created.push({ type: "project", id: data.project.id as string });
    return data.project;
  }

  async createApproval(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = {
      type: "strategy",
      payload: { description: `Test approval ${Date.now()}` },
      ...overrides,
    };
    const data = await this.api.post<{ approval: Record<string, unknown> }>(
      `/api/companies/${this.companyId}/approvals`,
      payload,
    );
    this.created.push({ type: "approval", id: data.approval.id as string });
    return data.approval;
  }

  async cleanup(): Promise<void> {
    // Reverse order: terminate agents last
    const reversed = [...this.created].reverse();
    for (const entity of reversed) {
      try {
        if (entity.type === "agent") {
          await this.api.post(`/api/agents/${entity.id}/terminate`);
        }
        // Issues, goals, projects, approvals: no delete endpoint,
        // but terminated agents and completed issues are inert
      } catch {
        // Best-effort cleanup - don't fail tests on cleanup errors
      }
    }
    this.created = [];
  }
}
