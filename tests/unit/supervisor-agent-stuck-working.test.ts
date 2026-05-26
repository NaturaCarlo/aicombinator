import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import { AgentRunner, type AgentRunnerCallbacks } from "../../supervisor/src/agent-runner.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig, AgentRow, TaskRow } from "../../supervisor/src/types.ts";
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
      "frontend-dev": {
        id: "frontend-dev", name: "Frontend Developer", role: "frontend-dev", title: "Frontend Developer",
        department: "engineering", reportsTo: "cto", systemPrompt: "You are a frontend dev.",
        skills: [], workflows: [], requiredTools: [], requiredApiKeys: [],
        mcpServers: [], relayChannels: [], provider: "claude", modelTier: "sonnet",
        estimatedCreditsPerDay: 80, tested: true, version: "1.0.0", description: "Frontend dev",
      },
    };
    return blueprints[id] ?? null;
  }),
  getAllBlueprints: vi.fn(() => []),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"],
  ENGINEERING_SUPERPOWERS: "",
  QA_SUPERPOWERS: "",
}));

// Mock routing
vi.mock("../../supervisor/src/routing.ts", () => ({
  canAssignTo: vi.fn(() => true),
  getReportTarget: vi.fn(() => undefined),
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
      output: "Agent response here",
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

function setupCompanyWithAgent(db: SupervisorDb, workspaceDir: string) {
  // Insert user with credits
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES ('user-1', 10000, 0, datetime('now'))`,
  );

  // Insert company
  db.run(
    `INSERT INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
     VALUES ('company-1', 'user-1', 'Test Co', 'Build stuff', 'running', ?, datetime('now'), datetime('now'))`,
    [workspaceDir],
  );

  // Insert agent
  db.run(
    `INSERT INTO agents (id, company_id, name, role, title, blueprint_id, model_tier, status, total_credits, created_at, updated_at)
     VALUES ('agent-1', 'company-1', 'Frontend Dev', 'frontend-dev', 'Frontend Developer', 'frontend-dev', 'sonnet', 'idle', 0, datetime('now'), datetime('now'))`,
  );

  // Insert CEO agent
  db.run(
    `INSERT INTO agents (id, company_id, name, role, title, blueprint_id, model_tier, status, total_credits, created_at, updated_at)
     VALUES ('ceo-1', 'company-1', 'CEO', 'ceo', 'Chief Executive Officer', 'ceo', 'sonnet', 'idle', 0, datetime('now'), datetime('now'))`,
  );

  // Insert milestone
  db.run(
    `INSERT INTO milestones (id, company_id, title, description, status, sort_order, created_by, created_at)
     VALUES ('ms-1', 'company-1', 'Milestone 1', 'Test milestone', 'active', 0, 'system', datetime('now'))`,
  );

  // Insert task
  db.run(
    `INSERT INTO tasks (id, company_id, milestone_id, title, description, status, owner_agent_id, acceptance_criteria, turns_spent, credits_spent, created_by, created_at)
     VALUES ('task-1', 'company-1', 'ms-1', 'Build landing page', 'Build it', 'ready', 'agent-1', '[]', 0, 0, 'system', datetime('now'))`,
  );

  mkdirSync(join(workspaceDir, ".agent", "agent-1"), { recursive: true });
  mkdirSync(join(workspaceDir, "docs"), { recursive: true });
  writeFileSync(join(workspaceDir, "docs", "mission.md"), "Test mission content that is long enough to pass word count validation with at least the minimum required words for the document budget check to accept it as valid content for the mission statement of the company and its goals and objectives for the foreseeable future.");
}

// ─── BUG 1: Timeout should abort the controller ─────────────────

describe("BUG 1: ClaudeCodeAdapter timeout aborts controller", () => {
  it("timeout() fires abortController.abort() when time expires", async () => {
    // We test the ClaudeCodeAdapter's timeout method by importing it and checking behavior.
    // The adapter is in claude-code.ts - we need to test that the timeout method
    // calls abort() on the provided abort controller.
    
    // Import the adapter class
    const { ClaudeCodeAdapter } = await import("../../supervisor/src/adapters/claude-code.ts");
    
    const config = {
      anthropicApiKey: "test-key",
      internalApiKey: "test-internal-key",
    } as SupervisorConfig;
    
    const adapter = new ClaudeCodeAdapter(config);
    
    // Access the private timeout method via prototype
    const timeoutFn = (adapter as any).timeout.bind(adapter);
    
    const abortController = new AbortController();
    expect(abortController.signal.aborted).toBe(false);
    
    // Call timeout with a very short delay and an abort controller
    const { promise, clear } = timeoutFn(50, abortController);
    
    // Wait for it to reject
    await expect(promise).rejects.toThrow("Agent turn timed out after 50ms");
    
    // The abort controller should have been aborted
    expect(abortController.signal.aborted).toBe(true);
  });

  it("timeout() without abort controller still rejects", async () => {
    const { ClaudeCodeAdapter } = await import("../../supervisor/src/adapters/claude-code.ts");
    
    const config = {
      anthropicApiKey: "test-key",
      internalApiKey: "test-internal-key",
    } as SupervisorConfig;
    
    const adapter = new ClaudeCodeAdapter(config);
    const timeoutFn = (adapter as any).timeout.bind(adapter);
    
    // Call timeout without an abort controller (backward compat)
    const { promise } = timeoutFn(50);
    await expect(promise).rejects.toThrow("Agent turn timed out after 50ms");
  });

  it("invoke() passes abortController to timeout for Anthropic models", async () => {
    // This test verifies that when timeout fires during invoke(),
    // the abort controller is properly signaled
    const { ClaudeCodeAdapter } = await import("../../supervisor/src/adapters/claude-code.ts");
    
    const config = {
      anthropicApiKey: "test-key",
      internalApiKey: "test-internal-key",
    } as SupervisorConfig;
    
    const adapter = new ClaudeCodeAdapter(config);
    
    // Mock runClaudeCode to hang forever (simulating stuck process)
    (adapter as any).runClaudeCode = vi.fn(() => new Promise(() => {})); // never resolves
    
    const abortController = new AbortController();
    const agent = {
      id: "agent-1",
      name: "Test Agent",
      role: "frontend-dev",
      model_tier: "sonnet",
      blueprint_id: "frontend-dev",
    } as AgentRow;
    
    const result = await adapter.invoke(agent, "test prompt", "/tmp/test", {
      abortController,
      turnLimits: { turnTimeoutMs: 100 },
    });
    
    // After timeout, the abort controller should be aborted
    expect(abortController.signal.aborted).toBe(true);
    // The result should indicate failure
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});

// ─── BUG 2: Abort controller released before on_agent_turn_finished ──

describe("BUG 2: Abort controller released before post-turn processing", () => {
  let db: SupervisorDb;
  let workspaceDir: string;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockInvoker: AgentInvoker;
  let runner: AgentRunner;
  let callbacks: AgentRunnerCallbacks;
  let onAgentTurnFinishedCalled: boolean;
  let abortControllerPresentDuringCallback: boolean;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `test-stuck-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });

    db = createTestDb();
    setupCompanyWithAgent(db, workspaceDir);
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockInvoker = createMockInvoker();
    onAgentTurnFinishedCalled = false;
    abortControllerPresentDuringCallback = false;

    callbacks = {
      on_task_completed: vi.fn(async () => {}),
      notify_ceo: vi.fn(async () => {}),
      notify_manager: vi.fn(async () => {}),
      process_subtask_request: vi.fn(async () => {}),
      pause_company: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
    };

    runner = new AgentRunner(db, taskManager, creditManager, mockInvoker, callbacks);
  });

  it("abort controller is NOT in active_abort_controllers when on_agent_turn_finished runs", async () => {
    // Spy on on_agent_turn_finished to check abort controller state during execution
    const originalFn = (runner as any).on_agent_turn_finished.bind(runner);
    (runner as any).on_agent_turn_finished = vi.fn(async (...args: any[]) => {
      onAgentTurnFinishedCalled = true;
      abortControllerPresentDuringCallback = runner.has_active_invocation("agent-1");
      return originalFn(...args);
    });

    const agent = taskManager.get_agent("agent-1")!;
    const task = taskManager.get_task("task-1")!;

    await runner.wake_agent(agent, task);

    expect(onAgentTurnFinishedCalled).toBe(true);
    // The abort controller should have been removed BEFORE on_agent_turn_finished
    expect(abortControllerPresentDuringCallback).toBe(false);
  });

  it("abort controller is still removed in finally block as safety net", async () => {
    // Make invoke throw to test that finally block still cleans up
    (mockInvoker.invoke as any).mockRejectedValueOnce(new Error("Invoke failed"));

    const agent = taskManager.get_agent("agent-1")!;
    const task = taskManager.get_task("task-1")!;

    await expect(runner.wake_agent(agent, task)).rejects.toThrow("Invoke failed");
    
    // After the error, the abort controller should NOT be in the map
    expect(runner.has_active_invocation("agent-1")).toBe(false);
  });

  afterEach(() => {
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
  });
});

// ─── BUG 3: Watchdog force-aborts agents stuck >30min ───────────

describe("BUG 3: Watchdog aggressive abort for agents stuck >30min with abort controller", () => {
  let db: SupervisorDb;
  let workspaceDir: string;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockInvoker: AgentInvoker;
  let scheduler: Scheduler;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `test-watchdog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workspaceDir, { recursive: true });

    db = createTestDb();
    setupCompanyWithAgent(db, workspaceDir);
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockInvoker = createMockInvoker();

    const config = createTestConfig();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspaceDir);
    scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, mockInvoker, containerManager);
  });

  it("resets agent stuck >30min even with active abort controller", () => {
    // Put agent in working state with wake_at 31 minutes ago
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    db.run(
      `UPDATE agents SET status = 'working', current_task_id = 'task-1', last_wake_at = ? WHERE id = 'agent-1'`,
      [thirtyOneMinAgo],
    );

    // Simulate that the runner has an active abort controller for this agent
    // We need to get the runner instance from the scheduler
    const runner = (scheduler as any).runner as AgentRunner;
    const fakeAbortController = new AbortController();
    (runner as any).active_abort_controllers.set("agent-1", fakeAbortController);

    // Verify agent is working and has abort controller
    expect(runner.has_active_invocation("agent-1")).toBe(true);
    const agentBefore = taskManager.get_agent("agent-1")!;
    expect(agentBefore.status).toBe("working");

    // Run watchdog
    scheduler.reset_stuck_agents("company-1");

    // Agent should be reset to idle
    const agentAfter = taskManager.get_agent("agent-1")!;
    expect(agentAfter.status).toBe("idle");
    expect(agentAfter.current_task_id).toBeNull();

    // Abort controller should have been called and removed
    expect(fakeAbortController.signal.aborted).toBe(true);
    expect(runner.has_active_invocation("agent-1")).toBe(false);
  });

  it("does NOT reset agent stuck <30min with active abort controller", () => {
    // Put agent in working state with wake_at 10 minutes ago (below 30 min threshold)
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.run(
      `UPDATE agents SET status = 'working', current_task_id = 'task-1', last_wake_at = ? WHERE id = 'agent-1'`,
      [tenMinAgo],
    );

    // Add abort controller
    const runner = (scheduler as any).runner as AgentRunner;
    const fakeAbortController = new AbortController();
    (runner as any).active_abort_controllers.set("agent-1", fakeAbortController);

    // Run watchdog
    scheduler.reset_stuck_agents("company-1");

    // Agent should still be working (not reset)
    const agentAfter = taskManager.get_agent("agent-1")!;
    expect(agentAfter.status).toBe("working");

    // Abort controller should NOT have been aborted
    expect(fakeAbortController.signal.aborted).toBe(false);
  });

  it("still resets agent without abort controller after 5 min (existing behavior)", () => {
    // Put agent in working state with wake_at 6 minutes ago (above 5 min threshold)
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    db.run(
      `UPDATE agents SET status = 'working', current_task_id = 'task-1', last_wake_at = ? WHERE id = 'agent-1'`,
      [sixMinAgo],
    );

    // No abort controller added - agent has no active invocation

    // Run watchdog
    scheduler.reset_stuck_agents("company-1");

    // Agent should be reset (existing behavior preserved)
    const agentAfter = taskManager.get_agent("agent-1")!;
    expect(agentAfter.status).toBe("idle");
    expect(agentAfter.current_task_id).toBeNull();
  });

  afterEach(() => {
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
  });
});
