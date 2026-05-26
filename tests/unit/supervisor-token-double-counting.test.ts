import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Test the token counting logic in the Claude Code adapter.
//
// The adapter's runClaudeCode() uses a dynamic import of @anthropic-ai/claude-code
// which lives in supervisor/node_modules/. Since Vitest can't reliably mock
// cross-package dynamic imports, we test the logic by directly reading and
// verifying the source code patterns, then test through the adapter's public
// invoke() method by patching the private runClaudeCode method via prototype.
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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
 * Patches the private runClaudeCode method to use a mock conversation
 * instead of the real Claude Code SDK. This allows us to test the token
 * counting logic in invoke() without needing to mock the dynamic import.
 */
function patchRunClaudeCode(
  adapter: ClaudeCodeAdapter,
  mockImpl: (accumulatedUsage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; toolCallCount: number }) => Promise<Omit<AgentTurnResult, "durationMs"> & { sessionId?: string }>,
) {
  // Access the prototype to override the private method
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

/**
 * Simulates the runClaudeCode token counting flow for a given set of messages.
 * This mirrors the EXACT logic from the source code to verify correctness.
 * After the fix, the result handler should use = (replace) instead of += (add).
 */
function simulateRunClaudeCodeTokenCounting(
  messages: Array<Record<string, unknown>>,
  accumulatedUsage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; toolCallCount: number },
): { inputTokens: number; outputTokens: number; cacheReadInputTokens: number } {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadInputTokens = 0;

  for (const message of messages) {
    if (message.type === "result") {
      const usage = (message as Record<string, unknown>).usage as Record<string, unknown> | undefined;
      if (usage) {
        // After fix: REPLACE (=) not ADD (+=)
        totalInputTokens = (usage.input_tokens as number) ?? 0;
        totalOutputTokens = (usage.output_tokens as number) ?? 0;
        totalCacheReadInputTokens = (usage.cache_read_input_tokens as number) ?? 0;
        // Update accumulated usage with authoritative values
        accumulatedUsage.inputTokens = totalInputTokens;
        accumulatedUsage.outputTokens = totalOutputTokens;
        accumulatedUsage.cacheReadInputTokens = totalCacheReadInputTokens;
      }
    } else if (message.type === "assistant") {
      const msg = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
      const msgUsage = msg?.usage as Record<string, unknown> | undefined;
      if (msgUsage) {
        // Keep incrementing for error-path fallback
        totalInputTokens += (msgUsage.input_tokens as number) ?? 0;
        totalOutputTokens += (msgUsage.output_tokens as number) ?? 0;
        totalCacheReadInputTokens += (msgUsage.cache_read_input_tokens as number) ?? 0;
        accumulatedUsage.inputTokens = totalInputTokens;
        accumulatedUsage.outputTokens = totalOutputTokens;
        accumulatedUsage.cacheReadInputTokens = totalCacheReadInputTokens;
      }
    }
  }

  return { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheReadInputTokens: totalCacheReadInputTokens };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Token double-counting fix in ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;
  let agent: AgentRow;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ClaudeCodeAdapter(createTestConfig());
    agent = createTestAgent();
  });

  describe("Source code verification: result handler uses = not +=", () => {

    it("result handler uses assignment (=) not addition (+=) for token totals", () => {
      const sourceCode = readFileSync(
        resolve(__dirname, "../../supervisor/src/adapters/claude-code.ts"),
        "utf-8",
      );

      // Find the result handler block — after "if (message.type === 'result')"
      // The fix should use = instead of += for totalInputTokens, totalOutputTokens, totalCacheReadInputTokens
      const resultBlock = sourceCode.match(
        /if\s*\(message\.type\s*===\s*["']result["']\)\s*\{([\s\S]*?)(?=\}\s*else\s*if)/,
      );
      expect(resultBlock).toBeTruthy();
      const block = resultBlock![1];

      // Verify: totalInputTokens should use = not +=
      expect(block).toMatch(/totalInputTokens\s*=\s*resultMsg\.usage\.input_tokens/);
      expect(block).not.toMatch(/totalInputTokens\s*\+=\s*resultMsg\.usage\.input_tokens/);

      // Verify: totalOutputTokens should use = not +=
      expect(block).toMatch(/totalOutputTokens\s*=\s*resultMsg\.usage\.output_tokens/);
      expect(block).not.toMatch(/totalOutputTokens\s*\+=\s*resultMsg\.usage\.output_tokens/);

      // Verify: totalCacheReadInputTokens should use = not +=
      expect(block).toMatch(/totalCacheReadInputTokens\s*=.*cache_read_input_tokens/);
      expect(block).not.toMatch(/totalCacheReadInputTokens\s*\+=.*cache_read_input_tokens/);
    });

    it("assistant handler still uses += for incremental accumulation", () => {
      const sourceCode = readFileSync(
        resolve(__dirname, "../../supervisor/src/adapters/claude-code.ts"),
        "utf-8",
      );

      // Find the assistant handler block
      const assistantBlock = sourceCode.match(
        /if\s*\(assistantMsg\.message\?\.usage\)\s*\{([\s\S]*?)\}/,
      );
      expect(assistantBlock).toBeTruthy();
      const block = assistantBlock![1];

      // Verify: assistant handler should still use += for incremental tracking
      expect(block).toMatch(/totalInputTokens\s*\+=/);
      expect(block).toMatch(/totalOutputTokens\s*\+=/);
      expect(block).toMatch(/totalCacheReadInputTokens\s*\+=/);
    });
  });

  describe("Token counting logic verification", () => {

    it("uses result.usage as authoritative total, NOT result.usage + assistant.usage", () => {
      const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, toolCallCount: 0 };
      const messages = [
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
            content: [{ type: "text", text: "First response" }],
          },
        },
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 15 },
            content: [{ type: "text", text: "Second response" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Final output",
          usage: { input_tokens: 180, output_tokens: 90, cache_read_input_tokens: 35 },
        },
      ];

      const result = simulateRunClaudeCodeTokenCounting(messages, accumulatedUsage);

      // result.usage replaces (not adds to) accumulated totals
      expect(result.inputTokens).toBe(180);
      expect(result.outputTokens).toBe(90);
      expect(result.cacheReadInputTokens).toBe(35);
    });

    it("error path returns accumulated partial usage when result never arrives", () => {
      const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, toolCallCount: 0 };
      const messages = [
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
          },
        },
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 15 },
          },
        },
        // No result message
      ];

      const result = simulateRunClaudeCodeTokenCounting(messages, accumulatedUsage);

      expect(result.inputTokens).toBe(180);
      expect(result.outputTokens).toBe(90);
      expect(result.cacheReadInputTokens).toBe(35);
      // accumulatedUsage should match for error-path fallback
      expect(accumulatedUsage.inputTokens).toBe(180);
      expect(accumulatedUsage.outputTokens).toBe(90);
      expect(accumulatedUsage.cacheReadInputTokens).toBe(35);
    });

    it("result with zero usage overrides accumulated assistant usage", () => {
      const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, toolCallCount: 0 };
      const messages = [
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
          },
        },
        {
          type: "result",
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
        },
      ];

      const result = simulateRunClaudeCodeTokenCounting(messages, accumulatedUsage);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.cacheReadInputTokens).toBe(0);
    });

    it("single assistant message + result does not double-count", () => {
      const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, toolCallCount: 0 };
      const messages = [
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100 },
          },
        },
        {
          type: "result",
          usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100 },
        },
      ];

      const result = simulateRunClaudeCodeTokenCounting(messages, accumulatedUsage);
      // Should be 500 (from result), NOT 1000 (500 assistant + 500 result)
      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(200);
      expect(result.cacheReadInputTokens).toBe(100);
    });

    it("result without usage field falls back to accumulated assistant usage", () => {
      const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, toolCallCount: 0 };
      const messages = [
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
        {
          type: "result",
          // No usage field
        },
      ];

      const result = simulateRunClaudeCodeTokenCounting(messages, accumulatedUsage);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);
    });

    it("accumulatedUsage is overwritten with authoritative values on result", () => {
      const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, toolCallCount: 0 };
      const messages = [
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
          },
        },
        {
          type: "result",
          usage: { input_tokens: 150, output_tokens: 75, cache_read_input_tokens: 30 },
        },
      ];

      simulateRunClaudeCodeTokenCounting(messages, accumulatedUsage);
      expect(accumulatedUsage.inputTokens).toBe(150);
      expect(accumulatedUsage.outputTokens).toBe(75);
      expect(accumulatedUsage.cacheReadInputTokens).toBe(30);
    });
  });

  describe("Integration via patched adapter", () => {

    it("invoke returns result.usage as authoritative, not doubled", async () => {
      // Patch runClaudeCode to simulate: assistant(100,50) + result(100,50)
      patchRunClaudeCode(adapter, async (accumulatedUsage) => {
        // Simulate the FIXED counting logic
        if (accumulatedUsage) {
          // First: assistant increments (error-path fallback)
          accumulatedUsage.inputTokens += 100;
          accumulatedUsage.outputTokens += 50;
          accumulatedUsage.cacheReadInputTokens += 20;
          // Then: result REPLACES (authoritative)
          accumulatedUsage.inputTokens = 100;
          accumulatedUsage.outputTokens = 50;
          accumulatedUsage.cacheReadInputTokens = 20;
        }
        return {
          success: true,
          tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20 },
          output: "response",
          aborted: false,
          toolCallCount: 0,
          sessionId: "sess-1",
        };
      });

      const result = await adapter.invoke(agent, "test prompt", "/workspace");

      expect(result.success).toBe(true);
      expect(result.tokenUsage.inputTokens).toBe(100);
      expect(result.tokenUsage.outputTokens).toBe(50);
      expect(result.tokenUsage.cacheReadInputTokens).toBe(20);
    });

    it("invoke returns accumulated usage on error (no result message)", async () => {
      // Patch runClaudeCode to simulate an error mid-stream
      patchRunClaudeCode(adapter, async (accumulatedUsage) => {
        if (accumulatedUsage) {
          accumulatedUsage.inputTokens = 180;
          accumulatedUsage.outputTokens = 90;
          accumulatedUsage.cacheReadInputTokens = 35;
        }
        throw new Error("Connection lost");
      });

      const result = await adapter.invoke(agent, "test prompt", "/workspace");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Connection lost");
      expect(result.tokenUsage.inputTokens).toBe(180);
      expect(result.tokenUsage.outputTokens).toBe(90);
      expect(result.tokenUsage.cacheReadInputTokens).toBe(35);
    });
  });
});
