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

describe("Projects API", () => {
  let projectId: string;

  describe("POST /api/companies/:id/projects", () => {
    it("creates a project with name", async () => {
      const project = await data.createProject({
        name: "Website Redesign",
        description: "Complete overhaul of the marketing site",
        color: "#3b82f6",
      });
      projectId = project.id as string;
      expect(project.name).toBe("Website Redesign");
      expect(project.description).toBe("Complete overhaul of the marketing site");
      expect(project.color).toBe("#3b82f6");
      expect(project.company_id).toBe(TEST_COMPANY_ID);
    });
  });

  describe("GET /api/companies/:id/projects", () => {
    it("lists active projects", async () => {
      const res = await api.get<{ projects: Array<{ id: string }> }>(
        `/api/companies/${TEST_COMPANY_ID}/projects`,
      );
      expect(res.projects).toBeInstanceOf(Array);
      const found = res.projects.find((p) => p.id === projectId);
      expect(found).toBeDefined();
    });
  });

  describe("GET /api/projects/:id", () => {
    it("returns project details", async () => {
      const res = await api.get<{ project: Record<string, unknown> }>(`/api/projects/${projectId}`);
      expect(res.project.id).toBe(projectId);
      expect(res.project.name).toBe("Website Redesign");
    });
  });

  describe("PATCH /api/projects/:id", () => {
    it("updates project name and status", async () => {
      const res = await api.patch<{ project: Record<string, unknown> }>(
        `/api/projects/${projectId}`,
        { name: "Website Redesign v2", status: "in_progress" },
      );
      expect(res.project.name).toBe("Website Redesign v2");
      expect(res.project.status).toBe("in_progress");
    });
  });
});
