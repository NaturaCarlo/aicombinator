import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
import type { Env } from "../../worker/src/types.ts";
import type { LaunchSessionBrief } from "../../worker/src/provisioning/launch-session.ts";

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

// ── Supervisor Helpers ──────────────────────────────────────

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

function seedCompanyForProvision(
  db: SupervisorDb,
  workspaceDir: string,
  opts: { genesisPrompt?: string; companyId?: string } = {},
) {
  const companyId = opts.companyId ?? "comp-1";
  const now = isoNow();
  db.run(
    `INSERT OR IGNORE INTO companies (id, user_id, name, goal, genesis_prompt, state, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, "user-1", "Test Co", "Test goal", opts.genesisPrompt ?? null, "provisioning", workspaceDir, now, now],
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
    ["user-1", 5000, 0, now],
  );
}

function createTempWorkspace(): string {
  const dir = join(tmpdir(), `test-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Worker/Artifact Helpers ─────────────────────────────────

const fetchSpy = vi.spyOn(globalThis, "fetch");

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "",
    OPENROUTER_API_KEY: "",
    FRONTEND_URL: "https://aicombinator.live",
    AUTOMATON_KV: {} as unknown as KVNamespace,
    DB: {} as unknown as D1Database,
    ENVIRONMENT: "test",
    BASE_RPC_URL: "",
    WORKER_API_URL: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SECRET: "",
    AGENTMAIL_API_KEY: "",
    BROWSERBASE_API_KEY: "",
    BROWSERBASE_PROJECT_ID: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    SUPERVISOR_API_KEY: "",
    SUPERVISOR_URL: "",
    SHARED_SUPERVISOR_URL: "",
    BROWSERBASE_FUNCTION_ID: "",
    ADMIN_USER_IDS: "",
    GEMINI_API_KEY: "",
    PORKBUN_API_KEY: "",
    PORKBUN_SECRET_API_KEY: "",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    CLOUDFLARE_DASHBOARD_SCRIPT_NAME: "",
    HETZNER_API_TOKEN: "",
    ...overrides,
  } as Env;
}

const sampleBrief: LaunchSessionBrief = {
  concept: "AI roofing lead gen",
  targetCustomer: "roofing companies in Texas",
  painfulProblem: "They lose leads from missed calls",
  firstOffer: "AI lead intake and booking for roofers",
  whyNow: "AI can now handle phone calls reliably",
  businessModel: "Monthly retainer per location",
  distributionWedge: "Cold email to roofing company owners",
  founderConstraints: [],
  autonomyBoundaries: ["Team may refine messaging without asking founder"],
  founderSetupTasks: ["Create Stripe account"],
  nonGoals: [],
  firstMilestone: "Ship a live site with lead capture",
  openQuestions: [],
  autonomyConfidence: 85,
};

afterEach(() => {
  fetchSpy.mockReset();
});

// ═══════════════════════════════════════════════════════════════
// FIX 1: provision_company pre-materializes mission.md from genesis_prompt
// ═══════════════════════════════════════════════════════════════

describe("FIX 1: provision_company pre-materializes mission.md from genesis_prompt", () => {
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

  it("writes mission.md before start_planning when genesis_prompt is provided", async () => {
    const genesisPrompt = "# Company Spec\nAI lead gen for roofers.\n\n# Mission\nBuild the best AI lead gen.";

    // Mock sync_manager.fetch_company to return a company with genesis_prompt
    (mockSync as any).fetch_company = vi.fn(async () => ({
      id: "comp-new",
      user_id: "user-1",
      name: "RoofLeads AI",
      goal: "AI lead gen",
      genesis_prompt: genesisPrompt,
      state: "provisioning",
      workspace_dir: null,
      container_id: null,
      created_at: isoNow(),
      updated_at: isoNow(),
    }));

    // Mock a valid plan for Turn 2 (Turn 1 should be skipped)
    const validPlan = JSON.stringify({
      mission: "Build the best AI lead gen.",
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

    const consoleSpy = vi.spyOn(console, "log");

    // provision_company will fire start_planning via fire-and-forget
    // We await the provision and then wait for the planning to complete
    await scheduler.provision_company({
      id: "comp-new",
      user_id: "user-1",
      name: "RoofLeads AI",
      goal: "AI lead gen",
      genesis_prompt: genesisPrompt,
      created_at: isoNow(),
      updated_at: isoNow(),
    });

    // Wait a tick for the fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 100));

    // Verify that mission.md was pre-materialized
    const missionPath = join(workspaceDir, "docs", "mission.md");
    expect(existsSync(missionPath)).toBe(true);
    const missionContent = readFileSync(missionPath, "utf8");
    expect(missionContent.length).toBeGreaterThan(0);

    // Verify the pre-materialization log
    const logCalls = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logCalls.some((msg) => msg.includes("pre-materialized mission.md from genesis_prompt"))).toBe(true);

    // Verify Turn 1 was skipped
    expect(logCalls.some((msg) => msg.includes("[planning] skipping mission turn"))).toBe(true);

    consoleSpy.mockRestore();
  });

  it("does NOT pre-materialize when genesis_prompt is empty", async () => {
    (mockSync as any).fetch_company = vi.fn(async () => ({
      id: "comp-empty",
      user_id: "user-1",
      name: "Test Co",
      goal: "Test goal",
      genesis_prompt: "",
      state: "provisioning",
      workspace_dir: null,
      container_id: null,
      created_at: isoNow(),
      updated_at: isoNow(),
    }));

    // Turn 1 will run (no skip), so we need both a mission and plan response
    (mockInvoker.invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({ mission: "Generated mission." }),
        tokenUsage: { inputTokens: 100, outputTokens: 200 },
        toolCallCount: 0,
        durationMs: 1000,
        aborted: false,
      })
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          mission: "Generated mission.",
          plan: {
            milestones: [{ title: "MVP", description: "Build MVP", tasks: [
              { title: "Build page", description: "Page", assigned_to: "frontend-dev", depends_on: [] },
            ] }],
            agents_needed: ["ceo", "frontend-dev"],
          },
        }),
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

    await scheduler.provision_company({
      id: "comp-empty",
      user_id: "user-1",
      name: "Test Co",
      goal: "Test goal",
      genesis_prompt: "",
      created_at: isoNow(),
      updated_at: isoNow(),
    });

    await new Promise((r) => setTimeout(r, 100));

    // Should NOT have pre-materialization log
    const logCalls = consoleSpy.mock.calls.map((c) => c.join(" "));
    expect(logCalls.some((msg) => msg.includes("pre-materialized mission.md from genesis_prompt"))).toBe(false);

    // Turn 1 should have run
    expect(logCalls.some((msg) => msg.includes("Turn 1 (mission) complete"))).toBe(true);

    consoleSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════
// FIX 2: Personalization in-flight lock prevents duplicates
// ═══════════════════════════════════════════════════════════════

describe("FIX 2: Personalization in-flight lock prevents duplicates", () => {
  it("company-status.ts has personalizationInFlight guard around ctx.waitUntil", async () => {
    const source = readFileSync(
      join(__dirname, "../../worker/src/routes/company-status.ts"),
      "utf8",
    );

    // Verify the in-flight lock exists
    expect(source).toContain("personalizationInFlight");
    // Verify it checks before starting
    expect(source).toContain("!personalizationInFlight.has(companyId)");
    // Verify it adds the company
    expect(source).toContain("personalizationInFlight.add(companyId)");
    // Verify it removes the company in finally
    expect(source).toContain("personalizationInFlight.delete(companyId)");
  });

  it("founder-state.ts has personalizationInFlight guard around personalize call", async () => {
    const source = readFileSync(
      join(__dirname, "../../worker/src/routes/founder-state.ts"),
      "utf8",
    );

    // Verify the in-flight lock exists
    expect(source).toContain("personalizationInFlight");
    // Verify it checks before starting
    expect(source).toContain("!personalizationInFlight.has(companyId)");
    // Verify it adds the company
    expect(source).toContain("personalizationInFlight.add(companyId)");
    // Verify cleanup in finally block
    expect(source).toContain("personalizationInFlight.delete(companyId)");
  });

  it("company-status uses module-level Set for locking", async () => {
    const source = readFileSync(
      join(__dirname, "../../worker/src/routes/company-status.ts"),
      "utf8",
    );

    // Verify it's a module-level Set<string>
    expect(source).toMatch(/const personalizationInFlight\s*=\s*new Set<string>\(\)/);
  });
});

// ═══════════════════════════════════════════════════════════════
// FIX 3: Artifact generation Anthropic→OpenRouter→static fallback chain
// ═══════════════════════════════════════════════════════════════

describe("FIX 3: Artifact generation Anthropic→OpenRouter→static fallback chain", () => {
  it("falls back to OpenRouter when Anthropic returns 500 error", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    // First call (Anthropic) returns 500
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );
    // Second call (OpenRouter) returns success
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "submit_artifacts",
                      arguments: JSON.stringify({
                        companySpecMd: "# OpenRouter Spec",
                        missionMd: "# OpenRouter Mission",
                        firstMilestoneMd: "# OpenRouter Milestone",
                        autonomyContractMd: "# OpenRouter Contract",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "or-test" }),
      companyName: "TestCo",
      idea: "Test idea",
      brief: sampleBrief,
    });

    // Should have called Anthropic first, then OpenRouter
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(fetchSpy.mock.calls[1][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    // Result should be from OpenRouter, not static fallback
    expect(result.companySpecMd).toContain("OpenRouter Spec");
    expect(result.missionMd).toContain("OpenRouter Mission");
  });

  it("falls back to OpenRouter when Anthropic network request fails", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    // First call (Anthropic) throws network error
    fetchSpy.mockRejectedValueOnce(new Error("Network error: connection refused"));
    // Second call (OpenRouter) returns success
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "submit_artifacts",
                      arguments: JSON.stringify({
                        companySpecMd: "# OR Spec after network fail",
                        missionMd: "# OR Mission",
                        firstMilestoneMd: "# OR Milestone",
                        autonomyContractMd: "# OR Contract",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "or-test" }),
      companyName: "TestCo",
      idea: "Test idea",
      brief: sampleBrief,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.companySpecMd).toContain("OR Spec after network fail");
  });

  it("falls back to static when both Anthropic and OpenRouter fail", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    // Both calls fail
    fetchSpy.mockResolvedValueOnce(new Response("Anthropic down", { status: 500 }));
    fetchSpy.mockResolvedValueOnce(new Response("OpenRouter down", { status: 503 }));

    const result = await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "or-test" }),
      companyName: "FallbackCo",
      idea: "Test idea",
      brief: sampleBrief,
    });

    // Should have tried both, then returned static fallback
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Fallback artifacts contain the company name
    expect(result.companySpecMd).toContain("FallbackCo");
    expect(result.missionMd).toBeTruthy();
  });

  it("falls back to OpenRouter when Anthropic returns unparseable response", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    // Anthropic returns 200 but garbage content
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "not valid json" }] }),
        { status: 200 },
      ),
    );
    // OpenRouter returns success
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "submit_artifacts",
                      arguments: JSON.stringify({
                        companySpecMd: "# OR rescue spec",
                        missionMd: "# OR rescue mission",
                        firstMilestoneMd: "# OR rescue milestone",
                        autonomyContractMd: "# OR rescue contract",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "or-test" }),
      companyName: "TestCo",
      idea: "Test idea",
      brief: sampleBrief,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.companySpecMd).toContain("OR rescue spec");
  });

  it("skips OpenRouter fallback when only ANTHROPIC_API_KEY is set", async () => {
    const { generateLaunchArtifacts } = await import(
      "../../worker/src/provisioning/launch-session.ts"
    );

    // Anthropic fails
    fetchSpy.mockResolvedValueOnce(new Response("Error", { status: 500 }));

    const result = await generateLaunchArtifacts({
      env: fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }),
      companyName: "FallbackCo",
      idea: "Test idea",
      brief: sampleBrief,
    });

    // Should only call Anthropic, skip OpenRouter (no key), and use static fallback
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.companySpecMd).toContain("FallbackCo");
  });
});
