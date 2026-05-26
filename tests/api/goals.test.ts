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

describe("Goals API", () => {
  let goalId: string;

  describe("POST /api/companies/:id/goals", () => {
    it("creates a goal with title", async () => {
      const goal = await data.createGoal({ title: "Increase revenue 10x" });
      goalId = goal.id as string;
      expect(goal.title).toBe("Increase revenue 10x");
      expect(goal.company_id).toBe(TEST_COMPANY_ID);
      expect(goal.status).toBe("planned");
    });

    it("creates a child goal with parent_id", async () => {
      const child = await data.createGoal({
        title: "Expand to new markets",
        parent_id: goalId,
        level: "team",
      });
      expect(child.parent_id).toBe(goalId);
      expect(child.level).toBe("team");
    });
  });

  describe("GET /api/companies/:id/goals", () => {
    it("lists all goals", async () => {
      const res = await api.get<{ goals: Array<{ id: string }> }>(
        `/api/companies/${TEST_COMPANY_ID}/goals`,
      );
      expect(res.goals).toBeInstanceOf(Array);
      expect(res.goals.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("GET /api/goals/:id", () => {
    it("returns a single goal", async () => {
      const res = await api.get<{ goal: Record<string, unknown> }>(`/api/goals/${goalId}`);
      expect(res.goal.id).toBe(goalId);
    });
  });

  describe("PATCH /api/goals/:id", () => {
    it("updates goal status", async () => {
      const res = await api.patch<{ goal: Record<string, unknown> }>(`/api/goals/${goalId}`, {
        status: "in_progress",
      });
      expect(res.goal.status).toBe("in_progress");
    });

    it("updates goal description", async () => {
      const res = await api.patch<{ goal: Record<string, unknown> }>(`/api/goals/${goalId}`, {
        description: "Revenue target for Q2",
      });
      expect(res.goal.description).toBe("Revenue target for Q2");
    });
  });
});
