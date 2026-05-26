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

function seedCompanyWithCredits(db: SupervisorDb, balance: number, state = "planning", userId = "user-1", companyId = "comp-1") {
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, userId, "Test Co", "Test goal", state, "/tmp/test-workspace", now, now],
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

// ─── Tests: planning_failures persisted to SQLite (VAL-RES-004, VAL-RES-005) ────

describe("planning_failures persisted to SQLite (VAL-RES-004)", () => {
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

  it("companies table has planning_failures column with default 0", () => {
    // After migrate(), the companies table should have a planning_failures column
    const row = db.get<{ planning_failures: number }>(
      `SELECT planning_failures FROM companies WHERE id = ?`,
      ["nonexistent"],
    );
    // Query should not throw — column exists. No row for nonexistent, but column is valid.
    // Seed a company and check the default value
    seedCompanyWithCredits(db, 1000, "planning");
    const company = db.get<{ planning_failures: number }>(
      `SELECT planning_failures FROM companies WHERE id = ?`,
      ["comp-1"],
    );
    expect(company?.planning_failures).toBe(0);
  });

  it("planning_failures is read from SQLite in retry_planning", async () => {
    seedCompanyWithCredits(db, 1000, "planning");

    // Pre-set planning_failures in SQLite to 2
    db.run(`UPDATE companies SET planning_failures = 2 WHERE id = ?`, ["comp-1"]);

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(),
    );

    // retry_planning should read attempts from DB (2) and increment to 3, then escalate
    await (scheduler as any).retry_planning("comp-1", ["test error"]);

    // After retry_planning with attempts=3, it should escalate → company state = "failed"
    const company = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(company?.state).toBe("failed");
  });

  it("planning_failures is written to SQLite on retry", async () => {
    seedCompanyWithCredits(db, 1000, "planning");

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(),
    );

    // Call retry_planning once — it increments planning_failures from 0 to 1,
    // then recursively retries (process_initial_plan → escalate → retry) until
    // it hits the 3-attempt threshold. So after full execution, planning_failures = 3.
    // The key assertion is that the counter is persisted in SQLite, not in-memory.
    await (scheduler as any).retry_planning("comp-1", ["test error"]);

    // Check SQLite — planning_failures should have been written
    const company = db.get<{ planning_failures: number }>(
      `SELECT planning_failures FROM companies WHERE id = ?`,
      ["comp-1"],
    );
    // Since retry cascades through process_initial_plan → escalate → retry until >= 3,
    // it should be at least 1 (the initial write) and exactly 3 (full cascade)
    expect(company?.planning_failures).toBeGreaterThanOrEqual(1);
    expect(company?.planning_failures).toBe(3);
  });

  it("planning_failures is read from SQLite in escalate_planning_failure", async () => {
    seedCompanyWithCredits(db, 1000, "planning");

    // Pre-set planning_failures in SQLite to 3 (at escalation threshold)
    db.run(`UPDATE companies SET planning_failures = 3 WHERE id = ?`, ["comp-1"]);

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(),
    );

    // escalate_planning_failure should read attempts from DB and find >= 3, marking company as failed
    await (scheduler as any).escalate_planning_failure("comp-1", "test failure reason");

    const company = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(company?.state).toBe("failed");

    // Check a CEO message was inserted about failed attempts
    const messages = db.all<{ content: string }>(
      `SELECT content FROM messages WHERE company_id = ?`,
      ["comp-1"],
    );
    expect(messages.some((m) => m.content.includes("3 attempts"))).toBe(true);
  });

  it("planning_failures is reset to 0 on successful finalize_initial_plan", async () => {
    seedCompanyWithCredits(db, 1000, "planning");

    // Pre-set planning_failures to 2
    db.run(`UPDATE companies SET planning_failures = 2 WHERE id = ?`, ["comp-1"]);

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(),
    );

    // Build a valid plan document
    const validPlan = {
      milestones: [{
        title: "Phase 1",
        description: "First milestone",
        tasks: [{
          title: "Task 1",
          description: "A task",
          assigned_to: "ceo",
          depends_on: [],
          acceptance_criteria: "Complete the task",
        }],
      }],
      agents_needed: [],
    };

    // Call finalize_initial_plan directly
    await (scheduler as any).finalize_initial_plan("comp-1", "Test mission", validPlan);

    // planning_failures should be reset to 0 in SQLite
    const company = db.get<{ planning_failures: number }>(
      `SELECT planning_failures FROM companies WHERE id = ?`,
      ["comp-1"],
    );
    expect(company?.planning_failures).toBe(0);
  });

  it("planning_failures survives across scheduler instances (VAL-RES-005)", async () => {
    seedCompanyWithCredits(db, 1000, "planning");

    // Simulate a supervisor that did 2 retries by writing directly to DB
    // (this simulates what retry_planning does: increment and persist)
    db.run(`UPDATE companies SET planning_failures = 2 WHERE id = ?`, ["comp-1"]);

    // Verify DB has planning_failures = 2
    const afterFirst = db.get<{ planning_failures: number }>(
      `SELECT planning_failures FROM companies WHERE id = ?`,
      ["comp-1"],
    );
    expect(afterFirst?.planning_failures).toBe(2);

    // Simulate supervisor restart by creating a NEW scheduler instance (same DB)
    // The new scheduler has NO in-memory state — it must read from SQLite.
    const scheduler2 = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(),
    );

    // Third retry should read 2 from SQLite, increment to 3, then escalate
    await (scheduler2 as any).retry_planning("comp-1", ["error 3"]);

    // Company should be failed (3 attempts reached escalation)
    const company = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(company?.state).toBe("failed");

    // planning_failures should be 3
    const finalFailures = db.get<{ planning_failures: number }>(
      `SELECT planning_failures FROM companies WHERE id = ?`,
      ["comp-1"],
    );
    expect(finalFailures?.planning_failures).toBe(3);
  });
});
