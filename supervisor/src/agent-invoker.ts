/**
 * Agent Invoker — Multi-runtime agent invocation.
 *
 * Routes agent execution to the appropriate adapter based on adapterType:
 * - "claude-code"   → ClaudeCodeAdapter (default when adapterType is absent)
 * - "http-webhook"  → HttpWebhookAdapter
 * - "bash"          → BashAdapter
 * - "codex"         → CodexAdapter (Agent Relay for non-Anthropic models)
 *
 * adapterType is resolved from (in priority order):
 * 1. Agent metadata JSON (`adapterType` or `adapter_type` field)
 * 2. Blueprint `adapterType` field
 * 3. Legacy provider-based fallback (codex → CodexAdapter, openclaw → inline)
 * 4. Default → ClaudeCodeAdapter
 *
 * Session management: The ClaudeCodeAdapter owns session state for Claude agents.
 * For OpenClaw agents, sessions are tracked locally in the invoker.
 */

import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentRow,
  AgentProvider,
  AdapterType,
  TurnLimits,
  AgentTurnResult,
  SessionLimits,
  SupervisorConfig,
  AgentBlueprint,
  OpenClawConfig,
} from "./types.js";
import { DEFAULT_TURN_LIMITS, ROLE_LIMITS, DEFAULT_SESSION_LIMITS, OPENCLAW_MODEL_MAP } from "./types.js";
import { getBlueprint } from "./blueprints.js";
import { containerName } from "./compose-template.js";
import type { RelayManager } from "./relay-manager.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { HttpWebhookAdapter } from "./adapters/http-webhook.js";
import { BashAdapter } from "./adapters/bash.js";
import { CodexAdapter } from "./adapters/codex.js";

const execFile = promisify(execFileCb);

const SKIP_DOCKER = process.env.SKIP_DOCKER === "true";
/** Workspace mount point inside OpenClaw containers */
const CONTAINER_WORKSPACE = "/root/workspace";

/** Tracks per-agent session state for non-Claude agents. */
interface AgentSession {
  sessionId: string | null;
  turnCount: number;
  startedAt: number;
  creditsSpent: number;
}

export interface AgentInvokeOptions {
  turnLimits?: Partial<TurnLimits>;
  systemPromptSuffix?: string;
  systemPromptOverride?: string;
  onTextDelta?: (text: string) => Promise<void> | void;
  onToolStart?: (toolName: string, toolId: string) => void;
  onToolEnd?: (toolId: string) => void;
  abortController?: AbortController;
  sessionKey?: string;
}

export class AgentInvoker {
  private anthropicApiKey: string;
  private openclawConfig: OpenClawConfig | undefined;
  /** Relay manager for non-Anthropic agents (set after construction) */
  private relayManager: RelayManager | null = null;
  /** Claude Code adapter for claude-provider agents */
  private claudeCodeAdapter: ClaudeCodeAdapter;
  /** HTTP webhook adapter for external agents */
  private httpWebhookAdapter: HttpWebhookAdapter;
  /** Bash adapter for shell-script agents */
  private bashAdapter: BashAdapter;
  /** Codex adapter for OpenAI Codex CLI / Agent Relay agents */
  private codexAdapter: CodexAdapter;
  /** Session tracking for non-Claude agents (OpenClaw, Codex) */
  private nonClaudeSessions: Map<string, AgentSession> = new Map();
  /** Optional DB for session persistence */
  private db: import("./db.js").SupervisorDb | null = null;

  constructor(config: SupervisorConfig, db?: import("./db.js").SupervisorDb) {
    this.anthropicApiKey = config.anthropicApiKey;
    this.openclawConfig = config.openclawConfig;
    this.claudeCodeAdapter = new ClaudeCodeAdapter(config, db);
    this.httpWebhookAdapter = new HttpWebhookAdapter();
    this.bashAdapter = new BashAdapter();
    this.codexAdapter = new CodexAdapter();
    if (db) {
      this.db = db;
    }
  }

  /**
   * Set the relay manager (called by Supervisor after construction).
   */
  setRelayManager(relay: RelayManager): void {
    this.relayManager = relay;
    this.codexAdapter.setRelayManager(relay);
  }

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
   *
   * Routes to the ClaudeCodeAdapter for Claude agents, otherwise checks
   * the invoker's local non-Claude session map.
   */
  checkSessionLimits(agentId: string, agent: AgentRow): string | undefined {
    const provider = this.getAgentProvider(agent);
    if (provider === "claude") {
      return this.claudeCodeAdapter.checkSessionLimits(agentId, agent);
    }

    // Non-Claude session tracking
    const session = this.nonClaudeSessions.get(agentId);
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
   * Routes to the appropriate session store based on the calling context.
   */
  recordSessionCredits(agentId: string, credits: number): void {
    // Try Claude adapter first (most agents are Claude)
    this.claudeCodeAdapter.recordSessionCredits(agentId, credits);

    // Also check non-Claude sessions
    const session = this.nonClaudeSessions.get(agentId);
    if (session) {
      session.creditsSpent += credits;
    }
  }

  /**
   * Reset an agent's session (start fresh conversation).
   */
  resetSession(agentId: string): void {
    this.claudeCodeAdapter.resetSession(agentId);
    this.nonClaudeSessions.delete(agentId);
  }

  /**
   * Invoke an agent with a prompt. Returns the turn result
   * including token usage for credit deduction.
   *
   * Routing priority:
   * 1. Explicit adapterType (from agent metadata or blueprint) → dispatches
   *    to the matching adapter.
   * 2. Provider-based fallback (from blueprint provider field) for legacy
   *    codex / openclaw agents.
   * 3. Default → ClaudeCodeAdapter (backward compatibility when adapterType
   *    is absent/undefined).
   */
  async invoke(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    options?: AgentInvokeOptions,
  ): Promise<AgentTurnResult> {
    // Route by adapterType first (from agent metadata or blueprint)
    const adapterType = this.getAdapterType(agent);
    if (adapterType) {
      switch (adapterType) {
        case "http-webhook":
          return this.httpWebhookAdapter.invoke(agent, prompt, workspaceDir, options);
        case "bash":
          return this.bashAdapter.invoke(agent, prompt, workspaceDir, options);
        case "codex":
          return this.codexAdapter.invoke(agent, prompt, workspaceDir, options);
        case "claude-code":
          return this.claudeCodeAdapter.invoke(agent, prompt, workspaceDir, options);
        default:
          // Unknown adapterType — fall through to provider-based routing
          break;
      }
    }

    // Fallback: route by provider (from blueprint) for legacy agents
    const provider = this.getAgentProvider(agent);

    if (provider === "codex") {
      return this.codexAdapter.invoke(agent, prompt, workspaceDir, options);
    }
    if (provider === "openclaw") {
      const limits = {
        ...this.getTurnLimits(agent),
        ...(options?.turnLimits ?? {}),
      };
      const startTime = Date.now();
      return this.runOpenClawTurn(agent, prompt, workspaceDir, limits, options, startTime);
    }

    // Default: Claude Code adapter (provider === "claude" or missing adapterType)
    return this.claudeCodeAdapter.invoke(agent, prompt, workspaceDir, options);
  }

  /**
   * Resolve the runtime provider for an agent from its blueprint.
   */
  private getAgentProvider(agent: AgentRow): AgentProvider {
    const blueprint = agent.blueprint_id ? getBlueprint(agent.blueprint_id) : null;
    return blueprint?.provider ?? "claude";
  }

  /**
   * Resolve the adapter type for an agent.
   *
   * Checks (in order):
   * 1. Agent metadata JSON for an `adapterType` field (highest priority —
   *    allows per-agent override, used by external agents)
   * 2. Direct `adapter_type` column on the agent row (set by external agent
   *    registration via D1 sync)
   * 3. Blueprint's `adapterType` field (set when the blueprint declares
   *    its preferred runtime)
   *
   * Returns null if no explicit adapter type is configured,
   * in which case routing falls through to provider-based dispatch.
   */
  private getAdapterType(agent: AgentRow): AdapterType | null {
    // 1. Check agent metadata (per-agent override)
    if (agent.metadata) {
      try {
        const meta = JSON.parse(agent.metadata) as Record<string, unknown>;
        if (typeof meta.adapterType === "string" && meta.adapterType) {
          return meta.adapterType as AdapterType;
        }
        // Also check snake_case variant
        if (typeof meta.adapter_type === "string" && meta.adapter_type) {
          return meta.adapter_type as AdapterType;
        }
      } catch {
        // Metadata is not valid JSON — ignore
      }
    }

    // 2. Check direct adapter_type column (set by external agent registration)
    if (typeof agent.adapter_type === "string" && agent.adapter_type) {
      return agent.adapter_type as AdapterType;
    }

    // 3. Check blueprint adapterType
    const blueprint = agent.blueprint_id ? getBlueprint(agent.blueprint_id) : null;
    if (blueprint?.adapterType) {
      return blueprint.adapterType;
    }

    return null;
  }

  /**
   * Run an agent via OpenClaw headless CLI (acpx).
   *
   * Each company has its own OpenClaw gateway running in its Docker container.
   * Agents are invoked by name within that instance. OpenClaw handles memory,
   * tool execution, and session persistence internally.
   *
   * Token usage is extracted from the structured JSON output of acpx.
   * If unavailable, session JSONL files are parsed as a fallback.
   */
  private async runOpenClawTurn(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    limits: TurnLimits,
    options: AgentInvokeOptions | undefined,
    startTime: number,
  ): Promise<AgentTurnResult> {
    const { promise: timeoutPromise, clear: clearTimeoutTimer } = this.timeout(limits.turnTimeoutMs);
    try {
      const result = await Promise.race([
        this.runOpenClaw(agent, prompt, workspaceDir, limits, options),
        timeoutPromise,
      ]);
      clearTimeoutTimer(); // Cancel the orphan timer

      // Track OpenClaw sessions locally for credit limits
      this.updateNonClaudeSession(options?.sessionKey ?? agent.id, result.sessionId);

      return {
        ...result,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      clearTimeoutTimer(); // Also clear on error
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[invoker:openclaw] Agent ${agent.id} (${agent.name}) error:`, message);

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

  /**
   * Run an agent via the OpenClaw headless CLI.
   */
  private async runOpenClaw(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    limits: TurnLimits,
    options?: AgentInvokeOptions,
  ): Promise<Omit<AgentTurnResult, "durationMs"> & { sessionId?: string }> {
    const agentName = agent.blueprint_id ?? agent.role;
    const model = OPENCLAW_MODEL_MAP[agent.model_tier] ?? this.openclawConfig?.defaultModel ?? "anthropic/claude-sonnet-4-6";
    const useDocker = !SKIP_DOCKER;

    // Workspace path depends on execution mode:
    // - Container mode: /root/workspace (Docker volume mount point)
    // - Host mode: actual host path (for development without Docker)
    const effectiveWorkspace = useDocker ? CONTAINER_WORKSPACE : workspaceDir;

    // Build the system prompt, rewriting /workspace to the target environment path
    const baseSystemPrompt = this.buildSystemPrompt(agent);
    const systemPrompt = this.rewriteWorkspacePaths(
      options?.systemPromptOverride
        ? options.systemPromptOverride
        : options?.systemPromptSuffix
          ? `${baseSystemPrompt}\n\n${options.systemPromptSuffix}`
          : baseSystemPrompt,
      effectiveWorkspace,
    );
    const fullPrompt = this.rewriteWorkspacePaths(prompt, effectiveWorkspace);

    // Write instructions to host filesystem (volume-mounted into container)
    const hostAgentDir = join(workspaceDir, ".agent", agent.id);
    await mkdir(hostAgentDir, { recursive: true });
    await writeFile(join(hostAgentDir, "SYSTEM.md"), systemPrompt);

    // Paths as seen from inside the target environment
    const instructionsPath = `${effectiveWorkspace}/.agent/${agent.id}/SYSTEM.md`;

    // Build acpx invocation args
    const acpxArgs = [
      "openclaw", "exec",
      "--agent", agentName,
      "--cwd", effectiveWorkspace,
      "--model", model,
      "--max-turns", String(limits.maxInferenceRoundsPerTurn),
      "--instructions", instructionsPath,
      "--json",
      fullPrompt,
    ];

    const timeoutMs = limits.turnTimeoutMs + 5_000; // extra buffer for cleanup
    const abortController = options?.abortController ?? new AbortController();

    console.log(`[invoker:openclaw] Invoking agent "${agentName}" for ${agent.company_id} (docker=${useDocker})`);

    let stdout: string;
    let stderr: string;

    if (useDocker) {
      // Container mode: docker exec into the company's container
      const cName = containerName(agent.company_id);
      ({ stdout, stderr } = await execFile("docker", [
        "exec",
        "-e", `ANTHROPIC_API_KEY=${this.anthropicApiKey}`,
        cName,
        "acpx",
        ...acpxArgs,
      ], {
        timeout: timeoutMs,
        signal: abortController.signal,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      }));
    } else {
      // Host mode: run acpx directly (development fallback)
      ({ stdout, stderr } = await execFile("acpx", acpxArgs, {
        timeout: timeoutMs,
        signal: abortController.signal,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.anthropicApiKey,
        },
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      }));
    }

    // Parse structured JSON output from acpx
    let tokenUsage = { inputTokens: 0, outputTokens: 0 };
    let output = "";
    let toolCallCount = 0;
    let sessionId: string | undefined;
    let success = true;

    try {
      const result = JSON.parse(stdout) as {
        exitCode?: number;
        usage?: { input?: number; output?: number };
        summary?: string;
        lastMessage?: string;
        toolCalls?: number;
        sessionId?: string;
      };

      success = result.exitCode === 0;
      tokenUsage = {
        inputTokens: result.usage?.input ?? 0,
        outputTokens: result.usage?.output ?? 0,
      };
      output = result.summary ?? result.lastMessage ?? "";
      toolCallCount = result.toolCalls ?? 0;
      sessionId = result.sessionId;
    } catch {
      // acpx didn't return valid JSON — use stderr/stdout as output
      output = stdout || stderr;
      console.warn(`[invoker:openclaw] Agent "${agentName}" did not return structured JSON`);

      // Fallback: estimate tokens from output length
      tokenUsage = {
        inputTokens: Math.ceil(fullPrompt.length / 4),
        outputTokens: Math.ceil(output.length / 4),
      };
    }

    return {
      success,
      tokenUsage,
      output,
      aborted: abortController.signal.aborted,
      toolCallCount,
      sessionId,
    };
  }

  /**
   * Build a system prompt for the agent.
   * Used by OpenClaw path (Claude Code adapter has its own copy).
   */
  private buildSystemPrompt(agent: AgentRow): string {
    const blueprint = agent.blueprint_id
      ? getBlueprint(agent.blueprint_id)
      : getBlueprint(agent.role);

    let prompt: string;
    if (blueprint) {
      prompt = this.buildBlueprintPrompt(agent, blueprint);
    } else {
      prompt = this.buildBasicPrompt(agent);
    }

    // Append user-provided custom instructions if present
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

  private rewriteWorkspacePaths(text: string, workspaceDir: string): string {
    return text.replaceAll("/workspace", workspaceDir);
  }

  /**
   * Update non-Claude session tracking after a turn.
   */
  private updateNonClaudeSession(agentId: string, sessionId?: string): void {
    const existing = this.nonClaudeSessions.get(agentId);

    if (existing) {
      existing.turnCount++;
      if (sessionId) {
        existing.sessionId = sessionId;
      }
    } else {
      this.nonClaudeSessions.set(agentId, {
        sessionId: sessionId ?? null,
        turnCount: 1,
        startedAt: Date.now(),
        creditsSpent: 0,
      });
    }
  }

  /**
   * Creates a timeout that rejects after `ms` milliseconds.
   * Returns both the promise and a clear() handle so the caller can cancel
   * the timer when the main work finishes first — preventing orphan timers
   * from firing after the turn is already complete.
   */
  private timeout(ms: number): { promise: Promise<never>; clear: () => void } {
    let timer: NodeJS.Timeout;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Agent turn timed out after ${ms}ms`)),
        ms,
      );
    });
    return { promise, clear: () => clearTimeout(timer!) };
  }
}
