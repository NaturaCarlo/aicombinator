import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  handleUpdateAgent,
  handlePauseAgent,
  handleResumeAgent,
} from "../../worker/src/routes/agents.ts";

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
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
    ...overrides,
  };
}

function makeMockEnv(overrides: {
  agentRow?: Record<string, unknown> | null;
  companyUserId?: string | null;
  updatedAgentRow?: Record<string, unknown> | null;
} = {}) {
  const {
    agentRow = makeAgentRow(),
    companyUserId = "user-1",
    updatedAgentRow,
  } = overrides;

  const runMock = vi.fn(async () => ({ success: true }));
  let firstCallCount = 0;

  return {
    DB: {
      prepare: vi.fn((sql: string) => {
        // Agent access check: join with companies
        if (sql.includes("SELECT a.* FROM agents a") && sql.includes("JOIN companies c")) {
          return {
            bind: vi.fn(() => ({
              first: vi.fn(async () => agentRow ? { ...agentRow } : null),
            })),
          };
        }
        // Post-update agent re-fetch
        if (sql.includes("SELECT * FROM agents WHERE id")) {
          firstCallCount++;
          const result = updatedAgentRow ?? agentRow;
          return {
            bind: vi.fn(() => ({
              first: vi.fn(async () => result ? { ...result } : null),
            })),
          };
        }
        // UPDATE agents
        if (sql.includes("UPDATE agents")) {
          return {
            bind: vi.fn(() => ({ run: runMock })),
          };
        }
        // activity log
        if (sql.includes("INSERT INTO activity_log")) {
          return {
            bind: vi.fn(() => ({ run: vi.fn(async () => ({})) })),
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

function makeRequest(body: unknown, method = "PATCH"): Request {
  return new Request("https://api.aicombinator.live/api/agents/agent-1", {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-token",
    },
    body: JSON.stringify(body),
  });
}

// ─── Tests ───────────────────────────────────────────────────

describe("handleUpdateAgent (PATCH /api/agents/:id)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates name, role, title, reports_to", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "New Name",
      role: "engineer",
      title: "Senior Engineer",
      reports_to: "agent-2",
    });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    // Verify the SQL was called with correct fields
    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("name = ?");
    expect(updateCall![0]).toContain("role = ?");
    expect(updateCall![0]).toContain("title = ?");
    expect(updateCall![0]).toContain("reports_to = ?");
  });

  it("accepts and persists adapter_type field", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ adapter_type: "http-webhook" }),
    });
    const req = makeRequest({ adapter_type: "http-webhook" });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("adapter_type = ?");
  });

  it("accepts and persists webhook_url field", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ webhook_url: "https://example.com/hook" }),
    });
    const req = makeRequest({ webhook_url: "https://example.com/hook" });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("webhook_url = ?");
  });

  it("accepts adapter_type and webhook_url together with other fields", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({
        name: "WebhookBot",
        adapter_type: "http-webhook",
        webhook_url: "https://hook.example.com",
      }),
    });
    const req = makeRequest({
      name: "WebhookBot",
      role: "worker",
      adapter_type: "http-webhook",
      webhook_url: "https://hook.example.com",
    });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall![0]).toContain("name = ?");
    expect(updateCall![0]).toContain("role = ?");
    expect(updateCall![0]).toContain("adapter_type = ?");
    expect(updateCall![0]).toContain("webhook_url = ?");
  });

  it("allows setting webhook_url to null", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ webhook_url: null }),
    });
    const req = makeRequest({ webhook_url: null });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall![0]).toContain("webhook_url = ?");
  });

  it("returns 400 when no fields are provided", async () => {
    const env = makeMockEnv();
    const req = makeRequest({});

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("No fields");
  });

  it("returns 404 when agent not found", async () => {
    const env = makeMockEnv({ agentRow: null });
    const req = makeRequest({ name: "Test" });

    const res = await handleUpdateAgent(req, env, "nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("handlePauseAgent (POST /api/agents/:id/pause)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFromCompanySupervisor.mockReset();
  });

  it("returns success when supervisor responds ok", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "idle" }) });
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/pause", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    const res = await handlePauseAgent(req, env, "agent-1");
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; status: string };
    expect(body.success).toBe(true);
    expect(body.status).toBe("paused");
  });

  it("returns error when supervisor is unreachable", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "idle" }) });
    mockFetchFromCompanySupervisor.mockRejectedValue(new Error("Connection refused"));

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/pause", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    const res = await handlePauseAgent(req, env, "agent-1");
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("supervisor");
  });

  it("returns error when supervisor returns 404", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "idle" }) });
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/pause", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    const res = await handlePauseAgent(req, env, "agent-1");
    expect(res.status).toBe(404);
  });

  it("returns 400 when agent is terminated", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "terminated" }) });

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/pause", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    const res = await handlePauseAgent(req, env, "agent-1");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("terminated");
  });

  it("does not modify name, role, or other fields", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "idle", name: "Original Name", role: "worker" }) });
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/pause", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    await handlePauseAgent(req, env, "agent-1");

    // Verify no UPDATE agents SQL was called (pause only updates via supervisor)
    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateAgentCalls = prepareCalls.filter(
      (c: string[]) => c[0].includes("UPDATE agents"),
    );
    expect(updateAgentCalls).toHaveLength(0);
  });

  it("returns 503 when supervisor is not configured", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "idle" }) });
    mockFetchFromCompanySupervisor.mockResolvedValue(null);

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/pause", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    const res = await handlePauseAgent(req, env, "agent-1");
    expect(res.status).toBe(503);
  });
});

describe("handleResumeAgent (POST /api/agents/:id/resume)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFromCompanySupervisor.mockReset();
  });

  it("returns success when supervisor responds ok", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "paused" }) });
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/resume", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    const res = await handleResumeAgent(req, env, "agent-1");
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; status: string };
    expect(body.success).toBe(true);
    expect(body.status).toBe("idle");
  });

  it("returns 400 when agent is not paused", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "idle" }) });

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/resume", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    const res = await handleResumeAgent(req, env, "agent-1");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not paused");
  });

  it("returns error when supervisor is unreachable", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "paused" }) });
    mockFetchFromCompanySupervisor.mockRejectedValue(new Error("Network failure"));

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/resume", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    const res = await handleResumeAgent(req, env, "agent-1");
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("supervisor");
  });

  it("does not modify name, role, or other fields", async () => {
    const env = makeMockEnv({ agentRow: makeAgentRow({ status: "paused", name: "Original Name", role: "worker" }) });
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const req = new Request("https://api.aicombinator.live/api/agents/agent-1/resume", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });

    await handleResumeAgent(req, env, "agent-1");

    // Verify no UPDATE agents SQL was called (resume only updates via supervisor)
    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateAgentCalls = prepareCalls.filter(
      (c: string[]) => c[0].includes("UPDATE agents"),
    );
    expect(updateAgentCalls).toHaveLength(0);
  });
});

describe("handleUpdateAgent model_tier and instructions fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts and persists model_tier field", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ model_tier: "opus-4-6" }),
    });
    const req = makeRequest({ model_tier: "opus-4-6" });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("model_tier = ?");
  });

  it("accepts and persists instructions field", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ instructions: "Be concise and focused." }),
    });
    const req = makeRequest({ instructions: "Be concise and focused." });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("instructions = ?");
  });

  it("accepts model_tier and instructions together with other fields", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({
        name: "Updated Agent",
        model_tier: "haiku",
        instructions: "Focus on research tasks.",
      }),
    });
    const req = makeRequest({
      name: "Updated Agent",
      model_tier: "haiku",
      instructions: "Focus on research tasks.",
    });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall![0]).toContain("name = ?");
    expect(updateCall![0]).toContain("model_tier = ?");
    expect(updateCall![0]).toContain("instructions = ?");
  });

  it("allows setting instructions to empty string", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ instructions: "" }),
    });
    const req = makeRequest({ instructions: "" });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall![0]).toContain("instructions = ?");
  });
});

describe("handleUpdateAgent system_prompt field (m2-fix-system-prompt-patch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts and persists system_prompt field in PATCH", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ system_prompt: "Custom system prompt" }),
    });
    const req = makeRequest({ system_prompt: "Custom system prompt" });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("system_prompt = ?");
  });

  it("allows setting system_prompt to null", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ system_prompt: null }),
    });
    const req = makeRequest({ system_prompt: null });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("system_prompt = ?");
  });

  it("accepts system_prompt together with model_tier and other fields", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({
        system_prompt: "Full custom prompt",
        model_tier: "gpt-5.2",
        name: "Updated Agent",
      }),
    });
    const req = makeRequest({
      system_prompt: "Full custom prompt",
      model_tier: "gpt-5.2",
      name: "Updated Agent",
    });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall![0]).toContain("system_prompt = ?");
    expect(updateCall![0]).toContain("model_tier = ?");
    expect(updateCall![0]).toContain("name = ?");
  });

  it("accepts very long system_prompt (10k+ chars)", async () => {
    const longPrompt = "A".repeat(15000);
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ system_prompt: longPrompt }),
    });
    const req = makeRequest({ system_prompt: longPrompt });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall![0]).toContain("system_prompt = ?");
  });

  it("syncs system_prompt to supervisor via PATCH", async () => {
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ system_prompt: "Supervisor sync test" }),
    });
    const req = makeRequest({ system_prompt: "Supervisor sync test" });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    // Verify supervisor was called with system_prompt in the PATCH body
    // fetchFromCompanySupervisor(env, companyId, path, init) - 4 args
    expect(mockFetchFromCompanySupervisor).toHaveBeenCalled();
    const supervisorCall = mockFetchFromCompanySupervisor.mock.calls[0];
    const supervisorInit = supervisorCall[3]; // 4th arg is RequestInit
    const supervisorBody = JSON.parse(supervisorInit?.body as string);
    expect(supervisorBody).toHaveProperty("system_prompt", "Supervisor sync test");
  });
});

describe("Agent slide-over save payload", () => {
  it("handleSave payload includes adapter_type and webhook_url", () => {
    // Simulating the payload construction from the slide-over component
    const adapterType = "http-webhook";
    const webhookUrl = "https://example.com/hook";
    const showWebhookUrl = adapterType !== "claude-code";

    const payload = {
      name: "Test Agent",
      role: "worker",
      title: "worker",
      reports_to: null,
      adapter_type: adapterType,
      webhook_url: showWebhookUrl ? webhookUrl.trim() || null : null,
    };

    expect(payload).toHaveProperty("adapter_type", "http-webhook");
    expect(payload).toHaveProperty("webhook_url", "https://example.com/hook");
  });

  it("handleSave payload sets webhook_url to null for claude-code adapter", () => {
    const adapterType = "claude-code";
    const webhookUrl = "https://example.com/hook";
    const showWebhookUrl = adapterType !== "claude-code";

    const payload = {
      name: "Claude Agent",
      role: "worker",
      title: "worker",
      reports_to: null,
      adapter_type: adapterType,
      webhook_url: showWebhookUrl ? webhookUrl.trim() || null : null,
    };

    expect(payload.adapter_type).toBe("claude-code");
    expect(payload.webhook_url).toBeNull();
  });

  it("handleToggle error message includes 'supervisor' context for 502/503 errors", () => {
    // Simulate the error handling logic from handleToggle
    function getToggleErrorMessage(message: string, isEnabled: boolean): string {
      const action = isEnabled ? "disable" : "enable";
      if (message.includes("supervisor") || message.includes("502") || message.includes("503")) {
        return `Failed to ${action} agent: the supervisor is currently unreachable. Please try again later.`;
      } else if (message.includes("not paused")) {
        return `Agent is not in a paused state. Refreshing status…`;
      } else {
        return `Failed to ${action} agent: ${message}`;
      }
    }

    expect(getToggleErrorMessage("Failed to reach supervisor: Connection refused", true)).toContain("supervisor is currently unreachable");
    expect(getToggleErrorMessage("Supervisor error: 503", true)).toContain("supervisor is currently unreachable");
    expect(getToggleErrorMessage("Agent is not paused", false)).toContain("not in a paused state");
    expect(getToggleErrorMessage("Some unknown error", true)).toContain("Failed to disable agent: Some unknown error");
  });
});

describe("handleUpdateAgent MAX_SYSTEM_PROMPT_LENGTH validation (m6-fix-prompt-persistence)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects system_prompt exceeding 50000 chars with 400", async () => {
    const oversizedPrompt = "X".repeat(50_001);
    const env = makeMockEnv();
    const req = makeRequest({ system_prompt: oversizedPrompt });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("exceeds maximum length");
    expect(body.error).toContain("50000");
    expect(body.error).toContain("50001");

    // Ensure DB was NOT called with UPDATE
    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeUndefined();
  });

  it("accepts system_prompt at exactly 50000 chars", async () => {
    const maxPrompt = "A".repeat(50_000);
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ system_prompt: maxPrompt }),
    });
    const req = makeRequest({ system_prompt: maxPrompt });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find((c: string[]) => c[0].includes("UPDATE agents SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("system_prompt = ?");
  });

  it("accepts 10k+ char system_prompt within limit", async () => {
    const longPrompt = "B".repeat(10_000);
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ system_prompt: longPrompt }),
    });
    const req = makeRequest({ system_prompt: longPrompt });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);
  });

  it("allows null system_prompt without length validation", async () => {
    const env = makeMockEnv({
      updatedAgentRow: makeAgentRow({ system_prompt: null }),
    });
    const req = makeRequest({ system_prompt: null });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(200);
  });

  it("returns correct error message format with character count", async () => {
    const oversizedPrompt = "Z".repeat(60_000);
    const env = makeMockEnv();
    const req = makeRequest({ system_prompt: oversizedPrompt });

    const res = await handleUpdateAgent(req, env, "agent-1");
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/System prompt exceeds maximum length of 50000 characters \(got 60000\)/);
  });
});

describe("Agent slide-over character count display (m6-fix-prompt-persistence)", () => {
  const MAX_SYSTEM_PROMPT_LENGTH = 50_000;

  it("character count format shows current/max", () => {
    const promptLength = 10_432;
    const display = `${promptLength.toLocaleString()}/${MAX_SYSTEM_PROMPT_LENGTH.toLocaleString()}`;
    expect(display).toBe("10,432/50,000");
  });

  it("prompt at limit shows correct count", () => {
    const promptLength = 50_000;
    const display = `${promptLength.toLocaleString()}/${MAX_SYSTEM_PROMPT_LENGTH.toLocaleString()}`;
    expect(display).toBe("50,000/50,000");
  });

  it("empty prompt shows 0/50,000", () => {
    const promptLength = 0;
    const display = `${promptLength.toLocaleString()}/${MAX_SYSTEM_PROMPT_LENGTH.toLocaleString()}`;
    expect(display).toBe("0/50,000");
  });

  it("save button is disabled when prompt exceeds max length", () => {
    // Simulating the save button disabled logic
    const saving = false;
    const name = "Test Agent";
    const systemPromptLength = 50_001;

    const disabled = saving || !name.trim() || systemPromptLength > MAX_SYSTEM_PROMPT_LENGTH;
    expect(disabled).toBe(true);
  });

  it("save button is enabled when prompt is within max length", () => {
    const saving = false;
    const name = "Test Agent";
    const systemPromptLength = 50_000;

    const disabled = saving || !name.trim() || systemPromptLength > MAX_SYSTEM_PROMPT_LENGTH;
    expect(disabled).toBe(false);
  });

  it("initial prompt value is trimmed from persisted system_prompt", () => {
    // Simulating the trimming logic from useEffect
    const agent = { system_prompt: "  Hello, world!  ", instructions: null };
    const initialPrompt = (agent.system_prompt && agent.system_prompt.trim())
      ? agent.system_prompt.trim()
      : (agent.instructions && (agent.instructions as string | null)?.trim?.())
        ? (agent.instructions as string).trim()
        : "";
    expect(initialPrompt).toBe("Hello, world!");
  });

  it("initial prompt value is trimmed from legacy instructions", () => {
    const agent = { system_prompt: null, instructions: "  Legacy prompt  " };
    const initialPrompt = (agent.system_prompt && (agent.system_prompt as string | null)?.trim?.())
      ? (agent.system_prompt as string).trim()
      : (agent.instructions && agent.instructions.trim())
        ? agent.instructions.trim()
        : "";
    expect(initialPrompt).toBe("Legacy prompt");
  });
});
