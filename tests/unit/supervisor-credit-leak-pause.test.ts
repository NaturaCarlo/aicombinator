import { describe, expect, it, vi, beforeEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import { CronManager } from "../../supervisor/src/cron.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig, CompanyRow } from "../../supervisor/src/types.ts";

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
  } as unknown as ContainerManager;
}

function seedCompanyWithCredits(db: SupervisorDb, balance: number, userId = "user-1", companyId = "comp-1") {
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, userId, "Test Co", "Test goal", "running", "/tmp/test-workspace", now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["agent-ceo-" + companyId, companyId, "ceo", "CEO", "ceo", "sonnet", "idle", 0, "internal", now, now],
  );
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance`,
    [userId, balance, 0, now],
  );
}

function seedMilestoneAndTask(db: SupervisorDb, companyId = "comp-1", agentId?: string) {
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["milestone-" + companyId, companyId, "Test Milestone", 0, "active", "agent-ceo-" + companyId, now],
  );
  if (agentId) {
    db.run(
      `INSERT OR IGNORE INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-" + companyId, companyId, "milestone-" + companyId, "Test task", "A test task", "[]", "[]", agentId, "ready", "agent-ceo-" + companyId, now],
    );
  }
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Credit leak prevention: pause callback (ROOT CAUSE 1)", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
  });

  it("pause callback immediately marks company as paused in DB", () => {
    seedCompanyWithCredits(db, 100);

    // Create the scheduler which wires up the pause callback
    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      createMockSyncManager(),
      createMockInvoker(),
      createMockContainerManager(),
    );

    // Verify company starts as running
    const before = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(before?.state).toBe("running");

    // Trigger the pause callback (this is what CreditManager calls when balance hits 0)
    // We access it through the credit_manager's pause_all_companies which calls the callback
    // Simulate by draining credits to 0 and watching the DB state
    creditManager.deduct_credits("user-1", 100);

    // The company should be immediately marked as paused in DB
    const after = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(after?.state).toBe("paused");
  });

  it("pause callback catches async errors and company remains paused in DB", () => {
    seedCompanyWithCredits(db, 100);

    const mockSync = createMockSyncManager();
    // Make push_company_now reject to simulate async failure
    (mockSync.push_company_now as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("D1 sync failed"));

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      createMockInvoker(),
      createMockContainerManager(),
    );

    // Trigger credit exhaustion via deduction
    creditManager.deduct_credits("user-1", 100);

    // Company should still be paused even if async portion fails
    const state = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(state?.state).toBe("paused");
  });

  it("immediate DB update prevents run_tick from scheduling paused company", () => {
    seedCompanyWithCredits(db, 100);
    seedMilestoneAndTask(db, "comp-1");

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      createMockSyncManager(),
      createMockInvoker(),
      createMockContainerManager(),
    );

    // Drain credits to 0 — this calls pause callback which immediately marks company paused
    creditManager.deduct_credits("user-1", 100);

    // Verify the company is paused in DB
    const company = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(company?.state).toBe("paused");

    // run_tick() queries only state='running' companies, so this company won't be selected
    const running = db.all<CompanyRow>(
      `SELECT * FROM companies WHERE state = 'running'`,
    );
    expect(running.length).toBe(0);
  });
});

describe("Credit leak prevention: run_tick credit pre-check (ROOT CAUSE 2)", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let config: SupervisorConfig;
  let mockInvoker: AgentInvoker;
  let mockSyncManager: SyncManager;
  let mockContainerManager: ContainerManager;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    config = createTestConfig();
    mockInvoker = createMockInvoker();
    mockSyncManager = createMockSyncManager();
    mockContainerManager = createMockContainerManager();
  });

  it("run_tick skips companies with 0 balance and pauses them", async () => {
    seedCompanyWithCredits(db, 0);
    const now = isoNow();
    // Add an idle agent with a ready task
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["agent-dev", "comp-1", "frontend-dev", "Dev", "developer", "sonnet", "idle", 0, "internal", now, now],
    );
    seedMilestoneAndTask(db, "comp-1", "agent-dev");

    const scheduler = new Scheduler(
      db, config, taskManager, creditManager, mockSyncManager, mockInvoker, mockContainerManager,
    );
    const pauseSpy = vi.spyOn(scheduler, "pause_company").mockResolvedValue(undefined);

    const cronManager = new CronManager(db, taskManager, creditManager, mockInvoker, scheduler, config);

    await cronManager.run_tick();

    // pause_company should have been called for the zero-balance company
    expect(pauseSpy).toHaveBeenCalledWith("comp-1");
  });

  it("run_tick does NOT skip companies with positive balance", async () => {
    seedCompanyWithCredits(db, 500);
    const now = isoNow();
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["agent-dev", "comp-1", "frontend-dev", "Dev", "developer", "sonnet", "idle", 0, "internal", now, now],
    );
    seedMilestoneAndTask(db, "comp-1", "agent-dev");

    const scheduler = new Scheduler(
      db, config, taskManager, creditManager, mockSyncManager, mockInvoker, mockContainerManager,
    );
    const pauseSpy = vi.spyOn(scheduler, "pause_company").mockResolvedValue(undefined);
    const scheduleSpy = vi.spyOn(scheduler, "schedule").mockResolvedValue(undefined);
    vi.spyOn(scheduler, "reset_stuck_agents").mockImplementation(() => {});

    const cronManager = new CronManager(db, taskManager, creditManager, mockInvoker, scheduler, config);

    await cronManager.run_tick();

    // pause_company should NOT have been called
    expect(pauseSpy).not.toHaveBeenCalled();
    // schedule should have been called
    expect(scheduleSpy).toHaveBeenCalledWith("comp-1");
  });

  it("run_tick skips companies with negative balance", async () => {
    seedCompanyWithCredits(db, -10);

    const scheduler = new Scheduler(
      db, config, taskManager, creditManager, mockSyncManager, mockInvoker, mockContainerManager,
    );
    const pauseSpy = vi.spyOn(scheduler, "pause_company").mockResolvedValue(undefined);

    const cronManager = new CronManager(db, taskManager, creditManager, mockInvoker, scheduler, config);

    await cronManager.run_tick();

    expect(pauseSpy).toHaveBeenCalledWith("comp-1");
  });
});

describe("Credit leak prevention: daily update checks (ROOT CAUSE 3)", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let config: SupervisorConfig;
  let mockInvoker: AgentInvoker;
  let mockSyncManager: SyncManager;
  let mockContainerManager: ContainerManager;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    config = createTestConfig();
    mockInvoker = createMockInvoker();
    mockSyncManager = createMockSyncManager();
    mockContainerManager = createMockContainerManager();
  });

  it("run_daily_update_checks skips companies with 0 balance", async () => {
    seedCompanyWithCredits(db, 0);

    const scheduler = new Scheduler(
      db, config, taskManager, creditManager, mockSyncManager, mockInvoker, mockContainerManager,
    );

    const cronManager = new CronManager(db, taskManager, creditManager, mockInvoker, scheduler, config);
    const requestSpy = vi.spyOn(cronManager, "request_daily_update").mockResolvedValue(undefined);

    await cronManager.run_daily_update_checks();

    // request_daily_update should NOT have been called for 0-balance company
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("run_daily_update_checks processes companies with positive balance", async () => {
    seedCompanyWithCredits(db, 500);

    const scheduler = new Scheduler(
      db, config, taskManager, creditManager, mockSyncManager, mockInvoker, mockContainerManager,
    );

    const cronManager = new CronManager(db, taskManager, creditManager, mockInvoker, scheduler, config);
    const requestSpy = vi.spyOn(cronManager, "request_daily_update").mockResolvedValue(undefined);

    await cronManager.run_daily_update_checks();

    // request_daily_update SHOULD have been called
    expect(requestSpy).toHaveBeenCalledWith("comp-1");
  });

  it("apply_pending_continuation_plans skips companies with 0 balance", async () => {
    seedCompanyWithCredits(db, 0);
    // Set mode to manual (apply_pending_continuation_plans only processes manual-mode companies)
    db.run(`UPDATE companies SET mode = 'manual' WHERE id = ?`, ["comp-1"]);

    const scheduler = new Scheduler(
      db, config, taskManager, creditManager, mockSyncManager, mockInvoker, mockContainerManager,
    );
    const applyPlanSpy = vi.spyOn(scheduler, "apply_plan_update").mockResolvedValue(undefined);

    const cronManager = new CronManager(db, taskManager, creditManager, mockInvoker, scheduler, config);

    // Call the private method via run_tick with the right hour
    // We'll test indirectly by ensuring no plan update is applied
    // Access private method via reflection for testing
    await (cronManager as unknown as { apply_pending_continuation_plans: () => Promise<void> }).apply_pending_continuation_plans();

    // apply_plan_update should NOT have been called
    expect(applyPlanSpy).not.toHaveBeenCalled();
  });
});
