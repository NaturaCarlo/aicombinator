/**
 * Relay Manager — Integrates Agent Relay SDK for inter-agent communication.
 *
 * Each company gets its own relay namespace with default channels:
 *   #all-hands, #leadership, #engineering, #marketing, #status, #escalations
 *
 * The relay manager:
 * 1. Creates per-company AgentRelay instances
 * 2. Spawns non-Anthropic agents via relay (Codex/GPT models)
 * 3. Routes incoming relay messages to the supervisor as events
 * 4. Sends messages between agents on company channels
 *
 * Claude agents use Claude Code SDK (handled by agent-invoker.ts).
 * They send relay messages by writing to /workspace/.agent/relay-outbox.json,
 * which the supervisor polls and dispatches via the relay.
 */

import type { AgentRelay as AgentRelayType } from "@agent-relay/sdk";
import type {
  SupervisorConfig,
  RelayConfig,
  RelayMessage,
  RelayAgentHandle,
  AgentRow,
  AgentBlueprint,
} from "./types.js";
import { DEFAULT_COMPANY_CHANNELS } from "./types.js";

/** Callback type for when a relay message arrives */
export type RelayMessageHandler = (
  companyId: string,
  message: RelayMessage,
) => Promise<void>;

/** Per-company relay state */
interface CompanyRelay {
  relay: AgentRelayType;
  channels: string[];
  /** Map of agentId → relay agent name (for spawned non-Anthropic agents) */
  spawnedAgents: Map<string, string>;
}

export class RelayManager {
  private config: RelayConfig;
  /** companyId → CompanyRelay */
  private relays: Map<string, CompanyRelay> = new Map();
  /** Callback to fire when a relay message arrives */
  private onMessage: RelayMessageHandler | null = null;
  /** Track relay-spawned agent processes */
  private agentHandles: Map<string, RelayAgentHandle> = new Map();

  constructor(config: SupervisorConfig) {
    this.config = config.relayConfig;
  }

  /**
   * Set the message handler. Called by the supervisor to wire up relay → event dispatch.
   */
  setMessageHandler(handler: RelayMessageHandler): void {
    this.onMessage = handler;
  }

  /**
   * Initialize a relay namespace for a company.
   * Creates the AgentRelay instance and default channels.
   */
  async initCompany(companyId: string): Promise<void> {
    if (!this.config.enabled) {
      console.log(`[relay] Relay disabled, skipping init for company ${companyId}`);
      return;
    }

    if (this.relays.has(companyId)) {
      console.log(`[relay] Company ${companyId} already initialized`);
      return;
    }

    try {
      const { AgentRelay } = await import("@agent-relay/sdk");
      const relay = new AgentRelay();

      // Set up message handler to route relay messages back to supervisor
      relay.onMessageReceived = (msg: { from: string; to: string; text: string }) => {
        if (this.onMessage) {
          this.onMessage(companyId, {
            from: msg.from,
            to: msg.to,
            text: msg.text,
          }).catch((err) =>
            console.error(`[relay] Error handling message for company ${companyId}:`, err),
          );
        }
      };

      const channels = [...DEFAULT_COMPANY_CHANNELS];

      this.relays.set(companyId, {
        relay,
        channels,
        spawnedAgents: new Map(),
      });

      console.log(
        `[relay] Initialized company ${companyId} with channels: ${channels.join(", ")}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[relay] Failed to initialize company ${companyId}:`, message);
      throw err;
    }
  }

  /**
   * Spawn a non-Anthropic agent via relay (e.g. Codex/GPT-4o-mini).
   * Returns when the agent is ready to receive messages.
   */
  async spawnAgent(
    companyId: string,
    agent: AgentRow,
    blueprint: AgentBlueprint,
    task: string,
  ): Promise<RelayAgentHandle> {
    const companyRelay = this.relays.get(companyId);
    if (!companyRelay) {
      throw new Error(`[relay] Company ${companyId} not initialized`);
    }

    const { relay } = companyRelay;
    const agentName = `${agent.name}-${agent.id.slice(0, 8)}`;

    try {
      const { Models } = await import("@agent-relay/sdk");

      // Determine which relay provider to use based on blueprint
      const channels = blueprint.relayChannels;
      let process: unknown;

      if (blueprint.provider === "codex") {
        process = await relay.codex.spawn({
          name: agentName,
          model: Models.Codex.GPT_5_3_CODEX_SPARK,
          channels,
          task,
        });
      } else {
        // Claude agents can also be spawned via relay for cross-agent communication
        process = await relay.claude.spawn({
          name: agentName,
          model: Models.Claude.SONNET,
          channels,
          task,
        });
      }

      await relay.waitForAgentReady(agentName);

      const handle: RelayAgentHandle = {
        agentId: agent.id,
        companyId,
        agentName,
        process,
      };

      companyRelay.spawnedAgents.set(agent.id, agentName);
      this.agentHandles.set(agent.id, handle);

      console.log(
        `[relay] Spawned ${blueprint.provider} agent "${agentName}" on channels: ${channels.join(", ")}`,
      );

      return handle;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[relay] Failed to spawn agent ${agent.id}:`, message);
      throw err;
    }
  }

  /**
   * Send a message from one agent to another via relay.
   */
  async sendMessage(
    companyId: string,
    from: string,
    to: string,
    text: string,
    channel?: string,
  ): Promise<void> {
    const companyRelay = this.relays.get(companyId);
    if (!companyRelay) {
      console.warn(`[relay] Company ${companyId} not initialized, cannot send message`);
      return;
    }

    const { relay } = companyRelay;

    try {
      relay.system().sendMessage({ to, text });
      console.log(
        `[relay] Message sent: ${from} → ${to}${channel ? ` on #${channel}` : ""}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[relay] Failed to send message:`, message);
    }
  }

  /**
   * Broadcast a message to a channel (all agents on that channel will receive it).
   */
  async broadcastToChannel(
    companyId: string,
    from: string,
    channel: string,
    text: string,
  ): Promise<void> {
    const companyRelay = this.relays.get(companyId);
    if (!companyRelay) {
      console.warn(`[relay] Company ${companyId} not initialized, cannot broadcast`);
      return;
    }

    const { relay } = companyRelay;

    try {
      // Send as system message to the channel — all agents listening will receive
      relay.system().sendMessage({ to: channel, text: `[${from}]: ${text}` });
      console.log(`[relay] Broadcast: ${from} → #${channel}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[relay] Broadcast to #${channel} failed:`, message);
    }
  }

  /**
   * Get channels for a company.
   */
  getChannels(companyId: string): string[] {
    const companyRelay = this.relays.get(companyId);
    return companyRelay ? [...companyRelay.channels] : [];
  }

  /**
   * Get the relay agent name for a given agent ID.
   */
  getRelayAgentName(companyId: string, agentId: string): string | undefined {
    const companyRelay = this.relays.get(companyId);
    return companyRelay?.spawnedAgents.get(agentId);
  }

  /**
   * Check if an agent is spawned via relay.
   */
  isRelayAgent(agentId: string): boolean {
    return this.agentHandles.has(agentId);
  }

  /**
   * Tear down a company's relay instance.
   */
  async destroyCompany(companyId: string): Promise<void> {
    const companyRelay = this.relays.get(companyId);
    if (!companyRelay) return;

    try {
      await companyRelay.relay.shutdown();
      console.log(`[relay] Shut down relay for company ${companyId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[relay] Error shutting down company ${companyId}:`, message);
    }

    // Clean up agent handles for this company
    for (const [agentId, handle] of this.agentHandles) {
      if (handle.companyId === companyId) {
        this.agentHandles.delete(agentId);
      }
    }

    this.relays.delete(companyId);
  }

  /**
   * Shut down all relay instances (graceful shutdown).
   */
  async shutdown(): Promise<void> {
    console.log(`[relay] Shutting down all relay instances...`);

    const shutdowns = Array.from(this.relays.keys()).map((companyId) =>
      this.destroyCompany(companyId),
    );

    await Promise.allSettled(shutdowns);
    this.agentHandles.clear();
    console.log(`[relay] All relay instances shut down`);
  }

  /**
   * Get status of all relay connections.
   */
  getStatus(): {
    enabled: boolean;
    activeCompanies: number;
    spawnedAgents: number;
  } {
    return {
      enabled: this.config.enabled,
      activeCompanies: this.relays.size,
      spawnedAgents: this.agentHandles.size,
    };
  }
}
