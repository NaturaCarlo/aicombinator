/**
 * Agent Adapter interface — formal abstraction for agent execution runtimes.
 *
 * Each adapter encapsulates the specifics of invoking an agent through a
 * particular runtime (Claude Code SDK, HTTP webhook, bash script, Codex relay).
 * The AgentInvoker routes to the correct adapter based on blueprint adapterType.
 */

import type { AgentRow, AgentTurnResult, TurnLimits } from "../types.js";

/**
 * Options passed to adapter invoke() from the AgentInvoker.
 */
export interface AdapterInvokeOptions {
  /** Per-turn limit overrides */
  turnLimits?: Partial<TurnLimits>;
  /** Additional text appended to the system prompt */
  systemPromptSuffix?: string;
  /** Full system prompt override (replaces the built prompt) */
  systemPromptOverride?: string;
  /** Streaming callback for text deltas (used by Claude Code for SSE) */
  onTextDelta?: (text: string) => Promise<void> | void;
  /** Streaming callback when a tool invocation starts */
  onToolStart?: (toolName: string, toolId: string) => void;
  /** Streaming callback when a tool invocation ends */
  onToolEnd?: (toolId: string) => void;
  /** Abort controller for cancelling the turn */
  abortController?: AbortController;
  /** Session key override (defaults to agent.id) */
  sessionKey?: string;
}

/**
 * Formal interface for agent execution adapters.
 *
 * All adapters must implement invoke() which takes an agent, a prompt,
 * a workspace directory, and options, and returns an AgentTurnResult.
 */
export interface AgentAdapter {
  /**
   * Invoke an agent with a prompt and return the turn result.
   *
   * @param agent - The agent row from the database
   * @param prompt - The user/task prompt to send to the agent
   * @param workspaceDir - The workspace directory for file operations
   * @param options - Optional invocation parameters (limits, streaming, abort)
   * @returns Promise resolving to the agent turn result with token usage
   */
  invoke(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    options?: AdapterInvokeOptions,
  ): Promise<AgentTurnResult>;
}
