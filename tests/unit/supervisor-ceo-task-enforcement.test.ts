import { describe, expect, it, vi, beforeEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
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

let invokeCallCount = 0;

function createMockInvoker(opts?: {
  writePlanUpdateOnCall?: number;
  workspaceDir?: string;
}): AgentInvoker {
  invokeCallCount = 0;
  return {
    invoke: vi.fn(async () => {
      invokeCallCount++;
      // Optionally write plan_update.json on a specific call
      if (opts?.writePlanUpdateOnCall === invokeCallCount && opts?.workspaceDir) {
        const agentDir = join(opts.workspaceDir, ".agent");
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(
          join(agentDir, "plan_update.json"),
          JSON.stringify({
            add_tasks: [{ title: "New task from enforcement", description: "Created by enforcement", milestone_id: "ms-1" }],
          }),
        );
      }
      return {
        success: true,
        output: "Sure, I'll get the team on it.",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        toolCallCount: opts?.writePlanUpdateOnCall === invokeCallCount ? 1 : 0,
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
  // Seed a milestone so tasks can be added
  db.run(
    `INSERT INTO milestones (id, company_id, title, status, sort_order, created_by, created_at)
     VALUES (?, ?, 'Phase 1', 'active', 0, 'ceo', ?)`,
    ["ms-1", companyId, now],
  );
  // Seed credits so CEO turns don't fail
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, 10000, 0, ?)`,
    [userId, now],
  );
}

// ─── is_work_request heuristic tests ────────────────────────────

describe("Work request detection heuristic", () => {
  // Import the function we're going to create
  // We'll test it via scheduler behavior, but also test the utility directly

  it("detects 'build me a landing page' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("build me a landing page")).toBe(true);
  });

  it("detects 'can you create a dashboard' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("can you create a dashboard")).toBe(true);
  });

  it("detects 'fix the login bug' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("fix the login bug")).toBe(true);
  });

  it("detects 'add a new feature for notifications' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("add a new feature for notifications")).toBe(true);
  });

  it("detects 'implement user authentication' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("implement user authentication")).toBe(true);
  });

  it("detects 'redesign the homepage' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("redesign the homepage")).toBe(true);
  });

  it("detects 'update the pricing page' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("update the pricing page")).toBe(true);
  });

  it("detects 'make the header sticky' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("make the header sticky")).toBe(true);
  });

  it("detects 'develop an API for payments' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("develop an API for payments")).toBe(true);
  });

  it("detects 'change the color scheme to blue' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("change the color scheme to blue")).toBe(true);
  });

  it("does NOT detect 'what's the status?' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("what's the status?")).toBe(false);
  });

  it("does NOT detect 'how are things going?' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("how are things going?")).toBe(false);
  });

  it("does NOT detect 'hi' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("hi")).toBe(false);
  });

  it("does NOT detect 'good morning' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("good morning")).toBe(false);
  });

  it("does NOT detect 'thanks for the update' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("thanks for the update")).toBe(false);
  });

  it("does NOT detect 'show me the current tasks' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("show me the current tasks")).toBe(false);
  });

  it("does NOT detect 'who is working on what?' as a work request", async () => {
    const { is_work_request } = await import("../../supervisor/src/scheduler.ts");
    expect(is_work_request("who is working on what?")).toBe(false);
  });
});

// ─── Enforcement: follow-up turn when work request doesn't create tasks ─────

describe("CEO task creation enforcement", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `ceo-task-enforcement-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(workspaceDir, ".agent"), { recursive: true });
    invokeCallCount = 0;
  });

  it("fires a follow-up CEO turn when work request doesn't produce plan_update.json", async () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, workspaceDir);
    const invoker = createMockInvoker({ writePlanUpdateOnCall: 2, workspaceDir });
    const config = createTestConfig();

    const tm = new TaskManager(db);
    const cm = new CreditManager(db);
    const syncManager = createMockSyncManager();
    const scheduler = new Scheduler(db, config, tm, cm, syncManager, invoker, createMockContainerManager(workspaceDir));

    // First call: CEO responds without creating plan_update.json
    // Second call (enforcement): CEO writes plan_update.json
    const reply = await scheduler.on_user_message("comp-1", "build me a landing page");
    
    // The invoker should have been called twice: once for the initial turn, once for enforcement
    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    
    // The second call's prompt should contain enforcement language
    const secondCallPrompt = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(secondCallPrompt).toContain("MUST write");
    expect(secondCallPrompt).toContain("plan_update.json");

    expect(reply).toBeTruthy();
  });

  it("does NOT fire follow-up when CEO properly creates plan_update.json on first turn", async () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, workspaceDir);
    // Write plan_update.json on the FIRST call
    const invoker = createMockInvoker({ writePlanUpdateOnCall: 1, workspaceDir });
    const config = createTestConfig();

    const tm = new TaskManager(db);
    const cm = new CreditManager(db);
    const syncManager = createMockSyncManager();
    const scheduler = new Scheduler(db, config, tm, cm, syncManager, invoker, createMockContainerManager(workspaceDir));

    const reply = await scheduler.on_user_message("comp-1", "build me a landing page");
    
    // Only one call — no enforcement needed
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    expect(reply).toBeTruthy();
  });

  it("does NOT fire follow-up for non-work-request messages", async () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, workspaceDir);
    const invoker = createMockInvoker();
    const config = createTestConfig();

    const tm = new TaskManager(db);
    const cm = new CreditManager(db);
    const syncManager = createMockSyncManager();
    const scheduler = new Scheduler(db, config, tm, cm, syncManager, invoker, createMockContainerManager(workspaceDir));

    const reply = await scheduler.on_user_message("comp-1", "what's the status?");
    
    // Only one call — no enforcement for status checks
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    expect(reply).toBeTruthy();
  });

  it("does NOT fire follow-up for casual chat", async () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, workspaceDir);
    const invoker = createMockInvoker();
    const config = createTestConfig();

    const tm = new TaskManager(db);
    const cm = new CreditManager(db);
    const syncManager = createMockSyncManager();
    const scheduler = new Scheduler(db, config, tm, cm, syncManager, invoker, createMockContainerManager(workspaceDir));

    const reply = await scheduler.on_user_message("comp-1", "hey, how are things?");
    
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    expect(reply).toBeTruthy();
  });

  it("logs a warning when work request doesn't produce plan_update.json", async () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, workspaceDir);
    const invoker = createMockInvoker({ writePlanUpdateOnCall: 2, workspaceDir });
    const config = createTestConfig();

    const tm = new TaskManager(db);
    const cm = new CreditManager(db);
    const syncManager = createMockSyncManager();
    const scheduler = new Scheduler(db, config, tm, cm, syncManager, invoker, createMockContainerManager(workspaceDir));

    const warnSpy = vi.spyOn(console, "warn");

    await scheduler.on_user_message("comp-1", "create a user registration system");

    // Should have logged a warning about the missed task creation
    const warningCalls = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("work request") && call[0].includes("plan_update"),
    );
    expect(warningCalls.length).toBeGreaterThanOrEqual(1);

    warnSpy.mockRestore();
  });

  it("enforcement works in streaming variant too", async () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, workspaceDir);
    const invoker = createMockInvoker({ writePlanUpdateOnCall: 2, workspaceDir });
    const config = createTestConfig();

    const tm = new TaskManager(db);
    const cm = new CreditManager(db);
    const syncManager = createMockSyncManager();
    const scheduler = new Scheduler(db, config, tm, cm, syncManager, invoker, createMockContainerManager(workspaceDir));

    const result = await scheduler.on_user_message_stream(
      "comp-1",
      "add a dark mode toggle",
      { onTextDelta: vi.fn() },
    );

    // The invoker should have been called twice: initial + enforcement
    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    expect(result.reply).toBeTruthy();
  });

  it("does NOT fire enforcement during planning state", async () => {
    const db = createTestDb();
    seedCompanyAndCeo(db, workspaceDir);
    // Set company to planning state
    db.run(`UPDATE companies SET state = 'planning' WHERE id = 'comp-1'`);
    const invoker = createMockInvoker();
    const config = createTestConfig();

    const tm = new TaskManager(db);
    const cm = new CreditManager(db);
    const syncManager = createMockSyncManager();
    const scheduler = new Scheduler(db, config, tm, cm, syncManager, invoker, createMockContainerManager(workspaceDir));

    const reply = await scheduler.on_user_message("comp-1", "build me something cool");
    
    // Planning state skips process_ceo_response entirely, so no enforcement
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    expect(reply).toBeTruthy();
  });
});
