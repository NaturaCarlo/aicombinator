import { describe, it, expect } from "vitest";
import { formatTokens, formatTokenCount, getModelMultipliers } from "../../dashboard/src/lib/credits";
import { MODEL_MULTIPLIERS, MULTIPLIER_VALUES, SUBSCRIPTION_TIERS, TOKENS_PER_DOLLAR } from "../../dashboard/src/lib/pricing-config";

describe("formatTokens — always millions format for balance displays", () => {
  it("returns '0.0M tokens' for 0", () => {
    expect(formatTokens(0)).toBe("0.0M tokens");
  });

  it("returns '0.0M tokens' for small values below 1K", () => {
    expect(formatTokens(500)).toBe("0.0M tokens");
    expect(formatTokens(1)).toBe("0.0M tokens");
    expect(formatTokens(999)).toBe("0.0M tokens");
  });

  it("returns K format for values between 1K and 1M", () => {
    expect(formatTokens(1_000)).toBe("1K tokens");
    expect(formatTokens(5_000)).toBe("5K tokens");
    expect(formatTokens(500_000)).toBe("500K tokens");
    expect(formatTokens(999_999)).toBe("1000K tokens");
    expect(formatTokens(123_456)).toBe("123K tokens");
  });

  it("returns M format for values ≥ 1M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M tokens");
    expect(formatTokens(5_200_000)).toBe("5.2M tokens");
    expect(formatTokens(20_000_000)).toBe("20.0M tokens");
    expect(formatTokens(200_000_000)).toBe("200.0M tokens");
  });

  it("returns '—' for null, undefined, and NaN", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(NaN)).toBe("—");
  });

  it("clamps negative values to 0.0M tokens", () => {
    expect(formatTokens(-100)).toBe("0.0M tokens");
    expect(formatTokens(-1_000_000)).toBe("0.0M tokens");
  });
});

describe("formatTokenCount — raw count without 'tokens' suffix", () => {
  it("returns '0.0M' for 0", () => {
    expect(formatTokenCount(0)).toBe("0.0M");
  });

  it("returns K format for values between 1K and 1M", () => {
    expect(formatTokenCount(5_000)).toBe("5K");
    expect(formatTokenCount(500_000)).toBe("500K");
  });

  it("returns M format for values ≥ 1M", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(20_000_000)).toBe("20.0M");
  });

  it("returns '—' for null/undefined/NaN", () => {
    expect(formatTokenCount(null)).toBe("—");
    expect(formatTokenCount(undefined)).toBe("—");
    expect(formatTokenCount(NaN)).toBe("—");
  });
});

describe("pricing-config — MODEL_MULTIPLIERS", () => {
  it("has all 15 primary models with correct multipliers", () => {
    expect(MODEL_MULTIPLIERS["minimax-m2.5"].multiplier).toBe(0.12);
    expect(MODEL_MULTIPLIERS["gemini-3-flash"].multiplier).toBe(0.2);
    expect(MODEL_MULTIPLIERS["glm-4.7"].multiplier).toBe(0.25);
    expect(MODEL_MULTIPLIERS["kimi-k2.5"].multiplier).toBe(0.25);
    expect(MODEL_MULTIPLIERS["haiku-4-5"].multiplier).toBe(0.4);
    expect(MODEL_MULTIPLIERS["glm-5"].multiplier).toBe(0.4);
    expect(MODEL_MULTIPLIERS["gpt-5.2"].multiplier).toBe(0.7);
    expect(MODEL_MULTIPLIERS["gpt-5.2-codex"].multiplier).toBe(0.7);
    expect(MODEL_MULTIPLIERS["gpt-5.3-codex"].multiplier).toBe(0.7);
    expect(MODEL_MULTIPLIERS["gemini-3.1-pro"].multiplier).toBe(0.8);
    expect(MODEL_MULTIPLIERS["gpt-5.4"].multiplier).toBe(1.0);
    expect(MODEL_MULTIPLIERS["sonnet-4-5"].multiplier).toBe(1.2);
    expect(MODEL_MULTIPLIERS["sonnet-4-6"].multiplier).toBe(1.2);
    expect(MODEL_MULTIPLIERS["opus-4-5"].multiplier).toBe(2.0);
    expect(MODEL_MULTIPLIERS["opus-4-6"].multiplier).toBe(2.0);
  });

  it("has exactly 15 primary model entries", () => {
    expect(Object.keys(MODEL_MULTIPLIERS)).toHaveLength(15);
  });

  it("has display names for all 15 models", () => {
    expect(MODEL_MULTIPLIERS["minimax-m2.5"].name).toBe("MiniMax M2.5");
    expect(MODEL_MULTIPLIERS["gemini-3-flash"].name).toBe("Gemini 3 Flash");
    expect(MODEL_MULTIPLIERS["glm-4.7"].name).toBe("GLM-4.7");
    expect(MODEL_MULTIPLIERS["kimi-k2.5"].name).toBe("Kimi K2.5");
    expect(MODEL_MULTIPLIERS["haiku-4-5"].name).toBe("Haiku 4.5");
    expect(MODEL_MULTIPLIERS["glm-5"].name).toBe("GLM-5");
    expect(MODEL_MULTIPLIERS["gpt-5.2"].name).toBe("GPT-5.2");
    expect(MODEL_MULTIPLIERS["gpt-5.2-codex"].name).toBe("GPT-5.2-Codex");
    expect(MODEL_MULTIPLIERS["gpt-5.3-codex"].name).toBe("GPT-5.3-Codex");
    expect(MODEL_MULTIPLIERS["gemini-3.1-pro"].name).toBe("Gemini 3.1 Pro");
    expect(MODEL_MULTIPLIERS["gpt-5.4"].name).toBe("GPT-5.4");
    expect(MODEL_MULTIPLIERS["sonnet-4-5"].name).toBe("Sonnet 4.5");
    expect(MODEL_MULTIPLIERS["sonnet-4-6"].name).toBe("Sonnet 4.6");
    expect(MODEL_MULTIPLIERS["opus-4-5"].name).toBe("Opus 4.5");
    expect(MODEL_MULTIPLIERS["opus-4-6"].name).toBe("Opus 4.6");
  });

  it("MULTIPLIER_VALUES has legacy alias keys", () => {
    expect(MULTIPLIER_VALUES["haiku"]).toBe(0.4);
    expect(MULTIPLIER_VALUES["sonnet"]).toBe(1.2);
    expect(MULTIPLIER_VALUES["opus"]).toBe(2.0);
    expect(MULTIPLIER_VALUES["gpt-4o-mini"]).toBe(0.1);
  });

  it("MULTIPLIER_VALUES has all 15 primary model keys", () => {
    expect(MULTIPLIER_VALUES["minimax-m2.5"]).toBe(0.12);
    expect(MULTIPLIER_VALUES["gemini-3-flash"]).toBe(0.2);
    expect(MULTIPLIER_VALUES["glm-4.7"]).toBe(0.25);
    expect(MULTIPLIER_VALUES["kimi-k2.5"]).toBe(0.25);
    expect(MULTIPLIER_VALUES["haiku-4-5"]).toBe(0.4);
    expect(MULTIPLIER_VALUES["glm-5"]).toBe(0.4);
    expect(MULTIPLIER_VALUES["gpt-5.2"]).toBe(0.7);
    expect(MULTIPLIER_VALUES["gpt-5.2-codex"]).toBe(0.7);
    expect(MULTIPLIER_VALUES["gpt-5.3-codex"]).toBe(0.7);
    expect(MULTIPLIER_VALUES["gemini-3.1-pro"]).toBe(0.8);
    expect(MULTIPLIER_VALUES["gpt-5.4"]).toBe(1.0);
    expect(MULTIPLIER_VALUES["sonnet-4-5"]).toBe(1.2);
    expect(MULTIPLIER_VALUES["sonnet-4-6"]).toBe(1.2);
    expect(MULTIPLIER_VALUES["opus-4-5"]).toBe(2.0);
    expect(MULTIPLIER_VALUES["opus-4-6"]).toBe(2.0);
  });

  it("matches getModelMultipliers from credits.ts", () => {
    const creditsMultipliers = getModelMultipliers();
    expect(creditsMultipliers["haiku"]).toBe(MULTIPLIER_VALUES["haiku"]);
    expect(creditsMultipliers["sonnet-4-6"]).toBe(MULTIPLIER_VALUES["sonnet-4-6"]);
    expect(creditsMultipliers["opus-4-6"]).toBe(MULTIPLIER_VALUES["opus-4-6"]);
    expect(creditsMultipliers["gpt-5.2"]).toBe(MULTIPLIER_VALUES["gpt-5.2"]);
    expect(creditsMultipliers["minimax-m2.5"]).toBe(MULTIPLIER_VALUES["minimax-m2.5"]);
  });
});

describe("pricing-config — subscription tiers", () => {
  it("Pro tier: $20/month = 20M tokens", () => {
    expect(SUBSCRIPTION_TIERS.pro.priceUsd).toBe(20);
    expect(SUBSCRIPTION_TIERS.pro.monthlyTokens).toBe(20_000_000);
  });

  it("Max tier: $200/month = 200M tokens", () => {
    expect(SUBSCRIPTION_TIERS.max.priceUsd).toBe(200);
    expect(SUBSCRIPTION_TIERS.max.monthlyTokens).toBe(200_000_000);
  });

  it("conversion rate: 1M tokens = $1", () => {
    expect(TOKENS_PER_DOLLAR).toBe(1_000_000);
  });
});
