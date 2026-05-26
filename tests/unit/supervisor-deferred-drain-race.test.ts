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

// ─── Tests: Deferred drain race condition fix ───────────────────

describe("Deferred drain race condition fix", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;
  let invoker: AgentInvoker;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    workspace = join(tmpdir(), `drain-race-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

  it("checks system-turn active at callback execution time, not scheduling time", async () => {
    // This test verifies the race condition fix: the is_any_ceo_turn_active check
    // must happen INSIDE the setTimeout callback, not before scheduling it.
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue a system event
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ task_id: "task-1", task_title: "Build MVP", reason: "No agent" }), isoNow()],
    );

    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "User response",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // Invoke a user-facing turn (no system turn active at scheduling time)
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "User message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // SIMULATE THE RACE: A system turn starts AFTER scheduling but BEFORE callback fires
    const systemTurnKey = (scheduler as any).ceo_turn_key("comp-1", false);
    (scheduler as any).active_ceo_turns.add(systemTurnKey);

    const drainSpy = vi.spyOn(scheduler as any, "drain_ceo_event_queue");

    // Advance timers — the callback should now see the system turn and skip the drain
    await vi.advanceTimersByTimeAsync(100);

    // The drain should NOT be called because the system turn is active at callback time
    expect(drainSpy).not.toHaveBeenCalled();

    // The event should still be undelivered (not lost)
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(1);

    // Clean up
    (scheduler as any).active_ceo_turns.delete(systemTurnKey);
  });

  it("proceeds with drain when no system turn active at callback execution time", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue a system event
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ task_id: "task-1", task_title: "Build MVP", reason: "No agent" }), isoNow()],
    );

    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "User response",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // Invoke a user-facing turn (no system turn active)
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "User message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // Do NOT add a system turn — callback should proceed with drain
    await vi.advanceTimersByTimeAsync(100);

    // The event should be delivered
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(0);
  });

  it("does not mark events as delivered when invoke_ceo_turn fails during drain", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Seed active work so drain doesn't skip non-user events
    db.run(
      `INSERT INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
       VALUES ('m-1', 'comp-1', 'Milestone 1', 1, 'active', 'system', ?)`,
      [isoNow()],
    );

    // Queue a system event
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ task_id: "task-1", task_title: "Build MVP", reason: "No agent" }), isoNow()],
    );

    let callCount = 0;
    (invoker.invoke as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: user-facing turn succeeds
        return {
          success: true,
          output: "User response",
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          toolCallCount: 0,
          durationMs: 500,
          aborted: false,
        };
      }
      // Second call: the drain's invoke_ceo_turn fails
      throw new Error("Turn lock conflict");
    });

    // Invoke a user-facing turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "User message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // Advance timers for deferred drain (which will fail)
    await vi.advanceTimersByTimeAsync(100);

    // The event should NOT be marked as delivered since the turn failed
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(1);
  });

  it("does not mark user_message events as delivered when drain invoke fails", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue a user_message event
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'user_message', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ text: "Hello CEO" }), isoNow()],
    );

    let callCount = 0;
    (invoker.invoke as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          success: true,
          output: "User response",
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          toolCallCount: 0,
          durationMs: 500,
          aborted: false,
        };
      }
      throw new Error("Turn lock conflict");
    });

    // Invoke a user-facing turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "First message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // Advance timers for deferred drain (which will fail)
    await vi.advanceTimersByTimeAsync(100);

    // The user_message event should NOT be marked as delivered
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(1);
  });

  it("events remain in queue for next drain attempt after failure", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Seed active work so drain doesn't skip non-user events
    db.run(
      `INSERT INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
       VALUES ('m-1', 'comp-1', 'Milestone 1', 1, 'active', 'system', ?)`,
      [isoNow()],
    );

    // Queue two events
    const now = isoNow();
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ task_id: "task-1", task_title: "Task A", reason: "blocked" }), now],
    );
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_failed', ?, 0, ?)`,
      ["comp-1", JSON.stringify({ task_id: "task-2", task_title: "Task B", reason: "failed" }), now],
    );

    let callCount = 0;
    (invoker.invoke as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: user-facing turn succeeds
        return {
          success: true,
          output: "User response",
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          toolCallCount: 0,
          durationMs: 500,
          aborted: false,
        };
      }
      // Subsequent calls: drain turns fail
      throw new Error("Turn lock conflict");
    });

    // Invoke user-facing turn — drain will fail
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "User message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    await vi.advanceTimersByTimeAsync(100);

    // Both events should still be undelivered (available for next drain)
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(2);

    // Now simulate a successful drain (next system turn calls drain)
    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "Handling events",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    await (scheduler as any).drain_ceo_event_queue("comp-1");

    // Now all events should be delivered
    const stillUndelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(stillUndelivered.length).toBe(0);
  });
});
