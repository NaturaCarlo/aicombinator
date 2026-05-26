/**
 * Tests for credit billing leak fixes:
 * - BUG 1: Model name mapping for Claude Code SDK vs LLM proxy
 * - BUG 2: Token usage includes cache_read_input_tokens
 * - BUG 3: Error path returns accumulated token usage
 * - Verify calculate_turn_credits uses actual token counts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MODEL_MAP, getOpenRouterModelId, isAnthropicModel } from "../../supervisor/src/model-routing.ts";
import { calculate_turn_credits } from "../../supervisor/src/credit-manager.ts";
import type { ModelTier, TokenUsage } from "../../supervisor/src/types.ts";

// ---------------------------------------------------------------------------
// BUG 1: Model name mapping — Claude Code SDK vs LLM proxy
// ---------------------------------------------------------------------------

describe("BUG 1: Claude Code SDK model names", () => {
  it("MODEL_MAP returns OpenRouter-prefixed names (for LLM proxy)", () => {
    expect(MODEL_MAP["sonnet-4-6"]).toBe("anthropic/claude-sonnet-4.6");
    expect(MODEL_MAP["opus-4-6"]).toBe("anthropic/claude-opus-4.6");
    expect(MODEL_MAP["haiku-4-5"]).toBe("anthropic/claude-haiku-4.5");
  });

  it("getClaudeCodeModelName returns bare Anthropic names for SDK", async () => {
    // This function should exist in model-routing.ts after the fix
    const { getClaudeCodeModelName } = await import("../../supervisor/src/model-routing.ts");
    expect(getClaudeCodeModelName("sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(getClaudeCodeModelName("opus-4-6")).toBe("claude-opus-4-6");
    expect(getClaudeCodeModelName("haiku-4-5")).toBe("claude-haiku-4-5");
    expect(getClaudeCodeModelName("sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(getClaudeCodeModelName("opus-4-5")).toBe("claude-opus-4-5");
  });

  it("getClaudeCodeModelName falls back to sonnet for unknown tiers", async () => {
    const { getClaudeCodeModelName } = await import("../../supervisor/src/model-routing.ts");
    expect(getClaudeCodeModelName("unknown-model" as ModelTier)).toBe("claude-sonnet-4-6");
  });

  it("getClaudeCodeModelName handles legacy tier names", async () => {
    const { getClaudeCodeModelName } = await import("../../supervisor/src/model-routing.ts");
    expect(getClaudeCodeModelName("sonnet")).toBe("claude-sonnet-4-6");
    expect(getClaudeCodeModelName("opus")).toBe("claude-opus-4-6");
    expect(getClaudeCodeModelName("haiku")).toBe("claude-haiku-4-5");
  });

  it("OpenRouter names and SDK names are different formats", async () => {
    const { getClaudeCodeModelName } = await import("../../supervisor/src/model-routing.ts");
    // OpenRouter uses "anthropic/claude-sonnet-4.6" (dot in version)
    // SDK uses "claude-sonnet-4-6" (hyphen in version, no prefix)
    const openRouterId = getOpenRouterModelId("sonnet-4-6");
    const sdkId = getClaudeCodeModelName("sonnet-4-6");
    
    expect(openRouterId).toContain("anthropic/");
    expect(sdkId).not.toContain("anthropic/");
    expect(openRouterId).not.toBe(sdkId);
  });
});

// ---------------------------------------------------------------------------
// BUG 2: Token usage includes cache_read_input_tokens
// ---------------------------------------------------------------------------

describe("BUG 2: cache_read_input_tokens in token extraction", () => {
  it("calculate_turn_credits accounts for cached tokens at 0.1x rate", () => {
    const usage: TokenUsage = {
      inputTokens: 5_000,
      outputTokens: 2_000,
      cacheReadInputTokens: 100_000,
    };
    // sonnet: (5000 + 2000) * 1.2 + 100000 * 1.2 * 0.1 = 8400 + 12000 = 20400
    expect(calculate_turn_credits("sonnet", usage)).toBe(20_400);
  });

  it("without cache_read_input_tokens, billing is drastically lower", () => {
    const withCache: TokenUsage = {
      inputTokens: 5_000,
      outputTokens: 2_000,
      cacheReadInputTokens: 100_000,
    };
    const withoutCache: TokenUsage = {
      inputTokens: 5_000,
      outputTokens: 2_000,
    };
    // With cache: 20400 credits
    // Without cache: 8400 credits (missing 12000 credits = 58% undercharge)
    const creditsWithCache = calculate_turn_credits("sonnet", withCache);
    const creditsWithoutCache = calculate_turn_credits("sonnet", withoutCache);
    expect(creditsWithCache).toBeGreaterThan(creditsWithoutCache);
    expect(creditsWithCache - creditsWithoutCache).toBe(12_000);
  });

  it("heavy caching scenario: 90% cached tokens", () => {
    // Typical Claude Code conversation: 90%+ input tokens are cached
    const usage: TokenUsage = {
      inputTokens: 10_000,      // 10% uncached
      outputTokens: 5_000,
      cacheReadInputTokens: 90_000,  // 90% cached
    };
    // sonnet: (10000 + 5000) * 1.2 + 90000 * 1.2 * 0.1 = 18000 + 10800 = 28800
    const credits = calculate_turn_credits("sonnet", usage);
    expect(credits).toBe(28_800);
    
    // Without caching: only 18000 credits (38% undercharge)
    const noCacheCredits = calculate_turn_credits("sonnet", {
      inputTokens: 10_000,
      outputTokens: 5_000,
    });
    expect(noCacheCredits).toBe(18_000);
  });
});

// ---------------------------------------------------------------------------
// BUG 3: Error path should return accumulated token usage
// ---------------------------------------------------------------------------

describe("BUG 3: Error path accumulated token usage", () => {
  it("calculate_turn_credits with zero tokens returns 1 (minimum)", () => {
    // This is the current bug: errors return {inputTokens: 0, outputTokens: 0}
    // which calculate_turn_credits converts to Math.max(1, 0) = 1
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(calculate_turn_credits("sonnet", usage)).toBe(1);
  });

  it("actual partial usage should produce meaningful credit count", () => {
    // Even if an error occurred, partial tokens were consumed
    const partialUsage: TokenUsage = {
      inputTokens: 50_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 30_000,
    };
    // sonnet: (50000 + 1000) * 1.2 + 30000 * 1.2 * 0.1 = 61200 + 3600 = 64800
    expect(calculate_turn_credits("sonnet", partialUsage)).toBe(64_800);
    // This should be billed, not 1 credit
  });
});

// ---------------------------------------------------------------------------
// Integration: credit deductions reflect actual API usage
// ---------------------------------------------------------------------------

describe("Credit deductions reflect actual API usage", () => {
  it("a realistic sonnet turn with caching costs significantly more than 1 credit", () => {
    // Realistic values for a Claude Code turn
    const usage: TokenUsage = {
      inputTokens: 20_000,
      outputTokens: 8_000,
      cacheReadInputTokens: 180_000,
    };
    // sonnet: (20000 + 8000) * 1.2 + 180000 * 1.2 * 0.1 = 33600 + 21600 = 55200
    const credits = calculate_turn_credits("sonnet", usage);
    expect(credits).toBe(55_200);
    expect(credits).toBeGreaterThan(1);
  });

  it("opus turns are appropriately expensive", () => {
    const usage: TokenUsage = {
      inputTokens: 30_000,
      outputTokens: 15_000,
      cacheReadInputTokens: 200_000,
    };
    // opus: (30000 + 15000) * 2.0 + 200000 * 2.0 * 0.1 = 90000 + 40000 = 130000
    const credits = calculate_turn_credits("opus", usage);
    expect(credits).toBe(130_000);
  });
});
