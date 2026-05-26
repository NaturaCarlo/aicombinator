/**
 * Container Manager — Docker lifecycle management for company containers.
 *
 * Manages the full container lifecycle:
 *   create  → Generates compose file, creates workspace, builds & starts container
 *   start   → Starts a stopped container
 *   stop    → Gracefully stops a running container
 *   destroy → Stops and removes container, optionally cleans workspace
 *   status  → Returns container status
 *
 * Each company gets one Docker container. The supervisor invokes agents
 * inside the container via `docker exec` + Claude Code SDK.
 */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import type { AgentBlueprint, ContainerConfig, ContainerInfo, OpenClawConfig, SupervisorConfig } from "./types.js";
import { OPENCLAW_MODEL_MAP, DEFAULT_OPENCLAW_CONFIG } from "./types.js";
import { generateComposeFile, containerName, type ComposeContext } from "./compose-template.js";
import { MCP_TO_OPENCLAW_SKILL, getAllBlueprints } from "./blueprints.js";

const exec = promisify(execCb);

/** Timeout for Docker commands (2 minutes) */
const DOCKER_TIMEOUT_MS = 120_000;
const SKIP_DOCKER = process.env.SKIP_DOCKER === "true";

export class ContainerManager {
  private config: ContainerConfig;
  private openclawConfig: OpenClawConfig;
  private containers: Map<string, ContainerInfo> = new Map();

  constructor(config: SupervisorConfig) {
    this.config = config.containerConfig;
    this.openclawConfig = config.openclawConfig ?? DEFAULT_OPENCLAW_CONFIG;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Create and start a container for a company.
   *
   * Steps:
   * 1. Create workspace directory on host
   * 2. Generate docker-compose.yml
   * 3. Build and start the container
   * 4. Track container info
   */
  async create(
    companyId: string,
    companyName: string,
    env?: Record<string, string>,
  ): Promise<ContainerInfo> {
    const companyDir = this.companyDir(companyId);
    const workspaceDir = join(companyDir, "workspace");

    console.log(`[containers] Creating container for company ${companyId}`);

    // 1. Create workspace directories
    await mkdir(join(workspaceDir, ".agent"), { recursive: true });
    await mkdir(join(workspaceDir, "src"), { recursive: true });
    await mkdir(join(workspaceDir, "docs"), { recursive: true });
    await mkdir(join(workspaceDir, "assets"), { recursive: true });

    // 2. Provision OpenClaw if any founding agents use it
    const openclawAgents = this.openclawConfig.enabled
      ? getAllBlueprints().filter(bp => bp.provider === "openclaw")
      : [];
    if (openclawAgents.length > 0) {
      await this.provisionOpenClaw(companyId, openclawAgents);
    }

    // 3. Generate docker-compose.yml
    const composeCtx: ComposeContext = {
      companyId,
      companyName,
      containerConfig: this.config,
      env,
      openclawEnabled: openclawAgents.length > 0,
      openclawImage: this.openclawConfig.dockerImage,
    };
    const composeContent = generateComposeFile(composeCtx);
    await writeFile(join(companyDir, "docker-compose.yml"), composeContent);

    const skipDocker = SKIP_DOCKER || env?.SKIP_DOCKER === "true";

    if (skipDocker) {
      const info: ContainerInfo = {
        companyId,
        containerId: `host-${companyId}`,
        containerName: `host-${companyId}`,
        workspaceDir,
        status: "running",
      };

      this.containers.set(companyId, info);
      console.log(`[containers] Docker skipped for ${companyId}; using host workspace only`);
      return info;
    }

    try {
      // 4. Ensure the Docker network exists
      await this.ensureNetwork();

      // 5. Build and start
      await this.dockerCompose(companyId, "up -d --build");

      // 6. Get container ID
      const containerId = await this.getContainerId(companyId);

      const info: ContainerInfo = {
        companyId,
        containerId,
        containerName: containerName(companyId),
        workspaceDir,
        status: "running",
      };

      this.containers.set(companyId, info);
      console.log(`[containers] Container ${info.containerName} created and running`);

      return info;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[containers] Docker container creation failed for ${companyId}: ${message}`,
      );
      throw err;
    }
  }

  /**
   * Start a stopped container.
   */
  async start(companyId: string): Promise<void> {
    console.log(`[containers] Starting container for ${companyId}`);
    const info = this.containers.get(companyId);
    if (SKIP_DOCKER) {
      const synthetic: ContainerInfo = info ?? {
        companyId,
        containerId: `host-${companyId}`,
        containerName: `host-${companyId}`,
        workspaceDir: this.getWorkspaceDir(companyId),
        status: "running",
      };
      synthetic.status = "running";
      this.containers.set(companyId, synthetic);
      return;
    }
    if (info?.containerId.startsWith("host-")) {
      info.status = "running";
      return;
    }

    await this.dockerCompose(companyId, "start");

    if (info) {
      info.status = "running";
    }
  }

  /**
   * Stop a running container (graceful, 30s timeout).
   */
  async stop(companyId: string): Promise<void> {
    console.log(`[containers] Stopping container for ${companyId}`);
    const info = this.containers.get(companyId);
    if (info?.containerId.startsWith("host-")) {
      info.status = "stopped";
      return;
    }

    await this.dockerCompose(companyId, "stop -t 30");

    if (info) {
      info.status = "stopped";
    }
  }

  /**
   * Destroy a container and optionally remove workspace data.
   */
  async destroy(companyId: string, removeData = false): Promise<void> {
    console.log(`[containers] Destroying container for ${companyId} (removeData=${removeData})`);

    const info = this.containers.get(companyId);
    if (info) {
      info.status = "removing";
    }

    if (!info?.containerId.startsWith("host-")) {
      // Stop and remove container + volumes
      try {
        await this.dockerCompose(companyId, "down -v --remove-orphans");
      } catch (err) {
        // Container may already be removed
        console.warn(`[containers] Warning during destroy:`, err);
      }
    }

    // Optionally remove workspace data
    if (removeData) {
      const companyDir = this.companyDir(companyId);
      await rm(companyDir, { recursive: true, force: true });
    }

    this.containers.delete(companyId);
    console.log(`[containers] Container for ${companyId} destroyed`);
  }

  // ─── Status & Queries ────────────────────────────────────────

  /**
   * Get container info for a company.
   */
  getInfo(companyId: string): ContainerInfo | undefined {
    return this.containers.get(companyId);
  }

  /**
   * Check if a container is running for a company.
   */
  isRunning(companyId: string): boolean {
    return this.containers.get(companyId)?.status === "running";
  }

  /**
   * Get the workspace directory path for a company.
   */
  getWorkspaceDir(companyId: string): string {
    return join(this.companyDir(companyId), "workspace");
  }

  /**
   * Discover and track any already-running company containers.
   * Called on supervisor startup to pick up containers from a previous run.
   */
  async discoverExisting(): Promise<number> {
    if (SKIP_DOCKER) {
      console.log("[containers] Docker discovery skipped");
      return 0;
    }

    try {
      const { stdout } = await exec(
        `docker ps --filter "name=aic-" --format "{{.Names}}\t{{.ID}}\t{{.Status}}"`,
        { timeout: DOCKER_TIMEOUT_MS },
      );

      let count = 0;
      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        const [name, id, status] = line.split("\t");
        const companyId = name?.replace("aic-", "");
        if (!companyId || !id) continue;

        this.containers.set(companyId, {
          companyId,
          containerId: id,
          containerName: name,
          workspaceDir: this.getWorkspaceDir(companyId),
          status: status?.toLowerCase().startsWith("up") ? "running" : "stopped",
        });
        count++;
      }

      console.log(`[containers] Discovered ${count} existing containers`);
      return count;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[containers] Docker discovery failed: ${message}`);
      return 0;
    }
  }

  /**
   * Execute a command inside a company's container.
   * Used by the agent invoker to run Claude Code inside the container.
   */
  async execInContainer(
    companyId: string,
    command: string,
    timeoutMs: number = DOCKER_TIMEOUT_MS,
  ): Promise<{ stdout: string; stderr: string }> {
    const name = containerName(companyId);
    return exec(`docker exec ${name} ${command}`, { timeout: timeoutMs });
  }

  /**
   * List all tracked containers.
   */
  listAll(): ContainerInfo[] {
    return Array.from(this.containers.values());
  }

  // ─── OpenClaw provisioning ──────────────────────────────────────

  /**
   * Provision an OpenClaw multi-agent instance for a company.
   *
   * Creates the OpenClaw directory structure, writes per-agent instruction files,
   * and generates an openclaw.json config with the full agent team.
   * The OpenClaw gateway service is added to the Docker Compose by compose-template.ts.
   */
  async provisionOpenClaw(companyId: string, agents: AgentBlueprint[]): Promise<void> {
    if (!this.openclawConfig.enabled) return;

    const companyDir = this.companyDir(companyId);
    const openclawDir = join(companyDir, ".openclaw");

    console.log(`[containers] Provisioning OpenClaw for company ${companyId} with ${agents.length} agents`);

    // Create base directories
    await mkdir(join(openclawDir, "workspace"), { recursive: true });

    // Create per-agent directories and write instruction files
    for (const agent of agents) {
      const agentDir = join(openclawDir, "agents", agent.id);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "instructions.md"), agent.systemPrompt);
    }

    // Generate openclaw.json with multi-agent config
    const config = this.buildOpenClawConfig(agents);
    await writeFile(join(openclawDir, "openclaw.json"), JSON.stringify(config, null, 2));

    console.log(`[containers] OpenClaw config written to ${openclawDir}`);
  }

  /**
   * Build an openclaw.json configuration for a company's agent team.
   */
  private buildOpenClawConfig(agents: AgentBlueprint[]): Record<string, unknown> {
    const agentConfigs: Record<string, unknown> = {};

    for (const agent of agents) {
      const model = OPENCLAW_MODEL_MAP[agent.modelTier] ?? this.openclawConfig.defaultModel;
      const skills = agent.mcpServers
        .map((mcp) => MCP_TO_OPENCLAW_SKILL[mcp])
        .filter(Boolean);

      agentConfigs[agent.id] = {
        model: { primary: model },
        instructions: `agents/${agent.id}/instructions.md`,
        workspace: "/root/workspace",
        skills: skills.length > 0 ? skills : undefined,
        sandbox: {
          permissions: {
            exec: true,
            filesystem: { read: true, write: true },
            browser: agent.mcpServers.includes("browser"),
          },
        },
      };
    }

    return {
      meta: { generatedBy: "supervisor", version: "1.0.0" },
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "token",
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: this.openclawConfig.defaultModel },
          workspace: "/root/workspace",
          compaction: { mode: "safeguard" },
          maxConcurrent: 4,
          subagents: { maxConcurrent: 8 },
        },
        ...agentConfigs,
      },
      gateway: {
        port: this.openclawConfig.gatewayPort,
        mode: "local",
        bind: "loopback",
        auth: { mode: "none" },
      },
      logging: { redactSensitive: "tools" },
    };
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private companyDir(companyId: string): string {
    return join(this.config.companiesDir, companyId);
  }

  /**
   * Run a docker compose command for a company.
   */
  private async dockerCompose(companyId: string, command: string): Promise<string> {
    const companyDir = this.companyDir(companyId);
    const composeFile = join(companyDir, "docker-compose.yml");

    // Verify compose file exists
    await access(composeFile);

    const { stdout, stderr } = await exec(
      `docker compose -f ${composeFile} ${command}`,
      { timeout: DOCKER_TIMEOUT_MS },
    );

    if (stderr && !stderr.includes("Warning") && !stderr.includes("Building")) {
      console.warn(`[containers] docker compose stderr for ${companyId}:`, stderr.slice(0, 500));
    }

    return stdout;
  }

  /**
   * Get the Docker container ID for a company.
   */
  private async getContainerId(companyId: string): Promise<string> {
    const name = containerName(companyId);
    const { stdout } = await exec(
      `docker inspect --format "{{.Id}}" ${name}`,
      { timeout: DOCKER_TIMEOUT_MS },
    );
    return stdout.trim().slice(0, 12);
  }

  /**
   * Ensure the Docker network exists.
   */
  private async ensureNetwork(): Promise<void> {
    const networkName = this.config.networkName;
    try {
      await exec(`docker network inspect ${networkName}`, { timeout: DOCKER_TIMEOUT_MS });
    } catch {
      console.log(`[containers] Creating Docker network: ${networkName}`);
      await exec(`docker network create ${networkName}`, { timeout: DOCKER_TIMEOUT_MS });
    }
  }
}
