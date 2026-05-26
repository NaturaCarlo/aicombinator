import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentRow, CompanyRow } from "../../supervisor/src/types.ts";

// ---------------------------------------------------------------------------
// Mock build_system_prompt from agent-runner so the API route can call it
// for CEO agents without needing a real DB or company row.
// ---------------------------------------------------------------------------
const buildSystemPromptMock = vi.fn<(agent: AgentRow, company: CompanyRow) => string>();

vi.mock("../../supervisor/src/agent-runner.ts", () => ({
  build_system_prompt: (...args: unknown[]) => buildSystemPromptMock(...(args as [AgentRow, CompanyRow])),
}));

// Mock blueprints module
const getBlueprintMock = vi.fn();
vi.mock("../../supervisor/src/blueprints.ts", () => ({
  getBlueprint: (...args: unknown[]) => getBlueprintMock(...args),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo"],
}));

// Mock other dependencies needed by createApi
vi.mock("../../supervisor/src/internal-contract.ts", () => ({
  INTERNAL_RUNTIME_CONTRACT_VERSION: "1.0.0",
  isCompatibleInternalContractVersion: () => true,
  parseProvisionCompanyPayload: vi.fn(),
  parseUserMessagePayload: vi.fn(),
}));

vi.mock("../../supervisor/src/llm-proxy.ts", () => ({
  createLlmProxy: vi.fn(),
}));

vi.mock("../../supervisor/src/importers/companies-sh.ts", () => ({
  parseCompaniesShPackage: vi.fn(),
  importToDb: vi.fn(),
}));

// Minimal in-memory DB mock
function createMockDb() {
  const store: Record<string, unknown[]> = {};
  return {
    get: vi.fn(),
    all: vi.fn(() => []),
    run: vi.fn(),
    exec: vi.fn(),
    _store: store,
  };
}

// Minimal scheduler mock
function createMockScheduler() {
  return {
    enqueue: vi.fn(),
    getCompanyIds: vi.fn(() => []),
  };
}

// Helper to build a minimal agent row
function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-1",
    company_id: "company-1",
    blueprint_id: "cto",
    name: "CTO",
    role: "cto",
    model_tier: "sonnet",
    status: "idle",
    session_id: null,
    current_task_id: null,
    total_credits: 100,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCompany(overrides: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: "company-1",
    user_id: "user-1",
    name: "Test Corp",
    goal: "Build something great",
    state: "running",
    container_id: null,
    workspace_dir: "/workspace",
    mode: "autonomous",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// Import createApi after mocks
import { createApi } from "../../supervisor/src/api.ts";

describe("GET /companies/:id/agents/:agentId/blueprint-prompt", () => {
  let app: ReturnType<typeof createApi>;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    app = createApi({
      config: {
        internalApiKey: "test-key",
        port: 8787,
        workerBaseUrl: "http://localhost",
        hostUrl: "http://localhost:8787",
      } as any,
      db: mockDb as any,
      scheduler: createMockScheduler() as any,
    });
  });

  it("returns dynamic system prompt for CEO agent (not the blueprint placeholder)", async () => {
    const ceoAgent = makeAgent({
      id: "ceo-1",
      blueprint_id: "ceo",
      role: "ceo",
      name: "CEO",
    });
    const company = makeCompany({ id: "company-1", name: "Test Corp" });

    // db.get for agent lookup
    mockDb.get.mockImplementation((sql: string) => {
      if (sql.includes("agents")) return ceoAgent;
      if (sql.includes("companies")) return company;
      return null;
    });

    const dynamicPrompt = "You are the CEO of Test Corp.\nCompany goal: Build something great\n...";
    buildSystemPromptMock.mockReturnValue(dynamicPrompt);

    const res = await app.request("/companies/company-1/agents/ceo-1/blueprint-prompt", {
      headers: { "x-internal-api-key": "test-key", "x-aic-contract-version": "1.0.0" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { prompt: string };

    // Must return the dynamic prompt, not the placeholder
    expect(body.prompt).toBe(dynamicPrompt);
    expect(body.prompt).not.toContain("constructed at runtime");

    // build_system_prompt must have been called with agent and company
    expect(buildSystemPromptMock).toHaveBeenCalledWith(ceoAgent, company);
  });

  it("does NOT call build_system_prompt for non-CEO agents", async () => {
    const ctoAgent = makeAgent({
      id: "cto-1",
      blueprint_id: "cto",
      role: "cto",
      name: "CTO",
    });

    mockDb.get.mockImplementation((sql: string) => {
      if (sql.includes("agents")) return ctoAgent;
      return null;
    });

    // Mock blueprint for CTO
    getBlueprintMock.mockReturnValue({
      systemPrompt: "You are the CTO.",
      workflows: [],
    });

    const res = await app.request("/companies/company-1/agents/cto-1/blueprint-prompt", {
      headers: { "x-internal-api-key": "test-key", "x-aic-contract-version": "1.0.0" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { prompt: string };

    // build_system_prompt must NOT be called
    expect(buildSystemPromptMock).not.toHaveBeenCalled();

    // Should still contain the normal blueprint prompt
    expect(body.prompt).toContain("You are the CTO.");
  });

  it("handles CEO agent identified by role (not blueprint_id)", async () => {
    const ceoAgent = makeAgent({
      id: "ceo-2",
      blueprint_id: null,
      role: "ceo",
      name: "CEO",
    });
    const company = makeCompany({ id: "company-1" });

    mockDb.get.mockImplementation((sql: string) => {
      if (sql.includes("agents")) return ceoAgent;
      if (sql.includes("companies")) return company;
      return null;
    });

    const dynamicPrompt = "Dynamic CEO prompt content";
    buildSystemPromptMock.mockReturnValue(dynamicPrompt);

    const res = await app.request("/companies/company-1/agents/ceo-2/blueprint-prompt", {
      headers: { "x-internal-api-key": "test-key", "x-aic-contract-version": "1.0.0" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { prompt: string };

    expect(body.prompt).toBe(dynamicPrompt);
    expect(buildSystemPromptMock).toHaveBeenCalledWith(ceoAgent, company);
  });

  it("returns 404 when agent not found", async () => {
    mockDb.get.mockReturnValue(null);

    const res = await app.request("/companies/company-1/agents/nonexistent/blueprint-prompt", {
      headers: { "x-internal-api-key": "test-key", "x-aic-contract-version": "1.0.0" },
    });
    expect(res.status).toBe(404);
  });
});
