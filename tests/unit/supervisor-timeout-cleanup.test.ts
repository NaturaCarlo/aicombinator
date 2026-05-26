import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Test that setTimeout is properly cleared when runClaudeCode / runOpenClaw
// wins the Promise.race against timeout. Orphan timers from completed turns
// must not fire and abort subsequent turns.
// ---------------------------------------------------------------------------

// Mock blueprints to avoid filesystem reads
vi.mock("../../supervisor/src/blueprints.ts", () => ({
  getBlueprint: vi.fn(() => ({
    id: "frontend-dev",
    name: "Frontend Developer",
    role: "frontend-dev",
    title: "Frontend Developer",
    department: "engineering",
    reportsTo: "cto",
    systemPrompt: "You are a frontend dev.",
    skills: [],
    workflows: [],
    requiredTools: [],
    requiredApiKeys: [],
    mcpServers: [],
    relayChannels: [],
    provider: "claude",
    modelTier: "sonnet",
    estimatedCreditsPerDay: 80,
    tested: true,
    version: "1.0.0",
    description: "Frontend dev",
  })),
  getAllBlueprints: vi.fn(() => []),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: [],
  ENGINEERING_SUPERPOWERS: "",
  QA_SUPERPOWERS: "",
}));

// Mock model-routing
vi.mock("../../supervisor/src/model-routing.ts", () => ({
  MODEL_MAP: {},
  isAnthropicModel: vi.fn(() => true),
  getOpenRouterModelId: vi.fn(() => "anthropic/claude-sonnet-4-20250514"),
  getClaudeCodeModelName: vi.fn(() => "claude-sonnet-4-20250514"),
}));

// Mock openrouter-client
vi.mock("../../supervisor/src/openrouter-client.ts", () => ({
  invokeViaOpenRouter: vi.fn(),
}));

import type { AgentRow, SupervisorConfig, AgentTurnResult } from "../../supervisor/src/types.ts";
import { ClaudeCodeAdapter } from "../../supervisor/src/adapters/claude-code.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function createTestAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-1",
    company_id: "company-1",
    blueprint_id: "frontend-dev",
    name: "Frontend Dev",
    role: "frontend-dev",
    model_tier: "sonnet" as const,
    status: "idle",
    session_id: null,
    current_task_id: null,
    total_credits: 0,
    created_at: new Date().toISOString(),
    metadata: null,
    ...overrides,
  };
}

/**
 * Patches the private runClaudeCode method to use a mock implementation.
 */
function patchRunClaudeCode(
  adapter: ClaudeCodeAdapter,
  mockImpl: (accumulatedUsage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; toolCallCount: number }) => Promise<Omit<AgentTurnResult, "durationMs"> & { sessionId?: string }>,
) {
  const proto = Object.getPrototypeOf(adapter);
  proto.runClaudeCode = async function (
    _agent: AgentRow,
    _prompt: string,
    _workspaceDir: string,
    _limits: unknown,
    _options: unknown,
    accumulatedUsage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; toolCallCount: number },
  ) {
    return mockImpl(accumulatedUsage);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Timeout cleanup in ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;
  let agent: AgentRow;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    adapter = new ClaudeCodeAdapter(createTestConfig());
    agent = createTestAgent();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Source code verification: timeout returns clearable handle", () => {
    it("timeout() returns an object with promise and clear function", () => {
      const sourceCode = readFileSync(
        resolve(__dirname, "../../supervisor/src/adapters/claude-code.ts"),
        "utf-8",
      );

      // The timeout method should return { promise, clear } instead of just a Promise
      expect(sourceCode).toMatch(/private\s+timeout\s*\([^)]*\)\s*:\s*\{\s*promise\s*:\s*Promise<never>\s*[,;]\s*clear\s*:\s*\(\)\s*=>\s*void\s*\}/);
    });

    it("invoke() calls clearTimeoutTimer after successful race", () => {
      const sourceCode = readFileSync(
        resolve(__dirname, "../../supervisor/src/adapters/claude-code.ts"),
        "utf-8",
      );

      // Should destructure the timeout return value
      expect(sourceCode).toMatch(/const\s*\{\s*promise\s*:\s*timeoutPromise\s*,\s*clear\s*:\s*clearTimeoutTimer\s*\}/);

      // Should call clearTimeoutTimer() after Promise.race resolves
      expect(sourceCode).toMatch(/clearTimeoutTimer\s*\(\s*\)/);
    });

    it("invoke() calls clearTimeoutTimer in catch block", () => {
      const sourceCode = readFileSync(
        resolve(__dirname, "../../supervisor/src/adapters/claude-code.ts"),
        "utf-8",
      );

      // The catch block should also call clearTimeoutTimer
      const catchBlock = sourceCode.match(/catch\s*\(\s*err\s*\)\s*\{([\s\S]*?)(?=return\s*\{)/);
      expect(catchBlock).toBeTruthy();
      expect(catchBlock![1]).toContain("clearTimeoutTimer()");
    });
  });

  describe("Behavioral: setTimeout cleared when turn completes before timeout", () => {
    it("setTimeout is cleared when runClaudeCode completes successfully before timeout", async () => {
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

      // Patch runClaudeCode to complete immediately (simulating fast turn)
      patchRunClaudeCode(adapter, async () => {
        return {
          success: true,
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          output: "Turn 1 complete",
          aborted: false,
          toolCallCount: 0,
          sessionId: "sess-1",
        };
      });

      const resultPromise = adapter.invoke(agent, "test prompt", "/workspace", {
        turnLimits: { turnTimeoutMs: 90_000 },
      });

      // Let microtasks resolve (runClaudeCode completes immediately)
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      // clearTimeout should have been called to cancel the orphan timer
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it("setTimeout is cleared when runClaudeCode throws an error", async () => {
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

      // Patch runClaudeCode to throw an error
      patchRunClaudeCode(adapter, async () => {
        throw new Error("SDK crashed");
      });

      const resultPromise = adapter.invoke(agent, "test prompt", "/workspace", {
        turnLimits: { turnTimeoutMs: 90_000 },
      });

      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("SDK crashed");
      // clearTimeout should have been called in the catch block
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it("orphan timer does NOT fire after turn completes", async () => {
      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, "abort");

      // Patch runClaudeCode to complete immediately
      patchRunClaudeCode(adapter, async () => {
        return {
          success: true,
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          output: "done",
          aborted: false,
          toolCallCount: 0,
          sessionId: "sess-1",
        };
      });

      const resultPromise = adapter.invoke(agent, "test prompt", "/workspace", {
        abortController,
        turnLimits: { turnTimeoutMs: 90_000 },
      });

      await vi.advanceTimersByTimeAsync(0);
      await resultPromise;

      // Advance time past the timeout — the orphan timer should NOT fire
      await vi.advanceTimersByTimeAsync(100_000);

      // The abort controller should NOT have been called by the orphan timer
      expect(abortSpy).not.toHaveBeenCalled();

      abortSpy.mockRestore();
    });

    it("Turn 2 is not aborted by Turn 1's orphan timer (shared abort controller scenario)", async () => {
      // Simulate the real bug: shared abort controller between Turn 1 and Turn 2
      const sharedAbortController = new AbortController();

      // Turn 1: completes quickly (10s), timeout is 90s
      patchRunClaudeCode(adapter, async () => {
        return {
          success: true,
          tokenUsage: { inputTokens: 50, outputTokens: 25 },
          output: "Turn 1 done",
          aborted: false,
          toolCallCount: 0,
          sessionId: "sess-1",
        };
      });

      const turn1Promise = adapter.invoke(agent, "Turn 1 prompt", "/workspace", {
        abortController: sharedAbortController,
        turnLimits: { turnTimeoutMs: 90_000 },
      });

      await vi.advanceTimersByTimeAsync(0);
      const turn1Result = await turn1Promise;
      expect(turn1Result.success).toBe(true);

      // Turn 2: starts after Turn 1, takes 120s, timeout 180s
      let turn2Resolved = false;
      patchRunClaudeCode(adapter, async () => {
        // Simulate a long-running turn
        await new Promise((r) => setTimeout(r, 120_000));
        return {
          success: true,
          tokenUsage: { inputTokens: 200, outputTokens: 100 },
          output: "Turn 2 done",
          aborted: false,
          toolCallCount: 0,
          sessionId: "sess-2",
        };
      });

      const turn2Promise = adapter.invoke(agent, "Turn 2 prompt", "/workspace", {
        abortController: sharedAbortController,
        turnLimits: { turnTimeoutMs: 180_000 },
      }).then((result) => {
        turn2Resolved = true;
        return result;
      });

      // Advance past Turn 1's original 90s timeout window
      // If the orphan timer wasn't cleared, it would fire here and abort the shared controller
      await vi.advanceTimersByTimeAsync(90_000);

      // The shared abort controller should NOT have been aborted
      expect(sharedAbortController.signal.aborted).toBe(false);

      // Complete Turn 2
      await vi.advanceTimersByTimeAsync(30_000); // total 120s for Turn 2 to complete
      const turn2Result = await turn2Promise;

      expect(turn2Result.success).toBe(true);
      expect(turn2Result.output).toBe("Turn 2 done");
      expect(sharedAbortController.signal.aborted).toBe(false);
    });
  });
});

describe("Timeout cleanup in AgentInvoker (OpenClaw path)", () => {
  it("agent-invoker.ts timeout() returns clearable handle", () => {
    const sourceCode = readFileSync(
      resolve(__dirname, "../../supervisor/src/agent-invoker.ts"),
      "utf-8",
    );

    // The timeout method should return { promise, clear } instead of just a Promise
    expect(sourceCode).toMatch(/private\s+timeout\s*\([^)]*\)\s*:\s*\{\s*promise\s*:\s*Promise<never>\s*[,;]\s*clear\s*:\s*\(\)\s*=>\s*void\s*\}/);
  });

  it("runOpenClawTurn uses destructured timeout with clear", () => {
    const sourceCode = readFileSync(
      resolve(__dirname, "../../supervisor/src/agent-invoker.ts"),
      "utf-8",
    );

    // Should destructure the timeout return value in runOpenClawTurn
    expect(sourceCode).toMatch(/const\s*\{\s*promise\s*:\s*timeoutPromise\s*,\s*clear\s*:\s*clearTimeoutTimer\s*\}/);

    // Should call clearTimeoutTimer() after Promise.race
    expect(sourceCode).toMatch(/clearTimeoutTimer\s*\(\s*\)/);
  });
});
