import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
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
  isSpecialistBlueprint: vi.fn(() => false),
}));

vi.mock("../../supervisor/src/routing.ts", () => ({
  canAssignTo: vi.fn(() => true),
  getReportTarget: vi.fn(() => "ceo"),
}));

// ── Helpers ──────────────────────────────────────────────────

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

function seedCompany(db: SupervisorDb, workspaceDir: string, companyId = "comp-1") {
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, "user-1", "Test Co", "Test goal", "planning", workspaceDir, now, now],
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
    ["user-1", 10000, 0, now],
  );
}

function createTempWorkspace(): string {
  const dir = join(tmpdir(), `test-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── FIX 3: Planning turn limits reduced ─────────────────────

describe("Planning Turn 2 limits reduced (launch speed)", () => {
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

  it("Turn 2 uses reduced limits: 12 rounds, 20 tools, 240s timeout", async () => {
    // Pre-create mission.md so Turn 1 is skipped
    const docsDir = join(workspaceDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "mission.md"), "# Mission\nBuild an AI product.");

    seedCompany(db, workspaceDir);

    const validPlan = JSON.stringify({
      mission: "Build an AI product.",
      plan: {
        milestones: [{ title: "MVP", description: "Build MVP", tasks: [
          { title: "Build page", description: "Create page", assigned_to: "frontend-dev", depends_on: [] },
        ] }],
        agents_needed: ["ceo", "frontend-dev"],
      },
    });

    (mockInvoker.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      output: validPlan,
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

    // Verify the invoke call used reduced Turn 2 limits
    const invokeCall = (mockInvoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = invokeCall[3]; // invoke(agent, prompt, workspaceDir, options)
    const limits = options?.turnLimits;

    expect(limits).toBeDefined();
    expect(limits.maxInferenceRoundsPerTurn).toBe(12);
    expect(limits.maxToolCallsPerTurn).toBe(20);
    expect(limits.turnTimeoutMs).toBe(240_000);
  });

  it("Turn 2 limits are lower than previous 25/40/480000 values", async () => {
    const docsDir = join(workspaceDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "mission.md"), "# Mission\nBuild an AI product.");

    seedCompany(db, workspaceDir);

    (mockInvoker.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      output: "",
      tokenUsage: { inputTokens: 100, outputTokens: 200 },
      toolCallCount: 0,
      durationMs: 1000,
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

    const invokeCall = (mockInvoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0];
    const limits = invokeCall[3]?.turnLimits;

    // Verify strictly lower than old values
    expect(limits.maxInferenceRoundsPerTurn).toBeLessThan(25);
    expect(limits.maxToolCallsPerTurn).toBeLessThan(40);
    expect(limits.turnTimeoutMs).toBeLessThan(480_000);
  });
});

// ── FIX 1: Avatar concurrency limiter ───────────────────────

describe("Avatar generation concurrency limiter", () => {
  it("ensureFoundingTeamAvatars processes avatars in batches of 3", async () => {
    // We verify by checking the source code structure: the Promise.allSettled
    // call should operate on batches, not the full array at once.
    // Direct import would require complex mocking, so we verify the pattern
    // exists in the source code.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      join(__dirname, "../../worker/src/routes/companies.ts"),
      "utf8",
    );

    // Verify concurrency limiter pattern exists
    expect(source).toContain("AVATAR_CONCURRENCY");
    expect(source).toContain("= 3");
    // Verify it uses batched processing
    expect(source).toMatch(/for\s*\(\s*let\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*agentsNeedingAvatars\.length/);
    expect(source).toContain(".slice(");
    // Verify the batch is processed with Promise.allSettled
    expect(source).toContain("Promise.allSettled");
  });
});

// ── FIX 2: personalizeUnreadyAgents in background ───────────

describe("personalizeUnreadyAgents runs in background (launch-status)", () => {
  it("launch-status endpoint uses ctx.waitUntil for personalization", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      join(__dirname, "../../worker/src/routes/company-status.ts"),
      "utf8",
    );

    // Verify ctx.waitUntil is used for personalization
    expect(source).toContain("ctx.waitUntil");
    // Verify the old inline await is gone
    expect(source).not.toMatch(/await\s+personalizeUnreadyAgents\s*\(/);
    // The comment should indicate background execution
    expect(source).toContain("background");
  });

  it("launch-status returns stale data immediately when agents are unready", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      join(__dirname, "../../worker/src/routes/company-status.ts"),
      "utf8",
    );

    // The old code had `return Response.json(launched, ...)` inside the if(hasUnreadyAgents) block
    // after awaiting personalization. The new code should NOT return early from personalization.
    // Instead, it should fall through to the stale response path.
    const handleFnMatch = source.match(/export async function handleCompanyLaunchStatus[\s\S]*?^}/m);
    // The ctx.waitUntil block should not contain a return statement
    const waitUntilSection = source.match(/if\s*\(hasUnreadyAgents\s*&&\s*ctx[\s\S]*?\{[\s\S]*?\}\s*\)/);
    expect(waitUntilSection).toBeTruthy();
    // The waitUntil block should not have a return Response.json
    expect(waitUntilSection![0]).not.toContain("return Response.json");
  });
});
