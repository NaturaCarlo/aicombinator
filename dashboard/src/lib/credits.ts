/** Model multipliers for the Factory Standard Token pricing model */
const MODEL_MULTIPLIERS = {
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
  opus: 2.0,
  sonnet: 1.2,
  haiku: 0.4,
  "gpt4o-mini": 0.1,
} as const;

type ModelKey = keyof typeof MODEL_MULTIPLIERS;

/**
 * Format a token count for display.
 * Always uses millions suffix for balance displays:
 * ≥1,000,000: "5.2M tokens"
 * ≥1,000 and <1,000,000: "123K tokens" or "0.5M tokens"
 * 0: "0.0M tokens"
 * Null/undefined: "—"
 */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  const v = Math.max(0, value);
  if (v >= 1_000_000) {
    return `${(v / 1_000_000).toFixed(1)}M tokens`;
  }
  if (v >= 1_000) {
    return `${Math.round(v / 1_000)}K tokens`;
  }
  return "0.0M tokens";
}

/**
 * Format a raw token count (no "tokens" suffix).
 * ≥1,000,000: "5.2M"
 * ≥1,000 and <1,000,000: "123K"
 * 0: "0.0M"
 * Null/undefined: "—"
 */
export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  const v = Math.max(0, value);
  if (v >= 1_000_000) {
    return `${(v / 1_000_000).toFixed(1)}M`;
  }
  if (v >= 1_000) {
    return `${Math.round(v / 1_000)}K`;
  }
  return "0.0M";
}

/** @deprecated Use formatTokens instead */
export function formatCredits(value: number | null | undefined): string {
  return formatTokens(value);
}

/** @deprecated Use formatTokenCount instead */
export function formatCreditCount(value: number | null | undefined): string {
  return formatTokenCount(value);
}

export function formatCostAgentLabel(
  agentName: string | null | undefined,
  agentId: string | null | undefined,
): string {
  if (agentName && agentName.trim().length > 0) {
    return agentName.trim();
  }
  if (agentId && agentId.trim().length > 0) {
    return agentId.trim().slice(0, 8);
  }
  return "Unattributed";
}

function resolveModelKey(model: string | null | undefined): ModelKey {
  const normalized = (model ?? "").toLowerCase().trim();
  // Direct match for known keys
  if (normalized in MODEL_MULTIPLIERS) return normalized as ModelKey;
  // Legacy fallbacks
  if (normalized.includes("opus")) return "opus-4-6";
  if (normalized.includes("haiku")) return "haiku-4-5";
  if (normalized.includes("gpt4o-mini") || normalized.includes("gpt-4o-mini")) return "gpt4o-mini";
  return "sonnet-4-6";
}

/** Display name mapping for all model tiers */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "minimax-m2.5": "MiniMax M2.5",
  "gemini-3-flash": "Gemini 3 Flash",
  "glm-4.7": "GLM-4.7",
  "kimi-k2.5": "Kimi K2.5",
  "haiku-4-5": "Haiku 4.5",
  "glm-5": "GLM-5",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-codex": "GPT-5.2-Codex",
  "gpt-5.3-codex": "GPT-5.3-Codex",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gpt-5.4": "GPT-5.4",
  "sonnet-4-5": "Sonnet 4.5",
  "sonnet-4-6": "Sonnet 4.6",
  "opus-4-5": "Opus 4.5",
  "opus-4-6": "Opus 4.6",
  // Legacy
  opus: "Opus 4.6",
  sonnet: "Sonnet 4.6",
  haiku: "Haiku 4.5",
  "gpt4o-mini": "GPT-4o Mini",
};

export function modelDisplayName(model: string | null | undefined): string {
  const key = resolveModelKey(model);
  return MODEL_DISPLAY_NAMES[key] ?? "Sonnet 4.6";
}

export function modelMultiplierLabel(model: string | null | undefined): string {
  const multiplier = MODEL_MULTIPLIERS[resolveModelKey(model)];
  return `${multiplier}x multiplier`;
}

/** @deprecated Use modelMultiplierLabel instead */
export function modelCreditRateLabel(model: string | null | undefined): string {
  return modelMultiplierLabel(model);
}

export function getModelMultipliers() {
  return MODEL_MULTIPLIERS;
}

/** @deprecated Use getModelMultipliers instead */
export function getCreditPricingTable() {
  return MODEL_MULTIPLIERS;
}
