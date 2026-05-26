import { describe, expect, it, vi, beforeEach } from "vitest";
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
    };
    return blueprints[id] ?? null;
  }),
  getAllBlueprints: vi.fn(() => []),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"],
}));

// Mock routing
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

function seedCompanyWithCredits(db: SupervisorDb, balance: number, state = "paused", userId = "user-1", companyId = "comp-1") {
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, userId, "Test Co", "Test goal", state, "/tmp/test-workspace", now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["agent-ceo-" + companyId, companyId, "ceo", "CEO", "ceo", "sonnet", "paused", 0, "internal", now, now],
  );
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance`,
    [userId, balance, 0, now],
  );
}

function seedMilestoneAndTask(db: SupervisorDb, companyId = "comp-1") {
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["milestone-" + companyId, companyId, "Test Milestone", 0, "active", "agent-ceo-" + companyId, now],
  );
  db.run(
    `INSERT OR IGNORE INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["task-" + companyId, companyId, "milestone-" + companyId, "Test task", "A test task", "[]", "[]", "agent-ceo-" + companyId, "ready", "agent-ceo-" + companyId, now],
  );
}

// ─── Tests: resume_company calls schedule for planning state ────

describe("resume_company calls schedule for planning state (VAL-RES-001)", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockSync: SyncManager;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockSync = createMockSyncManager();
  });

  it("resume_company calls schedule() when company resumes to planning state (no milestones/tasks)", async () => {
    // Seed a paused company with NO milestones/tasks → resumes into "planning" state
    seedCompanyWithCredits(db, 1000, "paused");

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      createMockInvoker(),
      createMockContainerManager(),
    );

    // Spy on schedule method
    const scheduleSpy = vi.spyOn(scheduler, "schedule" as never);

    await scheduler.resume_company("comp-1");

    // Company should be in 'planning' state (no milestones/tasks)
    const company = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(company?.state).toBe("planning");

    // schedule() should have been called
    expect(scheduleSpy).toHaveBeenCalledWith("comp-1");
  });

  it("resume_company calls schedule() when company resumes to running state (has milestones/tasks)", async () => {
    // Seed a paused company WITH milestones/tasks → resumes into "running" state
    seedCompanyWithCredits(db, 1000, "paused");
    seedMilestoneAndTask(db);

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      createMockInvoker(),
      createMockContainerManager(),
    );

    const scheduleSpy = vi.spyOn(scheduler, "schedule" as never);

    await scheduler.resume_company("comp-1");

    // Company should be in 'running' state
    const company = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(company?.state).toBe("running");

    // schedule() should have been called
    expect(scheduleSpy).toHaveBeenCalledWith("comp-1");
  });
});

// ─── Tests: Credit exhaustion during planning pauses company ────

describe("Credit exhaustion during planning transitions to paused (VAL-RES-002, VAL-RES-003)", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockSync: SyncManager;
  let mockInvoker: AgentInvoker;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockSync = createMockSyncManager();
    mockInvoker = createMockInvoker();
  });

  it("credit exhaustion during Turn 1 sets company state to paused", async () => {
    seedCompanyWithCredits(db, 1000, "planning");

    // Mock invoker to return credit exhaustion on Turn 1
    (mockInvoker.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      toolCallCount: 0,
      durationMs: 0,
      error: "Credits exhausted",
      aborted: true,
    });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(),
    );

    // Get the CompanyRow (start_planning takes a CompanyRow, not string)
    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // Company should now be paused
    const companyAfter = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(companyAfter?.state).toBe("paused");

    // Check that a CEO message was inserted
    const messages = db.all<{ content: string }>(
      `SELECT content FROM messages WHERE company_id = ?`,
      ["comp-1"],
    );
    expect(messages.some((m) => m.content.includes("Credits exhausted"))).toBe(true);
  });

  it("credit exhaustion during Turn 2 sets company state to paused", async () => {
    seedCompanyWithCredits(db, 1000, "planning");

    // Turn 1 succeeds, Turn 2 returns credit exhaustion
    (mockInvoker.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: true,
        output: "# Mission\nTest company mission",
        tokenUsage: { inputTokens: 100, outputTokens: 200 },
        toolCallCount: 0,
        durationMs: 1000,
        aborted: false,
      })
      .mockResolvedValueOnce({
        success: false,
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        toolCallCount: 0,
        durationMs: 0,
        error: "Credits exhausted",
        aborted: true,
      });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(),
    );

    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // Company should now be paused
    const companyAfter = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(companyAfter?.state).toBe("paused");

    // Check that a CEO message was inserted
    const messages = db.all<{ content: string }>(
      `SELECT content FROM messages WHERE company_id = ?`,
      ["comp-1"],
    );
    expect(messages.some((m) => m.content.includes("Credits exhausted"))).toBe(true);
  });

  it("credit exhaustion during planning enqueues sync to D1", async () => {
    seedCompanyWithCredits(db, 1000, "planning");

    // Mock invoker to return credit exhaustion on Turn 1
    (mockInvoker.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      toolCallCount: 0,
      durationMs: 0,
      error: "Credits exhausted",
      aborted: true,
    });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(),
    );

    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // Check that sync was enqueued — look for sync_queue entries with state = 'paused'
    const syncEntries = db.all<{ table_name: string; record_id: string; payload: string }>(
      `SELECT table_name, record_id, payload FROM sync_queue WHERE table_name = 'companies' AND record_id = ?`,
      ["comp-1"],
    );
    expect(syncEntries.length).toBeGreaterThan(0);
    const lastEntry = syncEntries[syncEntries.length - 1];
    const payload = JSON.parse(lastEntry.payload);
    expect(payload.state).toBe("paused");
  });
});
