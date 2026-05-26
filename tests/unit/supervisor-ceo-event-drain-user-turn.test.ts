import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
  // Seed credits so CEO turns don't fail due to exhaustion
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, 10000, 0, ?)`,
    [userId, now],
  );
}

// ─── Tests: CEO event drain after user-facing turns ─────────────

describe("CEO event drain after user-facing turns", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;
  let invoker: AgentInvoker;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    workspace = join(tmpdir(), `drain-user-turn-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    mkdirSync(join(workspace, "docs"), { recursive: true });

    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspace);

    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    seedCompanyAndCeo(db, workspace, "comp-1", "user-1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains queued events after a user-facing turn completes (deferred)", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue a system event (task_blocked) that arrived during a CEO turn
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      [
        "comp-1",
        JSON.stringify({ task_id: "task-1", task_title: "Build MVP", reason: "No agent assigned" }),
        isoNow(),
      ],
    );

    // Make invoker simulate successful turns
    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "Here's my response to you",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // Invoke a user-facing CEO turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "User message prompt", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // Advance timers to allow deferred drain to execute
    await vi.advanceTimersByTimeAsync(100);

    // The queued event should have been delivered (not stranded)
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(0);
  });

  it("does not block user response while draining events", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue a system event
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_failed', ?, 0, ?)`,
      [
        "comp-1",
        JSON.stringify({ task_id: "task-2", task_title: "Deploy app", reason: "Build failed" }),
        isoNow(),
      ],
    );

    let drainStartedBeforeReturn = false;
    const originalDrain = (scheduler as any).drain_ceo_event_queue.bind(scheduler);
    vi.spyOn(scheduler as any, "drain_ceo_event_queue").mockImplementation(async (companyId: string) => {
      // If drain is called synchronously before invoke_ceo_turn returns, this flag will be set
      drainStartedBeforeReturn = true;
      return originalDrain(companyId);
    });

    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "Response to user",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // invoke_ceo_turn should return before drain runs
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "User message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // The drain should NOT have started synchronously during the invoke_ceo_turn call
    expect(drainStartedBeforeReturn).toBe(false);

    // Now advance timers to allow deferred drain
    await vi.advanceTimersByTimeAsync(100);

    // drain should have been called after the turn returned
    expect((scheduler as any).drain_ceo_event_queue).toHaveBeenCalledWith("comp-1");
  });

  it("skips deferred drain if a system turn is already running", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue a system event
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      [
        "comp-1",
        JSON.stringify({ task_id: "task-3", task_title: "Design UI", reason: "Blocked" }),
        isoNow(),
      ],
    );

    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "Response",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // Simulate a system turn already running by manually adding the system turn key
    const systemTurnKey = (scheduler as any).ceo_turn_key("comp-1", false);
    (scheduler as any).active_ceo_turns.add(systemTurnKey);

    const drainSpy = vi.spyOn(scheduler as any, "drain_ceo_event_queue");

    // Invoke a user-facing CEO turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "User message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // Advance timers
    await vi.advanceTimersByTimeAsync(100);

    // drain should NOT have been called because a system turn is active
    // (the system turn will drain when it finishes)
    expect(drainSpy).not.toHaveBeenCalled();

    // Clean up
    (scheduler as any).active_ceo_turns.delete(systemTurnKey);
  });

  it("non-user-facing turns still drain synchronously (existing behavior preserved)", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue a system event
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      [
        "comp-1",
        JSON.stringify({ task_id: "task-4", task_title: "Test app", reason: "No tester" }),
        isoNow(),
      ],
    );

    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "System turn done",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // Invoke a non-user-facing CEO turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "System prompt", {
      is_user_facing: false,
      skip_response_processing: true,
      bill_credits: false,
    });

    // Events should already be delivered (synchronous drain for system turns)
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(0);
  });

  it("multiple queued events during user-facing turn are all drained", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue multiple events
    const now = isoNow();
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ task_id: "task-a", task_title: "Task A", reason: "blocked" }), now],
    );
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_failed', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ task_id: "task-b", task_title: "Task B", reason: "failed" }), now],
    );
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'document_revision', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ path: "docs/readme.md", title: "README" }), now],
    );

    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "Handling events",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // Invoke user-facing turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "User question", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // Advance timers for deferred drain
    await vi.advanceTimersByTimeAsync(100);

    // All events should be delivered
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(0);
  });
});
