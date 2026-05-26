/**
 * Comprehensive unit tests for the Standard Token pricing model.
 *
 * Tests cover:
 * - Model multipliers for all tiers
 * - calculate_turn_credits with the new formula
 * - Cached token support (cacheReadInputTokens at 0.1x)
 * - calculate_turn_credit_reservation with new scale
 * - fit_turn_limits_to_available_credits with token-scale budgets
 * - CreditManager reserve/settle/deduct mechanics with new units
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  calculate_turn_credits,
  calculate_turn_credit_reservation,
  fit_turn_limits_to_available_credits,
  MODEL_MULTIPLIERS,
  CreditManager,
} from "../../supervisor/src/credit-manager.ts";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import type { ModelTier, TokenUsage, TurnLimits } from "../../supervisor/src/types.ts";

// ---------------------------------------------------------------------------
// Model Multipliers
// ---------------------------------------------------------------------------

describe("MODEL_MULTIPLIERS", () => {
  // 15 primary models
  it("has correct multiplier for minimax-m2.5 (0.12x)", () => {
    expect(MODEL_MULTIPLIERS["minimax-m2.5"]).toBe(0.12);
  });

  it("has correct multiplier for gemini-3-flash (0.2x)", () => {
    expect(MODEL_MULTIPLIERS["gemini-3-flash"]).toBe(0.2);
  });

  it("has correct multiplier for glm-4.7 (0.25x)", () => {
    expect(MODEL_MULTIPLIERS["glm-4.7"]).toBe(0.25);
  });

  it("has correct multiplier for kimi-k2.5 (0.25x)", () => {
    expect(MODEL_MULTIPLIERS["kimi-k2.5"]).toBe(0.25);
  });

  it("has correct multiplier for haiku-4-5 (0.4x)", () => {
    expect(MODEL_MULTIPLIERS["haiku-4-5"]).toBe(0.4);
  });

  it("has correct multiplier for glm-5 (0.4x)", () => {
    expect(MODEL_MULTIPLIERS["glm-5"]).toBe(0.4);
  });

  it("has correct multiplier for gpt-5.2 (0.7x)", () => {
    expect(MODEL_MULTIPLIERS["gpt-5.2"]).toBe(0.7);
  });

  it("has correct multiplier for gpt-5.2-codex (0.7x)", () => {
    expect(MODEL_MULTIPLIERS["gpt-5.2-codex"]).toBe(0.7);
  });

  it("has correct multiplier for gpt-5.3-codex (0.7x)", () => {
    expect(MODEL_MULTIPLIERS["gpt-5.3-codex"]).toBe(0.7);
  });

  it("has correct multiplier for gemini-3.1-pro (0.8x)", () => {
    expect(MODEL_MULTIPLIERS["gemini-3.1-pro"]).toBe(0.8);
  });

  it("has correct multiplier for gpt-5.4 (1.0x)", () => {
    expect(MODEL_MULTIPLIERS["gpt-5.4"]).toBe(1.0);
  });

  it("has correct multiplier for sonnet-4-5 (1.2x)", () => {
    expect(MODEL_MULTIPLIERS["sonnet-4-5"]).toBe(1.2);
  });

  it("has correct multiplier for sonnet-4-6 (1.2x)", () => {
    expect(MODEL_MULTIPLIERS["sonnet-4-6"]).toBe(1.2);
  });

  it("has correct multiplier for opus-4-5 (2.0x)", () => {
    expect(MODEL_MULTIPLIERS["opus-4-5"]).toBe(2.0);
  });

  it("has correct multiplier for opus-4-6 (2.0x)", () => {
    expect(MODEL_MULTIPLIERS["opus-4-6"]).toBe(2.0);
  });

  // Legacy backward compatibility
  it("has correct multiplier for legacy haiku (0.4x)", () => {
    expect(MODEL_MULTIPLIERS.haiku).toBe(0.4);
  });

  it("has correct multiplier for legacy sonnet (1.2x)", () => {
    expect(MODEL_MULTIPLIERS.sonnet).toBe(1.2);
  });

  it("has correct multiplier for legacy opus (2.0x)", () => {
    expect(MODEL_MULTIPLIERS.opus).toBe(2.0);
  });

  it("has correct multiplier for legacy gpt4o-mini (0.1x)", () => {
    expect(MODEL_MULTIPLIERS["gpt4o-mini"]).toBe(0.1);
  });

  it("covers all 15 primary ModelTier values", () => {
    const primaryTiers: ModelTier[] = [
      "minimax-m2.5", "gemini-3-flash", "glm-4.7", "kimi-k2.5",
      "haiku-4-5", "glm-5", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex",
      "gemini-3.1-pro", "gpt-5.4", "sonnet-4-5", "sonnet-4-6",
      "opus-4-5", "opus-4-6",
    ];
    for (const tier of primaryTiers) {
      expect(MODEL_MULTIPLIERS[tier]).toBeDefined();
      expect(typeof MODEL_MULTIPLIERS[tier]).toBe("number");
    }
  });

  it("does NOT include opus-4-6-fast (12x)", () => {
    expect(MODEL_MULTIPLIERS["opus-4-6-fast" as ModelTier]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// calculate_turn_credits
// ---------------------------------------------------------------------------

describe("calculate_turn_credits", () => {
  it("formula: standard_tokens = (input + output) * multiplier", () => {
    const usage: TokenUsage = { inputTokens: 10_000, outputTokens: 5_000 };
    // sonnet: (10000 + 5000) * 1.2 = 18000
    expect(calculate_turn_credits("sonnet", usage)).toBe(18_000);
  });

  it("calculates correctly for haiku (0.4x)", () => {
    const usage: TokenUsage = { inputTokens: 50_000, outputTokens: 10_000 };
    // (50000 + 10000) * 0.4 = 24000
    expect(calculate_turn_credits("haiku", usage)).toBe(24_000);
  });

  it("calculates correctly for opus (2.0x)", () => {
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 20_000 };
    // (100000 + 20000) * 2.0 = 240000
    expect(calculate_turn_credits("opus", usage)).toBe(240_000);
  });

  it("calculates correctly for gpt4o-mini (0.1x)", () => {
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 50_000 };
    // (100000 + 50000) * 0.1 = 15000
    expect(calculate_turn_credits("gpt4o-mini", usage)).toBe(15_000);
  });

  it("returns minimum of 1 for zero tokens", () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(calculate_turn_credits("sonnet", usage)).toBe(1);
  });

  it("returns minimum of 1 for very small token counts", () => {
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 0 };
    // 1 * 0.1 = 0.1 → ceil = 1
    expect(calculate_turn_credits("gpt4o-mini", usage)).toBe(1);
  });

  it("ceils fractional results", () => {
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 0 };
    // 1 * 1.2 = 1.2 → ceil = 2
    expect(calculate_turn_credits("sonnet", usage)).toBe(2);
  });

  it("falls back to sonnet multiplier for unknown model tier", () => {
    const usage: TokenUsage = { inputTokens: 10_000, outputTokens: 5_000 };
    // (10000 + 5000) * 1.2 (sonnet fallback) = 18000
    expect(calculate_turn_credits("unknown-model" as ModelTier, usage)).toBe(18_000);
  });

  // Cached token tests
  it("applies 0.1x discount for cached tokens", () => {
    const usage: TokenUsage = {
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadInputTokens: 50_000,
    };
    // sonnet: (10000 + 5000) * 1.2 + 50000 * 1.2 * 0.1 = 18000 + 6000 = 24000
    expect(calculate_turn_credits("sonnet", usage)).toBe(24_000);
  });

  it("cached tokens with haiku multiplier", () => {
    const usage: TokenUsage = {
      inputTokens: 5_000,
      outputTokens: 2_000,
      cacheReadInputTokens: 100_000,
    };
    // haiku: (5000 + 2000) * 0.4 + 100000 * 0.4 * 0.1 = 2800 + 4000 = 6800
    expect(calculate_turn_credits("haiku", usage)).toBe(6_800);
  });

  it("cached tokens with opus multiplier", () => {
    const usage: TokenUsage = {
      inputTokens: 20_000,
      outputTokens: 10_000,
      cacheReadInputTokens: 80_000,
    };
    // opus: (20000 + 10000) * 2.0 + 80000 * 2.0 * 0.1 = 60000 + 16000 = 76000
    expect(calculate_turn_credits("opus", usage)).toBe(76_000);
  });

  it("cacheReadInputTokens = 0 has no effect", () => {
    const withoutCache: TokenUsage = { inputTokens: 10_000, outputTokens: 5_000 };
    const withZeroCache: TokenUsage = { inputTokens: 10_000, outputTokens: 5_000, cacheReadInputTokens: 0 };
    expect(calculate_turn_credits("sonnet", withoutCache))
      .toBe(calculate_turn_credits("sonnet", withZeroCache));
  });

  it("cacheReadInputTokens undefined has no effect", () => {
    const withoutCache: TokenUsage = { inputTokens: 10_000, outputTokens: 5_000 };
    const withUndefined: TokenUsage = { inputTokens: 10_000, outputTokens: 5_000, cacheReadInputTokens: undefined };
    expect(calculate_turn_credits("sonnet", withoutCache))
      .toBe(calculate_turn_credits("sonnet", withUndefined));
  });

  it("large realistic turn: 200K input + 64K output with sonnet", () => {
    const usage: TokenUsage = { inputTokens: 200_000, outputTokens: 64_000 };
    // (200000 + 64000) * 1.2 = 316800
    expect(calculate_turn_credits("sonnet", usage)).toBe(316_800);
  });

  it("large realistic turn with heavy caching", () => {
    const usage: TokenUsage = {
      inputTokens: 50_000,
      outputTokens: 64_000,
      cacheReadInputTokens: 150_000,
    };
    // sonnet: (50000 + 64000) * 1.2 + 150000 * 1.2 * 0.1 = 136800 + 18000 = 154800
    expect(calculate_turn_credits("sonnet", usage)).toBe(154_800);
  });
});

// ---------------------------------------------------------------------------
// calculate_turn_credit_reservation
// ---------------------------------------------------------------------------

describe("calculate_turn_credit_reservation", () => {
  const defaultLimits = {
    maxCreditsPerTurn: 500_000,
    maxTokensInput: 200_000,
    maxTokensOutput: 64_000,
  };

  it("returns token ceiling when below maxCreditsPerTurn", () => {
    // sonnet: (200000 + 64000) * 1.2 = 316800 < 500000
    const reservation = calculate_turn_credit_reservation("sonnet", defaultLimits);
    expect(reservation).toBe(316_800);
  });

  it("caps at maxCreditsPerTurn when token ceiling exceeds it", () => {
    const tightLimits = {
      maxCreditsPerTurn: 100_000,
      maxTokensInput: 200_000,
      maxTokensOutput: 64_000,
    };
    const reservation = calculate_turn_credit_reservation("opus", tightLimits);
    // opus: (200000 + 64000) * 2.0 = 528000, but capped at 100000
    expect(reservation).toBe(100_000);
  });

  it("returns minimum of 1", () => {
    const zeroLimits = {
      maxCreditsPerTurn: 0,
      maxTokensInput: 0,
      maxTokensOutput: 0,
    };
    expect(calculate_turn_credit_reservation("sonnet", zeroLimits)).toBe(1);
  });

  it("works with gpt4o-mini (small multiplier)", () => {
    // (200000 + 64000) * 0.1 = 26400
    const reservation = calculate_turn_credit_reservation("gpt4o-mini", defaultLimits);
    expect(reservation).toBe(26_400);
  });
});

// ---------------------------------------------------------------------------
// fit_turn_limits_to_available_credits
// ---------------------------------------------------------------------------

describe("fit_turn_limits_to_available_credits", () => {
  const baseLimits: TurnLimits = {
    maxCreditsPerTurn: 500_000,
    maxTokensInput: 200_000,
    maxTokensOutput: 64_000,
    maxToolCallsPerTurn: 200,
    maxInferenceRoundsPerTurn: 50,
    turnTimeoutMs: 3_600_000,
  };

  it("returns original limits when budget is sufficient", () => {
    const fitted = fit_turn_limits_to_available_credits("sonnet", baseLimits, 1_000_000);
    expect(fitted).toEqual(baseLimits);
  });

  it("scales down when budget is tight", () => {
    // sonnet reservation: 316800. If we only have 100000 available:
    const fitted = fit_turn_limits_to_available_credits("sonnet", baseLimits, 100_000);
    expect(fitted.maxCreditsPerTurn).toBeLessThanOrEqual(100_000);
    expect(fitted.maxTokensInput).toBeLessThan(baseLimits.maxTokensInput);
    expect(fitted.maxTokensOutput).toBeLessThan(baseLimits.maxTokensOutput);
    // minimums enforced
    expect(fitted.maxTokensInput).toBeGreaterThanOrEqual(2_000);
    expect(fitted.maxTokensOutput).toBeGreaterThanOrEqual(1_000);
  });

  it("preserves non-token limits when scaling", () => {
    const fitted = fit_turn_limits_to_available_credits("sonnet", baseLimits, 50_000);
    expect(fitted.maxToolCallsPerTurn).toBe(200);
    expect(fitted.maxInferenceRoundsPerTurn).toBe(50);
    expect(fitted.turnTimeoutMs).toBe(3_600_000);
  });

  it("works with very small budgets", () => {
    const fitted = fit_turn_limits_to_available_credits("sonnet", baseLimits, 5_000);
    expect(fitted.maxTokensInput).toBeGreaterThanOrEqual(2_000);
    expect(fitted.maxTokensOutput).toBeGreaterThanOrEqual(1_000);
    expect(fitted.maxCreditsPerTurn).toBeLessThanOrEqual(5_000);
  });

  it("returns unchanged limits for opus when budget is large", () => {
    // opus reservation: (200000 + 64000) * 2.0 = 528000
    const fitted = fit_turn_limits_to_available_credits("opus", baseLimits, 1_000_000);
    expect(fitted).toEqual(baseLimits);
  });
});

// ---------------------------------------------------------------------------
// CreditManager with new token scale
// ---------------------------------------------------------------------------

describe("CreditManager with standard tokens", () => {
  let db: SupervisorDb;
  let cm: CreditManager;

  function seedBalance(userId: string, balance: number) {
    db.run(
      `INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance`,
      [userId, balance, isoNow()],
    );
  }

  function seedCompany(companyId: string, userId: string) {
    const now = isoNow();
    db.run(
      `INSERT OR IGNORE INTO companies (id, user_id, name, goal, state, workspace_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, userId, "Test Co", "Goal", "running", "/tmp/ws", now, now],
    );
  }

  beforeEach(() => {
    db = new SupervisorDb(":memory:");
    db.migrate();
    cm = new CreditManager(db);
  });

  it("get_balance returns token-scale balance", () => {
    seedBalance("user-1", 20_000_000);
    expect(cm.get_balance("user-1")).toBe(20_000_000);
  });

  it("reserve_credits works with token-scale amounts", () => {
    seedBalance("user-1", 20_000_000);
    seedCompany("comp-1", "user-1");
    const reserved = cm.reserve_credits("user-1", 316_800, "comp-1");
    expect(reserved).toBe(true);
    // Available = 20M - 316800
    expect(cm.get_balance("user-1")).toBe(20_000_000 - 316_800);
  });

  it("reserve_credits fails when insufficient balance", () => {
    seedBalance("user-1", 100_000);
    seedCompany("comp-1", "user-1");
    const reserved = cm.reserve_credits("user-1", 200_000, "comp-1");
    expect(reserved).toBe(false);
  });

  it("settle_reserved_credits works with token-scale", () => {
    seedBalance("user-1", 20_000_000);
    seedCompany("comp-1", "user-1");
    cm.reserve_credits("user-1", 316_800, "comp-1");

    const deducted = cm.settle_reserved_credits("user-1", 316_800, 200_000, {
      company_id: "comp-1",
      model_tier: "sonnet",
    });
    expect(deducted).toBe(200_000);
    // Balance: 20M - 200K actual = 19.8M
    expect(cm.get_total_balance("user-1")).toBe(19_800_000);
  });

  it("deduct_credits works with token-scale", () => {
    seedBalance("user-1", 5_000_000);
    const remaining = cm.deduct_credits("user-1", 1_000_000, {
      company_id: "comp-1",
      description: "Test deduction",
    });
    expect(remaining).toBe(4_000_000);
  });

  it("apply_credit_purchase adds tokens correctly", () => {
    seedBalance("user-1", 5_000_000);
    cm.apply_credit_purchase("user-1", 20_000_000);
    expect(cm.get_total_balance("user-1")).toBe(25_000_000);
  });

  it("pauses companies when balance reaches zero", () => {
    seedBalance("user-1", 1_000);
    seedCompany("comp-1", "user-1");
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["agent-1", "comp-1", "ceo", "CEO", "ceo", "sonnet", "idle", 0, "internal", isoNow(), isoNow()],
    );

    cm.deduct_credits("user-1", 1_000);
    const company = db.get<{ state: string }>(`SELECT state FROM companies WHERE id = ?`, ["comp-1"]);
    expect(company?.state).toBe("paused");
  });
});
