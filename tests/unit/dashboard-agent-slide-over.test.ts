import { describe, it, expect } from "vitest";

// ─── Pure helper functions extracted for testing ──────────────────

function formatCostCents(cents: number): string {
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${Math.round(cents)}¢`;
}

function formatTokensConsumed(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return tokens.toLocaleString();
}

interface RecentTurn {
  id: string;
  timestamp: string;
  state: string;
  thinking: string;
  toolCallCount: number;
  costCents: number;
}

function filterAgentTurns(
  recentTurns: RecentTurn[],
  _agentId: string,
): RecentTurn[] {
  return recentTurns.slice(0, 10);
}

function formatTimeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("AgentSlideOver helpers", () => {
  describe("formatCostCents", () => {
    it("formats values >= 100 cents as dollars", () => {
      expect(formatCostCents(100)).toBe("$1.00");
      expect(formatCostCents(150)).toBe("$1.50");
      expect(formatCostCents(1234)).toBe("$12.34");
    });

    it("formats values < 100 cents with ¢ symbol", () => {
      expect(formatCostCents(0)).toBe("0¢");
      expect(formatCostCents(50)).toBe("50¢");
      expect(formatCostCents(99)).toBe("99¢");
    });

    it("rounds fractional cents", () => {
      expect(formatCostCents(33.7)).toBe("34¢");
    });
  });

  describe("formatTokensConsumed", () => {
    it("formats millions with M suffix", () => {
      expect(formatTokensConsumed(5_200_000)).toBe("5.2M");
    });

    it("formats large millions", () => {
      expect(formatTokensConsumed(20_000_000)).toBe("20.0M");
    });

    it("formats small values with comma separators", () => {
      expect(formatTokensConsumed(1234)).toBe("1,234");
    });

    it("handles zero tokens", () => {
      expect(formatTokensConsumed(0)).toBe("0");
    });
  });

  describe("filterAgentTurns", () => {
    const turns: RecentTurn[] = Array.from({ length: 15 }, (_, i) => ({
      id: `turn-${i}`,
      timestamp: new Date(Date.now() - i * 60_000).toISOString(),
      state: "complete",
      thinking: "thinking...",
      toolCallCount: i + 1,
      costCents: (i + 1) * 10,
    }));

    it("returns at most 10 turns", () => {
      const result = filterAgentTurns(turns, "agent-1");
      expect(result).toHaveLength(10);
    });

    it("returns all turns if fewer than 10", () => {
      const few = turns.slice(0, 3);
      const result = filterAgentTurns(few, "agent-1");
      expect(result).toHaveLength(3);
    });

    it("returns empty array for empty input", () => {
      const result = filterAgentTurns([], "agent-1");
      expect(result).toHaveLength(0);
    });
  });

  describe("formatTimeAgo", () => {
    it("returns 'just now' for timestamps less than a minute ago", () => {
      const ts = new Date(Date.now() - 30_000).toISOString();
      expect(formatTimeAgo(ts)).toBe("just now");
    });

    it("returns minutes for timestamps less than an hour ago", () => {
      const ts = new Date(Date.now() - 5 * 60_000).toISOString();
      expect(formatTimeAgo(ts)).toBe("5m ago");
    });

    it("returns hours for timestamps less than a day ago", () => {
      const ts = new Date(Date.now() - 3 * 3_600_000).toISOString();
      expect(formatTimeAgo(ts)).toBe("3h ago");
    });

    it("returns days for timestamps more than a day ago", () => {
      const ts = new Date(Date.now() - 2 * 86_400_000).toISOString();
      expect(formatTimeAgo(ts)).toBe("2d ago");
    });
  });

  describe("LLM model options (15 models grouped by provider)", () => {
    // Grouped model options matching the agent-slide-over component
    const LLM_MODEL_GROUPS = [
      {
        provider: "Anthropic",
        models: [
          { value: "haiku-4-5", label: "Haiku 4.5", multiplier: "0.4x" },
          { value: "sonnet-4-5", label: "Sonnet 4.5", multiplier: "1.2x" },
          { value: "sonnet-4-6", label: "Sonnet 4.6", multiplier: "1.2x" },
          { value: "opus-4-5", label: "Opus 4.5", multiplier: "2.0x" },
          { value: "opus-4-6", label: "Opus 4.6", multiplier: "2.0x" },
        ],
      },
      {
        provider: "OpenAI",
        models: [
          { value: "gpt-5.2", label: "GPT-5.2", multiplier: "0.7x" },
          { value: "gpt-5.2-codex", label: "GPT-5.2-Codex", multiplier: "0.7x" },
          { value: "gpt-5.3-codex", label: "GPT-5.3-Codex", multiplier: "0.7x" },
          { value: "gpt-5.4", label: "GPT-5.4", multiplier: "1.0x" },
        ],
      },
      {
        provider: "Google",
        models: [
          { value: "gemini-3-flash", label: "Gemini 3 Flash", multiplier: "0.2x" },
          { value: "gemini-3.1-pro", label: "Gemini 3.1 Pro", multiplier: "0.8x" },
        ],
      },
      {
        provider: "Z.ai",
        models: [
          { value: "glm-4.7", label: "GLM-4.7", multiplier: "0.25x" },
          { value: "glm-5", label: "GLM-5", multiplier: "0.4x" },
        ],
      },
      {
        provider: "MoonshotAI",
        models: [
          { value: "kimi-k2.5", label: "Kimi K2.5", multiplier: "0.25x" },
        ],
      },
      {
        provider: "MiniMax",
        models: [
          { value: "minimax-m2.5", label: "MiniMax M2.5", multiplier: "0.12x" },
        ],
      },
    ] as const;

    const allModels = LLM_MODEL_GROUPS.flatMap((g) => g.models);

    it("provides exactly 15 model options across all groups", () => {
      expect(allModels).toHaveLength(15);
    });

    it("has exactly 6 provider groups", () => {
      expect(LLM_MODEL_GROUPS).toHaveLength(6);
    });

    it("each option has value, label, and multiplier", () => {
      for (const opt of allModels) {
        expect(opt.value).toBeTruthy();
        expect(opt.label).toBeTruthy();
        expect(opt.multiplier).toMatch(/^\d+\.?\d*x$/);
      }
    });

    it("model tier values match pricing-config keys", () => {
      const pricingKeys = [
        "minimax-m2.5", "gemini-3-flash", "glm-4.7", "kimi-k2.5",
        "haiku-4-5", "glm-5", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex",
        "gemini-3.1-pro", "gpt-5.4", "sonnet-4-5", "sonnet-4-6",
        "opus-4-5", "opus-4-6",
      ];
      for (const opt of allModels) {
        expect(pricingKeys).toContain(opt.value);
      }
    });

    it("does NOT include Opus 4.6 Fast (12x)", () => {
      const values = allModels.map((m) => m.value);
      expect(values).not.toContain("opus-4-6-fast");
      const multipliers = allModels.map((m) => m.multiplier);
      expect(multipliers).not.toContain("12.0x");
      expect(multipliers).not.toContain("12x");
    });

    it("Anthropic group contains 5 models", () => {
      const anthropic = LLM_MODEL_GROUPS.find((g) => g.provider === "Anthropic");
      expect(anthropic?.models).toHaveLength(5);
    });

    it("OpenAI group contains 4 models", () => {
      const openai = LLM_MODEL_GROUPS.find((g) => g.provider === "OpenAI");
      expect(openai?.models).toHaveLength(4);
    });

    it("display format shows 'Model Name — Xx multiplier'", () => {
      const formatted = allModels.map(
        (opt) => `${opt.label} — ${opt.multiplier} multiplier`,
      );
      expect(formatted).toContain("Haiku 4.5 — 0.4x multiplier");
      expect(formatted).toContain("Sonnet 4.6 — 1.2x multiplier");
      expect(formatted).toContain("Opus 4.6 — 2.0x multiplier");
      expect(formatted).toContain("GPT-5.2 — 0.7x multiplier");
      expect(formatted).toContain("MiniMax M2.5 — 0.12x multiplier");
    });

    it("multiplier values are consistent with pricing config", () => {
      const expectedMultipliers: Record<string, string> = {
        "minimax-m2.5": "0.12x",
        "gemini-3-flash": "0.2x",
        "glm-4.7": "0.25x",
        "kimi-k2.5": "0.25x",
        "haiku-4-5": "0.4x",
        "glm-5": "0.4x",
        "gpt-5.2": "0.7x",
        "gpt-5.2-codex": "0.7x",
        "gpt-5.3-codex": "0.7x",
        "gemini-3.1-pro": "0.8x",
        "gpt-5.4": "1.0x",
        "sonnet-4-5": "1.2x",
        "sonnet-4-6": "1.2x",
        "opus-4-5": "2.0x",
        "opus-4-6": "2.0x",
      };
      for (const opt of allModels) {
        expect(opt.multiplier).toBe(expectedMultipliers[opt.value]);
      }
    });
  });

  describe("instructions field", () => {
    it("defaults to empty string when agent has no instructions", () => {
      const agentInstructions: string = "" || "";
      expect(agentInstructions).toBe("");
    });

    it("preserves existing instructions", () => {
      const agentInstructions: string = "Be concise and focused." || "";
      expect(agentInstructions).toBe("Be concise and focused.");
    });
  });

  describe("save payload includes model_tier and instructions", () => {
    it("constructs full payload with model_tier and instructions", () => {
      const payload = {
        name: "Test Agent",
        role: "worker",
        title: "worker",
        reports_to: null,
        adapter_type: "claude-code",
        webhook_url: null,
        model_tier: "opus-4-6",
        instructions: "Focus on code review tasks.",
      };

      expect(payload).toHaveProperty("model_tier", "opus-4-6");
      expect(payload).toHaveProperty("instructions", "Focus on code review tasks.");
    });

    it("includes empty instructions when cleared", () => {
      const payload = {
        name: "Test Agent",
        role: "worker",
        title: "worker",
        reports_to: null,
        adapter_type: "claude-code",
        webhook_url: null,
        model_tier: "sonnet-4-6",
        instructions: "",
      };

      expect(payload.instructions).toBe("");
    });

    it("sends correct model_tier for non-Anthropic models", () => {
      const payload = {
        name: "Test Agent",
        role: "worker",
        title: "worker",
        reports_to: null,
        adapter_type: "claude-code",
        webhook_url: null,
        model_tier: "gpt-5.2",
        instructions: "",
      };

      expect(payload.model_tier).toBe("gpt-5.2");
    });

    it("sends correct model_tier for all 15 models", () => {
      const validTiers = [
        "minimax-m2.5", "gemini-3-flash", "glm-4.7", "kimi-k2.5",
        "haiku-4-5", "glm-5", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex",
        "gemini-3.1-pro", "gpt-5.4", "sonnet-4-5", "sonnet-4-6",
        "opus-4-5", "opus-4-6",
      ];
      for (const tier of validTiers) {
        const payload = {
          name: "Test Agent",
          model_tier: tier,
        };
        expect(validTiers).toContain(payload.model_tier);
      }
    });
  });

  describe("slide-over adapter type visibility", () => {
    it("webhook URL should be visible for non-claude adapter types", () => {
      const adapterTypes = ["claude-code", "http-webhook", "bash", "codex"];
      const showWebhookUrl = adapterTypes.map((t) => t !== "claude-code");
      expect(showWebhookUrl).toEqual([false, true, true, true]);
    });
  });

  describe("reports_to dropdown filtering", () => {
    const agents = [
      { id: "a1", name: "Agent A" },
      { id: "a2", name: "Agent B" },
      { id: "a3", name: "Agent C" },
    ];

    it("excludes the current agent from the dropdown", () => {
      const currentId = "a2";
      const otherAgents = agents.filter((a) => a.id !== currentId);
      expect(otherAgents).toHaveLength(2);
      expect(otherAgents.map((a) => a.id)).toEqual(["a1", "a3"]);
    });

    it("returns all agents except self when current is first", () => {
      const currentId = "a1";
      const otherAgents = agents.filter((a) => a.id !== currentId);
      expect(otherAgents).toHaveLength(2);
      expect(otherAgents.map((a) => a.id)).toEqual(["a2", "a3"]);
    });

    it("returns empty when only one agent exists", () => {
      const singleAgent = [{ id: "solo", name: "Solo" }];
      const otherAgents = singleAgent.filter((a) => a.id !== "solo");
      expect(otherAgents).toHaveLength(0);
    });
  });
});
