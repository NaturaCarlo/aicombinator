/**
 * Codex Adapter — executes agents via Agent Relay for non-Anthropic models.
 *
 * Wraps the existing invokeNonAnthropic() logic from AgentInvoker. Unlike
 * Claude agents (which use the Claude Code SDK and wake/sleep per turn),
 * relay-spawned agents are long-running processes that communicate via channels.
 *
 * We "invoke" them by spawning if not already running, then sending the prompt
 * as a relay message. Token usage is estimated from prompt length since relay
 * agents don't report exact usage.
 *
 * Error handling:
 * - Missing relay manager: returns success:false with configuration error
 * - Missing blueprint: returns success:false with blueprint error
 * - Relay spawn/send failures: returns success:false with relay error message
 */

import type { AgentRow, AgentTurnResult } from "../types.js";
import { getBlueprint } from "../blueprints.js";
import type { RelayManager } from "../relay-manager.js";
import type { AgentAdapter, AdapterInvokeOptions } from "./types.js";

export class CodexAdapter implements AgentAdapter {
  private relayManager: RelayManager | null = null;

  constructor(relayManager?: RelayManager | null) {
    this.relayManager = relayManager ?? null;
  }

  /**
   * Set or update the relay manager reference.
   * Called by AgentInvoker when the relay manager is initialised after construction.
   */
  setRelayManager(relay: RelayManager): void {
    this.relayManager = relay;
  }

  /**
   * Invoke an agent via the Agent Relay.
   *
   * Spawns the agent through the relay if not already running, then sends
   * the prompt as a relay message. Returns an estimated AgentTurnResult
   * since relay agents handle work asynchronously.
   *
   * @param agent - The agent row from the database
   * @param prompt - The user/task prompt to send to the agent
   * @param _workspaceDir - The workspace directory (unused for relay agents)
   * @param _options - Optional invocation parameters (unused for relay agents)
   */
  async invoke(
    agent: AgentRow,
    prompt: string,
    _workspaceDir: string,
    _options?: AdapterInvokeOptions,
  ): Promise<AgentTurnResult> {
    const startTime = Date.now();

    if (!this.relayManager) {
      console.error(`[codex-adapter] Relay manager not configured, cannot invoke ${agent.id}`);
      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: "Relay manager not configured",
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    const blueprint = agent.blueprint_id ? getBlueprint(agent.blueprint_id) : null;

    if (!blueprint) {
      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: `No blueprint found for agent ${agent.id}`,
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // Spawn via relay if not already running
      if (!this.relayManager.isRelayAgent(agent.id)) {
        await this.relayManager.spawnAgent(
          agent.company_id,
          agent,
          blueprint,
          blueprint.systemPrompt,
        );
      }

      // Send the prompt as a relay message to the agent
      const relayName = this.relayManager.getRelayAgentName(agent.company_id, agent.id);
      if (relayName) {
        await this.relayManager.sendMessage(
          agent.company_id,
          "supervisor",
          relayName,
          prompt,
        );
      }

      // Relay agents handle their work asynchronously — we don't wait for completion.
      // Estimate token usage based on prompt length for credit tracking.
      const estimatedInputTokens = Math.ceil(prompt.length / 4);
      const estimatedOutputTokens = 500; // conservative estimate

      return {
        success: true,
        tokenUsage: {
          inputTokens: estimatedInputTokens,
          outputTokens: estimatedOutputTokens,
        },
        output: `[Relay] Message dispatched to ${blueprint.provider} agent "${agent.name}"`,
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[codex-adapter] Relay invocation failed for agent ${agent.id}:`, message);

      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: `Relay invocation failed: ${message}`,
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    }
  }
}
