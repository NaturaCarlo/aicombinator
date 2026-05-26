import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentRow, AgentTurnResult } from "../../supervisor/src/types.ts";

// ---------------------------------------------------------------------------
// Mock all adapter modules BEFORE importing AgentInvoker.
// We spy on each adapter's invoke() to verify routing without executing them.
// ---------------------------------------------------------------------------

const claudeCodeInvokeMock = vi.fn<() => Promise<AgentTurnResult>>();
const httpWebhookInvokeMock = vi.fn<() => Promise<AgentTurnResult>>();
const bashInvokeMock = vi.fn<() => Promise<AgentTurnResult>>();
const codexInvokeMock = vi.fn<() => Promise<AgentTurnResult>>();
const codexSetRelayManagerMock = vi.fn();

vi.mock("../../supervisor/src/adapters/claude-code.ts", () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(() => ({
    invoke: claudeCodeInvokeMock,
    checkSessionLimits: vi.fn(),
    recordSessionCredits: vi.fn(),
    resetSession: vi.fn(),
  })),
}));

vi.mock("../../supervisor/src/adapters/http-webhook.ts", () => ({
  HttpWebhookAdapter: vi.fn().mockImplementation(() => ({
    invoke: httpWebhookInvokeMock,
  })),
}));

vi.mock("../../supervisor/src/adapters/bash.ts", () => ({
  BashAdapter: vi.fn().mockImplementation(() => ({
    invoke: bashInvokeMock,
  })),
}));

vi.mock("../../supervisor/src/adapters/codex.ts", () => ({
  CodexAdapter: vi.fn().mockImplementation(() => ({
    invoke: codexInvokeMock,
    setRelayManager: codexSetRelayManagerMock,
  })),
}));

// Mock blueprints module to avoid loading real blueprint files
vi.mock("../../supervisor/src/blueprints.ts", () => ({
  getBlueprint: vi.fn(() => null),
  getAllSpecialistBlueprints: vi.fn(() => []),
}));

// Mock compose-template to avoid filesystem dependencies
vi.mock("../../supervisor/src/compose-template.ts", () => ({
  containerName: vi.fn((id: string) => `company-${id}`),
}));

// Mock relay-manager type (not instantiated, just typed)
vi.mock("../../supervisor/src/relay-manager.ts", () => ({
  RelayManager: vi.fn(),
}));

// Import AgentInvoker after mocks are set up
import { AgentInvoker } from "../../supervisor/src/agent-invoker.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default successful AgentTurnResult. */
function successResult(adapter: string): AgentTurnResult {
  return {
    success: true,
    tokenUsage: { inputTokens: 10, outputTokens: 20 },
    output: `Response from ${adapter}`,
    aborted: false,
    toolCallCount: 0,
    durationMs: 100,
  };
}

/** Create a minimal AgentRow with optional metadata for adapter routing. */
function makeAgent(
  adapterType?: string,
  overrides: Partial<AgentRow> = {},
): AgentRow {
  const metadata = adapterType
    ? JSON.stringify({ adapterType })
    : undefined;

  return {
    id: "agent-001",
    company_id: "company-001",
    blueprint_id: null,
    name: "Test Agent",
    role: "specialist",
    model_tier: "sonnet",
    status: "idle",
    session_id: null,
    current_task_id: null,
    total_credits: 0,
    created_at: new Date().toISOString(),
    metadata: metadata ?? null,
    ...overrides,
  };
}

/** Minimal SupervisorConfig for constructing AgentInvoker. */
const testConfig = {
  workerApiUrl: "http://localhost:8787",
  internalApiKey: "test-key",
  anthropicApiKey: "test-anthropic-key",
  port: 8787,
  dbPath: ":memory:",
  founderTimezone: "UTC",
  syncIntervalMs: 5000,
  cronIntervalMs: 60000,
  stallCheckEveryTurns: 5,
  containerConfig: {
    companiesDir: "/tmp/companies",
    mcpServersDir: "/tmp/mcp",
    networkName: "test-net",
    resources: {
      cpuLimit: "2.0",
      memoryLimit: "2g",
      cpuReservation: "0.5",
      memoryReservation: "512m",
    },
  },
  relayConfig: { enabled: false },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentInvoker adapter routing", () => {
  let invoker: AgentInvoker;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up default return values for each adapter mock
    claudeCodeInvokeMock.mockResolvedValue(successResult("claude-code"));
    httpWebhookInvokeMock.mockResolvedValue(successResult("http-webhook"));
    bashInvokeMock.mockResolvedValue(successResult("bash"));
    codexInvokeMock.mockResolvedValue(successResult("codex"));

    invoker = new AgentInvoker(testConfig);
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-013: Blueprint adapterType routes correctly
  // ------------------------------------------------------------------
  describe("adapterType routing (VAL-ADAPT-013)", () => {
    it('routes adapterType "claude-code" to ClaudeCodeAdapter', async () => {
      const agent = makeAgent("claude-code");
      const result = await invoker.invoke(agent, "Hello", "/workspace");

      expect(claudeCodeInvokeMock).toHaveBeenCalledOnce();
      expect(httpWebhookInvokeMock).not.toHaveBeenCalled();
      expect(bashInvokeMock).not.toHaveBeenCalled();
      expect(codexInvokeMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Response from claude-code");
    });

    it('routes adapterType "http-webhook" to HttpWebhookAdapter', async () => {
      const agent = makeAgent("http-webhook");
      const result = await invoker.invoke(agent, "Hello", "/workspace");

      expect(httpWebhookInvokeMock).toHaveBeenCalledOnce();
      expect(claudeCodeInvokeMock).not.toHaveBeenCalled();
      expect(bashInvokeMock).not.toHaveBeenCalled();
      expect(codexInvokeMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Response from http-webhook");
    });

    it('routes adapterType "bash" to BashAdapter', async () => {
      const agent = makeAgent("bash");
      const result = await invoker.invoke(agent, "Hello", "/workspace");

      expect(bashInvokeMock).toHaveBeenCalledOnce();
      expect(claudeCodeInvokeMock).not.toHaveBeenCalled();
      expect(httpWebhookInvokeMock).not.toHaveBeenCalled();
      expect(codexInvokeMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Response from bash");
    });

    it('routes adapterType "codex" to CodexAdapter', async () => {
      const agent = makeAgent("codex");
      const result = await invoker.invoke(agent, "Hello", "/workspace");

      expect(codexInvokeMock).toHaveBeenCalledOnce();
      expect(claudeCodeInvokeMock).not.toHaveBeenCalled();
      expect(httpWebhookInvokeMock).not.toHaveBeenCalled();
      expect(bashInvokeMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.output).toBe("Response from codex");
    });
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-013 (cont): Default routing when adapterType is absent
  // ------------------------------------------------------------------
  describe("default routing (backward compatibility)", () => {
    it("defaults to ClaudeCodeAdapter when adapterType is absent", async () => {
      const agent = makeAgent(undefined); // No adapterType
      const result = await invoker.invoke(agent, "Hello", "/workspace");

      expect(claudeCodeInvokeMock).toHaveBeenCalledOnce();
      expect(httpWebhookInvokeMock).not.toHaveBeenCalled();
      expect(bashInvokeMock).not.toHaveBeenCalled();
      expect(codexInvokeMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it("defaults to ClaudeCodeAdapter when metadata is null", async () => {
      const agent = makeAgent(undefined, { metadata: null });
      const result = await invoker.invoke(agent, "Hello", "/workspace");

      expect(claudeCodeInvokeMock).toHaveBeenCalledOnce();
      expect(result.success).toBe(true);
    });

    it("defaults to ClaudeCodeAdapter when metadata is invalid JSON", async () => {
      const agent = makeAgent(undefined, { metadata: "not-json" });
      const result = await invoker.invoke(agent, "Hello", "/workspace");

      expect(claudeCodeInvokeMock).toHaveBeenCalledOnce();
      expect(result.success).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-014: All adapters return consistent AgentTurnResult
  // ------------------------------------------------------------------
  describe("consistent AgentTurnResult shape (VAL-ADAPT-014)", () => {
    const adapterTypes = ["claude-code", "http-webhook", "bash", "codex"] as const;

    for (const adapterType of adapterTypes) {
      it(`${adapterType} adapter returns all required AgentTurnResult fields`, async () => {
        const agent = makeAgent(adapterType);
        const result = await invoker.invoke(agent, "Test", "/workspace");

        // Verify all required AgentTurnResult fields are present
        expect(result).toHaveProperty("success");
        expect(typeof result.success).toBe("boolean");

        expect(result).toHaveProperty("tokenUsage");
        expect(result.tokenUsage).toHaveProperty("inputTokens");
        expect(result.tokenUsage).toHaveProperty("outputTokens");
        expect(typeof result.tokenUsage.inputTokens).toBe("number");
        expect(typeof result.tokenUsage.outputTokens).toBe("number");

        expect(result).toHaveProperty("output");
        expect(result).toHaveProperty("aborted");
        expect(typeof result.aborted).toBe("boolean");

        expect(result).toHaveProperty("toolCallCount");
        expect(typeof result.toolCallCount).toBe("number");

        expect(result).toHaveProperty("durationMs");
        expect(typeof result.durationMs).toBe("number");
      });
    }
  });

  // ------------------------------------------------------------------
  // Additional edge cases
  // ------------------------------------------------------------------
  describe("edge cases", () => {
    it("reads adapterType from snake_case metadata field (adapter_type)", async () => {
      const agent = makeAgent(undefined, {
        metadata: JSON.stringify({ adapter_type: "bash" }),
      });
      await invoker.invoke(agent, "Hello", "/workspace");

      expect(bashInvokeMock).toHaveBeenCalledOnce();
      expect(claudeCodeInvokeMock).not.toHaveBeenCalled();
    });

    it("passes prompt and workspaceDir to the correct adapter", async () => {
      const agent = makeAgent("http-webhook");
      await invoker.invoke(agent, "Do the task", "/workspace/myproject");

      expect(httpWebhookInvokeMock).toHaveBeenCalledWith(
        agent,
        "Do the task",
        "/workspace/myproject",
        undefined,
      );
    });

    it("passes options through to the adapter", async () => {
      const agent = makeAgent("bash");
      const options = {
        turnLimits: { turnTimeoutMs: 5000 },
        systemPromptSuffix: "Extra context",
      };
      await invoker.invoke(agent, "Execute", "/workspace", options);

      expect(bashInvokeMock).toHaveBeenCalledWith(
        agent,
        "Execute",
        "/workspace",
        options,
      );
    });

    it("propagates adapter errors without unhandled exception", async () => {
      httpWebhookInvokeMock.mockRejectedValue(new Error("Network error"));

      const agent = makeAgent("http-webhook");
      await expect(invoker.invoke(agent, "Fail", "/workspace")).rejects.toThrow(
        "Network error",
      );
    });

    it("setRelayManager propagates to CodexAdapter", () => {
      const fakeRelay = { isRelayAgent: vi.fn() } as unknown as import("../../supervisor/src/relay-manager.ts").RelayManager;
      invoker.setRelayManager(fakeRelay);

      expect(codexSetRelayManagerMock).toHaveBeenCalledWith(fakeRelay);
    });
  });
});
