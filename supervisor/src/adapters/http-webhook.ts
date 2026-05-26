/**
 * HTTP Webhook Adapter — executes agents via external HTTP POST endpoints.
 *
 * Sends a JSON payload to the agent's configured webhookUrl and parses
 * the response into an AgentTurnResult. Designed for external agents
 * (Paperclip, OpenClaw, or any HTTP-compatible agent service).
 *
 * Error handling:
 * - Timeout: returns success:false with /timeout/i in error
 * - Non-2xx HTTP responses: returns success:false with HTTP status in error
 * - Malformed JSON response: returns success:false with parse error
 * - Connection refused: returns success:false without unhandled exception
 */

import type { AgentRow, AgentTurnResult } from "../types.js";
import type { AgentAdapter, AdapterInvokeOptions } from "./types.js";

/** Default timeout for webhook requests (60 seconds). */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 60_000;

/**
 * Response shape expected from the webhook endpoint.
 * The adapter is lenient: it only requires `output` to be present.
 */
interface WebhookResponse {
  output?: string;
  error?: string;
  success?: boolean;
}

export class HttpWebhookAdapter implements AgentAdapter {
  /**
   * Invoke an agent by sending an HTTP POST to its configured webhook URL.
   *
   * The agent row must have a `webhook_url` stored in metadata or a known field.
   * The payload contains: { prompt, agentId, taskId, workspaceDir }.
   *
   * @param agent - The agent row (must have webhook URL accessible)
   * @param prompt - The user/task prompt
   * @param workspaceDir - The workspace directory path
   * @param options - Optional invocation parameters (turnLimits for timeout)
   */
  async invoke(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    options?: AdapterInvokeOptions,
  ): Promise<AgentTurnResult> {
    const startTime = Date.now();
    const timeoutMs =
      options?.turnLimits?.turnTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;

    // Extract webhook URL from agent metadata
    const webhookUrl = this.getWebhookUrl(agent);
    if (!webhookUrl) {
      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: `No webhook URL configured for agent ${agent.id}`,
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Extract task ID from current_task_id on the agent row
    const taskId = agent.current_task_id ?? null;

    const payload = {
      prompt,
      agentId: agent.id,
      taskId,
      workspaceDir,
    };

    try {
      const response = await this.fetchWithTimeout(
        webhookUrl,
        payload,
        timeoutMs,
        options?.abortController,
      );

      // Handle non-2xx responses
      if (!response.ok) {
        return {
          success: false,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          error: `HTTP ${response.status}: ${response.statusText}`,
          aborted: false,
          toolCallCount: 0,
          durationMs: Date.now() - startTime,
        };
      }

      // Parse response body as JSON
      const body = await response.text();
      let parsed: WebhookResponse;
      try {
        parsed = JSON.parse(body) as WebhookResponse;
      } catch {
        return {
          success: false,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          error: `Failed to parse webhook response as JSON: invalid JSON`,
          aborted: false,
          toolCallCount: 0,
          durationMs: Date.now() - startTime,
        };
      }

      // Build successful result
      return {
        success: parsed.success !== false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        output: parsed.output ?? "",
        error: parsed.error,
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Detect timeout errors (from AbortController or our timeout logic)
      if (this.isTimeoutError(err)) {
        return {
          success: false,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          error: `Webhook request timeout after ${timeoutMs}ms`,
          aborted: true,
          toolCallCount: 0,
          durationMs: Date.now() - startTime,
        };
      }

      // Connection refused or other network errors
      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: `Webhook request failed: ${message}`,
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Extract the webhook URL from an agent row.
   * Checks the dedicated webhook_url column first, then metadata JSON.
   */
  private getWebhookUrl(agent: AgentRow): string | null {
    // 1. Check dedicated webhook_url column (set by external agent registration)
    if (typeof agent.webhook_url === "string" && agent.webhook_url) {
      return agent.webhook_url;
    }

    // 2. Fallback: check metadata JSON field for webhookUrl
    if (agent.metadata) {
      try {
        const meta = JSON.parse(agent.metadata) as Record<string, unknown>;
        if (typeof meta.webhookUrl === "string" && meta.webhookUrl) {
          return meta.webhookUrl;
        }
        // Also check webhook_url (snake_case variant)
        if (typeof meta.webhook_url === "string" && meta.webhook_url) {
          return meta.webhook_url;
        }
      } catch {
        // Metadata is not valid JSON — ignore
      }
    }
    return null;
  }

  /**
   * Execute a POST request with timeout support.
   * Uses AbortController to enforce the timeout.
   */
  private async fetchWithTimeout(
    url: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    externalAbort?: AbortController,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // If an external abort controller is provided, propagate its signal
    if (externalAbort) {
      if (externalAbort.signal.aborted) {
        controller.abort();
      } else {
        externalAbort.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }
    }

    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Determine whether an error is a timeout/abort error.
   */
  private isTimeoutError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === "AbortError") {
      return true;
    }
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes("abort") || msg.includes("timeout")) {
        return true;
      }
    }
    return false;
  }
}
