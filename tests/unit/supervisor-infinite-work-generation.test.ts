import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import { CronManager } from "../../supervisor/src/cron.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  isSpecialistBlueprint: vi.fn(() => false),
  SPECIALIST_BLUEPRINTS: new Set(),
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
      output: "CEO response here",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 1000,
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

function createMockContainerManager(workspaceDir: string): ContainerManager {
  return {
    create: vi.fn(async () => ({ workspaceDir, containerId: "test-container" })),
    destroy: vi.fn(async () => {}),
    getWorkspaceDir: vi.fn(() => workspaceDir),
  } as unknown as ContainerManager;
}

function seedCompanyAndCeo(
  db: SupervisorDb,
  workspaceDir: string,
  companyId = "comp-1",
  userId = "user-1",
): void {
  const now = isoNow();
  db.run(
    `INSERT INTO companies (id, user_id, name, goal, state, workspace_dir, container_id, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, 'test-container', 'autonomous', ?, ?)`,
    [companyId, userId, "TestCo", "Build great things", workspaceDir, now, now],
  );
  db.run(
    `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
     VALUES (?, ?, 'ceo', 'CEO', 'ceo', 'idle', 'sonnet', 0, ?, ?)`,
    [`${companyId}-ceo`, companyId, now, now],
  );
  // Seed credits so CEO turns don't fail due to exhaustion
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, 10000, 0, ?)`,
    [userId, now],
  );
}

function seedMilestone(
  db: SupervisorDb,
  companyId: string,
  milestoneId: string,
  status: string,
  sortOrder = 0,
): void {
  const now = isoNow();
  db.run(
    `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ceo', ?)`,
    [milestoneId, companyId, `Milestone ${milestoneId}`, "Test milestone", sortOrder, status, now],
  );
}

function seedTask(
  db: SupervisorDb,
  companyId: string,
  milestoneId: string,
  taskId: string,
  status: string,
): void {
  const now = isoNow();
  db.run(
    `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, status, credits_spent, turns_spent, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 0, 0, 'ceo', ?)`,
    [taskId, companyId, milestoneId, `Task ${taskId}`, "Test task", status, now],
  );
}

// ─── FIX 1: Stop auto-continuation when all milestones complete ─

describe("FIX 1: Stop auto-continuation when all milestones complete", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `test-infinite-work-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("sends completion message and does NOT invoke CEO continuation turn when all milestones are done in autonomous mode", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const task_manager = new TaskManager(db);
    const credit_manager = new CreditManager(db, config, createMockSyncManager() as unknown as SyncManager);
    const invoker = createMockInvoker();

    const scheduler = new Scheduler(
      db, config, task_manager, credit_manager,
      createMockSyncManager() as unknown as SyncManager,
      invoker,
      createMockContainerManager(workspaceDir) as unknown as ContainerManager,
    );

    seedCompanyAndCeo(db, workspaceDir, "comp-1", "user-1");
    // All milestones are done — no pending or active
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedMilestone(db, "comp-1", "ms-2", "done", 2);

    await scheduler.advance_to_next_milestone("comp-1");

    // CEO continuation turn should NOT have been invoked
    expect(invoker.invoke).not.toHaveBeenCalled();

    // A completion message should have been inserted
    const msgs = db.all<{ content: string }>(
      `SELECT content FROM messages WHERE company_id = 'comp-1' AND role = 'ceo' ORDER BY created_at DESC`,
    );
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].content).toContain("All planned milestones are complete");
    expect(msgs[0].content).toContain("Send me a message");
  });

  it("sets company mode to manual when all milestones complete in autonomous mode", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const task_manager = new TaskManager(db);
    const credit_manager = new CreditManager(db, config, createMockSyncManager() as unknown as SyncManager);
    const invoker = createMockInvoker();

    const scheduler = new Scheduler(
      db, config, task_manager, credit_manager,
      createMockSyncManager() as unknown as SyncManager,
      invoker,
      createMockContainerManager(workspaceDir) as unknown as ContainerManager,
    );

    seedCompanyAndCeo(db, workspaceDir, "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedMilestone(db, "comp-1", "ms-2", "done", 2);

    await scheduler.advance_to_next_milestone("comp-1");

    // Company mode should be changed to 'manual'
    const company = db.get<{ mode: string }>(`SELECT mode FROM companies WHERE id = 'comp-1'`);
    expect(company?.mode).toBe("manual");
  });
});

// ─── FIX 2: Skip daily updates when no active work ─────────────

describe("FIX 2: Skip daily updates when no active work", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `test-daily-update-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
    mkdirSync(join(workspaceDir, "docs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("skips daily update when all milestones and tasks are terminal", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const task_manager = new TaskManager(db);
    const credit_manager = new CreditManager(db, config, createMockSyncManager() as unknown as SyncManager);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager() as unknown as SyncManager;

    const scheduler = new Scheduler(
      db, config, task_manager, credit_manager,
      syncManager, invoker,
      createMockContainerManager(workspaceDir) as unknown as ContainerManager,
    );

    const cron = new CronManager(db, task_manager, credit_manager, invoker, scheduler, config);

    seedCompanyAndCeo(db, workspaceDir, "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedTask(db, "comp-1", "ms-1", "task-1", "done");
    seedTask(db, "comp-1", "ms-1", "task-2", "cancelled");

    await cron.request_daily_update("comp-1");

    // CEO turn should NOT have been invoked — no active work
    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("does NOT skip daily update when there are active milestones/tasks", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const task_manager = new TaskManager(db);
    const credit_manager = new CreditManager(db, config, createMockSyncManager() as unknown as SyncManager);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager() as unknown as SyncManager;

    const scheduler = new Scheduler(
      db, config, task_manager, credit_manager,
      syncManager, invoker,
      createMockContainerManager(workspaceDir) as unknown as ContainerManager,
    );

    const cron = new CronManager(db, task_manager, credit_manager, invoker, scheduler, config);

    seedCompanyAndCeo(db, workspaceDir, "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "active", 1);
    seedTask(db, "comp-1", "ms-1", "task-1", "in_progress");
    seedTask(db, "comp-1", "ms-1", "task-2", "ready");

    await cron.request_daily_update("comp-1");

    // CEO turn SHOULD have been invoked — active work exists
    expect(invoker.invoke).toHaveBeenCalled();
  });
});

// ─── FIX 3: Skip cron tasks when no active work ────────────────

describe("FIX 3: Skip cron tasks when no active work", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `test-cron-tasks-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("skips cron task execution when all milestones and tasks are terminal", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const task_manager = new TaskManager(db);
    const credit_manager = new CreditManager(db, config, createMockSyncManager() as unknown as SyncManager);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager() as unknown as SyncManager;

    const scheduler = new Scheduler(
      db, config, task_manager, credit_manager,
      syncManager, invoker,
      createMockContainerManager(workspaceDir) as unknown as ContainerManager,
    );

    const cron = new CronManager(db, task_manager, credit_manager, invoker, scheduler, config);

    seedCompanyAndCeo(db, workspaceDir, "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedTask(db, "comp-1", "ms-1", "task-1", "done");

    // Add a cron task that would normally be due
    const now = isoNow();
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
       VALUES (?, ?, 'frontend-dev', 'Dev', 'developer', 'idle', 'sonnet', 0, ?, ?)`,
      ["agent-dev", "comp-1", now, now],
    );
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, title, prompt, schedule, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ceo', ?)`,
      ["cron-1", "comp-1", "agent-dev", "Check metrics", "Check all metrics", "0 * * * *", oneHourAgo, now],
    );

    await cron.schedule_cron_tasks("comp-1");

    // Invoker should NOT have been called — no active work
    expect(invoker.invoke).not.toHaveBeenCalled();
  });
});

// ─── FIX 4: Skip document budget checks when no active work ────

describe("FIX 4: Skip document budget checks when no active work", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `test-doc-budgets-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("skips check_document_budgets when all milestones and tasks are terminal", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const task_manager = new TaskManager(db);
    const credit_manager = new CreditManager(db, config, createMockSyncManager() as unknown as SyncManager);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager() as unknown as SyncManager;

    const scheduler = new Scheduler(
      db, config, task_manager, credit_manager,
      syncManager, invoker,
      createMockContainerManager(workspaceDir) as unknown as ContainerManager,
    );

    seedCompanyAndCeo(db, workspaceDir, "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedTask(db, "comp-1", "ms-1", "task-1", "done");

    // Spy on check_document_budgets
    const checkDocBudgetsSpy = vi.spyOn(
      (scheduler as any).runner,
      "check_document_budgets",
    );

    // Simulate process_ceo_response with no plan_update.json
    await scheduler.process_ceo_response(
      "comp-1",
      { success: true, output: "All done", tokenUsage: { inputTokens: 10, outputTokens: 5 }, toolCallCount: 0, durationMs: 100, aborted: false },
      false,
    );

    // check_document_budgets should NOT have been called — no active work
    expect(checkDocBudgetsSpy).not.toHaveBeenCalled();
  });

  it("does NOT skip check_document_budgets when active work exists", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const task_manager = new TaskManager(db);
    const credit_manager = new CreditManager(db, config, createMockSyncManager() as unknown as SyncManager);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager() as unknown as SyncManager;

    const scheduler = new Scheduler(
      db, config, task_manager, credit_manager,
      syncManager, invoker,
      createMockContainerManager(workspaceDir) as unknown as ContainerManager,
    );

    seedCompanyAndCeo(db, workspaceDir, "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "active", 1);
    seedTask(db, "comp-1", "ms-1", "task-1", "in_progress");

    // Spy on check_document_budgets
    const checkDocBudgetsSpy = vi.spyOn(
      (scheduler as any).runner,
      "check_document_budgets",
    );

    // Simulate process_ceo_response with no plan_update.json
    await scheduler.process_ceo_response(
      "comp-1",
      { success: true, output: "Working on it", tokenUsage: { inputTokens: 10, outputTokens: 5 }, toolCallCount: 0, durationMs: 100, aborted: false },
      false,
    );

    // check_document_budgets SHOULD have been called — active work exists
    expect(checkDocBudgetsSpy).toHaveBeenCalled();
  });
});

// ─── has_active_work helper ─────────────────────────────────────

describe("has_active_work helper", () => {
  it("returns false when all milestones are done and all tasks are done/cancelled/failed", () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, "/tmp/test", "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedMilestone(db, "comp-1", "ms-2", "cancelled", 2);
    seedTask(db, "comp-1", "ms-1", "task-1", "done");
    seedTask(db, "comp-1", "ms-1", "task-2", "cancelled");
    seedTask(db, "comp-1", "ms-2", "task-3", "failed");

    const task_manager = new TaskManager(db);
    expect(task_manager.has_active_work("comp-1")).toBe(false);
  });

  it("returns true when there is an active milestone", () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, "/tmp/test", "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedMilestone(db, "comp-1", "ms-2", "active", 2);
    seedTask(db, "comp-1", "ms-1", "task-1", "done");

    const task_manager = new TaskManager(db);
    expect(task_manager.has_active_work("comp-1")).toBe(true);
  });

  it("returns true when there is a pending milestone", () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, "/tmp/test", "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedMilestone(db, "comp-1", "ms-2", "pending", 2);

    const task_manager = new TaskManager(db);
    expect(task_manager.has_active_work("comp-1")).toBe(true);
  });

  it("returns true when there are ready/in_progress/pending tasks", () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, "/tmp/test", "comp-1", "user-1");
    seedMilestone(db, "comp-1", "ms-1", "done", 1);
    seedTask(db, "comp-1", "ms-1", "task-1", "done");
    seedTask(db, "comp-1", "ms-1", "task-2", "ready");

    const task_manager = new TaskManager(db);
    expect(task_manager.has_active_work("comp-1")).toBe(true);
  });

  it("returns false when there are no milestones or tasks at all", () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, "/tmp/test", "comp-1", "user-1");

    const task_manager = new TaskManager(db);
    expect(task_manager.has_active_work("comp-1")).toBe(false);
  });
});
