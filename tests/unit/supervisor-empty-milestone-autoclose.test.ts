import { describe, expect, it, vi, beforeEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
import { mkdirSync, rmSync } from "node:fs";
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

// ─── Tests: Empty milestone auto-close in activate_pending_milestone_tasks ──

describe("Empty milestone auto-close", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `empty-milestone-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

  it("auto-completes a milestone with zero tasks after activation", () => {
    const now = isoNow();
    // Create a milestone with zero tasks
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ["ms-empty", "comp-1", "Empty Milestone", "Has no tasks", 0, "comp-1-ceo", now],
    );

    // Call activate_pending_milestone_tasks
    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    // The milestone should be auto-completed (status = 'done')
    const milestone = db.get<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at FROM milestones WHERE id = 'ms-empty'`,
    );
    expect(milestone).toBeTruthy();
    expect(milestone!.status).toBe("done");
    expect(milestone!.completed_at).toBeTruthy();
  });

  it("auto-completes a milestone where all tasks are already done", () => {
    const now = isoNow();
    // Create a milestone
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ["ms-alldone", "comp-1", "All Done Milestone", "All tasks done", 0, "comp-1-ceo", now],
    );
    // Add a task that's already done
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-done-1", "comp-1", "ms-alldone", "Done Task", "Already complete", "comp-1-ceo", "comp-1-ceo", now, now],
    );

    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    const milestone = db.get<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at FROM milestones WHERE id = 'ms-alldone'`,
    );
    expect(milestone).toBeTruthy();
    expect(milestone!.status).toBe("done");
    expect(milestone!.completed_at).toBeTruthy();
  });

  it("does NOT auto-complete a milestone where all tasks are cancelled (stays active for new tasks)", () => {
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ["ms-cancelled", "comp-1", "Cancelled Tasks Milestone", "All tasks cancelled", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["task-cancel-1", "comp-1", "ms-cancelled", "Cancelled Task", "Was cancelled", "comp-1-ceo", "comp-1-ceo", now],
    );

    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    const milestone = db.get<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at FROM milestones WHERE id = 'ms-cancelled'`,
    );
    expect(milestone).toBeTruthy();
    // Milestones with only cancelled tasks stay active so new tasks can be added
    expect(milestone!.status).toBe("active");
  });

  it("does NOT auto-complete a milestone with active tasks", () => {
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ["ms-active", "comp-1", "Active Milestone", "Has active tasks", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'pending', ?, ?)`,
      ["task-pending-1", "comp-1", "ms-active", "Pending Task", "Not done yet", "comp-1-ceo", "comp-1-ceo", now],
    );

    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    const milestone = db.get<{ status: string }>(
      `SELECT status FROM milestones WHERE id = 'ms-active'`,
    );
    expect(milestone).toBeTruthy();
    expect(milestone!.status).toBe("active");
  });

  it("auto-completes multiple empty milestones in a single pass", () => {
    const now = isoNow();
    // Create two empty milestones
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ["ms-empty-1", "comp-1", "Empty 1", "No tasks", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ["ms-empty-2", "comp-1", "Empty 2", "Also no tasks", 1, "comp-1-ceo", now],
    );

    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    const ms1 = db.get<{ status: string }>(`SELECT status FROM milestones WHERE id = 'ms-empty-1'`);
    const ms2 = db.get<{ status: string }>(`SELECT status FROM milestones WHERE id = 'ms-empty-2'`);
    expect(ms1!.status).toBe("done");
    expect(ms2!.status).toBe("done");
  });

  it("auto-completes a milestone with mix of done and cancelled tasks", () => {
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ["ms-mixed", "comp-1", "Mixed Terminal Milestone", "Done + cancelled", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-d", "comp-1", "ms-mixed", "Done Task", "Done", "comp-1-ceo", "comp-1-ceo", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["task-c", "comp-1", "ms-mixed", "Cancelled Task", "Cancelled", "comp-1-ceo", "comp-1-ceo", now],
    );

    (scheduler as any).activate_pending_milestone_tasks("comp-1");

    const milestone = db.get<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at FROM milestones WHERE id = 'ms-mixed'`,
    );
    expect(milestone!.status).toBe("done");
    expect(milestone!.completed_at).toBeTruthy();
  });
});

// ─── Tests: apply_plan_update auto-closes empty milestones ──────

describe("apply_plan_update auto-closes milestones with zero tasks", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `plan-update-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

  it("auto-completes a newly created milestone with empty tasks array", async () => {
    // apply_plan_update with a milestone that has zero tasks
    await (scheduler as any).apply_plan_update("comp-1", {
      add_milestones: [
        {
          title: "Empty Phase",
          description: "A phase with no tasks",
          tasks: [],
        },
      ],
    });

    // Find the newly created milestone
    const milestone = db.get<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at FROM milestones WHERE company_id = 'comp-1' AND title = 'Empty Phase'`,
    );
    expect(milestone).toBeTruthy();
    expect(milestone!.status).toBe("done");
    expect(milestone!.completed_at).toBeTruthy();
  });

  it("does NOT auto-complete a milestone with tasks in apply_plan_update", async () => {
    await (scheduler as any).apply_plan_update("comp-1", {
      add_milestones: [
        {
          title: "Normal Phase",
          description: "A phase with tasks",
          tasks: [
            {
              title: "Task 1",
              description: "Do something",
              assigned_to: "ceo",
              acceptance_criteria: [],
              depends_on: [],
            },
          ],
        },
      ],
    });

    // apply_plan_update triggers schedule() which activates pending milestones,
    // but the milestone should NOT be auto-completed since it has tasks
    const milestone = db.get<{ status: string }>(
      `SELECT status FROM milestones WHERE company_id = 'comp-1' AND title = 'Normal Phase'`,
    );
    expect(milestone).toBeTruthy();
    expect(milestone!.status).not.toBe("done");
  });
});
