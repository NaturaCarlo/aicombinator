/**
 * Factory Standard Token pricing configuration.
 *
 * These multipliers are static and hardcoded to avoid CORS issues
 * when fetching from api.aicombinator.live/api/billing/pricing.
 * The dashboard uses a service binding to the worker, not direct HTTP,
 * so we embed the constants directly.
 *
 * Source: docs.factory.ai/pricing
 */

/** Model multipliers for converting raw tokens to standard tokens */
export const MODEL_MULTIPLIERS = {
  "minimax-m2.5": { name: "MiniMax M2.5", multiplier: 0.12 },
  "gemini-3-flash": { name: "Gemini 3 Flash", multiplier: 0.2 },
  "glm-4.7": { name: "GLM-4.7", multiplier: 0.25 },
  "kimi-k2.5": { name: "Kimi K2.5", multiplier: 0.25 },
  "haiku-4-5": { name: "Haiku 4.5", multiplier: 0.4 },
  "glm-5": { name: "GLM-5", multiplier: 0.4 },
  "gpt-5.2": { name: "GPT-5.2", multiplier: 0.7 },
  "gpt-5.2-codex": { name: "GPT-5.2-Codex", multiplier: 0.7 },
  "gpt-5.3-codex": { name: "GPT-5.3-Codex", multiplier: 0.7 },
  "gemini-3.1-pro": { name: "Gemini 3.1 Pro", multiplier: 0.8 },
  "gpt-5.4": { name: "GPT-5.4", multiplier: 1.0 },
  "sonnet-4-5": { name: "Sonnet 4.5", multiplier: 1.2 },
  "sonnet-4-6": { name: "Sonnet 4.6", multiplier: 1.2 },
  "opus-4-5": { name: "Opus 4.5", multiplier: 2.0 },
  "opus-4-6": { name: "Opus 4.6", multiplier: 2.0 },
} as const;

/** Flat multiplier lookup by key (matches credit-manager keys) */
export const MULTIPLIER_VALUES: Record<string, number> = {
  // 15 primary models
  "minimax-m2.5": 0.12,
  "gemini-3-flash": 0.2,
  "glm-4.7": 0.25,
  "kimi-k2.5": 0.25,
  "haiku-4-5": 0.4,
  "glm-5": 0.4,
  "gpt-5.2": 0.7,
  "gpt-5.2-codex": 0.7,
  "gpt-5.3-codex": 0.7,
  "gemini-3.1-pro": 0.8,
  "gpt-5.4": 1.0,
  "sonnet-4-5": 1.2,
  "sonnet-4-6": 1.2,
  "opus-4-5": 2.0,
  "opus-4-6": 2.0,
  // Legacy tier names (backward compatibility)
  haiku: 0.4,
  sonnet: 1.2,
  opus: 2.0,
  "gpt4o-mini": 0.1,
  "gpt-4o-mini": 0.1,
};

/** Subscription tiers */
export const SUBSCRIPTION_TIERS = {
  pro: {
    name: "Pro",
    priceUsd: 20,
    monthlyTokens: 20_000_000,
  },
  max: {
    name: "Max",
    priceUsd: 200,
    monthlyTokens: 200_000_000,
  },
} as const;

/** Conversion rate: 1M standard tokens = $1 */
export const TOKENS_PER_DOLLAR = 1_000_000;

/** Cached token discount factor (1/10th of standard cost) */
export const CACHED_TOKEN_DISCOUNT = 0.1;
