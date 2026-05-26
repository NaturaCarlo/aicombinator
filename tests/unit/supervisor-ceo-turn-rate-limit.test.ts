import { describe, expect, it, vi, beforeEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import type { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";
import type { SyncManager } from "../../supervisor/src/sync.ts";
import type { ContainerManager } from "../../supervisor/src/container-manager.ts";
import type { SupervisorConfig } from "../../supervisor/src/types.ts";
import { mkdirSync } from "node:fs";
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

/**
 * Seed N CEO messages in the past hour to simulate recent turns.
 */
function seedRecentCeoMessages(
  db: SupervisorDb,
  companyId: string,
  count: number,
  minutesAgo = 30,
): void {
  for (let i = 0; i < count; i++) {
    const createdAt = new Date(Date.now() - minutesAgo * 60 * 1000 + i * 1000).toISOString();
    db.run(
      `INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
       VALUES (?, ?, ?, 'ceo', ?, ?)`,
      [`msg-${i}`, companyId, `${companyId}-ceo`, `CEO message ${i}`, createdAt],
    );
  }
}

// ─── CEO Turn Rate Limit Tests ──────────────────────────────────

describe("CEO turn rate limiting", () => {
  let db: SupervisorDb;
  let scheduler: Scheduler;
  let workspace: string;
  let invoker: AgentInvoker;

  beforeEach(() => {
    db = createTestDb();
    workspace = join(tmpdir(), `ceo-rate-limit-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

  it("allows non-user-facing CEO turns when under the hourly limit", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Seed 5 recent CEO messages (well under limit of 30)
    seedRecentCeoMessages(db, "comp-1", 5);

    const result = await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // The turn should succeed
    expect(result.success).toBe(true);
    expect(invoker.invoke).toHaveBeenCalled();
  });

  it("blocks non-user-facing CEO turns when at or above the hourly limit", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Seed 30 recent CEO messages (at the limit)
    seedRecentCeoMessages(db, "comp-1", 30);

    const result = await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // The turn should be skipped
    expect(result.success).toBe(false);
    expect(result.error).toContain("rate limit");
    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("always allows user-facing turns even when over the hourly limit", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Seed 50 recent CEO messages (well over the limit)
    seedRecentCeoMessages(db, "comp-1", 50);

    const result = await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      is_user_facing: true,
      skip_response_processing: true,
      bill_credits: false,
    });

    // User-facing turns should always be allowed
    expect(result.success).toBe(true);
    expect(invoker.invoke).toHaveBeenCalled();
  });

  it("logs a warning when rate limited", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Seed 35 recent CEO messages (over the limit)
    seedRecentCeoMessages(db, "comp-1", 35);

    const warnSpy = vi.spyOn(console, "warn");

    await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // Should log a warning about rate limiting
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("CEO turn rate limited"),
    );
    warnSpy.mockRestore();
  });

  it("does not count messages older than 1 hour", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Seed 35 CEO messages from 2 hours ago (should not count)
    for (let i = 0; i < 35; i++) {
      const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      db.run(
        `INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
         VALUES (?, ?, ?, 'ceo', ?, ?)`,
        [`msg-old-${i}`, "comp-1", "comp-1-ceo", `Old CEO message ${i}`, createdAt],
      );
    }

    const result = await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // Old messages should not count — turn should be allowed
    expect(result.success).toBe(true);
    expect(invoker.invoke).toHaveBeenCalled();
  });

  it("rate limit only counts CEO role messages, not user messages", async () => {
    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    // Seed 35 user messages (should not count toward CEO rate limit)
    for (let i = 0; i < 35; i++) {
      const createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      db.run(
        `INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
         VALUES (?, ?, NULL, 'user', ?, ?)`,
        [`msg-user-${i}`, "comp-1", `User message ${i}`, createdAt],
      );
    }

    const result = await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // User messages should not count — turn should be allowed
    expect(result.success).toBe(true);
    expect(invoker.invoke).toHaveBeenCalled();
  });

  it("rate limit is per-company (other companies' CEO messages don't count)", async () => {
    // Create a second company
    const now = isoNow();
    db.run(
      `INSERT INTO companies (id, user_id, name, goal, state, workspace_dir, container_id, mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, 'test-container-2', 'autonomous', ?, ?)`,
      ["comp-2", "user-1", "OtherCo", "Build other things", workspace, now, now],
    );
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, status, model_tier, total_credits, created_at, updated_at)
       VALUES (?, ?, 'ceo', 'CEO', 'ceo', 'idle', 'sonnet', 0, ?, ?)`,
      ["comp-2-ceo", "comp-2", now, now],
    );

    // Seed 35 CEO messages for comp-2 (other company)
    for (let i = 0; i < 35; i++) {
      const createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      db.run(
        `INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
         VALUES (?, ?, ?, 'ceo', ?, ?)`,
        [`msg-comp2-${i}`, "comp-2", "comp-2-ceo", `CEO message ${i}`, createdAt],
      );
    }

    const ceo = db.get<any>(`SELECT * FROM agents WHERE company_id = 'comp-1' AND role = 'ceo'`)!;

    const result = await (scheduler as any).invoke_ceo_turn("comp-1", ceo, "test prompt", {
      skip_response_processing: true,
      bill_credits: false,
    });

    // Other company's messages should not affect comp-1's rate limit
    expect(result.success).toBe(true);
    expect(invoker.invoke).toHaveBeenCalled();
  });
});
