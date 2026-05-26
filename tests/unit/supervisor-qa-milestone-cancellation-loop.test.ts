import { describe, expect, it, vi, beforeEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
import { build_system_prompt } from "../../supervisor/src/agent-runner.ts";
import { gather_ceo_context } from "../../supervisor/src/scheduler-founder.ts";
import { mkdirSync } from "node:fs";
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
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, 10000, 0, ?)`,
    [userId, now],
  );
}

// ─── Fix 1: get_active_milestone_id() fallback to done milestone ────

describe("Fix 1: get_active_milestone_id() fallback to done milestone", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `qa-fix1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(workspace, ".agent"), { recursive: true });

    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspace);

    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    seedCompanyAndCeo(db, workspace, "comp-1", "user-1");
  });

  it("returns the most recent done milestone when no active milestones exist", () => {
    const now = isoNow();
    // Create two done milestones
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?)`,
      ["ms-done-1", "comp-1", "Phase 1", "First phase", 0, "comp-1-ceo", now, now],
    );
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?)`,
      ["ms-done-2", "comp-1", "Phase 2", "Second phase", 1, "comp-1-ceo", now, now],
    );

    const result = (scheduler as any).get_active_milestone_id("comp-1");
    // Should fall back to the highest sort_order done milestone
    expect(result).toBe("ms-done-2");
  });

  it("prefers active milestones over done milestones", () => {
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?)`,
      ["ms-done", "comp-1", "Done Phase", "Completed", 0, "comp-1-ceo", now, now],
    );
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-active", "comp-1", "Active Phase", "In progress", 1, "comp-1-ceo", now],
    );

    const result = (scheduler as any).get_active_milestone_id("comp-1");
    expect(result).toBe("ms-active");
  });

  it("returns null when no milestones exist at all", () => {
    const result = (scheduler as any).get_active_milestone_id("comp-1");
    expect(result).toBeNull();
  });
});

// ─── Fix 2: Fix milestone task count display (exclude cancelled) ────

describe("Fix 2: Milestone task count excludes cancelled tasks", () => {
  let db: SupervisorDb;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `qa-fix2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    seedCompanyAndCeo(db, workspace, "comp-1", "user-1");
  });

  it("tasks_total excludes cancelled tasks from count", () => {
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-1", "comp-1", "Milestone 1", "Test", 0, "comp-1-ceo", now],
    );
    // 2 done tasks + 2 cancelled tasks
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["t-1", "comp-1", "ms-1", "Task 1", "D", "comp-1-ceo", "comp-1-ceo", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["t-2", "comp-1", "ms-1", "Task 2", "D", "comp-1-ceo", "comp-1-ceo", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["t-3", "comp-1", "ms-1", "Task 3", "C", "comp-1-ceo", "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["t-4", "comp-1", "ms-1", "Task 4", "C", "comp-1-ceo", "comp-1-ceo", now],
    );

    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);

    const ctx = gather_ceo_context("comp-1", { db, task_manager: taskManager, credit_manager: creditManager });
    const milestone = ctx.milestones.find((m) => m.id === "ms-1");

    expect(milestone).toBeTruthy();
    // Should show 2/2 done, not 2/4 done
    expect(milestone!.tasks_done).toBe(2);
    expect(milestone!.tasks_total).toBe(2);
  });

  it("tasks_total includes non-cancelled tasks (pending, ready, in_progress, done, blocked, failed)", () => {
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-2", "comp-1", "Milestone 2", "Test", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["t-a", "comp-1", "ms-2", "Done", "D", "comp-1-ceo", "comp-1-ceo", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'in_progress', ?, ?)`,
      ["t-b", "comp-1", "ms-2", "WIP", "W", "comp-1-ceo", "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["t-c", "comp-1", "ms-2", "Cancelled", "C", "comp-1-ceo", "comp-1-ceo", now],
    );

    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);

    const ctx = gather_ceo_context("comp-1", { db, task_manager: taskManager, credit_manager: creditManager });
    const milestone = ctx.milestones.find((m) => m.id === "ms-2");

    expect(milestone).toBeTruthy();
    // 2 non-cancelled tasks (done + in_progress), 1 done
    expect(milestone!.tasks_total).toBe(2);
    expect(milestone!.tasks_done).toBe(1);
  });
});

// ─── Fix 3: Don't auto-complete milestones with only cancelled tasks ────

describe("Fix 3: Milestones with only cancelled tasks stay active", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `qa-fix3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(workspace, ".agent"), { recursive: true });

    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspace);

    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    seedCompanyAndCeo(db, workspace, "comp-1", "user-1");
  });

  it("does NOT auto-complete a milestone where all tasks are cancelled (no done tasks)", () => {
    const now = isoNow();
    // Create an active milestone with only cancelled tasks
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-only-cancelled", "comp-1", "Only Cancelled", "All cancelled", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["t-c1", "comp-1", "ms-only-cancelled", "C1", "Was cancelled", "comp-1-ceo", "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["t-c2", "comp-1", "ms-only-cancelled", "C2", "Also cancelled", "comp-1-ceo", "comp-1-ceo", now],
    );

    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    const milestone = db.get<{ status: string }>(
      `SELECT status FROM milestones WHERE id = 'ms-only-cancelled'`,
    );
    expect(milestone).toBeTruthy();
    // Should stay active, NOT auto-complete
    expect(milestone!.status).toBe("active");
  });

  it("auto-completes a milestone with at least one done task and some cancelled tasks", () => {
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-mixed", "comp-1", "Mixed", "Done + cancelled", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["t-d1", "comp-1", "ms-mixed", "Done task", "D", "comp-1-ceo", "comp-1-ceo", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["t-c3", "comp-1", "ms-mixed", "Cancelled task", "C", "comp-1-ceo", "comp-1-ceo", now],
    );

    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    const milestone = db.get<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at FROM milestones WHERE id = 'ms-mixed'`,
    );
    expect(milestone).toBeTruthy();
    expect(milestone!.status).toBe("done");
    expect(milestone!.completed_at).toBeTruthy();
  });

  it("auto-completes a milestone with zero tasks (empty milestone)", () => {
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-empty", "comp-1", "Empty", "No tasks", 0, "comp-1-ceo", now],
    );

    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    const milestone = db.get<{ status: string }>(
      `SELECT status FROM milestones WHERE id = 'ms-empty'`,
    );
    expect(milestone).toBeTruthy();
    // Empty milestones should still auto-complete
    expect(milestone!.status).toBe("done");
  });
});

// ─── Fix 4: CEO system prompt includes done milestone guidance ────

describe("Fix 4: CEO system prompt includes done milestone guidance", () => {
  it("includes guidance about done milestones in the CEO system prompt", () => {
    const now = isoNow();
    const agent = {
      id: "comp-1-ceo",
      company_id: "comp-1",
      blueprint_id: "ceo",
      name: "CEO",
      role: "ceo",
      status: "idle",
      model_tier: "sonnet",
      total_credits: 0,
      created_at: now,
      updated_at: now,
    };
    const company = {
      id: "comp-1",
      user_id: "user-1",
      name: "TestCo",
      goal: "Build great things",
      state: "running",
      workspace_dir: "/tmp/test",
      container_id: "test",
      mode: "autonomous",
      created_at: now,
      updated_at: now,
    };

    const promptText = build_system_prompt(agent as any, company as any, []);

    expect(promptText).toContain("Do NOT cancel tasks in done milestones");
    expect(promptText).toContain("create a NEW milestone");
    expect(promptText).toContain("ALWAYS include milestone_id");
  });
});

// ─── Fix 5: Auto-create continuation milestone for orphan tasks ────

describe("Fix 5: Auto-create continuation milestone instead of dropping tasks", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `qa-fix5-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(workspace, ".agent"), { recursive: true });

    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspace);

    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    seedCompanyAndCeo(db, workspace, "comp-1", "user-1");
  });

  it("creates a continuation milestone when add_tasks has no milestone_id and no active/done milestones", async () => {
    // No milestones exist at all
    await (scheduler as any).apply_plan_update("comp-1", {
      add_tasks: [
        {
          title: "QA Testing",
          description: "Run QA tests",
          assigned_to: "ceo",
          depends_on: [],
          acceptance_criteria: [],
        },
      ],
    });

    // A continuation milestone should have been created
    const milestones = db.all<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM milestones WHERE company_id = 'comp-1'`,
    );
    expect(milestones.length).toBeGreaterThanOrEqual(1);
    const continuation = milestones.find((m) => m.title === "Continuation");
    expect(continuation).toBeTruthy();
    expect(continuation!.status).toBe("active");

    // The task should have been created and assigned to that milestone
    const tasks = db.all<{ id: string; title: string; milestone_id: string }>(
      `SELECT id, title, milestone_id FROM tasks WHERE company_id = 'comp-1' AND title = 'QA Testing'`,
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0].milestone_id).toBe(continuation!.id);
  });

  it("does not create continuation milestone when a done milestone exists as fallback", async () => {
    const now = isoNow();
    // Create a done milestone (Fix 1 fallback)
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?)`,
      ["ms-done", "comp-1", "Phase 1", "Complete", 0, "comp-1-ceo", now, now],
    );

    await (scheduler as any).apply_plan_update("comp-1", {
      add_tasks: [
        {
          title: "New QA Task",
          description: "Run QA",
          assigned_to: "ceo",
          depends_on: [],
          acceptance_criteria: [],
        },
      ],
    });

    // Task should be assigned to the done milestone (via Fix 1 fallback)
    const tasks = db.all<{ title: string; milestone_id: string }>(
      `SELECT title, milestone_id FROM tasks WHERE company_id = 'comp-1' AND title = 'New QA Task'`,
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0].milestone_id).toBe("ms-done");

    // No continuation milestone should be created
    const continuation = db.get<{ id: string }>(
      `SELECT id FROM milestones WHERE company_id = 'comp-1' AND title = 'Continuation'`,
    );
    expect(continuation).toBeFalsy();
  });

  it("no tasks are silently dropped", async () => {
    // No milestones, no active milestones — previously tasks were dropped
    const consoleSpy = vi.spyOn(console, "log");

    await (scheduler as any).apply_plan_update("comp-1", {
      add_tasks: [
        {
          title: "Orphan Task 1",
          description: "Should not be dropped",
          assigned_to: "ceo",
          depends_on: [],
          acceptance_criteria: [],
        },
        {
          title: "Orphan Task 2",
          description: "Should also not be dropped",
          assigned_to: "ceo",
          depends_on: [],
          acceptance_criteria: [],
        },
      ],
    });

    // Both tasks should exist
    const tasks = db.all<{ title: string }>(
      `SELECT title FROM tasks WHERE company_id = 'comp-1' AND title LIKE 'Orphan Task%'`,
    );
    expect(tasks.length).toBe(2);

    // Should see the auto-creation log
    const logCalls = consoleSpy.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Auto-created continuation milestone");
    consoleSpy.mockRestore();
  });
});
