import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestToken } from "../setup/auth.js";
import { ApiClient, ApiError } from "../setup/api-client.js";
import { TestDataManager } from "../setup/test-data.js";
import { TEST_COMPANY_ID } from "../setup/constants.js";

let api: ApiClient;
let data: TestDataManager;
let testAgentId: string;

beforeAll(async () => {
  const token = await getTestToken();
  api = new ApiClient(token);
  data = new TestDataManager(api);
  // Create an agent for assignment/checkout tests
  const agent = await data.createAgent({ name: "Issue Test Agent" });
  testAgentId = agent.id as string;
});

afterAll(async () => {
  await data.cleanup();
});

describe("Issues API", () => {
  let issueId: string;
  let issueIdentifier: string;

  describe("POST /api/companies/:id/issues", () => {
    it("creates an issue with auto-increment identifier", async () => {
      const issue = await data.createIssue({ title: "Fix login bug", priority: "high" });
      issueId = issue.id as string;
      issueIdentifier = issue.identifier as string;
      expect(issue).toHaveProperty("id");
      expect(issue.title).toBe("Fix login bug");
      expect(issue.priority).toBe("high");
      expect(issue.identifier).toBeDefined();
      expect(issue.status).toBe("backlog");
    });

    it("creates an issue with assignee", async () => {
      const issue = await data.createIssue({
        title: "Assigned issue",
        assignee_agent_id: testAgentId,
      });
      expect(issue.assignee_agent_id).toBe(testAgentId);
    });

    it("returns 401 without auth", async () => {
      const res = await api.unauthenticated("POST", `/api/companies/${TEST_COMPANY_ID}/issues`);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/companies/:id/issues", () => {
    it("lists issues", async () => {
      const res = await api.get<{ issues: Array<{ id: string }> }>(
        `/api/companies/${TEST_COMPANY_ID}/issues`,
      );
      expect(res.issues).toBeInstanceOf(Array);
      expect(res.issues.length).toBeGreaterThan(0);
    });

    it("filters by status", async () => {
      const res = await api.get<{ issues: Array<{ status: string }> }>(
        `/api/companies/${TEST_COMPANY_ID}/issues?status=backlog`,
      );
      for (const issue of res.issues) {
        expect(issue.status).toBe("backlog");
      }
    });
  });

  describe("GET /api/issues/:id", () => {
    it("returns issue with commentCount", async () => {
      const res = await api.get<{ issue: Record<string, unknown>; commentCount: number }>(
        `/api/issues/${issueId}`,
      );
      expect(res.issue.id).toBe(issueId);
      expect(typeof res.commentCount).toBe("number");
    });
  });

  describe("PATCH /api/issues/:id", () => {
    it("updates status to in_progress and sets started_at", async () => {
      const res = await api.patch<{ issue: Record<string, unknown> }>(`/api/issues/${issueId}`, {
        status: "in_progress",
      });
      expect(res.issue.status).toBe("in_progress");
      expect(res.issue.started_at).toBeDefined();
    });

    it("updates status to done and sets completed_at", async () => {
      const res = await api.patch<{ issue: Record<string, unknown> }>(`/api/issues/${issueId}`, {
        status: "done",
      });
      expect(res.issue.status).toBe("done");
      expect(res.issue.completed_at).toBeDefined();
    });
  });

  describe("POST /api/issues/:id/checkout", () => {
    let checkoutIssueId: string;

    it("checks out an issue to an agent", async () => {
      const issue = await data.createIssue({ title: "Checkout test issue" });
      checkoutIssueId = issue.id as string;

      const res = await api.post<{ success: boolean }>(`/api/issues/${checkoutIssueId}/checkout`, {
        agent_id: testAgentId,
        run_id: "test-run-1",
      });
      expect(res.success).toBe(true);
    });

    it("returns 409 on double checkout", async () => {
      try {
        await api.post(`/api/issues/${checkoutIssueId}/checkout`, {
          agent_id: testAgentId,
          run_id: "test-run-2",
        });
        expect.fail("Should have thrown 409");
      } catch (e) {
        expect((e as ApiError).status).toBe(409);
      }
    });

    it("releases a checked-out issue", async () => {
      const res = await api.post<{ success: boolean }>(`/api/issues/${checkoutIssueId}/release`);
      expect(res.success).toBe(true);
    });
  });

  describe("Issue Comments", () => {
    it("creates a comment", async () => {
      const res = await api.post<{ comment: Record<string, unknown> }>(
        `/api/issues/${issueId}/comments`,
        { body: "This is a test comment" },
      );
      expect(res.comment.body).toBe("This is a test comment");
      expect(res.comment.id).toBeDefined();
    });

    it("lists comments", async () => {
      const res = await api.get<{ comments: Array<Record<string, unknown>> }>(
        `/api/issues/${issueId}/comments`,
      );
      expect(res.comments).toBeInstanceOf(Array);
      expect(res.comments.length).toBeGreaterThan(0);
    });

    it("returns 400 for empty comment body", async () => {
      try {
        await api.post(`/api/issues/${issueId}/comments`, { body: "" });
        expect.fail("Should have thrown");
      } catch (e) {
        expect((e as ApiError).status).toBe(400);
      }
    });
  });
});
