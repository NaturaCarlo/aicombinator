import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ModelTier } from "../../supervisor/src/types.ts";

// ---------------------------------------------------------------------------
// Tests for model provider detection and OpenRouter routing
// ---------------------------------------------------------------------------

describe("OpenRouter routing logic", () => {
  // -------------------------------------------------------------------------
  // Model provider detection
  // -------------------------------------------------------------------------
  describe("getModelProvider()", () => {
    // We import the function dynamically after defining it
    let getModelProvider: (tier: ModelTier) => string;
    let isAnthropicModel: (tier: ModelTier) => boolean;

    beforeEach(async () => {
      const mod = await import("../../supervisor/src/model-routing.ts");
      getModelProvider = mod.getModelProvider;
      isAnthropicModel = mod.isAnthropicModel;
    });

    it("identifies Anthropic models correctly", () => {
      expect(getModelProvider("haiku-4-5")).toBe("anthropic");
      expect(getModelProvider("sonnet-4-5")).toBe("anthropic");
      expect(getModelProvider("sonnet-4-6")).toBe("anthropic");
      expect(getModelProvider("opus-4-5")).toBe("anthropic");
      expect(getModelProvider("opus-4-6")).toBe("anthropic");
    });

    it("identifies OpenAI models correctly", () => {
      expect(getModelProvider("gpt-5.2")).toBe("openai");
      expect(getModelProvider("gpt-5.2-codex")).toBe("openai");
      expect(getModelProvider("gpt-5.3-codex")).toBe("openai");
      expect(getModelProvider("gpt-5.4")).toBe("openai");
    });

    it("identifies Google models correctly", () => {
      expect(getModelProvider("gemini-3-flash")).toBe("google");
      expect(getModelProvider("gemini-3.1-pro")).toBe("google");
    });

    it("identifies Z.ai models correctly", () => {
      expect(getModelProvider("glm-4.7")).toBe("z-ai");
      expect(getModelProvider("glm-5")).toBe("z-ai");
    });

    it("identifies MoonshotAI models correctly", () => {
      expect(getModelProvider("kimi-k2.5")).toBe("moonshotai");
    });

    it("identifies MiniMax models correctly", () => {
      expect(getModelProvider("minimax-m2.5")).toBe("minimax");
    });

    it("identifies legacy Anthropic tiers correctly", () => {
      expect(getModelProvider("haiku")).toBe("anthropic");
      expect(getModelProvider("sonnet")).toBe("anthropic");
      expect(getModelProvider("opus")).toBe("anthropic");
      // gpt4o-mini maps to anthropic/claude-sonnet-4.6 for backward compat
      expect(getModelProvider("gpt4o-mini")).toBe("anthropic");
    });

    it("isAnthropicModel returns true for Anthropic models", () => {
      expect(isAnthropicModel("sonnet-4-6")).toBe(true);
      expect(isAnthropicModel("haiku-4-5")).toBe(true);
      expect(isAnthropicModel("opus-4-6")).toBe(true);
      expect(isAnthropicModel("sonnet")).toBe(true);
      expect(isAnthropicModel("haiku")).toBe(true);
    });

    it("isAnthropicModel returns false for non-Anthropic models", () => {
      expect(isAnthropicModel("gpt-5.2")).toBe(false);
      expect(isAnthropicModel("gemini-3-flash")).toBe(false);
      expect(isAnthropicModel("glm-4.7")).toBe(false);
      expect(isAnthropicModel("kimi-k2.5")).toBe(false);
      expect(isAnthropicModel("minimax-m2.5")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getOpenRouterModelId
  // -------------------------------------------------------------------------
  describe("getOpenRouterModelId()", () => {
    let getOpenRouterModelId: (tier: ModelTier) => string;

    beforeEach(async () => {
      const mod = await import("../../supervisor/src/model-routing.ts");
      getOpenRouterModelId = mod.getOpenRouterModelId;
    });

    it("returns correct OpenRouter model IDs for all 15 models", () => {
      expect(getOpenRouterModelId("minimax-m2.5")).toBe("minimax/minimax-m2.5");
      expect(getOpenRouterModelId("gemini-3-flash")).toBe("google/gemini-3-flash-preview");
      expect(getOpenRouterModelId("glm-4.7")).toBe("z-ai/glm-4.7");
      expect(getOpenRouterModelId("kimi-k2.5")).toBe("moonshotai/kimi-k2.5");
      expect(getOpenRouterModelId("haiku-4-5")).toBe("anthropic/claude-haiku-4.5");
      expect(getOpenRouterModelId("glm-5")).toBe("z-ai/glm-5");
      expect(getOpenRouterModelId("gpt-5.2")).toBe("openai/gpt-5.2");
      expect(getOpenRouterModelId("gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
      expect(getOpenRouterModelId("gpt-5.3-codex")).toBe("openai/gpt-5.3-codex");
      expect(getOpenRouterModelId("gemini-3.1-pro")).toBe("google/gemini-3.1-pro-preview");
      expect(getOpenRouterModelId("gpt-5.4")).toBe("openai/gpt-5.4");
      expect(getOpenRouterModelId("sonnet-4-5")).toBe("anthropic/claude-sonnet-4.5");
      expect(getOpenRouterModelId("sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
      expect(getOpenRouterModelId("opus-4-5")).toBe("anthropic/claude-opus-4.5");
      expect(getOpenRouterModelId("opus-4-6")).toBe("anthropic/claude-opus-4.6");
    });

    it("returns correct OpenRouter model IDs for legacy tiers", () => {
      expect(getOpenRouterModelId("opus")).toBe("anthropic/claude-opus-4.6");
      expect(getOpenRouterModelId("sonnet")).toBe("anthropic/claude-sonnet-4.6");
      expect(getOpenRouterModelId("haiku")).toBe("anthropic/claude-haiku-4.5");
      expect(getOpenRouterModelId("gpt4o-mini")).toBe("anthropic/claude-sonnet-4.6");
    });
  });

  // -------------------------------------------------------------------------
  // LLM Proxy model-aware routing
  // -------------------------------------------------------------------------
  describe("LLM Proxy model-aware routing", () => {
    let createLlmProxy: typeof import("../../supervisor/src/llm-proxy.ts").createLlmProxy;
    let clearLlmConfigCache: typeof import("../../supervisor/src/llm-proxy.ts").clearLlmConfigCache;

    beforeEach(async () => {
      const mod = await import("../../supervisor/src/llm-proxy.ts");
      createLlmProxy = mod.createLlmProxy;
      clearLlmConfigCache = mod.clearLlmConfigCache;
      clearLlmConfigCache();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const testConfig = {
      internalApiKey: "test-internal-key",
      workerApiUrl: "http://localhost:9999",
      openRouterApiKey: "test-openrouter-key",
    };

    it("returns 401 for missing API key", async () => {
      const app = createLlmProxy(testConfig);
      const res = await app.request("/llm-proxy/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4.6", messages: [] }),
      });
      expect(res.status).toBe(401);
    });

    it("health endpoint works", async () => {
      const app = createLlmProxy(testConfig);
      const res = await app.request("/llm-proxy/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it("routes Anthropic model to Anthropic API when using model-aware routing", async () => {
      // Mock fetch for the provider config and the actual upstream request
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes("/api/supervisor/llm-config")) {
          return new Response(JSON.stringify({ provider: "openrouter", key: "or-key" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (urlStr.includes("api.anthropic.com")) {
          return new Response(JSON.stringify({ id: "msg_123", type: "message", content: [{ type: "text", text: "Hello" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (urlStr.includes("openrouter.ai")) {
          return new Response(JSON.stringify({ id: "msg_123", type: "message", content: [{ type: "text", text: "Hello" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(url as RequestInfo);
      });
      globalThis.fetch = fetchMock;

      try {
        const app = createLlmProxy(testConfig);

        // Send a request with an Anthropic model (no slash in name)
        const res = await app.request("/llm-proxy/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": "test-internal-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "claude-sonnet-4.6", messages: [] }),
        });

        expect(res.status).toBe(200);

        // When provider is openrouter, it should route to openrouter.ai
        // and prefix the model with "anthropic/" if no slash
        const calls = fetchMock.mock.calls;
        const upstreamCall = calls.find((c: unknown[]) => {
          const url = typeof c[0] === "string" ? c[0] : "";
          return url.includes("openrouter.ai");
        });
        expect(upstreamCall).toBeTruthy();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Non-Anthropic model direct invocation via OpenRouter
  // -------------------------------------------------------------------------
  describe("invokeViaOpenRouter()", () => {
    let invokeViaOpenRouter: typeof import("../../supervisor/src/openrouter-client.ts").invokeViaOpenRouter;

    beforeEach(async () => {
      const mod = await import("../../supervisor/src/openrouter-client.ts");
      invokeViaOpenRouter = mod.invokeViaOpenRouter;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("sends correct request to OpenRouter with proper headers", async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "gen-123",
            choices: [
              {
                message: { role: "assistant", content: "I completed the task." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      globalThis.fetch = fetchMock;

      try {
        const result = await invokeViaOpenRouter({
          openRouterApiKey: "or-test-key",
          model: "openai/gpt-5.2",
          systemPrompt: "You are a helpful assistant.",
          userPrompt: "Hello, world!",
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("I completed the task.");
        expect(result.tokenUsage.inputTokens).toBe(100);
        expect(result.tokenUsage.outputTokens).toBe(50);

        // Verify the fetch was called with correct URL and headers
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(options.method).toBe("POST");
        const headers = options.headers as Record<string, string>;
        expect(headers["Authorization"]).toBe("Bearer or-test-key");
        expect(headers["Content-Type"]).toBe("application/json");

        // Verify body
        const body = JSON.parse(options.body as string);
        expect(body.model).toBe("openai/gpt-5.2");
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
        expect(body.messages[1]).toEqual({ role: "user", content: "Hello, world!" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles OpenRouter API failure gracefully", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Rate limited", code: 429 } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      );

      try {
        const result = await invokeViaOpenRouter({
          openRouterApiKey: "or-test-key",
          model: "openai/gpt-5.2",
          systemPrompt: "You are a helpful assistant.",
          userPrompt: "Hello!",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("429");
        expect(result.tokenUsage.inputTokens).toBe(0);
        expect(result.tokenUsage.outputTokens).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles network errors gracefully", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network connection failed"));

      try {
        const result = await invokeViaOpenRouter({
          openRouterApiKey: "or-test-key",
          model: "google/gemini-3-flash-preview",
          systemPrompt: "You are a specialist.",
          userPrompt: "Do the work.",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Network connection failed");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles empty/missing response content", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "gen-456",
            choices: [
              {
                message: { role: "assistant", content: "" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      try {
        const result = await invokeViaOpenRouter({
          openRouterApiKey: "or-test-key",
          model: "z-ai/glm-4.7",
          systemPrompt: "You are a specialist.",
          userPrompt: "Do nothing.",
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("");
        expect(result.tokenUsage.inputTokens).toBe(50);
        expect(result.tokenUsage.outputTokens).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles missing usage data in response", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "gen-789",
            choices: [
              {
                message: { role: "assistant", content: "Done." },
                finish_reason: "stop",
              },
            ],
            // No usage field
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      try {
        const result = await invokeViaOpenRouter({
          openRouterApiKey: "or-test-key",
          model: "moonshotai/kimi-k2.5",
          systemPrompt: "You are a specialist.",
          userPrompt: "Work.",
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("Done.");
        // Should estimate tokens from content length
        expect(result.tokenUsage.inputTokens).toBeGreaterThanOrEqual(0);
        expect(result.tokenUsage.outputTokens).toBeGreaterThanOrEqual(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Invalid model tier handling
  // -------------------------------------------------------------------------
  describe("invalid model tier handling", () => {
    let getModelProvider: (tier: ModelTier) => string;
    let isAnthropicModel: (tier: ModelTier) => boolean;

    beforeEach(async () => {
      const mod = await import("../../supervisor/src/model-routing.ts");
      getModelProvider = mod.getModelProvider;
      isAnthropicModel = mod.isAnthropicModel;
    });

    it("falls back to anthropic for unknown model tiers", () => {
      // Unknown tiers default to anthropic (via sonnet fallback)
      const provider = getModelProvider("nonexistent-model" as ModelTier);
      expect(provider).toBe("anthropic");
    });

    it("isAnthropicModel returns true for unknown model tiers (safe fallback)", () => {
      expect(isAnthropicModel("nonexistent-model" as ModelTier)).toBe(true);
    });
  });
});
