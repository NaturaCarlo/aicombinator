import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestToken } from "../setup/auth.js";
import { ApiClient, ApiError } from "../setup/api-client.js";
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

describe("Agents API", () => {
  let agentId: string;

  describe("POST /api/companies/:id/agents", () => {
    it("creates an agent with name and role", async () => {
      const agent = await data.createAgent({ name: "Alpha Agent", role: "researcher" });
      agentId = agent.id as string;
      expect(agent).toHaveProperty("id");
      expect(agent.name).toBe("Alpha Agent");
      expect(agent.role).toBe("researcher");
      expect(agent.company_id).toBe(TEST_COMPANY_ID);
      expect(agent.status).toBeDefined();
    });

    it("returns 401 without auth token", async () => {
      const res = await api.unauthenticated("POST", `/api/companies/${TEST_COMPANY_ID}/agents`);
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent company", async () => {
      try {
        await api.post(`/api/companies/nonexistent-id/agents`, { name: "Test" });
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(404);
      }
    });
  });

  describe("GET /api/companies/:id/agents", () => {
    it("lists agents including the created one", async () => {
      const res = await api.get<{ agents: Array<{ id: string }> }>(
        `/api/companies/${TEST_COMPANY_ID}/agents`,
      );
      expect(res.agents).toBeInstanceOf(Array);
      const found = res.agents.find((a) => a.id === agentId);
      expect(found).toBeDefined();
    });
  });

  describe("GET /api/agents/:id", () => {
    it("returns agent details", async () => {
      const res = await api.get<{ agent: Record<string, unknown> }>(`/api/agents/${agentId}`);
      expect(res.agent.id).toBe(agentId);
      expect(res.agent.name).toBe("Alpha Agent");
    });

    it("returns 404 for non-existent agent", async () => {
      try {
        await api.get(`/api/agents/nonexistent-id`);
        expect.fail("Should have thrown");
      } catch (e) {
        expect((e as ApiError).status).toBe(404);
      }
    });
  });

  describe("PATCH /api/agents/:id", () => {
    it("updates agent name and title", async () => {
      const res = await api.patch<{ agent: Record<string, unknown> }>(`/api/agents/${agentId}`, {
        name: "Alpha Agent Updated",
        title: "Senior Researcher",
      });
      expect(res.agent.name).toBe("Alpha Agent Updated");
      expect(res.agent.title).toBe("Senior Researcher");
    });
  });

  describe("POST /api/agents/:id/pause", () => {
    it("pauses the agent", async () => {
      const res = await api.post<{ success: boolean }>(`/api/agents/${agentId}/pause`);
      expect(res.success).toBe(true);

      const check = await api.get<{ agent: Record<string, unknown> }>(`/api/agents/${agentId}`);
      expect(check.agent.status).toBe("paused");
    });
  });

  describe("POST /api/agents/:id/resume", () => {
    it("resumes the paused agent", async () => {
      const res = await api.post<{ success: boolean }>(`/api/agents/${agentId}/resume`);
      expect(res.success).toBe(true);

      const check = await api.get<{ agent: Record<string, unknown> }>(`/api/agents/${agentId}`);
      expect(check.agent.status).toBe("idle");
    });
  });

  describe("POST /api/agents/:id/wake", () => {
    it("creates a wakeup request", async () => {
      const res = await api.post<Record<string, unknown>>(`/api/agents/${agentId}/wake`, {
        message: "Test wakeup",
      });
      expect(res).toHaveProperty("wakeupId");
    });
  });

  describe("POST /api/agents/:id/keys", () => {
    it("creates an API key with ak_ prefix", async () => {
      const res = await api.post<{ id: string; key: string; name: string }>(
        `/api/agents/${agentId}/keys`,
        { name: "test-key" },
      );
      expect(res.key).toMatch(/^ak_/);
      expect(res.name).toBe("test-key");
      expect(res.id).toBeDefined();
    });
  });

  describe("POST /api/agents/:id/terminate", () => {
    it("terminates the agent", async () => {
      // Create a fresh agent to terminate (don't terminate our main test agent yet)
      const tempAgent = await data.createAgent({ name: "To Terminate" });
      const res = await api.post<{ success: boolean }>(`/api/agents/${tempAgent.id}/terminate`);
      expect(res.success).toBe(true);

      const check = await api.get<{ agent: Record<string, unknown> }>(`/api/agents/${tempAgent.id}`);
      expect(check.agent.status).toBe("terminated");
    });
  });
});
