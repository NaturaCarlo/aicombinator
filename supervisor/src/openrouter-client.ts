/**
 * OpenRouter HTTP client — direct invocation for non-Anthropic models.
 *
 * When a model tier maps to a non-Anthropic provider (OpenAI, Google, Z.ai,
 * MoonshotAI, MiniMax), we can't use the Claude Code SDK. Instead, we call
 * the OpenRouter API directly using the OpenAI-compatible chat completions
 * endpoint.
 *
 * This client handles:
 * - Request formatting (system + user messages)
 * - Authorization (Bearer token)
 * - Response parsing (choices, usage)
 * - Error handling (API failures, network errors)
 * - Token counting from response usage data
 */

import type { TokenUsage } from "./types.js";

export interface OpenRouterInvokeOptions {
  /** OpenRouter API key */
  openRouterApiKey: string;
  /** Full OpenRouter model ID (e.g., "openai/gpt-5.2") */
  model: string;
  /** System prompt */
  systemPrompt: string;
  /** User prompt */
  userPrompt: string;
  /** Optional max tokens for the response */
  maxTokens?: number;
  /** Optional abort controller */
  abortController?: AbortController;
  /** Optional timeout in ms (default: 300_000 = 5 min) */
  timeoutMs?: number;
}

export interface OpenRouterInvokeResult {
  success: boolean;
  output: string;
  tokenUsage: TokenUsage;
  error?: string;
}

/**
 * OpenRouter chat completion response (OpenAI-compatible format).
 */
interface OpenRouterChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Invoke a non-Anthropic model via OpenRouter's chat completions API.
 *
 * Uses the OpenAI-compatible endpoint: POST /api/v1/chat/completions
 * Returns a result with success/failure, output text, and token usage.
 */
export async function invokeViaOpenRouter(
  options: OpenRouterInvokeOptions,
): Promise<OpenRouterInvokeResult> {
  const {
    openRouterApiKey,
    model,
    systemPrompt,
    userPrompt,
    maxTokens = 16_384,
    abortController,
    timeoutMs = 300_000,
  } = options;

  // Build a timeout if no abort controller provided
  const controller = abortController ?? new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (!abortController) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://aicombinator.live",
        "X-Title": "AI Combinator Supervisor",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      console.error(
        `[openrouter-client] API error ${response.status} for model ${model}: ${errorBody}`,
      );
      return {
        success: false,
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: `OpenRouter API error ${response.status}: ${errorBody}`,
      };
    }

    const data = (await response.json()) as OpenRouterChatCompletionResponse;

    // Extract output text from choices
    const output =
      data.choices?.[0]?.message?.content ?? "";

    // Extract token usage (fallback to estimates if not provided)
    const tokenUsage: TokenUsage = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        }
      : {
          // Estimate tokens from content length (~4 chars per token)
          inputTokens: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
          outputTokens: Math.ceil(output.length / 4),
        };

    return {
      success: true,
      output,
      tokenUsage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[openrouter-client] Request failed for model ${model}: ${message}`);
    return {
      success: false,
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      error: message,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
