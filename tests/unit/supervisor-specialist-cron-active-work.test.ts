import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { CronManager } from "../../supervisor/src/cron.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
import { mkdirSync, rmSync } from "node:fs";
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
      "seo-specialist": {
        id: "seo-specialist", name: "SEO Specialist", role: "seo-specialist",
        title: "SEO Specialist", department: "marketing", reportsTo: "ceo",
        systemPrompt: "You are the SEO specialist.",
        skills: [], workflows: [], requiredTools: [], requiredApiKeys: [],
        mcpServers: [], relayChannels: [], provider: "claude", modelTier: "sonnet",
        estimatedCreditsPerDay: 50, tested: true, version: "1.0.0", description: "SEO agent",
      },
    };
    return blueprints[id] ?? null;
  }),
  getAllBlueprints: vi.fn(() => []),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"],
  isSpecialistBlueprint: vi.fn((id: string) => id === "seo-specialist"),
  SPECIALIST_BLUEPRINTS: new Set(["seo-specialist"]),
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
      output: "Cron task output",
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

// ─── Specialist cron fires even without active work ─────────────

describe("Specialist self-update crons fire when no active work", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `specialist-cron-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
    mkdirSync(join(workspaceDir, "docs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("specialist agent cron fires even when has_active_work() returns false", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspaceDir);
    const scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    const cron = new CronManager(db, taskManager, creditManager, invoker, scheduler, config);

    seedCompanyAndCeo(db, workspaceDir);

    // All milestones done, all tasks done — has_active_work() returns false
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, status, sort_order, created_by, created_at, completed_at)
       VALUES (?, ?, 'Phase 1', 'done', 0, 'ceo', ?, ?)`,
      ["ms-1", "comp-1", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, status, credits_spent, turns_spent, created_by, created_at)
       VALUES (?, ?, ?, 'Task 1', 'Test', '[]', '[]', 'done', 0, 0, 'ceo', ?)`,
      ["task-1", "comp-1", "ms-1", now],
    );

    // Add an idle specialist agent
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
       VALUES (?, ?, 'seo-specialist', 'SEO Specialist', 'seo-specialist', 'idle', 'sonnet', 0, ?, ?)`,
      ["agent-seo", "comp-1", now, now],
    );

    // Add a cron task for the specialist agent — use every-minute schedule to guarantee it's due
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, title, prompt, schedule, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ceo', ?)`,
      ["cron-seo", "comp-1", "agent-seo", "SEO Self-Update", "Run daily SEO self-update", "*/1 * * * *", yesterday, now],
    );

    // Confirm no active work
    expect(taskManager.has_active_work("comp-1")).toBe(false);

    await cron.schedule_cron_tasks("comp-1");

    // Specialist cron should have been invoked despite no active work
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("non-specialist agent cron is still blocked when has_active_work() is false", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspaceDir);
    const scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    const cron = new CronManager(db, taskManager, creditManager, invoker, scheduler, config);

    seedCompanyAndCeo(db, workspaceDir);

    // All milestones and tasks done
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, status, sort_order, created_by, created_at, completed_at)
       VALUES (?, ?, 'Phase 1', 'done', 0, 'ceo', ?, ?)`,
      ["ms-1", "comp-1", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, status, credits_spent, turns_spent, created_by, created_at)
       VALUES (?, ?, ?, 'Task 1', 'Test', '[]', '[]', 'done', 0, 0, 'ceo', ?)`,
      ["task-1", "comp-1", "ms-1", now],
    );

    // Add a non-specialist agent with a cron
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
       VALUES (?, ?, 'frontend-dev', 'Dev', 'developer', 'idle', 'sonnet', 0, ?, ?)`,
      ["agent-dev", "comp-1", now, now],
    );
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, title, prompt, schedule, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ceo', ?)`,
      ["cron-dev", "comp-1", "agent-dev", "Dev Check", "Run dev check", "*/1 * * * *", yesterday, now],
    );

    expect(taskManager.has_active_work("comp-1")).toBe(false);

    await cron.schedule_cron_tasks("comp-1");

    // Non-specialist cron should NOT have been invoked
    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("when has_active_work() is true, all crons (specialist + non-specialist) fire", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspaceDir);
    const scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    const cron = new CronManager(db, taskManager, creditManager, invoker, scheduler, config);

    seedCompanyAndCeo(db, workspaceDir);

    // Active milestone and task — has_active_work() returns true
    const now = isoNow();
    db.run(
      `INSERT INTO milestones (id, company_id, title, status, sort_order, created_by, created_at)
       VALUES (?, ?, 'Phase 1', 'active', 0, 'ceo', ?)`,
      ["ms-1", "comp-1", now],
    );
    db.run(
      `INSERT INTO tasks (id, company_id, milestone_id, title, description, acceptance_criteria, depends_on, status, credits_spent, turns_spent, owner_agent_id, created_by, created_at)
       VALUES (?, ?, ?, 'Active task', 'Test', '[]', '[]', 'in_progress', 0, 0, 'comp-1-ceo', 'ceo', ?)`,
      ["task-1", "comp-1", "ms-1", now],
    );

    // Specialist agent + cron
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
       VALUES (?, ?, 'seo-specialist', 'SEO Specialist', 'seo-specialist', 'idle', 'sonnet', 0, ?, ?)`,
      ["agent-seo", "comp-1", now, now],
    );
    // Non-specialist agent + cron
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
       VALUES (?, ?, 'frontend-dev', 'Dev', 'developer', 'idle', 'sonnet', 0, ?, ?)`,
      ["agent-dev", "comp-1", now, now],
    );

    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, title, prompt, schedule, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ceo', ?)`,
      ["cron-seo", "comp-1", "agent-seo", "SEO Update", "SEO self-update", "*/1 * * * *", yesterday, now],
    );
    db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, title, prompt, schedule, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ceo', ?)`,
      ["cron-dev", "comp-1", "agent-dev", "Dev Check", "Run dev check", "*/1 * * * *", yesterday, now],
    );

    expect(taskManager.has_active_work("comp-1")).toBe(true);

    await cron.schedule_cron_tasks("comp-1");

    // Both crons should fire when there's active work
    // Note: invoke_cron internally calls scheduler.schedule() which may trigger
    // additional agent invocations. We check that invoke was called at least 2 times.
    expect((invoker.invoke as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── CEO task enforcement is per-company, no cross-company bleed ─────────

describe("CEO task enforcement per-company (no cross-company bleed)", () => {
  let workspaceDir1: string;
  let workspaceDir2: string;

  beforeEach(() => {
    workspaceDir1 = join(tmpdir(), `enforce-co1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspaceDir2 = join(tmpdir(), `enforce-co2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(workspaceDir1, ".agent"), { recursive: true });
    mkdirSync(join(workspaceDir2, ".agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir1, { recursive: true, force: true });
    rmSync(workspaceDir2, { recursive: true, force: true });
  });

  it("plan_update from company A does not suppress enforcement for company B", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspaceDir1);

    let invokeCount = 0;
    const invoker: AgentInvoker = {
      invoke: vi.fn(async (_agent, _prompt, workspaceDir) => {
        invokeCount++;
        // Company 1's first turn writes plan_update.json
        if (invokeCount === 1 && workspaceDir === workspaceDir1) {
          const { mkdirSync: mkSync, writeFileSync: writeSync } = await import("node:fs");
          const agentDir = join(workspaceDir, ".agent");
          mkSync(agentDir, { recursive: true });
          writeSync(
            join(agentDir, "plan_update.json"),
            JSON.stringify({ add_tasks: [{ title: "Task from Co1", description: "test", milestone_id: "ms-1a" }] }),
          );
        }
        // Company 2's first turn does NOT write plan_update.json
        return {
          success: true,
          output: "Sure, I'll handle that.",
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          toolCallCount: 0,
          durationMs: 1000,
          aborted: false,
        };
      }),
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

    const scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);

    // Seed company 1
    const now = isoNow();
    db.run(
      `INSERT INTO companies (id, user_id, name, goal, state, workspace_dir, container_id, mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, 'container-1', 'autonomous', ?, ?)`,
      ["comp-1", "user-1", "Co1", "Goal 1", workspaceDir1, now, now],
    );
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
       VALUES (?, ?, 'ceo', 'CEO', 'ceo', 'idle', 'sonnet', 0, ?, ?)`,
      ["comp-1-ceo", "comp-1", now, now],
    );
    db.run(
      `INSERT INTO milestones (id, company_id, title, status, sort_order, created_by, created_at)
       VALUES (?, ?, 'Phase 1', 'active', 0, 'ceo', ?)`,
      ["ms-1a", "comp-1", now],
    );

    // Seed company 2
    db.run(
      `INSERT INTO companies (id, user_id, name, goal, state, workspace_dir, container_id, mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, 'container-2', 'autonomous', ?, ?)`,
      ["comp-2", "user-1", "Co2", "Goal 2", workspaceDir2, now, now],
    );
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
       VALUES (?, ?, 'ceo', 'CEO', 'ceo', 'idle', 'sonnet', 0, ?, ?)`,
      ["comp-2-ceo", "comp-2", now, now],
    );
    db.run(
      `INSERT INTO milestones (id, company_id, title, status, sort_order, created_by, created_at)
       VALUES (?, ?, 'Phase 1', 'active', 0, 'ceo', ?)`,
      ["ms-2a", "comp-2", now],
    );

    // Seed credits
    db.run(
      `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
       VALUES (?, 10000, 0, ?)`,
      ["user-1", now],
    );

    // Company 1: work request, CEO writes plan_update.json → no enforcement
    await scheduler.on_user_message("comp-1", "build me a landing page");

    // Company 2: work request, CEO does NOT write plan_update.json → should fire enforcement
    // The bug was that company 1's plan_update set the shared boolean to true,
    // which prevented enforcement for company 2
    invokeCount = 0; // Reset for clarity
    await scheduler.on_user_message("comp-2", "create a pricing page");

    // Company 2 should have 2 invoke calls: initial + enforcement
    // Filter calls by workspace dir to confirm
    const comp2Calls = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[2] === workspaceDir2,
    );
    expect(comp2Calls.length).toBe(2);

    // Second call for comp-2 should be enforcement
    const enforcementPrompt = comp2Calls[1][1] as string;
    expect(enforcementPrompt).toContain("MUST write");
  });
});

// ─── Enforcement fires at most once per user message ─────────────

describe("Enforcement fires at most once per user message", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `enforce-once-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("enforcement turn does NOT trigger a second enforcement turn", async () => {
    const db = createTestDb();
    const config = createTestConfig();
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspaceDir);

    // Neither call writes plan_update.json — without the guard, this could
    // loop (enforcement responds without plan_update → triggers another enforcement)
    const invoker: AgentInvoker = {
      invoke: vi.fn(async () => ({
        success: true,
        output: "I'll get right on that.",
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

    const scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);

    seedCompanyAndCeo(db, workspaceDir);
    db.run(
      `INSERT INTO milestones (id, company_id, title, status, sort_order, created_by, created_at)
       VALUES (?, ?, 'Phase 1', 'active', 0, 'ceo', ?)`,
      ["ms-1", "comp-1", isoNow()],
    );

    await scheduler.on_user_message("comp-1", "build me a dashboard");

    // Should be exactly 2 calls: initial user-facing turn + enforcement turn
    // NOT 3 (which would mean enforcement triggered another enforcement)
    expect(invoker.invoke).toHaveBeenCalledTimes(2);
  });
});
