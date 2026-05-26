/**
 * Claude Code Adapter — executes agents via the Claude Code SDK (Anthropic)
 * or OpenRouter API (non-Anthropic models).
 *
 * Routing logic:
 * - Anthropic models (haiku, sonnet, opus) → Claude Code SDK via LLM proxy
 * - Non-Anthropic models (GPT, Gemini, GLM, Kimi, MiniMax) → OpenRouter API directly
 *
 * Preserves ALL existing behavior for Anthropic models:
 * - Session management (Map<string, AgentSession>, persistence via DB)
 * - Token tracking (input/output tokens from SDK messages)
 * - Credit billing integration (recordSessionCredits, checkSessionLimits)
 * - lastAssistantText fallback capture
 * - Model mapping (ModelTier → OpenRouter model ID via model-routing.ts)
 * - Conversation resume via session IDs
 * - System prompt building from blueprints
 * - Workspace path rewriting
 * - Turn limits enforcement (timeout, max tool calls)
 *
 * Non-Anthropic models use OpenRouter chat completions API with:
 * - Proper model IDs (e.g., openai/gpt-5.2, google/gemini-3-flash-preview)
 * - Token counting from OpenRouter response usage data
 * - Graceful error handling for API failures
 */

import type {
  AgentRow,
  AgentTurnResult,
  TurnLimits,
  ModelTier,
  AgentBlueprint,
  SupervisorConfig,
  SessionLimits,
} from "../types.js";
import { DEFAULT_TURN_LIMITS, ROLE_LIMITS, DEFAULT_SESSION_LIMITS } from "../types.js";
import { getBlueprint } from "../blueprints.js";
import type { AgentAdapter, AdapterInvokeOptions } from "./types.js";
import type { SDKMessage } from "@anthropic-ai/claude-code";
import { MODEL_MAP, isAnthropicModel, getOpenRouterModelId, getClaudeCodeModelName } from "../model-routing.js";
import { invokeViaOpenRouter } from "../openrouter-client.js";

/** Tracks per-agent session state between turns. */
interface AgentSession {
  /** Claude Code session ID for conversation persistence */
  sessionId: string | null;
  /** Number of turns in this session */
  turnCount: number;
  /** Session start timestamp */
  startedAt: number;
  /** Total credits spent in this session */
  creditsSpent: number;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  private anthropicApiKey: string;
  private internalApiKey: string;
  /** OpenRouter API key for non-Anthropic model routing */
  private openRouterApiKey: string;
  /** Active sessions: agentId → session state */
  private sessions: Map<string, AgentSession> = new Map();
  /** Optional DB for session persistence */
  private db: import("../db.js").SupervisorDb | null = null;

  constructor(config: SupervisorConfig, db?: import("../db.js").SupervisorDb) {
    this.anthropicApiKey = config.anthropicApiKey;
    this.internalApiKey = config.internalApiKey;
    this.openRouterApiKey = process.env.OPENROUTER_API_KEY ?? "";
    if (db) {
      this.db = db;
      this.loadSessionsFromDb();
    }
  }

  // ---------------------------------------------------------------------------
  // Session persistence
  // ---------------------------------------------------------------------------

  private loadSessionsFromDb(): void {
    if (!this.db) return;
    const rows = this.db.all<{
      agent_id: string;
      session_id: string | null;
      turn_count: number;
      credits_spent: number;
      started_at: number;
    }>(`SELECT agent_id, session_id, turn_count, credits_spent, started_at FROM agent_sessions`);
    for (const row of rows) {
      this.sessions.set(row.agent_id, {
        sessionId: row.session_id,
        turnCount: row.turn_count,
        startedAt: row.started_at,
        creditsSpent: row.credits_spent,
      });
    }
    console.log(`[claude-code-adapter] Loaded ${rows.length} persisted sessions`);
  }

  private persistSession(agentId: string, session: AgentSession): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO agent_sessions (agent_id, session_id, turn_count, credits_spent, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(agent_id) DO UPDATE SET
         session_id = excluded.session_id,
         turn_count = excluded.turn_count,
         credits_spent = excluded.credits_spent,
         updated_at = datetime('now')`,
      [agentId, session.sessionId, session.turnCount, session.creditsSpent, session.startedAt],
    );
  }

  private deletePersistedSession(agentId: string): void {
    if (!this.db) return;
    this.db.run(`DELETE FROM agent_sessions WHERE agent_id = ?`, [agentId]);
  }

  // ---------------------------------------------------------------------------
  // Public session management (called by AgentInvoker)
  // ---------------------------------------------------------------------------

  /**
   * Get turn limits for an agent based on its role.
   */
  getTurnLimits(agent: AgentRow): TurnLimits {
    const roleOverrides = ROLE_LIMITS[agent.role] ?? {};
    return { ...DEFAULT_TURN_LIMITS, ...roleOverrides };
  }

  /**
   * Get session limits for an agent.
   */
  getSessionLimits(_agent: AgentRow): SessionLimits {
    return DEFAULT_SESSION_LIMITS;
  }

  /**
   * Check if an agent's session has exceeded its limits.
   * Returns a reason string if exceeded, undefined if ok.
   */
  checkSessionLimits(agentId: string, agent: AgentRow): string | undefined {
    const session = this.sessions.get(agentId);
    if (!session) return undefined;

    const limits = this.getSessionLimits(agent);

    if (session.turnCount >= limits.maxTurnsPerSession) {
      return `Session turn limit reached (${limits.maxTurnsPerSession} turns)`;
    }

    const elapsed = Date.now() - session.startedAt;
    if (elapsed >= limits.maxSessionDurationMs) {
      return `Session duration limit reached (${limits.maxSessionDurationMs / 60_000} min)`;
    }

    if (session.creditsSpent >= limits.maxCreditsPerSession) {
      return `Session credit limit reached (${limits.maxCreditsPerSession} credits)`;
    }

    return undefined;
  }

  /**
   * Record credits spent in the current session.
   */
  recordSessionCredits(agentId: string, credits: number): void {
    const session = this.sessions.get(agentId);
    if (session) {
      session.creditsSpent += credits;
      this.persistSession(agentId, session);
    }
  }

  /**
   * Reset an agent's session (start fresh conversation).
   */
  resetSession(agentId: string): void {
    this.sessions.delete(agentId);
    this.deletePersistedSession(agentId);
  }

  // ---------------------------------------------------------------------------
  // AgentAdapter.invoke()
  // ---------------------------------------------------------------------------

  /**
   * Invoke an agent with a prompt.
   *
   * For Anthropic models: uses Claude Code SDK (existing behavior).
   * For non-Anthropic models: routes to OpenRouter API directly.
   *
   * Returns the turn result including token usage for credit deduction.
   */
  async invoke(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    options?: AdapterInvokeOptions,
  ): Promise<AgentTurnResult> {
    const limits = {
      ...this.getTurnLimits(agent),
      ...(options?.turnLimits ?? {}),
    };
    const startTime = Date.now();
    const sessionKey = options?.sessionKey ?? agent.id;

    // Check session limits before invoking
    const sessionLimitReason = this.checkSessionLimits(sessionKey, agent);
    if (sessionLimitReason) {
      console.log(`[claude-code-adapter] Agent ${agent.id} session limit: ${sessionLimitReason}`);
      this.resetSession(sessionKey);
      // Allow this turn (fresh session), but log the reset
    }

    // Route non-Anthropic models to OpenRouter directly
    if (!isAnthropicModel(agent.model_tier)) {
      return this.invokeNonAnthropic(agent, prompt, workspaceDir, limits, options, startTime);
    }

    // Shared accumulator so the catch block can return partial token usage
    // even when runClaudeCode throws or times out mid-stream.
    const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, toolCallCount: 0 };

    const { promise: timeoutPromise, clear: clearTimeoutTimer } = this.timeout(limits.turnTimeoutMs, options?.abortController);
    try {
      const result = await Promise.race([
        this.runClaudeCode(agent, prompt, workspaceDir, limits, options, accumulatedUsage),
        timeoutPromise,
      ]);
      clearTimeoutTimer(); // Cancel the orphan timer

      // Update session state
      this.updateSession(sessionKey, result.sessionId);

      return {
        ...result,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      clearTimeoutTimer(); // Also clear on error
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[claude-code-adapter] Agent ${agent.id} (${agent.name}) error:`, message);

      return {
        success: false,
        tokenUsage: {
          inputTokens: accumulatedUsage.inputTokens,
          outputTokens: accumulatedUsage.outputTokens,
          cacheReadInputTokens: accumulatedUsage.cacheReadInputTokens || undefined,
        },
        error: message,
        aborted: options?.abortController?.signal.aborted ?? false,
        toolCallCount: accumulatedUsage.toolCallCount,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Non-Anthropic model invocation via OpenRouter
  // ---------------------------------------------------------------------------

  /**
   * Invoke a non-Anthropic model via OpenRouter's chat completions API.
   * Used for OpenAI, Google, Z.ai, MoonshotAI, and MiniMax models.
   */
  private async invokeNonAnthropic(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    limits: TurnLimits,
    options: AdapterInvokeOptions | undefined,
    startTime: number,
  ): Promise<AgentTurnResult> {
    const openRouterModelId = getOpenRouterModelId(agent.model_tier);
    const baseSystemPrompt = this.buildSystemPrompt(agent);
    const systemPrompt = this.rewriteWorkspacePaths(
      options?.systemPromptOverride
        ? options.systemPromptOverride
        : options?.systemPromptSuffix
          ? `${baseSystemPrompt}\n\n${options.systemPromptSuffix}`
          : baseSystemPrompt,
      workspaceDir,
    );
    const normalizedPrompt = this.rewriteWorkspacePaths(prompt, workspaceDir);

    if (!this.openRouterApiKey) {
      console.error(
        `[claude-code-adapter] Cannot route non-Anthropic model ${agent.model_tier} (${openRouterModelId}): OPENROUTER_API_KEY not set`,
      );
      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: `OPENROUTER_API_KEY not configured for non-Anthropic model ${agent.model_tier}`,
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    console.log(
      `[claude-code-adapter] Routing non-Anthropic model ${agent.model_tier} → OpenRouter (${openRouterModelId}) for agent ${agent.id} (${agent.name})`,
    );

    try {
      const result = await invokeViaOpenRouter({
        openRouterApiKey: this.openRouterApiKey,
        model: openRouterModelId,
        systemPrompt,
        userPrompt: normalizedPrompt,
        maxTokens: limits.maxTokensOutput,
        abortController: options?.abortController,
        timeoutMs: limits.turnTimeoutMs,
      });

      // Stream output text if a callback is provided
      if (result.output && options?.onTextDelta) {
        await options.onTextDelta(result.output);
      }

      // Update session state (no session ID for OpenRouter, but track turns)
      const sessionKey = options?.sessionKey ?? agent.id;
      this.updateSession(sessionKey, undefined);

      return {
        success: result.success,
        tokenUsage: result.tokenUsage,
        output: result.output,
        error: result.error,
        aborted: options?.abortController?.signal.aborted ?? false,
        toolCallCount: 0, // OpenRouter chat completions don't support tool use in this flow
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[claude-code-adapter] Non-Anthropic invocation failed for agent ${agent.id} (${agent.name}), model ${openRouterModelId}: ${message}`,
      );

      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: message,
        aborted: options?.abortController?.signal.aborted ?? false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Core Claude Code execution
  // ---------------------------------------------------------------------------

  /**
   * Run an agent via the Claude Code SDK.
   */
  private async runClaudeCode(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    limits: TurnLimits,
    options?: AdapterInvokeOptions,
    accumulatedUsage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; toolCallCount: number },
  ): Promise<Omit<AgentTurnResult, "durationMs"> & { sessionId?: string }> {
    const { query } = await import("@anthropic-ai/claude-code");

    const model = getClaudeCodeModelName(agent.model_tier);
    const baseSystemPrompt = this.buildSystemPrompt(agent);
    const customSystemPrompt = this.rewriteWorkspacePaths(
      options?.systemPromptOverride
        ? options.systemPromptOverride
        : options?.systemPromptSuffix
        ? `${baseSystemPrompt}\n\n${options.systemPromptSuffix}`
        : baseSystemPrompt,
      workspaceDir,
    );
    const normalizedPrompt = this.rewriteWorkspacePaths(prompt, workspaceDir);
    const abortController = options?.abortController ?? new AbortController();

    // Get existing session for conversation persistence
    const existingSession = this.sessions.get(options?.sessionKey ?? agent.id);

    console.log(`[claude-code-adapter] Starting Claude Code for ${agent.id} (${agent.name}), model=${model}, cwd=${workspaceDir}`);
    const conversation = query({
      prompt: normalizedPrompt,
      options: {
        model,
        customSystemPrompt,
        cwd: workspaceDir,
        env: this.buildClaudeRuntimeEnv(),
        includePartialMessages: Boolean(options?.onTextDelta),
        maxTurns: limits.maxInferenceRoundsPerTurn,
        abortController,
        permissionMode: "bypassPermissions",
        // Ensure node is found when running under systemd
        executable: process.execPath as "node",
        // Capture stderr for debugging
        stderr: (data: string) => {
          console.error(`[claude-code-adapter][stderr] ${agent.id}: ${data.trim()}`);
        },
        // Resume previous session if available
        ...(existingSession?.sessionId
          ? { resume: existingSession.sessionId }
          : {}),
      },
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let toolCallCount = 0;
    let output = "";
    let lastAssistantText = "";
    let capturedSessionId: string | undefined;
    let activeToolId: string | undefined;

    for await (const message of conversation) {
      // Capture session ID from system init message
      if (message.type === "system" && "subtype" in message && message.subtype === "init") {
        // Session ID is in the message's session_id field
        capturedSessionId = message.session_id;
      }

      if (message.type === "result") {
        const resultMsg = message as Extract<SDKMessage, { type: "result" }>;
        const resultVal = "result" in resultMsg ? (resultMsg as Record<string, unknown>).result : undefined;
        console.log(`[claude-code-adapter] Result message for ${agent.id}: subtype=${resultMsg.subtype}, result_type=${typeof resultVal}, result_length=${typeof resultVal === "string" ? resultVal.length : "N/A"}, is_error=${resultMsg.is_error}, lastAssistantText_length=${lastAssistantText.length}`);
        if ("result" in resultMsg && typeof (resultMsg as Record<string, unknown>).result === "string") {
          output = (resultMsg as Record<string, unknown>).result as string;
        }
        if (resultMsg.usage) {
          // result.usage is the authoritative cumulative total from the SDK.
          // REPLACE (=) the running totals instead of adding (+=) to avoid
          // double-counting with the per-message incremental usage from
          // assistant messages. The assistant-message accumulation above is
          // kept as a fallback for error/timeout paths where result.usage
          // never arrives.
          totalInputTokens = resultMsg.usage.input_tokens ?? 0;
          totalOutputTokens = resultMsg.usage.output_tokens ?? 0;
          const usageAny = resultMsg.usage as Record<string, unknown>;
          totalCacheReadInputTokens = (usageAny.cache_read_input_tokens as number) ?? 0;
          // Overwrite shared accumulator with authoritative values
          if (accumulatedUsage) {
            accumulatedUsage.inputTokens = totalInputTokens;
            accumulatedUsage.outputTokens = totalOutputTokens;
            accumulatedUsage.cacheReadInputTokens = totalCacheReadInputTokens;
          }
        }
        // Also capture session_id from result
        if (resultMsg.session_id) {
          capturedSessionId = resultMsg.session_id;
        }
      } else if (message.type === "stream_event") {
        const streamMsg = message as Extract<SDKMessage, { type: "stream_event" }>;
        if (
          streamMsg.event.type === "content_block_delta"
          && streamMsg.event.delta.type === "text_delta"
          && streamMsg.event.delta.text
        ) {
          await options?.onTextDelta?.(streamMsg.event.delta.text);
        }
      } else if (message.type === "assistant") {
        const assistantMsg = message as Extract<SDKMessage, { type: "assistant" }>;
        // Extract usage from assistant messages for incremental tracking
        if (assistantMsg.message?.usage) {
          const msgUsage = assistantMsg.message.usage as Record<string, unknown>;
          totalInputTokens += (msgUsage.input_tokens as number) ?? 0;
          totalOutputTokens += (msgUsage.output_tokens as number) ?? 0;
          totalCacheReadInputTokens += (msgUsage.cache_read_input_tokens as number) ?? 0;
          if (accumulatedUsage) {
            accumulatedUsage.inputTokens = totalInputTokens;
            accumulatedUsage.outputTokens = totalOutputTokens;
            accumulatedUsage.cacheReadInputTokens = totalCacheReadInputTokens;
          }
        }
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if (typeof block === "object" && "type" in block) {
              if (block.type === "tool_use") {
                // Emit tool_end for any previously active tool before starting a new one
                if (activeToolId) {
                  options?.onToolEnd?.(activeToolId);
                }
                toolCallCount++;
                if (accumulatedUsage) accumulatedUsage.toolCallCount = toolCallCount;
                const toolBlock = block as { type: "tool_use"; name: string; id: string };
                activeToolId = toolBlock.id;
                options?.onToolStart?.(toolBlock.name, toolBlock.id);
                if (toolCallCount > limits.maxToolCallsPerTurn) {
                  console.warn(
                    `[claude-code-adapter] Agent ${agent.id} exceeded max tool calls (${limits.maxToolCallsPerTurn})`,
                  );
                  abortController.abort();
                  break;
                }
              } else if (block.type === "text" && "text" in block && typeof block.text === "string" && block.text.trim()) {
                // Text block means previous tool is done
                if (activeToolId) {
                  options?.onToolEnd?.(activeToolId);
                  activeToolId = undefined;
                }
                // Capture last assistant text block as fallback output
                lastAssistantText = block.text;
              }
            }
          }
        }
      } else if (message.type === "user") {
        // User messages in the SDK represent tool results — emit tool_end
        if (activeToolId) {
          options?.onToolEnd?.(activeToolId);
          activeToolId = undefined;
        }
      }
    }

    // Emit tool_end for any remaining active tool
    if (activeToolId) {
      options?.onToolEnd?.(activeToolId);
    }

    // Use last assistant text as fallback if the SDK result had no text
    const finalOutput = output || lastAssistantText;
    return {
      success: true,
      tokenUsage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadInputTokens: totalCacheReadInputTokens || undefined,
      },
      output: finalOutput,
      aborted: abortController.signal.aborted,
      toolCallCount,
      sessionId: capturedSessionId,
    };
  }

  // ---------------------------------------------------------------------------
  // Prompt building
  // ---------------------------------------------------------------------------

  /**
   * Build a system prompt for the agent.
   *
   * Priority:
   * 1. If agent has a non-null, non-empty `system_prompt` → use it as the COMPLETE
   *    prompt (do NOT prepend blueprint or append legacy instructions).
   * 2. Otherwise fall back to blueprint + optional legacy `instructions` field.
   */
  private buildSystemPrompt(agent: AgentRow): string {
    // If a custom system_prompt is explicitly saved, use it as the COMPLETE prompt
    if (agent.system_prompt != null && agent.system_prompt.trim() !== "") {
      return agent.system_prompt;
    }

    // Fall back: blueprint-derived prompt
    const blueprint = agent.blueprint_id
      ? getBlueprint(agent.blueprint_id)
      : getBlueprint(agent.role); // fallback: match by role

    let prompt: string;
    if (blueprint) {
      prompt = this.buildBlueprintPrompt(agent, blueprint);
    } else {
      // Fallback: basic prompt from agent row data
      prompt = this.buildBasicPrompt(agent);
    }

    // Append user-provided custom instructions if present (legacy field)
    if (agent.instructions && agent.instructions.trim()) {
      prompt += `\n\n## Custom Instructions\n${agent.instructions.trim()}`;
    }

    return prompt;
  }

  /**
   * Build a full system prompt from a blueprint.
   */
  private buildBlueprintPrompt(agent: AgentRow, blueprint: AgentBlueprint): string {
    const parts = [blueprint.systemPrompt];

    // Add workflow instructions if any
    if (blueprint.workflows.length > 0) {
      parts.push("\n## Available Workflows\n");
      for (const wf of blueprint.workflows) {
        parts.push(`### ${wf.name}`);
        wf.steps.forEach((step, i) => {
          parts.push(`${i + 1}. ${step}`);
        });
        parts.push("");
      }
    }

    // Add company-specific context
    parts.push(
      "\n## Agent Identity",
      `- Name: ${agent.name}`,
      `- Role: ${agent.role}`,
      `- Company ID: ${agent.company_id}`,
    );

    if (agent.department) {
      parts.push(`- Department: ${agent.department}`);
    }

    parts.push(
      "",
      "## Important Rules",
      "- Be efficient — every turn costs credits",
      "- Write files to /workspace/ (shared with all agents)",
      "- Summarize what you accomplished at the end of each turn",
    );

    return parts.join("\n");
  }

  /**
   * Build a basic system prompt when no blueprint is available.
   */
  private buildBasicPrompt(agent: AgentRow): string {
    const parts = [
      `You are ${agent.name}, the ${agent.title ?? agent.role} of the company.`,
      `Your role: ${agent.role}.`,
    ];

    if (agent.department) {
      parts.push(`Department: ${agent.department}.`);
    }

    parts.push(
      "",
      "You have access to tools for your work. Complete the requested task efficiently.",
      "Write files to /workspace/ which is shared with all agents.",
      "When you're done, summarize what you accomplished.",
    );

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private rewriteWorkspacePaths(text: string, workspaceDir: string): string {
    return text.replaceAll("/workspace", workspaceDir);
  }

  private buildClaudeRuntimeEnv(): Record<string, string> {
    // Use the local LLM proxy on the supervisor itself.
    // This avoids CF Worker → OpenRouter Cloudflare-to-Cloudflare routing issues.
    const proxyBase = `http://localhost:${process.env.PORT || 8787}/llm-proxy`;

    return {
      ANTHROPIC_API_KEY: this.internalApiKey,
      ANTHROPIC_AUTH_TOKEN: this.internalApiKey,
      ANTHROPIC_BASE_URL: proxyBase,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    };
  }

  /**
   * Update session tracking after a turn.
   */
  private updateSession(agentId: string, sessionId?: string): void {
    const existing = this.sessions.get(agentId);

    if (existing) {
      existing.turnCount++;
      if (sessionId) {
        existing.sessionId = sessionId;
      }
      this.persistSession(agentId, existing);
    } else {
      const session: AgentSession = {
        sessionId: sessionId ?? null,
        turnCount: 1,
        startedAt: Date.now(),
        creditsSpent: 0,
      };
      this.sessions.set(agentId, session);
      this.persistSession(agentId, session);
    }
  }

  /**
   * Creates a timeout that rejects after `ms` milliseconds.
   * Returns both the promise and a clear() handle so the caller can cancel
   * the timer when the main work finishes first — preventing orphan timers
   * from firing after the turn is already complete.
   *
   * If an abortController is provided, it will be aborted when the timeout fires,
   * ensuring the underlying Claude Code process is actually killed.
   */
  private timeout(ms: number, abortController?: AbortController): { promise: Promise<never>; clear: () => void } {
    let timer: NodeJS.Timeout;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          abortController?.abort("Turn timed out");
          reject(new Error(`Agent turn timed out after ${ms}ms`));
        },
        ms,
      );
    });
    return { promise, clear: () => clearTimeout(timer!) };
  }
}
