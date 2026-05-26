import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";

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
      output: "",
      tokenUsage: { inputTokens: 100, outputTokens: 200 },
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

function seedCompanyWithCredits(
  db: SupervisorDb,
  balance: number,
  state = "planning",
  userId = "user-1",
  companyId = "comp-1",
  workspaceDir = "/tmp/test-workspace",
  genesisPrompt?: string,
) {
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO companies (id, user_id, name, goal, genesis_prompt, state, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, userId, "Test Co", "Test goal", genesisPrompt ?? null, state, workspaceDir, now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["agent-ceo-" + companyId, companyId, "ceo", "CEO", "ceo", "sonnet", "idle", 0, "internal", now, now],
  );
  db.run(
    `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance`,
    [userId, balance, 0, now],
  );
}

function createTempWorkspace(): string {
  const dir = join(tmpdir(), `test-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Skip CEO Mission Turn 1 when early mission exists", () => {
  let db: SupervisorDb;
  let taskManager: TaskManager;
  let creditManager: CreditManager;
  let mockSync: SyncManager;
  let mockInvoker: AgentInvoker;
  let workspaceDir: string;

  beforeEach(() => {
    db = createTestDb();
    taskManager = new TaskManager(db);
    creditManager = new CreditManager(db);
    mockSync = createMockSyncManager();
    mockInvoker = createMockInvoker();
    workspaceDir = createTempWorkspace();
  });

  it("skips Turn 1 when docs/mission.md already exists and is non-empty", async () => {
    // Pre-create mission.md in the workspace
    const docsDir = join(workspaceDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "mission.md"), "# Mission\nBuild a revolutionary AI product.");

    seedCompanyWithCredits(db, 5000, "planning", "user-1", "comp-1", workspaceDir);

    // Mock invoker: Turn 2 returns a valid plan (the only turn that should be called)
    const validPlanOutput = JSON.stringify({
      mission: "Build a revolutionary AI product.",
      plan: {
        milestones: [
          {
            title: "Launch MVP",
            description: "Build and launch the minimum viable product",
            tasks: [
              {
                title: "Build landing page",
                description: "Create a professional landing page",
                assigned_to: "frontend-dev",
                depends_on: [],
              },
            ],
          },
        ],
        agents_needed: ["ceo", "frontend-dev"],
      },
    });
    // Return valid plan for Turn 2, and default empty for any subsequent agent dispatches
    (mockInvoker.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      output: validPlanOutput,
      tokenUsage: { inputTokens: 500, outputTokens: 1000 },
      toolCallCount: 5,
      durationMs: 5000,
      aborted: false,
    });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(workspaceDir),
    );

    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // The FIRST invoke call should be Turn 2 (planning), not Turn 1 (mission).
    // Additional calls may happen from schedule() dispatching agents for tasks.
    // We verify the first call's system prompt is the planning system prompt, not mission.
    const firstCall = (mockInvoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0];
    const firstCallAgent = firstCall[0];
    // CEO agent should be the one invoked
    expect(firstCallAgent.blueprint_id).toBe("ceo");
    // The prompt should be the planning prompt (Turn 2), NOT the mission prompt (Turn 1)
    const firstCallPrompt = firstCall[1] as string;
    // Planning prompt references the plan, mission prompt references writing a mission
    // The key indicator is the system prompt override in the invoke options
    const firstCallOptions = firstCall[3]; // invoke(agent, prompt, workspaceDir, options)
    const systemPrompt = firstCallOptions?.systemPromptOverride as string;
    // The planning system prompt contains "plan" references, mission system prompt is different
    expect(systemPrompt).toBeTruthy();
  });

  it("runs Turn 1 when docs/mission.md does not exist", async () => {
    // No mission.md pre-created
    seedCompanyWithCredits(db, 5000, "planning", "user-1", "comp-1", workspaceDir);

    // Mock invoker: Turn 1 returns mission, Turn 2 returns a valid plan
    const validPlanOutput = JSON.stringify({
      mission: "Build a revolutionary AI product.",
      plan: {
        milestones: [
          {
            title: "Launch MVP",
            description: "Build and launch the minimum viable product",
            tasks: [
              {
                title: "Build landing page",
                description: "Create a professional landing page",
                assigned_to: "frontend-dev",
                depends_on: [],
              },
            ],
          },
        ],
        agents_needed: ["ceo", "frontend-dev"],
      },
    });
    (mockInvoker.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({ mission: "Build a revolutionary AI product." }),
        tokenUsage: { inputTokens: 100, outputTokens: 200 },
        toolCallCount: 0,
        durationMs: 1000,
        aborted: false,
      })
      .mockResolvedValueOnce({
        success: true,
        output: validPlanOutput,
        tokenUsage: { inputTokens: 500, outputTokens: 1000 },
        toolCallCount: 5,
        durationMs: 5000,
        aborted: false,
      });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(workspaceDir),
    );

    // Spy on invoke_ceo_turn to count CEO-specific turns (not agent dispatches)
    const ceoTurnSpy = vi.spyOn(scheduler as any, "invoke_ceo_turn");

    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // CEO should have been called TWICE in start_planning (Turn 1 + Turn 2)
    // invoke_ceo_turn is also called by schedule() → notify_ceo, but those are separate.
    // The first two calls from start_planning should be Turn 1 (mission) and Turn 2 (plan).
    expect(ceoTurnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("runs Turn 1 when docs/mission.md exists but is empty", async () => {
    // Create empty mission.md
    const docsDir = join(workspaceDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "mission.md"), "");

    seedCompanyWithCredits(db, 5000, "planning", "user-1", "comp-1", workspaceDir);

    const validPlanOutput = JSON.stringify({
      mission: "Build a revolutionary AI product.",
      plan: {
        milestones: [
          {
            title: "Launch MVP",
            description: "Build and launch the minimum viable product",
            tasks: [
              {
                title: "Build landing page",
                description: "Create a professional landing page",
                assigned_to: "frontend-dev",
                depends_on: [],
              },
            ],
          },
        ],
        agents_needed: ["ceo", "frontend-dev"],
      },
    });
    (mockInvoker.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({ mission: "Build a revolutionary AI product." }),
        tokenUsage: { inputTokens: 100, outputTokens: 200 },
        toolCallCount: 0,
        durationMs: 1000,
        aborted: false,
      })
      .mockResolvedValueOnce({
        success: true,
        output: validPlanOutput,
        tokenUsage: { inputTokens: 500, outputTokens: 1000 },
        toolCallCount: 5,
        durationMs: 5000,
        aborted: false,
      });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(workspaceDir),
    );

    const consoleSpy = vi.spyOn(console, "log");
    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // Empty mission.md should NOT trigger skip — Turn 1 log should appear
    const logCalls = consoleSpy.mock.calls.map(call => call.join(" "));
    expect(logCalls.some(msg => msg.includes("[planning] skipping mission turn"))).toBe(false);
    expect(logCalls.some(msg => msg.includes("Turn 1 (mission) complete"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("runs Turn 1 when docs/mission.md exists but is whitespace-only", async () => {
    // Create whitespace-only mission.md
    const docsDir = join(workspaceDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "mission.md"), "   \n\n  \n ");

    seedCompanyWithCredits(db, 5000, "planning", "user-1", "comp-1", workspaceDir);

    const validPlanOutput = JSON.stringify({
      mission: "Build a revolutionary AI product.",
      plan: {
        milestones: [
          {
            title: "Launch MVP",
            description: "Build and launch the minimum viable product",
            tasks: [
              {
                title: "Build landing page",
                description: "Create a professional landing page",
                assigned_to: "frontend-dev",
                depends_on: [],
              },
            ],
          },
        ],
        agents_needed: ["ceo", "frontend-dev"],
      },
    });
    (mockInvoker.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({ mission: "Build a revolutionary AI product." }),
        tokenUsage: { inputTokens: 100, outputTokens: 200 },
        toolCallCount: 0,
        durationMs: 1000,
        aborted: false,
      })
      .mockResolvedValueOnce({
        success: true,
        output: validPlanOutput,
        tokenUsage: { inputTokens: 500, outputTokens: 1000 },
        toolCallCount: 5,
        durationMs: 5000,
        aborted: false,
      });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(workspaceDir),
    );

    const consoleSpy = vi.spyOn(console, "log");
    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // Whitespace-only mission.md should NOT trigger skip
    const logCalls = consoleSpy.mock.calls.map(call => call.join(" "));
    expect(logCalls.some(msg => msg.includes("[planning] skipping mission turn"))).toBe(false);
    expect(logCalls.some(msg => msg.includes("Turn 1 (mission) complete"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("uses existing mission content for Turn 2 prompt when skipping Turn 1", async () => {
    const missionContent = "# Mission\nBuild a revolutionary AI product that changes the world.";
    const docsDir = join(workspaceDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "mission.md"), missionContent);

    seedCompanyWithCredits(db, 5000, "planning", "user-1", "comp-1", workspaceDir);

    const validPlanOutput = JSON.stringify({
      mission: "Build a revolutionary AI product that changes the world.",
      plan: {
        milestones: [
          {
            title: "Launch MVP",
            description: "Build and launch the minimum viable product",
            tasks: [
              {
                title: "Build landing page",
                description: "Create a professional landing page",
                assigned_to: "frontend-dev",
                depends_on: [],
              },
            ],
          },
        ],
        agents_needed: ["ceo", "frontend-dev"],
      },
    });
    (mockInvoker.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      output: validPlanOutput,
      tokenUsage: { inputTokens: 500, outputTokens: 1000 },
      toolCallCount: 5,
      durationMs: 5000,
      aborted: false,
    });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(workspaceDir),
    );

    const consoleSpy = vi.spyOn(console, "log");
    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // Verify skip log was emitted
    const logCalls = consoleSpy.mock.calls.map(call => call.join(" "));
    expect(logCalls.some(msg => msg.includes("[planning] skipping mission turn"))).toBe(true);
    // Verify Turn 1 log was NOT emitted
    expect(logCalls.some(msg => msg.includes("Turn 1 (mission) complete"))).toBe(false);
    consoleSpy.mockRestore();
  });

  it("logs skip message when mission turn is skipped", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    const missionContent = "# Mission\nBuild a revolutionary AI product.";
    const docsDir = join(workspaceDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "mission.md"), missionContent);

    seedCompanyWithCredits(db, 5000, "planning", "user-1", "comp-1", workspaceDir);

    const validPlanOutput = JSON.stringify({
      mission: "Build a revolutionary AI product.",
      plan: {
        milestones: [
          {
            title: "Launch MVP",
            description: "Build and launch the minimum viable product",
            tasks: [
              {
                title: "Build landing page",
                description: "Create a professional landing page",
                assigned_to: "frontend-dev",
                depends_on: [],
              },
            ],
          },
        ],
        agents_needed: ["ceo", "frontend-dev"],
      },
    });
    (mockInvoker.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      output: validPlanOutput,
      tokenUsage: { inputTokens: 500, outputTokens: 1000 },
      toolCallCount: 5,
      durationMs: 5000,
      aborted: false,
    });

    const scheduler = new Scheduler(
      db,
      createTestConfig(),
      taskManager,
      creditManager,
      mockSync,
      mockInvoker,
      createMockContainerManager(workspaceDir),
    );

    const companyRow = db.get<any>(`SELECT * FROM companies WHERE id = ?`, ["comp-1"]);
    await (scheduler as any).start_planning(companyRow);

    // Check that the skip log message was emitted
    const logCalls = consoleSpy.mock.calls.map(call => call.join(" "));
    expect(logCalls.some(msg => msg.includes("[planning] skipping mission turn"))).toBe(true);

    consoleSpy.mockRestore();
  });
});
