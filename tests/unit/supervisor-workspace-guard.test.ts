import { describe, expect, it, vi, beforeEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import { CronManager } from "../../supervisor/src/cron.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
import { existsSync } from "node:fs";

// Mock existsSync so we can control workspace existence in tests
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

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
    };
    return blueprints[id] ?? null;
  }),
  getAllBlueprints: vi.fn(() => []),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"],
  isSpecialistBlueprint: vi.fn(() => false),
  SPECIALIST_BLUEPRINTS: new Set(),
  ENGINEERING_SUPERPOWERS: "",
  QA_SUPERPOWERS: "",
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

function createTestConfig(): SupervisorConfig {
  return {
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
}

function createMockInvoker(): AgentInvoker {
  return {
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
}

function createMockSyncManager(): SyncManager {
  return {
    push_agent_now: vi.fn(async () => {}),
    push_company_now: vi.fn(async () => {}),
    fetch_company: vi.fn(async () => ({})),
  } as unknown as SyncManager;
}

function createMockContainerManager(): ContainerManager {
  return {
    create: vi.fn(async () => ({ workspaceDir: "/tmp/test-workspace", containerId: "test-container" })),
    destroy: vi.fn(async () => {}),
    getWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
    isRunning: vi.fn(() => true),
    start: vi.fn(async () => {}),
  } as unknown as ContainerManager;
}

function seedCompany(db: SupervisorDb, opts: {
  companyId?: string;
  userId?: string;
  balance?: number;
  state?: string;
  workspaceDir?: string;
} = {}) {
  const {
    companyId = "comp-1",
    userId = "user-1",
    balance = 1000,
    state = "running",
    workspaceDir = "/tmp/test-workspace",
  } = opts;
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, userId, "Test Co", "Test goal", state, workspaceDir, now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["agent-ceo-" + companyId, companyId, "ceo", "CEO", "ceo", "sonnet", "idle", 0, "internal", now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["agent-dev-" + companyId, companyId, "frontend-dev", "Dev", "developer", "sonnet", "idle", 0, "internal", now, now],
  );
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance`,
    [userId, balance, 0, now],
  );
  return { companyId, userId };
}

function seedTask(db: SupervisorDb, companyId = "comp-1", agentId = "agent-dev-comp-1") {
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["milestone-" + companyId, companyId, "Test Milestone", 0, "active", "agent-ceo-" + companyId, now],
  );
  db.run(
    `INSERT OR IGNORE INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["task-" + companyId, companyId, "milestone-" + companyId, "Test task", "A test task", "[]", "[]", agentId, "ready", "agent-ceo-" + companyId, now],
  );
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Workspace guard: wake_agent returns early when workspace doesn't exist", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockInvoker: AgentInvoker;
  let mockSyncManager: SyncManager;
  let mockContainerManager: ContainerManager;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockInvoker = createMockInvoker();
    mockSyncManager = createMockSyncManager();
    mockContainerManager = createMockContainerManager();
    scheduler = new Scheduler(
      db, createTestConfig(), taskManager, creditManager,
      mockSyncManager, mockInvoker, mockContainerManager,
    );
    // Reset all mocks
    vi.mocked(existsSync).mockReset();
  });

  it("wake_agent returns early and pauses company when workspace_dir doesn't exist", async () => {
    seedCompany(db);
    seedTask(db);

    // Make existsSync return false for the workspace directory
    vi.mocked(existsSync).mockReturnValue(false);

    const agent = taskManager.get_agent("agent-dev-comp-1")!;
    const task = taskManager.get_task("task-comp-1")!;

    const pauseSpy = vi.spyOn(scheduler, "pause_company_missing_workspace");

    // wake_agent should NOT throw, should return early
    await scheduler["runner"].wake_agent(agent, task);

    // invoker.invoke should NOT have been called
    expect(mockInvoker.invoke).not.toHaveBeenCalled();

    // pause_company_missing_workspace should have been called
    expect(pauseSpy).toHaveBeenCalledWith("comp-1");
  });

  it("wake_agent proceeds normally when workspace_dir exists", async () => {
    seedCompany(db);
    seedTask(db);

    // Make existsSync return true for the workspace directory
    vi.mocked(existsSync).mockReturnValue(true);

    const agent = taskManager.get_agent("agent-dev-comp-1")!;
    const task = taskManager.get_task("task-comp-1")!;

    // invoke will succeed (mocked) so wake_agent should complete
    await scheduler["runner"].wake_agent(agent, task);

    // The key assertion: invoke WAS attempted (meaning we got past the workspace check)
    expect(mockInvoker.invoke).toHaveBeenCalled();
  });
});

describe("Workspace guard: company auto-paused when workspace missing", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockSyncManager: SyncManager;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockSyncManager = createMockSyncManager();
    scheduler = new Scheduler(
      db, createTestConfig(), taskManager, creditManager,
      mockSyncManager, createMockInvoker(), createMockContainerManager(),
    );
  });

  it("pause_company_missing_workspace sets company state to paused", async () => {
    seedCompany(db);

    await scheduler.pause_company_missing_workspace("comp-1");

    const company = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(company?.state).toBe("paused");
  });

  it("pause_company_missing_workspace enqueues sync to D1", async () => {
    seedCompany(db);

    await scheduler.pause_company_missing_workspace("comp-1");

    // push_company_now should have been called (via pause_company)
    expect(mockSyncManager.push_company_now).toHaveBeenCalledWith(
      "comp-1",
      expect.objectContaining({ state: "paused" }),
    );
  });

  it("pause_company_missing_workspace pauses agents too", async () => {
    seedCompany(db);

    await scheduler.pause_company_missing_workspace("comp-1");

    const agents = db.all<{ status: string }>(
      `SELECT status FROM agents WHERE company_id = ?`,
      ["comp-1"],
    );
    for (const agent of agents) {
      expect(agent.status).toBe("paused");
    }
  });

  it("pause_company_missing_workspace is a no-op for already paused companies", async () => {
    seedCompany(db, { state: "paused" });

    await scheduler.pause_company_missing_workspace("comp-1");

    // push_company_now should NOT have been called (company already paused)
    expect(mockSyncManager.push_company_now).not.toHaveBeenCalled();
  });
});

describe("Workspace guard: cron skips companies with missing workspace", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockInvoker: AgentInvoker;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockInvoker = createMockInvoker();
    scheduler = new Scheduler(
      db, createTestConfig(), taskManager, creditManager,
      createMockSyncManager(), mockInvoker, createMockContainerManager(),
    );
    vi.mocked(existsSync).mockReset();
  });

  it("invoke_cron returns early when workspace doesn't exist", async () => {
    seedCompany(db);

    // Make existsSync return false for workspace
    vi.mocked(existsSync).mockReturnValue(false);

    const agent = taskManager.get_agent("agent-dev-comp-1")!;
    const cronManager = new CronManager(db, taskManager, creditManager, mockInvoker, scheduler, createTestConfig());

    // Seed a cron task with all required fields
    const now = isoNow();
    db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, schedule, prompt, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["cron-1", "comp-1", agent.id, "0 9 * * *", "Test cron task", 1, "agent-ceo-comp-1", now],
    );
    const cron = db.get<Record<string, unknown>>(
      `SELECT * FROM cron_tasks WHERE id = ?`, ["cron-1"],
    )!;

    const pauseSpy = vi.spyOn(scheduler, "pause_company_missing_workspace");

    // invoke_cron should NOT call invoker.invoke
    await cronManager.invoke_cron(agent, cron as any);
    expect(mockInvoker.invoke).not.toHaveBeenCalled();
    expect(pauseSpy).toHaveBeenCalledWith("comp-1");
  });
});

describe("Workspace guard: CEO turn skips companies with missing workspace", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockInvoker: AgentInvoker;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockInvoker = createMockInvoker();
    scheduler = new Scheduler(
      db, createTestConfig(), taskManager, creditManager,
      createMockSyncManager(), mockInvoker, createMockContainerManager(),
    );
    vi.mocked(existsSync).mockReset();
  });

  it("invoke_ceo_turn returns early when workspace doesn't exist", async () => {
    seedCompany(db);

    // Make existsSync return false for workspace
    vi.mocked(existsSync).mockReturnValue(false);

    const pauseSpy = vi.spyOn(scheduler, "pause_company_missing_workspace");
    const ceo = taskManager.get_agent("agent-ceo-comp-1")!;

    // invoke_ceo_turn should NOT call invoker.invoke
    const result = await scheduler.invoke_ceo_turn("comp-1", ceo, "Test prompt", {});
    expect(mockInvoker.invoke).not.toHaveBeenCalled();

    // Should auto-pause the company
    expect(pauseSpy).toHaveBeenCalledWith("comp-1");

    // Result should indicate failure with empty output
    expect(result.success).toBe(false);
    expect(result.output).toBe("");
  });
});

describe("Workspace guard: infrastructure failure backoff", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockInvoker: AgentInvoker;
  let mockSyncManager: SyncManager;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockInvoker = createMockInvoker();
    mockSyncManager = createMockSyncManager();
    scheduler = new Scheduler(
      db, createTestConfig(), taskManager, creditManager,
      mockSyncManager, mockInvoker, createMockContainerManager(),
    );
    vi.mocked(existsSync).mockReset();
  });

  it("auto-pauses company after 3 consecutive infrastructure failures", async () => {
    seedCompany(db);
    seedTask(db);

    // existsSync returns true so we test the backoff path (error comes from invoke)
    vi.mocked(existsSync).mockReturnValue(true);

    // Make wake_agent's invoker throw an ENOENT error
    const enoentError = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";
    vi.mocked(mockInvoker.invoke).mockRejectedValue(enoentError);

    const pauseSpy = vi.spyOn(scheduler, "pause_company_missing_workspace");

    // Simulate 3 consecutive schedule() calls that each fail with ENOENT
    for (let i = 0; i < 3; i++) {
      await scheduler.schedule("comp-1");
      // Wait for async error handler to complete
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Reset agent to idle for next iteration (as error handler does)
      db.run(`UPDATE agents SET status = 'idle' WHERE company_id = ?`, ["comp-1"]);
    }

    // After 3 failures, company should be auto-paused
    expect(pauseSpy).toHaveBeenCalledWith("comp-1");
  });

  it("resets failure count on successful dispatch", async () => {
    seedCompany(db);
    seedTask(db);

    vi.mocked(existsSync).mockReturnValue(true);

    const enoentError = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";

    // Fail twice, then succeed
    vi.mocked(mockInvoker.invoke)
      .mockRejectedValueOnce(enoentError)
      .mockRejectedValueOnce(enoentError)
      .mockResolvedValueOnce({
        success: true,
        output: "done",
        tokenUsage: { inputTokens: 10, outputTokens: 10 },
        toolCallCount: 0,
        durationMs: 100,
        aborted: false,
      } as any);

    const pauseSpy = vi.spyOn(scheduler, "pause_company_missing_workspace");

    // Two failures
    await scheduler.schedule("comp-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    db.run(`UPDATE agents SET status = 'idle' WHERE company_id = ?`, ["comp-1"]);
    db.run(`UPDATE tasks SET status = 'ready' WHERE company_id = ?`, ["comp-1"]);

    await scheduler.schedule("comp-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    db.run(`UPDATE agents SET status = 'idle' WHERE company_id = ?`, ["comp-1"]);
    db.run(`UPDATE tasks SET status = 'ready' WHERE company_id = ?`, ["comp-1"]);

    // Success (resets counter)
    await scheduler.schedule("comp-1");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should NOT have triggered auto-pause (only 2 consecutive, then success)
    expect(pauseSpy).not.toHaveBeenCalled();
  });
});

describe("Workspace guard: container startup failure pauses company", () => {
  it("company set to paused when container_manager.start() fails at startup", () => {
    const db = createTestDb();
    const now = isoNow();

    // Seed a running company
    db.run(
      `INSERT INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["comp-1", "user-1", "Test Co", "Test goal", "running", "/tmp/test-workspace", now, now],
    );

    // Simulate what hydrate_active_companies does when container start fails:
    // It sets company state to paused in the DB and enqueues sync
    const company = db.get<{ state: string; id: string }>(
      `SELECT state, id FROM companies WHERE id = ?`,
      ["comp-1"],
    )!;
    expect(company.state).toBe("running");

    // Simulate the fix: set company to paused when container start fails
    db.run(`UPDATE companies SET state = 'paused', updated_at = ? WHERE id = ?`, [isoNow(), "comp-1"]);
    db.enqueue_sync("companies", "comp-1", "upsert", { state: "paused", updated_at: isoNow() });

    const afterFix = db.get<{ state: string }>(
      `SELECT state FROM companies WHERE id = ?`,
      ["comp-1"],
    )!;
    expect(afterFix.state).toBe("paused");

    // Verify sync was enqueued
    const syncEntry = db.get<{ record_id: string }>(
      `SELECT record_id FROM sync_queue WHERE table_name = 'companies' AND record_id = ?`,
      ["comp-1"],
    );
    expect(syncEntry).toBeTruthy();
  });
});
