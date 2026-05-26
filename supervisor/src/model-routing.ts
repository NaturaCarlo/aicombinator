/**
 * Model routing utilities — detect provider from ModelTier and map to OpenRouter IDs.
 *
 * Used by the LLM proxy and claude-code adapter to route requests to the
 * correct upstream provider (Anthropic API direct vs OpenRouter).
 */

import type { ModelTier } from "./types.js";

/**
 * Complete model mapping: ModelTier → OpenRouter model ID.
 * This is the single source of truth for model ID routing.
 */
export const MODEL_MAP: Record<ModelTier, string> = {
  // 15 primary models
  "minimax-m2.5": "minimax/minimax-m2.5",
  "gemini-3-flash": "google/gemini-3-flash-preview",
  "glm-4.7": "z-ai/glm-4.7",
  "kimi-k2.5": "moonshotai/kimi-k2.5",
  "haiku-4-5": "anthropic/claude-haiku-4.5",
  "glm-5": "z-ai/glm-5",
  "gpt-5.2": "openai/gpt-5.2",
  "gpt-5.2-codex": "openai/gpt-5.2-codex",
  "gpt-5.3-codex": "openai/gpt-5.3-codex",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
  "gpt-5.4": "openai/gpt-5.4",
  "sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "opus-4-5": "anthropic/claude-opus-4.5",
  "opus-4-6": "anthropic/claude-opus-4.6",
  // Legacy tier names (backward compatibility)
  opus: "anthropic/claude-opus-4.6",
  sonnet: "anthropic/claude-sonnet-4.6",
  haiku: "anthropic/claude-haiku-4.5",
  "gpt4o-mini": "anthropic/claude-sonnet-4.6",
};

/**
 * Get the OpenRouter model ID for a given ModelTier.
 * Falls back to sonnet if the tier is unknown.
 */
export function getOpenRouterModelId(tier: ModelTier): string {
  return MODEL_MAP[tier] ?? MODEL_MAP.sonnet;
}

/**
 * Extract the provider prefix from an OpenRouter model ID.
 * e.g., "anthropic/claude-sonnet-4.6" → "anthropic"
 *       "openai/gpt-5.2" → "openai"
 */
function extractProvider(openRouterModelId: string): string {
  const slashIndex = openRouterModelId.indexOf("/");
  if (slashIndex === -1) return "anthropic"; // fallback
  return openRouterModelId.substring(0, slashIndex);
}

/**
 * Get the provider name for a given ModelTier.
 * Returns the provider prefix from the OpenRouter model ID.
 *
 * Possible values: "anthropic", "openai", "google", "z-ai", "moonshotai", "minimax"
 * Falls back to "anthropic" for unknown tiers.
 */
export function getModelProvider(tier: ModelTier): string {
  const modelId = MODEL_MAP[tier];
  if (!modelId) return "anthropic"; // safe fallback for unknown tiers
  return extractProvider(modelId);
}

/**
 * Check if a ModelTier maps to an Anthropic model.
 * This determines whether to use Claude Code SDK (Anthropic) or
 * the OpenRouter HTTP client (non-Anthropic).
 *
 * Returns true for unknown tiers as a safe fallback (use Claude Code SDK).
 */
export function isAnthropicModel(tier: ModelTier): boolean {
  return getModelProvider(tier) === "anthropic";
}

/**
 * Claude Code SDK model name mapping: ModelTier → bare Anthropic model ID.
 *
 * The Claude Code SDK requires bare Anthropic model names (e.g., "claude-sonnet-4-6")
 * NOT OpenRouter-prefixed names (e.g., "anthropic/claude-sonnet-4.6").
 *
 * Note the version format difference:
 * - OpenRouter uses dots: "claude-sonnet-4.6"
 * - Anthropic SDK uses hyphens: "claude-sonnet-4-6"
 */
const CLAUDE_SDK_MODEL_MAP: Record<string, string> = {
  // Primary Anthropic tiers
  "haiku-4-5": "claude-haiku-4-5",
  "sonnet-4-5": "claude-sonnet-4-5",
  "sonnet-4-6": "claude-sonnet-4-6",
  "opus-4-5": "claude-opus-4-5",
  "opus-4-6": "claude-opus-4-6",
  // Legacy tier names
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  "gpt4o-mini": "claude-sonnet-4-6", // legacy fallback
};

/**
 * Get the bare Anthropic model name for the Claude Code SDK.
 * Falls back to "claude-sonnet-4-6" for unknown tiers.
 *
 * This is DIFFERENT from getOpenRouterModelId() which returns
 * prefixed names like "anthropic/claude-sonnet-4.6" for the LLM proxy.
 */
export function getClaudeCodeModelName(tier: ModelTier): string {
  return CLAUDE_SDK_MODEL_MAP[tier] ?? CLAUDE_SDK_MODEL_MAP.sonnet;
}
