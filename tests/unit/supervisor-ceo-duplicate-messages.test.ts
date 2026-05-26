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
  // Seed credits so CEO turns don't fail due to exhaustion
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, 10000, 0, ?)`,
    [userId, now],
  );
}

// ─── BUG 1: Continuation dedup (VAL-SUP-001, VAL-SUP-002) ─────

describe("BUG 1: Continuation dedup matches actual message content", () => {
  it("dedup query matches 'All milestones complete' messages (VAL-SUP-001)", () => {
    const db = createTestDb();
    const now = isoNow();
    const companyId = "comp-1";

    // Seed a message with the actual continuation text
    db.run(
      `INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
       VALUES (?, ?, 'ceo-1', 'ceo', ?, ?)`,
      [
        "msg-1",
        companyId,
        "All milestones complete. I've planned the next phase and the team is already working on it.",
        now,
      ],
    );

    // The fixed dedup query should match this message
    const match = db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = ? AND role = 'ceo'
       AND content LIKE '%milestones%complete%'
       AND created_at > datetime('now', '-30 minutes')
       ORDER BY created_at DESC LIMIT 1`,
      [companyId],
    );
    expect(match).toBeTruthy();
    expect(match!.id).toBe("msg-1");
  });

  it("dedup query matches 'All milestones are complete!' variant (VAL-SUP-002)", () => {
    const db = createTestDb();
    const now = isoNow();
    const companyId = "comp-1";

    db.run(
      `INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
       VALUES (?, ?, 'ceo-1', 'ceo', ?, ?)`,
      [
        "msg-2",
        companyId,
        "All milestones are complete! Here's my proposed next phase:\n\n**Proposed milestones:**\n- Phase 2 (3 tasks)",
        now,
      ],
    );

    const match = db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = ? AND role = 'ceo'
       AND content LIKE '%milestones%complete%'
       AND created_at > datetime('now', '-30 minutes')
       ORDER BY created_at DESC LIMIT 1`,
      [companyId],
    );
    expect(match).toBeTruthy();
    expect(match!.id).toBe("msg-2");
  });

  it("old dedup pattern '%continuation%' does NOT match actual messages", () => {
    const db = createTestDb();
    const now = isoNow();
    const companyId = "comp-1";

    // These are the actual messages — none contain "continuation"
    const messages = [
      "All milestones complete. I've planned the next phase and the team is already working on it.",
      "All milestones are complete! Here's my proposed next phase:\n\n**Proposed milestones:**\n- Phase 2",
      "All milestones are complete! Add credits to continue.",
    ];

    for (const [i, msg] of messages.entries()) {
      db.run(
        `INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
         VALUES (?, ?, 'ceo-1', 'ceo', ?, ?)`,
        [`msg-${i}`, companyId, msg, now],
      );
    }

    // The old pattern should NOT match any of these
    const oldMatch = db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = ? AND role = 'ceo'
       AND content LIKE '%continuation%'
       AND created_at > datetime('now', '-30 minutes')
       ORDER BY created_at DESC LIMIT 1`,
      [companyId],
    );
    expect(oldMatch).toBeFalsy();
  });
});

// ─── BUG 2: check_ceo_signals user-facing guard (VAL-SUP-003, VAL-SUP-004) ──

describe("BUG 2: check_ceo_signals user-facing guard", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `ceo-dedup-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

  it("does NOT insert ceo_notice for user-facing turns (VAL-SUP-003)", async () => {
    const ceo = db.get<{ id: string; company_id: string; blueprint_id: string; name: string; role: string; status: string; model_tier: string; total_credits: number; created_at: string; updated_at: string }>(
      `SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`,
    )!;

    // Write a fake approval_request.json so the insert branch is exercised
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(workspace, ".agent", "approval_request.json"),
      JSON.stringify({ type: "budget", description: "Need $500 for hosting" }),
    );

    const result = {
      success: true,
      output: "Here is my response to the user about the approval",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 1000,
      aborted: false,
    };

    // Call check_ceo_signals with is_user_facing = true
    await (scheduler as any).check_ceo_signals("comp-1", ceo, result, true);

    // The approval should still be created
    const approvals = db.all<{ id: string }>(
      `SELECT * FROM approvals WHERE company_id = 'comp-1'`,
    );
    expect(approvals.length).toBe(1);

    // But NO ceo_notice message should be inserted (user-facing turn already has founder_chat)
    const messages = db.all<{ id: string; role: string; content: string }>(
      `SELECT * FROM messages WHERE company_id = 'comp-1' AND role = 'ceo'`,
    );
    expect(messages.length).toBe(0);
  });

  it("still inserts ceo_notice for non-user-facing turns (VAL-SUP-004)", async () => {
    const ceo = db.get<{ id: string; company_id: string; blueprint_id: string; name: string; role: string; status: string; model_tier: string; total_credits: number; created_at: string; updated_at: string }>(
      `SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`,
    )!;

    // Write a fake approval_request.json so check_ceo_signals triggers the insert
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(workspace, ".agent", "approval_request.json"),
      JSON.stringify({ type: "budget", description: "Need $500 for hosting" }),
    );

    const result = {
      success: true,
      output: "I'm requesting budget approval for hosting costs.",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 1000,
      aborted: false,
    };

    // Call check_ceo_signals with is_user_facing = false
    await (scheduler as any).check_ceo_signals("comp-1", ceo, result, false);

    // A ceo_notice message SHOULD be inserted
    const messages = db.all<{ id: string; role: string; content: string }>(
      `SELECT * FROM messages WHERE company_id = 'comp-1' AND role = 'ceo'`,
    );
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain("requesting budget approval");
  });

  it("check_ceo_signals without is_user_facing param defaults to inserting (backward compat)", async () => {
    const ceo = db.get<{ id: string }>(
      `SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`,
    )!;

    // Write a fake approval_request.json
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(workspace, ".agent", "approval_request.json"),
      JSON.stringify({ type: "budget", description: "Test approval" }),
    );

    const result = {
      success: true,
      output: "Approval requested.",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 1000,
      aborted: false,
    };

    // Call without is_user_facing (should default to false → inserts)
    await (scheduler as any).check_ceo_signals("comp-1", ceo, result);

    const messages = db.all<{ id: string; role: string; content: string }>(
      `SELECT * FROM messages WHERE company_id = 'comp-1' AND role = 'ceo'`,
    );
    expect(messages.length).toBe(1);
  });
});

// ─── BUG 3: drain_ceo_event_queue after lock release (VAL-SUP-005, VAL-SUP-006) ──

describe("BUG 3: drain_ceo_event_queue runs after lock release", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;
  let invoker: AgentInvoker;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `drain-queue-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

  it("drain_ceo_event_queue is called after active_ceo_turns lock is released (VAL-SUP-005)", async () => {
    // We spy on drain_ceo_event_queue to record when it's called
    // and check if the lock is released at that point.
    let lockHeldDuringDrain: boolean | null = null;

    const originalDrain = (scheduler as any).drain_ceo_event_queue.bind(scheduler);
    vi.spyOn(scheduler as any, "drain_ceo_event_queue").mockImplementation(async (companyId: string) => {
      // Record whether the lock is still held when drain is called
      lockHeldDuringDrain = (scheduler as any).active_ceo_turns.has(companyId);
      return originalDrain(companyId);
    });

    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Make invoker simulate a successful turn
    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "Done",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // Invoke a CEO turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // drain_ceo_event_queue should have been called
    expect(lockHeldDuringDrain).not.toBeNull();

    // The lock should NOT be held when drain runs (fix: drain runs after finally block)
    expect(lockHeldDuringDrain).toBe(false);
  });

  it("queued events are processed after lock release, not silently lost (VAL-SUP-006)", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Queue an event that would be queued during an active CEO turn
    db.run(
      `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at)
       VALUES (?, 'task_blocked', ?, 0, ?)`,
      [
        "comp-1",
        JSON.stringify({ task_id: "task-1", task_title: "Build MVP", reason: "No agent assigned" }),
        isoNow(),
      ],
    );

    // Make invoker simulate successful turns (one for main, one for drain delivery)
    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "Handling it",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    // Invoke a CEO turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // After the turn completes with lock released, the event should be delivered
    const undelivered = db.all<{ id: number }>(
      `SELECT id FROM ceo_event_queue WHERE company_id = 'comp-1' AND delivered = 0`,
    );
    expect(undelivered.length).toBe(0);
  });
});
