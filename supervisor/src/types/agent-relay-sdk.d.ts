/**
 * Type declarations for @agent-relay/sdk
 *
 * Based on the Agent Relay SDK API:
 * https://github.com/AgentWorkforce/relay
 */
declare module "@agent-relay/sdk" {
  export interface SpawnOptions {
    name: string;
    model: string;
    channels: string[];
    task: string;
  }

  export interface RelayMessageEvent {
    from: string;
    to: string;
    text: string;
  }

  export interface SendMessageOptions {
    to: string;
    text: string;
  }

  export interface SystemSender {
    sendMessage(options: SendMessageOptions): void;
  }

  export interface ProviderSpawner {
    spawn(options: SpawnOptions): Promise<unknown>;
  }

  export class AgentRelay {
    claude: ProviderSpawner;
    codex: ProviderSpawner;

    onMessageReceived: ((msg: RelayMessageEvent) => void) | null;

    system(): SystemSender;
    waitForAgentReady(agentName: string): Promise<void>;
    shutdown(): Promise<void>;

    static waitForAny(
      agents: unknown[],
      timeoutMs: number,
    ): Promise<void>;
  }

  export const Models: {
    Claude: {
      SONNET: string;
      HAIKU: string;
    };
    Codex: {
      GPT_5_3_CODEX_SPARK: string;
    };
  };
}
