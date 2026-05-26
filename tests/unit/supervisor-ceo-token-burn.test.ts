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
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, 10000, 0, ?)`,
    [userId, now],
  );
}

// ─── FIX 1: notify_ceo drops non-user events when no active work ──

describe("FIX 1: notify_ceo drops non-user events when has_active_work() is false", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let invoker: AgentInvoker;
  let workspaceDir: string;

  beforeEach(() => {
    db = createTestDb();
    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    workspaceDir = join(tmpdir(), `test-ceo-token-burn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
    const containerManager = createMockContainerManager(workspaceDir);

    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);

    seedCompanyAndCeo(db, workspaceDir);
  });

  it("drops task_blocked event when no active work exists", async () => {
    // No milestones or tasks seeded — has_active_work returns false
    await scheduler.notify_ceo("comp-1", "task_blocked", {
      task_id: "t-1",
      task_title: "Some task",
      reason: "missing dependency",
    });

    // Should NOT have queued or delivered anything — invoker should not be called
    expect(invoker.invoke).not.toHaveBeenCalled();

    // Should NOT have queued an event either
    const queued = db.all(`SELECT * FROM ceo_event_queue WHERE company_id = 'comp-1'`);
    expect(queued.length).toBe(0);
  });

  it("drops no_agent_assigned event when no active work exists", async () => {
    await scheduler.notify_ceo("comp-1", "no_agent_assigned", {
      task_id: "t-1",
      task_title: "Some task",
    });

    expect(invoker.invoke).not.toHaveBeenCalled();
    const queued = db.all(`SELECT * FROM ceo_event_queue WHERE company_id = 'comp-1'`);
    expect(queued.length).toBe(0);
  });

  it("drops task_failed event when no active work exists", async () => {
    await scheduler.notify_ceo("comp-1", "task_failed", {
      task_id: "t-1",
      task_title: "Some task",
      reason: "build failed",
    });

    expect(invoker.invoke).not.toHaveBeenCalled();
    const queued = db.all(`SELECT * FROM ceo_event_queue WHERE company_id = 'comp-1'`);
    expect(queued.length).toBe(0);
  });

  it("allows user_message event even when no active work exists", async () => {
    // user_message should always get through
    await scheduler.notify_ceo("comp-1", "user_message", {
      text: "Hey CEO, what's going on?",
    });

    // Should have queued or delivered the event (CEO is idle so direct delivery)
    // The invoker may or may not be called directly (depends on delivery path)
    // But the event should NOT be silently dropped
    const queued = db.all(`SELECT * FROM ceo_event_queue WHERE company_id = 'comp-1'`);
    // Either queued or delivered — check that invoker was called OR event was queued
    const wasDelivered = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    const wasQueued = queued.length > 0;
    expect(wasDelivered || wasQueued).toBe(true);
  });

  it("allows task_blocked event when active work exists", async () => {
    // Seed an active milestone so has_active_work returns true
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, 1, 'active', 'system', ?)`,
      ["m-1", "comp-1", "Milestone 1", now],
    );

    await scheduler.notify_ceo("comp-1", "task_blocked", {
      task_id: "t-1",
      task_title: "Some task",
      reason: "missing dependency",
    });

    // Should have been delivered (invoker called) since CEO is idle and work exists
    expect(invoker.invoke).toHaveBeenCalled();
  });
});

// ─── FIX 2: drain_ceo_event_queue skips events when no active work ──

describe("FIX 2: drain_ceo_event_queue clears queue when no active work", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let invoker: AgentInvoker;
  let workspaceDir: string;

  beforeEach(() => {
    db = createTestDb();
    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    workspaceDir = join(tmpdir(), `test-ceo-drain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
    const containerManager = createMockContainerManager(workspaceDir);

    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);

    seedCompanyAndCeo(db, workspaceDir);
  });

  it("clears non-user queued events when no active work", async () => {
    // Manually insert some queued events
    const now = isoNow();
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', '{"task_id":"t-1","task_title":"Some task","reason":"blocked"}', 0, ?)`,
      ["comp-1", now],
    );
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'no_agent_assigned', '{"task_id":"t-2","task_title":"Another task"}', 0, ?)`,
      ["comp-1", now],
    );

    // No active work — drain should clear the queue without delivering
    await scheduler.drain_ceo_event_queue("comp-1");

    // Invoker should NOT have been called
    expect(invoker.invoke).not.toHaveBeenCalled();

    // Events should be marked delivered (cleared)
    const undelivered = db.all(
      `SELECT * FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(0);
  });

  it("still delivers user_message events even when no active work", async () => {
    const now = isoNow();
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'user_message', '{"text":"Hello CEO"}', 0, ?)`,
      ["comp-1", now],
    );

    await scheduler.drain_ceo_event_queue("comp-1");

    // User messages should still be delivered
    const wasDelivered = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    expect(wasDelivered).toBe(true);
  });

  it("delivers all events when active work exists", async () => {
    // Seed active milestone
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, 1, 'active', 'system', ?)`,
      ["m-1", "comp-1", "Milestone 1", now],
    );

    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', '{"task_id":"t-1","task_title":"Some task","reason":"blocked"}', 0, ?)`,
      ["comp-1", now],
    );

    await scheduler.drain_ceo_event_queue("comp-1");

    // Should have been delivered since active work exists
    expect(invoker.invoke).toHaveBeenCalled();
  });
});

// ─── FIX 3: schedule() in cron.ts run_tick() gated by has_active_work ──

describe("FIX 3: run_tick() skips schedule() when no active work", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let cronManager: CronManager;
  let workspaceDir: string;

  beforeEach(() => {
    db = createTestDb();
    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    workspaceDir = join(tmpdir(), `test-cron-tick-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
    const containerManager = createMockContainerManager(workspaceDir);

    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    cronManager = new CronManager(db, taskManager, creditManager, invoker, scheduler, config);

    seedCompanyAndCeo(db, workspaceDir);
  });

  it("does not call schedule() when company has no active work", async () => {
    // Spy on scheduler.schedule
    const scheduleSpy = vi.spyOn(scheduler, "schedule");

    await cronManager.run_tick();

    // schedule() should NOT have been called since there's no active work
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("calls schedule() when company has active work", async () => {
    // Seed active milestone
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, 1, 'active', 'system', ?)`,
      ["m-1", "comp-1", "Milestone 1", now],
    );

    const scheduleSpy = vi.spyOn(scheduler, "schedule");

    await cronManager.run_tick();

    // schedule() should have been called since active work exists
    expect(scheduleSpy).toHaveBeenCalledWith("comp-1");
  });
});
