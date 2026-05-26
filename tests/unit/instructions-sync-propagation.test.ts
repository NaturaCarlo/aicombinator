import { describe, expect, it, vi, beforeEach } from "vitest";

import { handleUpdateAgent } from "../../worker/src/routes/agents.ts";
import { handleSupervisorListAgents } from "../../worker/src/routes/supervisor.ts";

// ─── Mock auth modules ──────────────────────────────────────

vi.mock("../../worker/src/middleware/auth.ts", () => ({
  extractToken: vi.fn(() => "valid-token"),
  verifyClerkJwt: vi.fn(async () => "user-1"),
}));

vi.mock("../../worker/src/middleware/cors.ts", () => ({
  corsHeaders: vi.fn(() => ({})),
}));

vi.mock("../../worker/src/utils/activity.ts", () => ({
  logActivity: vi.fn(async () => {}),
}));

const mockFetchFromCompanySupervisor = vi.fn();
vi.mock("../../worker/src/utils/supervisor-routing.ts", () => ({
  fetchFromCompanySupervisor: (...args: unknown[]) => mockFetchFromCompanySupervisor(...args),
}));

vi.mock("../../worker/src/utils/live-runtime.ts", () => ({
  fetchLiveSupervisorRuntime: vi.fn(async () => ({ companyState: "running" })),
  fetchLiveSupervisorAgents: vi.fn(async () => null),
  normalizeFounderVisibleAgentStatus: vi.fn((agent: Record<string, unknown>) => agent),
}));

vi.mock("../../worker/src/utils/internal-contract.ts", () => ({
  isCompatibleInternalContractVersion: vi.fn(() => true),
  INTERNAL_RUNTIME_CONTRACT_VERSION: "test",
}));

vi.mock("../../worker/src/enrichment/agent-identity.ts", () => ({
  resolveFounderCountryContext: vi.fn(async () => ({ country: "US", countryName: "United States" })),
  defaultFoundingTeamNamesForCountry: vi.fn(() => ({})),
  generateAgentAvatar: vi.fn(async () => null),
  storeAvatar: vi.fn(async () => "/api/avatars/test"),
  hasStoredAvatar: vi.fn(async () => false),
  avatarGenerationEnabled: vi.fn(() => false),
  generateSpecialistAgentName: vi.fn(async () => "Test Agent"),
  ensureAvatarPoolWarm: vi.fn(async () => ({ poolSize: 0 })),
}));

// ─── Mock helpers ────────────────────────────────────────────

function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    company_id: "comp-1",
    name: "Test Agent",
    role: "worker",
    title: "Test Worker",
    icon: null,
    status: "idle",
    reports_to: null,
    capabilities: "[]",
    adapter_config: "{}",
    runtime_config: "{}",
    adapter_type: "claude-code",
    webhook_url: null,
    source: "system",
    permissions: "{}",
    metadata: "{}",
    instructions: "",
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
    ...overrides,
  };
}

function makeMockEnv(overrides: {
  agentRow?: Record<string, unknown> | null;
  updatedAgentRow?: Record<string, unknown> | null;
  supervisorAgents?: Record<string, unknown>[];
} = {}) {
  const {
    agentRow = makeAgentRow(),
    updatedAgentRow,
    supervisorAgents,
  } = overrides;

  const runMock = vi.fn(async () => ({ success: true }));

  return {
    DB: {
      prepare: vi.fn((sql: string) => {
        // Agent access check
        if (sql.includes("SELECT a.* FROM agents a") && sql.includes("JOIN companies c")) {
          return {
            bind: vi.fn(() => ({
              first: vi.fn(async () => agentRow ? { ...agentRow } : null),
            })),
          };
        }
        // Post-update agent re-fetch or supervisor agent list
        if (sql.includes("SELECT * FROM agents WHERE id")) {
          const result = updatedAgentRow ?? agentRow;
          return {
            bind: vi.fn(() => ({
              first: vi.fn(async () => result ? { ...result } : null),
            })),
          };
        }
        // Supervisor list agents query (includes instructions)
        if (sql.includes("SELECT id, company_id, name, role") && sql.includes("FROM agents WHERE company_id")) {
          return {
            bind: vi.fn(() => ({
              all: vi.fn(async () => ({
                results: supervisorAgents ?? [agentRow],
              })),
            })),
          };
        }
        // UPDATE agents
        if (sql.includes("UPDATE agents")) {
          return {
            bind: vi.fn(() => ({ run: runMock })),
          };
        }
        // Default
        return {
          bind: vi.fn(() => ({
            run: vi.fn(async () => ({})),
            first: vi.fn(async () => null),
            all: vi.fn(async () => ({ results: [] })),
          })),
        };
      }),
    },
    FRONTEND_URL: "https://aicombinator.live",
    ENVIRONMENT: "test",
    SUPERVISOR_API_KEY: "test-key",
  } as unknown as Parameters<typeof handleUpdateAgent>[1];
}

function makeRequest(body: unknown): Request {
  return new Request("https://api.aicombinator.live/api/agents/agent-1", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-token",
    },
    body: JSON.stringify(body),
  });
}

function makeSupervisorRequest(companyId: string): Request {
  return new Request(
    `https://api.aicombinator.live/api/supervisor/companies/${companyId}/agents`,
    {
      method: "GET",
      headers: {
        "X-Supervisor-Key": "test-key",
        "X-AIC-Contract-Version": "test",
      },
    },
  );
}

// ─── Tests ───────────────────────────────────────────────────

describe("Instructions sync propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFromCompanySupervisor.mockReset();
  });

  describe("ISSUE 1: handleSupervisorListAgents includes instructions in payload", () => {
    it("SELECT query includes instructions column", async () => {
      const agentWithInstructions = makeAgentRow({
        instructions: "Always be polite and professional.",
      });
      const env = makeMockEnv({ supervisorAgents: [agentWithInstructions] });
      const req = makeSupervisorRequest("comp-1");

      const res = await handleSupervisorListAgents(req, env, "comp-1");
      expect(res.status).toBe(200);

      // Verify the SQL includes 'instructions'
      const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
      const selectCall = prepareCalls.find(
        (c: string[]) => c[0].includes("SELECT") && c[0].includes("FROM agents WHERE company_id"),
      );
      expect(selectCall).toBeDefined();
      expect(selectCall![0]).toContain("instructions");

      // Verify the response payload includes instructions
      const body = await res.json() as { agents: Array<{ instructions?: string }> };
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].instructions).toBe("Always be polite and professional.");
    });

    it("returns empty string instructions for agents without custom instructions", async () => {
      const agentNoInstructions = makeAgentRow({ instructions: "" });
      const env = makeMockEnv({ supervisorAgents: [agentNoInstructions] });
      const req = makeSupervisorRequest("comp-1");

      const res = await handleSupervisorListAgents(req, env, "comp-1");
      expect(res.status).toBe(200);

      const body = await res.json() as { agents: Array<{ instructions?: string }> };
      expect(body.agents[0].instructions).toBe("");
    });
  });

  describe("ISSUE 3: PATCH /api/agents/:id pushes instructions to supervisor", () => {
    it("pushes instructions update to supervisor via PATCH", async () => {
      const env = makeMockEnv({
        updatedAgentRow: makeAgentRow({ instructions: "Focus on testing tasks." }),
      });
      mockFetchFromCompanySupervisor.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const req = makeRequest({ instructions: "Focus on testing tasks." });
      const res = await handleUpdateAgent(req, env, "agent-1");
      expect(res.status).toBe(200);

      // Verify supervisor was called with PATCH containing instructions
      expect(mockFetchFromCompanySupervisor).toHaveBeenCalled();
      const supervisorCall = mockFetchFromCompanySupervisor.mock.calls[0];
      expect(supervisorCall[2]).toContain("/agents/agent-1");
      const supervisorInit = supervisorCall[3] as { method: string; body: string };
      expect(supervisorInit.method).toBe("PATCH");
      const supervisorBody = JSON.parse(supervisorInit.body);
      expect(supervisorBody.instructions).toBe("Focus on testing tasks.");
    });

    it("pushes all editable fields to supervisor together", async () => {
      const env = makeMockEnv({
        updatedAgentRow: makeAgentRow({
          name: "Updated Agent",
          instructions: "Be concise.",
          model_tier: "opus",
        }),
      });
      mockFetchFromCompanySupervisor.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const req = makeRequest({
        name: "Updated Agent",
        instructions: "Be concise.",
        model_tier: "opus",
      });
      const res = await handleUpdateAgent(req, env, "agent-1");
      expect(res.status).toBe(200);

      expect(mockFetchFromCompanySupervisor).toHaveBeenCalled();
      const supervisorInit = mockFetchFromCompanySupervisor.mock.calls[0][3] as { body: string };
      const supervisorBody = JSON.parse(supervisorInit.body);
      expect(supervisorBody.name).toBe("Updated Agent");
      expect(supervisorBody.instructions).toBe("Be concise.");
      expect(supervisorBody.model_tier).toBe("opus");
    });

    it("succeeds even when supervisor is unreachable (non-fatal)", async () => {
      const env = makeMockEnv({
        updatedAgentRow: makeAgentRow({ instructions: "Test instructions" }),
      });
      mockFetchFromCompanySupervisor.mockRejectedValue(
        new Error("Connection refused"),
      );

      const req = makeRequest({ instructions: "Test instructions" });
      const res = await handleUpdateAgent(req, env, "agent-1");

      // Should still succeed — D1 was updated, supervisor notification is non-fatal
      expect(res.status).toBe(200);
      const body = await res.json() as { agent: { instructions: string } };
      expect(body.agent.instructions).toBe("Test instructions");
    });

    it("succeeds when supervisor returns null (not configured)", async () => {
      const env = makeMockEnv({
        updatedAgentRow: makeAgentRow({ instructions: "New instructions" }),
      });
      mockFetchFromCompanySupervisor.mockResolvedValue(null);

      const req = makeRequest({ instructions: "New instructions" });
      const res = await handleUpdateAgent(req, env, "agent-1");

      // Should still succeed — D1 update is primary
      expect(res.status).toBe(200);
    });

    it("does not push to supervisor when no supervisor-relevant fields change", async () => {
      const env = makeMockEnv({
        updatedAgentRow: makeAgentRow({ icon: "/new-icon.png" }),
      });

      const req = makeRequest({ icon: "/new-icon.png" });
      const res = await handleUpdateAgent(req, env, "agent-1");
      expect(res.status).toBe(200);

      // icon is NOT in the supervisorPatch fields, so no supervisor call
      expect(mockFetchFromCompanySupervisor).not.toHaveBeenCalled();
    });
  });

  describe("ISSUE 2: Supervisor bootstrap upsert stores instructions", () => {
    it("sync.ts agent upsert SQL includes instructions column", () => {
      // This is a static code verification test.
      // We verify the SQL structure by importing and checking the sync.ts code.
      // The actual test is that the INSERT INTO agents includes 'instructions'
      // and the ON CONFLICT clause includes 'instructions = excluded.instructions'.

      // Read the sync.ts code and verify the SQL structure
      const syncSource = require("fs").readFileSync(
        require("path").join(__dirname, "../../supervisor/src/sync.ts"),
        "utf-8",
      ) as string;

      // Verify INSERT column list includes instructions
      const insertMatch = syncSource.match(
        /INSERT INTO agents \(\s*([^)]+)\)/,
      );
      expect(insertMatch).toBeTruthy();
      expect(insertMatch![1]).toContain("instructions");

      // Verify ON CONFLICT UPDATE SET includes instructions
      const onConflictMatch = syncSource.match(
        /ON CONFLICT\(id\) DO UPDATE SET\s*([\s\S]*?)(?:\)\s*VALUES|\]\s*\))/,
      );
      // Alternative: just check the whole source for the pattern
      expect(syncSource).toContain("instructions = excluded.instructions");
    });
  });

  describe("Full round-trip: instructions from dashboard to supervisor", () => {
    it("instructions round-trips through the sync path", async () => {
      // Step 1: Dashboard PATCH → Worker D1 update
      const env = makeMockEnv({
        updatedAgentRow: makeAgentRow({ instructions: "Round-trip test instructions" }),
      });
      mockFetchFromCompanySupervisor.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const patchReq = makeRequest({ instructions: "Round-trip test instructions" });
      const patchRes = await handleUpdateAgent(patchReq, env, "agent-1");
      expect(patchRes.status).toBe(200);

      // Verify D1 was updated with instructions
      const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain("instructions = ?");

      // Verify supervisor was notified with instructions
      expect(mockFetchFromCompanySupervisor).toHaveBeenCalled();
      const supervisorInit = mockFetchFromCompanySupervisor.mock.calls[0][3] as { body: string };
      const supervisorBody = JSON.parse(supervisorInit.body);
      expect(supervisorBody.instructions).toBe("Round-trip test instructions");

      // Step 2: Supervisor bootstrap → Worker GET agents (includes instructions)
      const listEnv = makeMockEnv({
        supervisorAgents: [
          makeAgentRow({ instructions: "Round-trip test instructions" }),
        ],
      });
      const listReq = makeSupervisorRequest("comp-1");
      const listRes = await handleSupervisorListAgents(listReq, listEnv, "comp-1");
      expect(listRes.status).toBe(200);

      const listBody = await listRes.json() as { agents: Array<{ instructions: string }> };
      expect(listBody.agents[0].instructions).toBe("Round-trip test instructions");
    });
  });
});
