import { describe, expect, it, vi, beforeEach } from "vitest";
import { createApi } from "../../supervisor/src/api.ts";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";

// Mock blueprints module to avoid loading real blueprint files
vi.mock("../../supervisor/src/blueprints.ts", () => ({
  getBlueprint: vi.fn((id: string) => {
    const blueprints: Record<string, unknown> = {
      ceo: {
        id: "ceo", name: "CEO", role: "ceo", title: "Chief Executive Officer",
        department: "executive", reportsTo: "", systemPrompt: "You are the CEO.",
        skills: [], workflows: [], requiredTools: [], requiredApiKeys: [],
        mcpServers: [], relayChannels: [], provider: "claude", modelTier: "sonnet",
        estimatedCreditsPerDay: 100, tested: true, version: "1.0.0", description: "CEO agent",
      },
      "frontend-dev": {
        id: "frontend-dev", name: "Frontend Dev", role: "developer", title: "Frontend Developer",
        department: "engineering", reportsTo: "cto", systemPrompt: "You are the Frontend Dev.",
        skills: [], workflows: [], requiredTools: [], requiredApiKeys: [],
        mcpServers: [], relayChannels: [], provider: "claude", modelTier: "sonnet",
        estimatedCreditsPerDay: 100, tested: true, version: "1.0.0", description: "Frontend Dev agent",
      },
      "backend-dev": {
        id: "backend-dev", name: "Backend Dev", role: "developer", title: "Backend Developer",
        department: "engineering", reportsTo: "cto", systemPrompt: "You are the Backend Dev.",
        skills: [], workflows: [], requiredTools: [], requiredApiKeys: [],
        mcpServers: [], relayChannels: [], provider: "claude", modelTier: "sonnet",
        estimatedCreditsPerDay: 100, tested: true, version: "1.0.0", description: "Backend Dev agent",
      },
    };
    return blueprints[id] ?? null;
  }),
  getAllBlueprints: vi.fn(() => []),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"],
}));

// Mock routing to allow all assignments
vi.mock("../../supervisor/src/routing.ts", () => ({
  canAssignTo: vi.fn(() => true),
  getReportTarget: vi.fn(() => "ceo"),
}));

// ─── Helpers ────────────────────────────────────────────────────

function createTestDb(): SupervisorDb {
  const db = new SupervisorDb(":memory:");
  db.migrate();
  return db;
}

function seedCompanyAndAgent(
  db: SupervisorDb,
  overrides: { agentStatus?: string; companyState?: string } = {},
) {
  const now = isoNow();
  const agentStatus = overrides.agentStatus ?? "idle";
  const companyState = overrides.companyState ?? "running";

  db.run(
    `INSERT INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["comp-1", "user-1", "Test Co", "Test", companyState, "/tmp/test", now, now],
  );

  db.run(
    `INSERT INTO agents (id, company_id, name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["agent-1", "comp-1", "TestBot", "worker", agentStatus, now, now],
  );
}

function createMockScheduler(db: SupervisorDb): Scheduler {
  return {
    pause_company: vi.fn(async () => {}),
    resume_company: vi.fn(async () => {}),
    pause_agent: vi.fn(async () => {}),
    resume_agent: vi.fn(async () => {}),
    provision_company: vi.fn(async () => ({})),
    schedule: vi.fn(async () => {}),
    abort_agent_turn: vi.fn(),
    sync_manager: {
      push_agent_now: vi.fn(async () => {}),
      push_company_now: vi.fn(async () => {}),
    },
    get_company_status: vi.fn(() => ({})),
    get_agent_activity: vi.fn(() => []),
    get_founder_documents: vi.fn(() => []),
    get_verified_telemetry_summary: vi.fn(() => ({})),
    export_workspace_archive: vi.fn(() => ({ archiveBase64: "" })),
    import_workspace_archive: vi.fn(),
    destroy_company: vi.fn(async () => {}),
    generate_id: vi.fn(() => "gen-id"),
    on_user_message: vi.fn(async () => null),
    on_user_message_to_agent: vi.fn(async () => null),
    on_approval_resolved: vi.fn(async () => {}),
    on_credit_purchase: vi.fn(async () => {}),
    dispatch_agent_work: vi.fn(async () => {}),
    invoke_ceo_turn: vi.fn(async () => {}),
  } as unknown as Scheduler;
}

function createTestApp(db: SupervisorDb, scheduler?: Scheduler) {
  const config = {
    internalApiKey: "test-key",
    scopeUserId: "user-1",
  };
  const mockScheduler = scheduler ?? createMockScheduler(db);

  const app = createApi({
    config: config as any,
    db,
    scheduler: mockScheduler,
  });

  return { app, scheduler: mockScheduler };
}

function makeAuthHeaders(): Record<string, string> {
  return {
    "x-internal-api-key": "test-key",
    "x-aic-contract-version": "2026-03-22.v1",
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("POST /companies/:id/agents/:agentId/pause", () => {
  let db: SupervisorDb;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  it("pauses an idle agent and calls scheduler.pause_agent", async () => {
    seedCompanyAndAgent(db, { agentStatus: "idle" });
    const { app, scheduler } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/pause",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect((scheduler.pause_agent as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("comp-1", "agent-1");
  });

  it("pauses a working agent and calls scheduler.pause_agent", async () => {
    seedCompanyAndAgent(db, { agentStatus: "working" });
    const { app, scheduler } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/pause",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(200);
    expect((scheduler.pause_agent as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("comp-1", "agent-1");
  });

  it("returns ok without calling pause_agent when agent is already paused", async () => {
    seedCompanyAndAgent(db, { agentStatus: "paused" });
    const { app, scheduler } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/pause",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    // Should NOT call pause_agent since already paused
    expect((scheduler.pause_agent as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("returns 400 when agent is terminated", async () => {
    seedCompanyAndAgent(db, { agentStatus: "terminated" });
    const { app } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/pause",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("terminated");
  });

  it("returns 404 when agent does not exist", async () => {
    seedCompanyAndAgent(db);
    const { app } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/nonexistent/pause",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 when agent belongs to different company", async () => {
    seedCompanyAndAgent(db);
    const { app } = createTestApp(db);

    const res = await app.request(
      "/companies/other-company/agents/agent-1/pause",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    seedCompanyAndAgent(db);
    const { app } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/pause",
      { method: "POST" },
    );

    expect(res.status).toBe(401);
  });
});

describe("POST /companies/:id/agents/:agentId/resume", () => {
  let db: SupervisorDb;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  it("resumes a paused agent and calls scheduler.resume_agent", async () => {
    seedCompanyAndAgent(db, { agentStatus: "paused" });
    const { app, scheduler } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/resume",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect((scheduler.resume_agent as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("comp-1", "agent-1");
  });

  it("returns 400 when agent is not paused (idle)", async () => {
    seedCompanyAndAgent(db, { agentStatus: "idle" });
    const { app } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/resume",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not paused");
  });

  it("returns 400 when agent is working (not paused)", async () => {
    seedCompanyAndAgent(db, { agentStatus: "working" });
    const { app } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/resume",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(400);
  });

  it("returns 404 when agent does not exist", async () => {
    seedCompanyAndAgent(db);
    const { app } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/nonexistent/resume",
      { method: "POST", headers: makeAuthHeaders() },
    );

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    seedCompanyAndAgent(db);
    const { app } = createTestApp(db);

    const res = await app.request(
      "/companies/comp-1/agents/agent-1/resume",
      { method: "POST" },
    );

    expect(res.status).toBe(401);
  });
});

describe("Scheduler skips paused agents", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockInvoker: AgentInvoker;
  let mockSyncManager: SyncManager;
  let mockContainerManager: ContainerManager;
  let config: SupervisorConfig;

  beforeEach(() => {
    db = new SupervisorDb(":memory:");
    db.migrate();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);

    config = {
      workerApiUrl: "http://localhost:9999",
      internalApiKey: "test-key",
      anthropicApiKey: "test-anthropic-key",
      port: 8787,
      dbPath: ":memory:",
      scopeUserId: "user-1",
      founderTimezone: "UTC",
      syncIntervalMs: 60000,
      cronIntervalMs: 60000,
      stallCheckEveryTurns: 10,
      containerConfig: { companiesDir: "/tmp/test-companies", mcpServersDir: "/tmp/test-mcp" },
      relayConfig: { enabled: false },
    } as SupervisorConfig;

    mockInvoker = {
      invoke: vi.fn(async () => ({
        success: true,
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        toolCallCount: 0,
        durationMs: 0,
        aborted: false,
      })),
      getTurnLimits: vi.fn(() => ({
        maxInferenceRoundsPerTurn: 5,
        maxToolCallsPerTurn: 10,
        turnTimeoutMs: 60000,
        maxCreditsPerTurn: 100,
        maxTokensInput: 100000,
        maxTokensOutput: 16000,
      })),
      recordSessionCredits: vi.fn(),
      resetSession: vi.fn(),
    } as unknown as AgentInvoker;

    mockSyncManager = {
      push_agent_now: vi.fn(async () => {}),
      push_company_now: vi.fn(async () => {}),
      fetch_company: vi.fn(async () => ({})),
    } as unknown as SyncManager;

    mockContainerManager = {
      create: vi.fn(async () => ({ workspaceDir: "/tmp/test-workspace", containerId: "test-container" })),
      destroy: vi.fn(async () => {}),
      getWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
    } as unknown as ContainerManager;
  });

  function seedSchedulerTestData(opts: { pausedAgentId: string; idleAgentId: string }) {
    const now = isoNow();

    // Company
    db.run(
      `INSERT INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["comp-1", "user-1", "Test Co", "Test goal", "running", "/tmp/test-workspace", now, now],
    );

    // CEO agent (idle — required by scheduler internals)
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["agent-ceo", "comp-1", "ceo", "CEO", "ceo", "sonnet", "idle", 0, "internal", now, now],
    );

    // Paused agent
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [opts.pausedAgentId, "comp-1", "frontend-dev", "Frontend Dev", "developer", "sonnet", "paused", 0, "internal", now, now],
    );

    // Idle agent
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [opts.idleAgentId, "comp-1", "backend-dev", "Backend Dev", "developer", "sonnet", "idle", 0, "internal", now, now],
    );

    // Milestone
    db.run(
      `INSERT INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["milestone-1", "comp-1", "Test Milestone", 0, "active", "agent-ceo", now],
    );

    // Task assigned to the paused agent (status 'ready')
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-paused", "comp-1", "milestone-1", "Paused agent task", "Task for paused agent", "[]", "[]", opts.pausedAgentId, "ready", "agent-ceo", now],
    );

    // Task assigned to the idle agent (status 'ready')
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-idle", "comp-1", "milestone-1", "Idle agent task", "Task for idle agent", "[]", "[]", opts.idleAgentId, "ready", "agent-ceo", now],
    );

    // Grant credits so dispatch is not blocked by credit checks
    db.run(
      `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
       VALUES (?, ?, ?, ?)`,
      ["user-1", 10000, 0, now],
    );
  }

  it("schedule() does NOT dispatch a paused agent (no wake_agent call)", async () => {
    const pausedAgentId = "agent-paused";
    const idleAgentId = "agent-idle";
    seedSchedulerTestData({ pausedAgentId, idleAgentId });

    const scheduler = new Scheduler(
      db,
      config,
      taskManager,
      creditManager,
      mockSyncManager,
      mockInvoker,
      mockContainerManager,
    );

    // Spy on the internal runner's wake_agent method
    const runner = (scheduler as unknown as { runner: { wake_agent: (...args: unknown[]) => Promise<void> } }).runner;
    const wakeAgentSpy = vi.spyOn(runner, "wake_agent").mockResolvedValue(undefined);

    await scheduler.schedule("comp-1");

    // wake_agent should have been called for the idle agent's task
    const wakeAgentCalls = wakeAgentSpy.mock.calls;
    const dispatchedAgentIds = wakeAgentCalls.map((call) => (call[0] as { id: string }).id);

    expect(dispatchedAgentIds).toContain(idleAgentId);
    expect(dispatchedAgentIds).not.toContain(pausedAgentId);
  });

  it("schedule() dispatches idle agent while skipping paused agent in same company", async () => {
    const pausedAgentId = "agent-paused-2";
    const idleAgentId = "agent-idle-2";
    seedSchedulerTestData({ pausedAgentId, idleAgentId });

    const scheduler = new Scheduler(
      db,
      config,
      taskManager,
      creditManager,
      mockSyncManager,
      mockInvoker,
      mockContainerManager,
    );

    const runner = (scheduler as unknown as { runner: { wake_agent: (...args: unknown[]) => Promise<void> } }).runner;
    const wakeAgentSpy = vi.spyOn(runner, "wake_agent").mockResolvedValue(undefined);

    await scheduler.schedule("comp-1");

    // Verify exactly 1 dispatch happened (for the idle agent only)
    expect(wakeAgentSpy).toHaveBeenCalledTimes(1);

    // The dispatched agent must be the idle one
    const dispatchedAgent = wakeAgentSpy.mock.calls[0]![0] as { id: string; status: string };
    expect(dispatchedAgent.id).toBe(idleAgentId);

    // The dispatched task must be the idle agent's task
    const dispatchedTask = wakeAgentSpy.mock.calls[0]![1] as { id: string };
    expect(dispatchedTask.id).toBe("task-idle");
  });

  it("paused agent's task remains in 'ready' status after schedule()", async () => {
    seedSchedulerTestData({ pausedAgentId: "agent-paused-3", idleAgentId: "agent-idle-3" });

    const scheduler = new Scheduler(
      db,
      config,
      taskManager,
      creditManager,
      mockSyncManager,
      mockInvoker,
      mockContainerManager,
    );

    const runner = (scheduler as unknown as { runner: { wake_agent: (...args: unknown[]) => Promise<void> } }).runner;
    vi.spyOn(runner, "wake_agent").mockResolvedValue(undefined);

    await scheduler.schedule("comp-1");

    // The paused agent's task should still be 'ready' (not dispatched)
    const pausedTask = db.get<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, ["task-paused"]);
    expect(pausedTask?.status).toBe("ready");
  });
});
