import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestToken } from "../setup/auth.js";
import { ApiClient } from "../setup/api-client.js";
import { TestDataManager } from "../setup/test-data.js";
import { TEST_COMPANY_ID } from "../setup/constants.js";

let api: ApiClient;
let data: TestDataManager;

beforeAll(async () => {
  const token = await getTestToken();
  api = new ApiClient(token);
  data = new TestDataManager(api);
});

afterAll(async () => {
  await data.cleanup();
});

describe("Full Workflow: Agent → Issue → Checkout → Complete → Costs", () => {
  let agentId: string;
  let projectId: string;
  let goalId: string;
  let issueId: string;

  it("1. creates an agent", async () => {
    const agent = await data.createAgent({ name: "Workflow Agent", role: "engineer" });
    agentId = agent.id as string;
    expect(agent.id).toBeDefined();
  });

  it("2. verifies agent appears in list", async () => {
    const res = await api.get<{ agents: Array<{ id: string }> }>(
      `/api/companies/${TEST_COMPANY_ID}/agents`,
    );
    expect(res.agents.find((a) => a.id === agentId)).toBeDefined();
  });

  it("3. creates a project", async () => {
    const project = await data.createProject({ name: "Workflow Project" });
    projectId = project.id as string;
    expect(project.id).toBeDefined();
  });

  it("4. creates a goal", async () => {
    const goal = await data.createGoal({ title: "Workflow Goal" });
    goalId = goal.id as string;
    expect(goal.id).toBeDefined();
  });

  it("5. creates an issue linked to project and goal", async () => {
    const issue = await data.createIssue({
      title: "Workflow Task",
      project_id: projectId,
      goal_id: goalId,
      assignee_agent_id: agentId,
    });
    issueId = issue.id as string;
    expect(issue.project_id).toBe(projectId);
    expect(issue.goal_id).toBe(goalId);
    expect(issue.assignee_agent_id).toBe(agentId);
  });

  it("6. checks out the issue", async () => {
    const res = await api.post<{ success: boolean }>(`/api/issues/${issueId}/checkout`, {
      agent_id: agentId,
      run_id: "workflow-run-1",
    });
    expect(res.success).toBe(true);
  });

  it("7. verifies issue is checked out", async () => {
    const res = await api.get<{ issue: Record<string, unknown> }>(`/api/issues/${issueId}`);
    expect(res.issue.assignee_agent_id).toBe(agentId);
    expect(res.issue.checkout_run_id).toBe("workflow-run-1");
    expect(res.issue.status).toBe("in_progress");
  });

  it("8. adds a comment", async () => {
    const res = await api.post<{ comment: Record<string, unknown> }>(
      `/api/issues/${issueId}/comments`,
      { body: "Working on this now" },
    );
    expect(res.comment.body).toBe("Working on this now");
  });

  it("9. completes the issue", async () => {
    const res = await api.patch<{ issue: Record<string, unknown> }>(`/api/issues/${issueId}`, {
      status: "done",
    });
    expect(res.issue.status).toBe("done");
    expect(res.issue.completed_at).toBeDefined();
  });

  it("10. releases the issue", async () => {
    const res = await api.post<{ success: boolean }>(`/api/issues/${issueId}/release`);
    expect(res.success).toBe(true);
  });

  it("11. verifies cost endpoints respond", async () => {
    const summary = await api.get<Record<string, unknown>>(
      `/api/companies/${TEST_COMPANY_ID}/costs/summary`,
    );
    expect(typeof summary.budgetMonthlyCents).toBe("number");

    const byAgent = await api.get<{ agents: unknown[] }>(
      `/api/companies/${TEST_COMPANY_ID}/costs/by-agent`,
    );
    expect(byAgent.agents).toBeInstanceOf(Array);
  });

  it("12. terminates the agent", async () => {
    const res = await api.post<{ success: boolean }>(`/api/agents/${agentId}/terminate`);
    expect(res.success).toBe(true);

    const check = await api.get<{ agent: Record<string, unknown> }>(`/api/agents/${agentId}`);
    expect(check.agent.status).toBe("terminated");
  });
});
