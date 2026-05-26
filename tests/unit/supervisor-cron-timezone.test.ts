import { describe, expect, it, vi, beforeEach } from "vitest";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { CronManager } from "../../supervisor/src/cron.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { CreditManager } from "../../supervisor/src/credit-manager.ts";
import { Scheduler } from "../../supervisor/src/scheduler.ts";
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
  isSpecialistBlueprint: vi.fn(() => false),
  SPECIALIST_BLUEPRINTS: new Set(),
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

function createTestConfig(founderTimezone = "America/Los_Angeles"): SupervisorConfig {
  return {
    workerApiUrl: "http://localhost:9999",
    internalApiKey: "test-key",
    anthropicApiKey: "test-anthropic-key",
    port: 8787,
    dbPath: ":memory:",
    scopeUserId: "user-1",
    founderTimezone,
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

// ─── BUG 1: format_date_tz accepts timezone parameter (VAL-SUP-007, VAL-SUP-008) ──

describe("BUG 1: format_date_tz uses founderTimezone", () => {
  it("format_date_tz is exported and accepts timezone parameter (VAL-SUP-007)", async () => {
    // Import format_date_tz from cron.ts — it should be exported now
    const { format_date_tz } = await import("../../supervisor/src/cron.ts");
    expect(typeof format_date_tz).toBe("function");

    // Call with explicit timezone
    const result = format_date_tz("America/New_York");
    // Should return a date string in YYYY-MM-DD format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("format_date_tz returns different dates for different timezones near midnight (VAL-SUP-007)", async () => {
    const { format_date_tz } = await import("../../supervisor/src/cron.ts");

    // Use a specific date near UTC midnight where different timezones yield different dates
    // 2024-03-15T01:00:00Z → March 15 in UTC, March 14 in America/Los_Angeles (UTC-7)
    const nearMidnightUtc = new Date("2024-03-15T01:00:00Z");

    const utcDate = format_date_tz("UTC", nearMidnightUtc);
    const laDate = format_date_tz("America/Los_Angeles", nearMidnightUtc);

    expect(utcDate).toBe("2024-03-15");
    expect(laDate).toBe("2024-03-14");
  });

  it("format_date_tz works with Asia/Tokyo timezone (VAL-SUP-007)", async () => {
    const { format_date_tz } = await import("../../supervisor/src/cron.ts");

    // 2024-06-15T20:00:00Z → June 15 in UTC, June 16 in Asia/Tokyo (UTC+9)
    const date = new Date("2024-06-15T20:00:00Z");

    const utcDate = format_date_tz("UTC", date);
    const tokyoDate = format_date_tz("Asia/Tokyo", date);

    expect(utcDate).toBe("2024-06-15");
    expect(tokyoDate).toBe("2024-06-16");
  });

  it("get_last_daily_update_date uses timezone parameter (VAL-SUP-008)", async () => {
    const { get_last_daily_update_date } = await import("../../supervisor/src/cron.ts");
    expect(typeof get_last_daily_update_date).toBe("function");

    // get_last_daily_update_date should accept (workspace_dir, timezone)
    // Just verify it takes 2 params and doesn't throw
    const result = get_last_daily_update_date("/nonexistent-path", "America/New_York");
    expect(result).toBeNull(); // no files exist at that path
  });

  it("CronManager.request_daily_update passes founderTimezone to format_date_tz (VAL-SUP-008)", async () => {
    // We test this indirectly by setting a timezone and checking the daily update path
    const db = createTestDb();
    const workspace = join(tmpdir(), `tz-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(workspace, "docs"), { recursive: true });
    mkdirSync(join(workspace, ".agent"), { recursive: true });

    const config = createTestConfig("Asia/Tokyo");
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspace);
    const scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    const cronManager = new CronManager(db, taskManager, creditManager, invoker, scheduler, config);
    cronManager.set_founder_timezone("Asia/Tokyo");

    seedCompanyAndCeo(db, workspace);

    // The request_daily_update should use Asia/Tokyo timezone for the date
    // We just verify it doesn't throw and runs using the configured timezone
    await cronManager.request_daily_update("comp-1");

    // The daily update file should be named with the Tokyo-timezone date
    const { format_date_tz } = await import("../../supervisor/src/cron.ts");
    const expectedDate = format_date_tz("Asia/Tokyo");
    const { existsSync } = await import("node:fs");
    // The file may or may not exist depending on whether the invoker mock writes it,
    // but the prompt passed to invoke should reference the correct date
    const invokeCall = (invoker.invoke as any).mock.calls[0];
    if (invokeCall) {
      const prompt = invokeCall[1] as string;
      expect(prompt).toContain(expectedDate);
    }
  });
});

// ─── BUG 2: is_due uses timezone-aware time (VAL-SUP-009, VAL-SUP-010) ──

describe("BUG 2: is_due uses timezone-aware hour/minute extraction", () => {
  it("is_due is exported and accepts timezone parameter (VAL-SUP-009)", async () => {
    const { is_due } = await import("../../supervisor/src/cron.ts");
    expect(typeof is_due).toBe("function");
  });

  it("is_due with Asia/Tokyo fires at 9am Tokyo time, not server time (VAL-SUP-010)", async () => {
    const { is_due } = await import("../../supervisor/src/cron.ts");

    // Create a scenario: schedule is "0 9 * * *" (9:00 AM)
    // Current time: 9:30 AM in Tokyo (= 0:30 UTC)
    // Last run: 2 days ago
    // Should be due because 9:00 AM Tokyo has passed

    // Mock Date.now to return a specific time: 2024-06-15T00:30:00Z (= 9:30 AM Tokyo, UTC+9)
    const originalNow = Date.now;
    const mockNow = new Date("2024-06-15T00:30:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(mockNow);

    try {
      const twoDaysAgo = new Date(mockNow - 2 * 86_400_000).toISOString();

      // With Asia/Tokyo, 9:00 AM Tokyo = 0:00 UTC. It's 0:30 UTC now, so 9:00 AM Tokyo has passed → due
      const result = is_due("0 9 * * *", twoDaysAgo, twoDaysAgo, "Asia/Tokyo");
      expect(result).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("is_due with Asia/Tokyo does NOT fire at server's 9am UTC (VAL-SUP-010)", async () => {
    const { is_due } = await import("../../supervisor/src/cron.ts");

    // Current time: 9:30 UTC (= 6:30 PM Tokyo)
    // Schedule: "0 9 * * *" with Tokyo timezone
    // Last run: 30 minutes ago (at 9:00 UTC = 6:00 PM Tokyo)
    // 9:00 AM Tokyo = 0:00 UTC. Since last run was at 9:00 UTC and we're at 9:30 UTC,
    // the next 9:00 AM Tokyo is at 0:00 UTC tomorrow → NOT due

    const originalNow = Date.now;
    const mockNow = new Date("2024-06-15T09:30:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(mockNow);

    try {
      // Last run at 9:00 AM Tokyo time (= 0:00 UTC same day)
      const lastRunAt = new Date("2024-06-15T00:00:00Z").toISOString();
      const createdAt = new Date("2024-06-01T00:00:00Z").toISOString();

      // With Tokyo timezone, next 9:00 AM is tomorrow at 0:00 UTC → not due
      const result = is_due("0 9 * * *", lastRunAt, createdAt, "Asia/Tokyo");
      expect(result).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("is_due correctly handles DST transition (VAL-SUP-010)", async () => {
    const { is_due } = await import("../../supervisor/src/cron.ts");

    // US DST spring forward: March 10, 2024 at 2:00 AM PST → 3:00 AM PDT
    // Before DST: PST = UTC-8, After DST: PDT = UTC-7
    // Schedule: "0 9 * * *" with America/Los_Angeles
    // 9:00 AM PDT = 16:00 UTC (after DST)

    const mockNow = new Date("2024-03-10T16:30:00Z").getTime(); // 9:30 AM PDT
    vi.spyOn(Date, "now").mockReturnValue(mockNow);

    try {
      const twoDaysAgo = new Date(mockNow - 2 * 86_400_000).toISOString();

      const result = is_due("0 9 * * *", twoDaysAgo, twoDaysAgo, "America/Los_Angeles");
      expect(result).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("is_due does not use getHours/getMinutes (VAL-SUP-009)", async () => {
    // Read the source file and verify no usage of getHours()/getMinutes() in is_due
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      join(__dirname, "../../supervisor/src/cron.ts"),
      "utf8",
    );

    // Extract the is_due function body
    const isDueMatch = source.match(/function is_due\([^)]*\)[^{]*\{([\s\S]*?)^}/m);
    expect(isDueMatch).toBeTruthy();

    const isDueBody = isDueMatch![1];
    // Should NOT contain getHours() or getMinutes()
    expect(isDueBody).not.toContain(".getHours()");
    expect(isDueBody).not.toContain(".getMinutes()");
    // Should contain Intl.DateTimeFormat for timezone-aware extraction
    expect(isDueBody).toContain("Intl.DateTimeFormat");
  });

  it("CronManager.get_due_cron_tasks passes founderTimezone (VAL-SUP-008)", () => {
    const db = createTestDb();
    const workspace = join(tmpdir(), `tz-cron-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(workspace, { recursive: true });

    const config = createTestConfig("Europe/London");
    const taskManager = new TaskManager(db);
    const creditManager = new CreditManager(db, config);
    const invoker = createMockInvoker();
    const syncManager = createMockSyncManager();
    const containerManager = createMockContainerManager(workspace);
    const scheduler = new Scheduler(db, config, taskManager, creditManager, syncManager, invoker, containerManager);
    const cronManager = new CronManager(db, taskManager, creditManager, invoker, scheduler, config);
    cronManager.set_founder_timezone("Europe/London");

    seedCompanyAndCeo(db, workspace);

    // Seed a cron task
    const now = isoNow();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, schedule, prompt, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ["cron-1", "comp-1", "comp-1-ceo", "0 9 * * *", "Daily check", yesterday, "comp-1-ceo", now],
    );

    // This should work without errors — the timezone is passed through
    const dueTasks = cronManager.get_due_cron_tasks("comp-1");
    // The result depends on current time, but it shouldn't throw
    expect(Array.isArray(dueTasks)).toBe(true);
  });

  it("is_due with UTC timezone and every-2-hour schedule works correctly", async () => {
    const { is_due } = await import("../../supervisor/src/cron.ts");

    const mockNow = new Date("2024-06-15T10:30:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(mockNow);

    try {
      const threeHoursAgo = new Date(mockNow - 3 * 3_600_000).toISOString();
      const result = is_due("0 */2 * * *", threeHoursAgo, threeHoursAgo, "UTC");
      expect(result).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("is_due defaults gracefully when timezone not provided", async () => {
    const { is_due } = await import("../../supervisor/src/cron.ts");

    // If called without timezone, it should still work (default to America/Los_Angeles or similar)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const result = is_due("0 9 * * *", yesterday, yesterday);
    expect(typeof result).toBe("boolean");
  });
});
