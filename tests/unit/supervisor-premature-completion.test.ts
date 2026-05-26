import { describe, expect, it, vi, beforeEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
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

// ─── Tests: CEO premature completion fix ──────────────────────

describe("CEO premature 'All milestones complete' fix", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `premature-completion-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

  it("does NOT declare 'all milestones complete' when other active milestones have in-progress tasks", async () => {
    const now = isoNow();

    // Milestone A: active, all tasks done (the one being completed)
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-a", "comp-1", "Milestone A", "First milestone", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-a1", "comp-1", "ms-a", "Task A1", "Done task", "comp-1-ceo", "comp-1-ceo", now, now],
    );

    // Milestone B: also active (was set by activate_pending_milestone_tasks), has in-progress tasks
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-b", "comp-1", "Milestone B", "Second milestone", 1, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'in_progress', ?, ?)`,
      ["task-b1", "comp-1", "ms-b", "Task B1", "Still working", "comp-1-ceo", "comp-1-ceo", now],
    );

    // Call advance_to_next_milestone — should NOT declare all complete
    await (scheduler as any).advance_to_next_milestone("comp-1");

    // Verify NO "All planned milestones are complete" message was inserted
    const completionMsg = db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = 'comp-1' AND content LIKE '%milestones%complete%'`,
    );
    expect(completionMsg).toBeUndefined();

    // Verify company mode was NOT switched to 'manual'
    const company = db.get<{ mode: string }>(
      `SELECT mode FROM companies WHERE id = 'comp-1'`,
    );
    expect(company!.mode).toBe("autonomous");
  });

  it("does NOT declare 'all milestones complete' when other active milestones have pending tasks", async () => {
    const now = isoNow();

    // Milestone A: active, all tasks done
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-a", "comp-1", "Milestone A", "First milestone", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-a1", "comp-1", "ms-a", "Task A1", "Done task", "comp-1-ceo", "comp-1-ceo", now, now],
    );

    // Milestone B: also active, has pending (ready) tasks
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-b", "comp-1", "Milestone B", "Second milestone", 1, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'ready', ?, ?)`,
      ["task-b1", "comp-1", "ms-b", "Task B1", "Ready to start", "comp-1-ceo", "comp-1-ceo", now],
    );

    await (scheduler as any).advance_to_next_milestone("comp-1");

    // No completion message
    const completionMsg = db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = 'comp-1' AND content LIKE '%milestones%complete%'`,
    );
    expect(completionMsg).toBeUndefined();

    // Mode not switched
    const company = db.get<{ mode: string }>(
      `SELECT mode FROM companies WHERE id = 'comp-1'`,
    );
    expect(company!.mode).toBe("autonomous");
  });

  it("DOES declare 'all milestones complete' when all milestones have only terminal tasks", async () => {
    const now = isoNow();

    // Milestone A: active, all tasks done
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-a", "comp-1", "Milestone A", "First milestone", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-a1", "comp-1", "ms-a", "Task A1", "Done", "comp-1-ceo", "comp-1-ceo", now, now],
    );

    // Milestone B: also active, tasks are all done/cancelled
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-b", "comp-1", "Milestone B", "Second milestone", 1, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-b1", "comp-1", "ms-b", "Task B1", "Done too", "comp-1-ceo", "comp-1-ceo", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'cancelled', ?, ?)`,
      ["task-b2", "comp-1", "ms-b", "Task B2", "Cancelled", "comp-1-ceo", "comp-1-ceo", now],
    );

    await (scheduler as any).advance_to_next_milestone("comp-1");

    // Should have the completion message
    const completionMsg = db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = 'comp-1' AND content LIKE '%milestones%complete%'`,
    );
    expect(completionMsg).toBeTruthy();

    // Mode should be 'manual'
    const company = db.get<{ mode: string }>(
      `SELECT mode FROM companies WHERE id = 'comp-1'`,
    );
    expect(company!.mode).toBe("manual");
  });

  it("does NOT declare 'all milestones complete' when there are still pending milestones with tasks", async () => {
    const now = isoNow();

    // Milestone A: active, all tasks done
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-a", "comp-1", "Milestone A", "First milestone", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-a1", "comp-1", "ms-a", "Task A1", "Done", "comp-1-ceo", "comp-1-ceo", now, now],
    );

    // Milestone B: still pending with tasks (shouldn't normally happen with activate_pending, but edge case)
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ["ms-b", "comp-1", "Milestone B", "Second milestone", 1, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'pending', ?, ?)`,
      ["task-b1", "comp-1", "ms-b", "Task B1", "Not started", "comp-1-ceo", "comp-1-ceo", now],
    );

    await (scheduler as any).advance_to_next_milestone("comp-1");

    // The existing code already handles `next` (pending milestone) — should activate it
    // The key is: it should NOT send "all milestones complete"
    const completionMsg = db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = 'comp-1' AND content LIKE '%milestones%complete%'`,
    );
    expect(completionMsg).toBeUndefined();
  });

  it("handles mix of active milestones: some done, some still working", async () => {
    const now = isoNow();

    // Milestone A: active, tasks done — being completed
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-a", "comp-1", "Milestone A", "First", 0, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-a1", "comp-1", "ms-a", "Done Task A", "Done", "comp-1-ceo", "comp-1-ceo", now, now],
    );

    // Milestone B: active, all tasks done
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-b", "comp-1", "Milestone B", "Second", 1, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'done', ?, ?, ?)`,
      ["task-b1", "comp-1", "ms-b", "Done Task B", "Done", "comp-1-ceo", "comp-1-ceo", now, now],
    );

    // Milestone C: active, still has work
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ["ms-c", "comp-1", "Milestone C", "Third", 2, "comp-1-ceo", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, 'in_progress', ?, ?)`,
      ["task-c1", "comp-1", "ms-c", "Working Task C", "In progress", "comp-1-ceo", "comp-1-ceo", now],
    );

    await (scheduler as any).advance_to_next_milestone("comp-1");

    // Should NOT declare complete — milestone C still has work
    const completionMsg = db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = 'comp-1' AND content LIKE '%milestones%complete%'`,
    );
    expect(completionMsg).toBeUndefined();

    const company = db.get<{ mode: string }>(
      `SELECT mode FROM companies WHERE id = 'comp-1'`,
    );
    expect(company!.mode).toBe("autonomous");
  });
});
