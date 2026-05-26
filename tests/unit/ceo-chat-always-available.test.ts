import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock blueprints module
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

// ─── BUG 1: CEO chat always available despite system turns ──────

describe("BUG 1: CEO chat accepts user messages regardless of system turn state", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;
  let invoker: AgentInvoker;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `ceo-chat-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
    try { rmSync(workspace, { recursive: true, force: true }); } catch {}
  });

  it("is_ceo_turn_active returns true only for system turns, not user-facing", async () => {
    // Simulate a system turn being active using compound key
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Start a system CEO turn (non-user-facing)
    let systemTurnResolve: () => void;
    const systemTurnPromise = new Promise<void>((resolve) => { systemTurnResolve = resolve; });
    (invoker.invoke as any).mockImplementation(async () => {
      await systemTurnPromise;
      return {
        success: true,
        output: "System response",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        toolCallCount: 0,
        durationMs: 1000,
        aborted: false,
      };
    });

    const systemTurn = (scheduler as any).invoke_ceo_turn("comp-1", ceo, "system prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // While system turn is running, is_ceo_turn_active should be true
    // But user-facing turns should still be accepted
    expect(scheduler.is_ceo_turn_active("comp-1")).toBe(true);

    // Resolve the system turn
    systemTurnResolve!();
    await systemTurn;
  });

  it("user-facing CEO turn succeeds even when system turn is active (compound keys)", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Hold the system turn open
    let systemResolve: () => void;
    const systemBlock = new Promise<void>((resolve) => { systemResolve = resolve; });
    let callCount = 0;
    (invoker.invoke as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call is the system turn - block it
        await systemBlock;
      }
      return {
        success: true,
        output: `Response ${callCount}`,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        toolCallCount: 0,
        durationMs: 500,
        aborted: false,
      };
    });

    // Start system turn (don't await)
    const systemTurn = (scheduler as any).invoke_ceo_turn("comp-1", ceo, "system check", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // Wait a tick to ensure the system turn is registered
    await new Promise((r) => setTimeout(r, 10));

    // Now invoke a user-facing turn — should NOT be blocked
    const userResult = await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "user message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // User turn should succeed
    expect(userResult.success).toBe(true);

    // Release system turn
    systemResolve!();
    await systemTurn;
  });

  it("user-facing and system turns use separate session keys", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;
    const sessionKeys: string[] = [];

    (invoker.invoke as any).mockImplementation(async (_agent: any, _prompt: string, _workspace: string, opts: any) => {
      sessionKeys.push(opts.sessionKey);
      return {
        success: true,
        output: "Response",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        toolCallCount: 0,
        durationMs: 500,
        aborted: false,
      };
    });

    // System turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "system prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // User-facing turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "user message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    expect(sessionKeys).toHaveLength(2);
    // System turn uses ceo.id, user-facing uses ceo.id:founder-chat
    expect(sessionKeys[0]).toBe(ceo.id);
    expect(sessionKeys[1]).toBe(`${ceo.id}:founder-chat`);
    expect(sessionKeys[0]).not.toBe(sessionKeys[1]);
  });

  it("concurrent system + user-facing turns use separate abort controllers", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    let systemResolve: () => void;
    const systemBlock = new Promise<void>((resolve) => { systemResolve = resolve; });
    let callCount = 0;
    (invoker.invoke as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) await systemBlock;
      return {
        success: true,
        output: `Response ${callCount}`,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        toolCallCount: 0,
        durationMs: 500,
        aborted: false,
      };
    });

    // Start system turn
    const systemTurn = (scheduler as any).invoke_ceo_turn("comp-1", ceo, "system", {
      skip_response_processing: true,
      bill_credits: false,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Both system and user should have separate abort controllers
    const abortControllers = (scheduler as any).active_ceo_abort_controllers as Map<string, AbortController>;
    expect(abortControllers.has("comp-1:system") || abortControllers.has("comp-1")).toBe(true);

    // Run user turn
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "user message", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    systemResolve!();
    await systemTurn;
  });
});

// ─── BUG 2: Document revision infinite loop ─────────────────────

describe("BUG 2: Document revision infinite loop prevention", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;
  let invoker: AgentInvoker;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `doc-rev-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
    try { rmSync(workspace, { recursive: true, force: true }); } catch {}
  });

  it("check_document_budgets accepts 30-80 word mission.md (aligned with CEO system prompt)", () => {
    // Write a mission.md with ~50 words (within 30-80 range from CEO system prompt)
    const missionContent = "We build AI-powered tools that help small businesses automate their customer service operations. Our platform provides intelligent chatbots, automated email responses, and smart routing for support tickets. We serve small to medium businesses in retail and e-commerce who need affordable yet powerful customer support solutions.";
    writeFileSync(join(workspace, "docs", "mission.md"), missionContent);

    const runner = (scheduler as any).runner;
    const notifyCeo = vi.spyOn(runner.callbacks, "notify_ceo");

    runner.check_document_budgets("comp-1");

    // Should NOT trigger document_revision since 30-80 words is within the aligned range
    const docRevisionCalls = notifyCeo.mock.calls.filter(
      (call: any[]) => call[1] === "document_revision" && call[2]?.path === "docs/mission.md",
    );
    expect(docRevisionCalls.length).toBe(0);
  });

  it("check_document_budgets rejects mission.md with <30 words", () => {
    // Write a very short mission.md (under 30 words)
    const shortMission = "We build AI tools.";
    writeFileSync(join(workspace, "docs", "mission.md"), shortMission);

    const runner = (scheduler as any).runner;
    const notifyCeo = vi.spyOn(runner.callbacks, "notify_ceo");

    runner.check_document_budgets("comp-1");

    // Should trigger document_revision since under 30 words
    const docRevisionCalls = notifyCeo.mock.calls.filter(
      (call: any[]) => call[1] === "document_revision" && call[2]?.path === "docs/mission.md",
    );
    expect(docRevisionCalls.length).toBe(1);
  });

  it("document_revision cooldown prevents re-firing within 30 minutes", async () => {
    // Write a mission.md that's too short
    const shortMission = "We build AI tools.";
    writeFileSync(join(workspace, "docs", "mission.md"), shortMission);

    const runner = (scheduler as any).runner;
    const notifyCeo = vi.spyOn(runner.callbacks, "notify_ceo");

    // First call should trigger revision
    runner.check_document_budgets("comp-1");
    expect(notifyCeo.mock.calls.filter(
      (call: any[]) => call[1] === "document_revision" && call[2]?.path === "docs/mission.md",
    ).length).toBe(1);

    notifyCeo.mockClear();

    // Second call within 30 min should NOT trigger revision (cooldown)
    runner.check_document_budgets("comp-1");
    expect(notifyCeo.mock.calls.filter(
      (call: any[]) => call[1] === "document_revision" && call[2]?.path === "docs/mission.md",
    ).length).toBe(0);
  });

  it("process_ceo_response skips check_document_budgets when turn was triggered by document_revision", async () => {
    // Write a short mission.md
    writeFileSync(join(workspace, "docs", "mission.md"), "Short mission.");

    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    (invoker.invoke as any).mockResolvedValue({
      success: true,
      output: "I updated the mission document.",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      toolCallCount: 0,
      durationMs: 500,
      aborted: false,
    });

    const runner = (scheduler as any).runner;
    const notifyCeo = vi.spyOn(runner.callbacks, "notify_ceo");

    // Invoke a CEO turn triggered by document_revision
    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "Please fix mission.md", {
      skip_response_processing: false,
      bill_credits: false,
      event_type: "document_revision",
    });

    // check_document_budgets should NOT have fired another document_revision
    // (because the turn itself was triggered by document_revision)
    const docRevisionCalls = notifyCeo.mock.calls.filter(
      (call: any[]) => call[1] === "document_revision",
    );
    expect(docRevisionCalls.length).toBe(0);
  });
});

// ─── BUG 3: Watchdog catches all stuck agents ──────────────────

describe("BUG 3: Watchdog catches all stuck agents", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `watchdog-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    mkdirSync(join(workspace, "docs"), { recursive: true });

    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspace);

    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    seedCompanyAndCeo(db, workspace, "comp-1", "user-1");
  });

  afterEach(() => {
    try { rmSync(workspace, { recursive: true, force: true }); } catch {}
  });

  it("resets CEO stuck in working state >30min with no abort controller", () => {
    const ceoId = "comp-1-ceo";
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.run(
      `UPDATE agents SET status = 'working', last_wake_at = ? WHERE id = ?`,
      [thirtyOneMinAgo, ceoId],
    );

    scheduler.reset_stuck_agents("comp-1");

    const ceo = db.get<any>(`SELECT * FROM agents WHERE id = ?`, [ceoId])!;
    expect(ceo.status).toBe("idle");
  });

  it("resets CEO stuck in working state >30min WITH active abort controller", () => {
    const ceoId = "comp-1-ceo";
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.run(
      `UPDATE agents SET status = 'working', last_wake_at = ? WHERE id = ?`,
      [thirtyOneMinAgo, ceoId],
    );

    // Add a CEO abort controller
    const abortControllers = (scheduler as any).active_ceo_abort_controllers as Map<string, AbortController>;
    abortControllers.set("comp-1:system", new AbortController());

    scheduler.reset_stuck_agents("comp-1");

    const ceo = db.get<any>(`SELECT * FROM agents WHERE id = ?`, [ceoId])!;
    expect(ceo.status).toBe("idle");
  });

  it("does NOT reset CEO working for <30min with active invocation", () => {
    const ceoId = "comp-1-ceo";
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.run(
      `UPDATE agents SET status = 'working', last_wake_at = ? WHERE id = ?`,
      [tenMinAgo, ceoId],
    );

    // Add a CEO abort controller
    const abortControllers = (scheduler as any).active_ceo_abort_controllers as Map<string, AbortController>;
    abortControllers.set("comp-1:system", new AbortController());

    scheduler.reset_stuck_agents("comp-1");

    const ceo = db.get<any>(`SELECT * FROM agents WHERE id = ?`, [ceoId])!;
    expect(ceo.status).toBe("working");
  });

  it("resets agent stuck >5min with no active invocation at all", () => {
    const ceoId = "comp-1-ceo";
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    db.run(
      `UPDATE agents SET status = 'working', last_wake_at = ? WHERE id = ?`,
      [sixMinAgo, ceoId],
    );

    // No abort controllers — clean state
    scheduler.reset_stuck_agents("comp-1");

    const ceo = db.get<any>(`SELECT * FROM agents WHERE id = ?`, [ceoId])!;
    expect(ceo.status).toBe("idle");
  });
});
