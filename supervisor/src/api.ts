import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { SupervisorDb, isoNow } from "./db.js";
import type { DeployManager } from "./deploy-manager.js";
import { Scheduler } from "./scheduler.js";
import { FOUNDING_BLUEPRINTS, getBlueprint } from "./blueprints.js";
import { build_system_prompt } from "./agent-runner.js";
import {
  INTERNAL_RUNTIME_CONTRACT_VERSION,
  isCompatibleInternalContractVersion,
  parseProvisionCompanyPayload,
  parseUserMessagePayload,
} from "./internal-contract.js";
import type {
  AgentRow,
  ApprovalResolutionPayload,
  CreditPurchasePayload,
  HealthResponse,
  LaunchAgentPreview,
  LaunchStage,
  LaunchStatusPayload,
  LaunchStep,
  LaunchTaskPreview,
  ProvisionCompanyPayload,
  SupervisorConfig,
  TaskRow,
  TelemetryMirrorPayload,
  UserMessagePayload,
  WorkspaceArchivePayload,
} from "./types.js";

import { createLlmProxy, type LlmProxyConfig } from "./llm-proxy.js";
import { parseCompaniesShPackage, importToDb } from "./importers/companies-sh.js";

interface ApiDependencies {
  config: SupervisorConfig;
  db: SupervisorDb;
  scheduler: Scheduler;
  deploy_manager?: DeployManager;
  llmProxyConfig?: LlmProxyConfig;
}

function json_error(c: Context, status: number, error: string): Response {
  c.status(status as 200);
  return c.json({ error });
}

async function require_internal_auth(c: Context, next: Next, config: SupervisorConfig): Promise<Response | void> {
  const provided = c.req.header("x-internal-api-key") ?? c.req.header("x-supervisor-key");
  if (!provided || provided !== config.internalApiKey) {
    return json_error(c, 401, "Unauthorized");
  }
  const contractVersion = c.req.header("x-aic-contract-version");
  if (!isCompatibleInternalContractVersion(contractVersion)) {
    return json_error(
      c,
      409,
      `Contract version mismatch. Expected ${INTERNAL_RUNTIME_CONTRACT_VERSION}.`,
    );
  }
  await next();
  c.res.headers.set("X-AIC-Contract-Version", INTERNAL_RUNTIME_CONTRACT_VERSION);
}

const READY_LAUNCH_STATES = new Set(["running", "paused"]);
const EXPECTED_NON_CEO_LAUNCH_AGENTS = FOUNDING_BLUEPRINTS.filter((id) => id !== "ceo");
const FOUNDING_BLUEPRINT_SET = new Set<string>(FOUNDING_BLUEPRINTS);

function is_ceo_agent(agent: Pick<AgentRow, "blueprint_id" | "role" | "title">): boolean {
  const title = agent.title?.toLowerCase() ?? "";
  return agent.blueprint_id === "ceo" || agent.role === "ceo" || title === "chief executive officer" || title === "ceo";
}

function agent_has_started(agent: AgentRow | undefined): boolean {
  if (!agent) return false;
  return agent.status === "working" || agent.status === "running" || Boolean(agent.last_wake_at);
}

function parse_agent_metadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function founding_agent_identity_ready(agent: AgentRow): boolean {
  const blueprint = agent.blueprint_id ? getBlueprint(agent.blueprint_id) : undefined;
  const metadata = parse_agent_metadata(agent.metadata);
  const personalizedName = typeof agent.name === "string"
    && agent.name.trim().length > 0
    && agent.name.trim().toLowerCase() !== (blueprint?.name ?? "").trim().toLowerCase();
  const identityReady = Boolean(metadata.founding_identity_ready);
  // Avatars are cosmetic — don't block launch progression on them.
  // They'll generate in the background and appear when ready.
  return personalizedName && identityReady;
}

/** Map tool names to user-friendly descriptions for SSE streaming. */
function toolNameToDescription(toolName: string): string {
  switch (toolName) {
    case "Read":
    case "View":
      return "Reading files...";
    case "Write":
    case "Create":
    case "Edit":
    case "MultiEdit":
      return "Writing code...";
    case "Bash":
    case "Execute":
      return "Running commands...";
    case "Search":
    case "Grep":
    case "Glob":
      return "Searching codebase...";
    case "WebSearch":
      return "Searching the web...";
    case "TodoRead":
    case "TodoWrite":
      return "Organizing tasks...";
    case "LS":
      return "Browsing files...";
    default:
      return "Working...";
  }
}

function launch_progress_percent(stage: LaunchStage): number {
  switch (stage) {
    case "creating_workspace":
      return 8;
    case "creating_ceo":
      return 22;
    case "ceo_mission":
      return 30;
    case "ceo_planning":
      return 55;
    case "activating_team":
      return 70;
    case "delegating_tasks":
      return 80;
    case "founder_briefing":
      return 90;
    case "finalizing":
      return 95;
    case "ready":
    case "awaiting_funding":
    case "failed":
      return 100;
  }
}

function build_launch_status(
  company_id: string,
  scheduler: Scheduler,
  db: SupervisorDb,
): LaunchStatusPayload {
  const company = db.get<{
    id: string;
    name: string;
    state: string;
    workspace_dir: string | null;
  }>(`SELECT id, name, state, workspace_dir FROM companies WHERE id = ?`, [company_id]);
  if (!company) {
    throw new Error(`Company ${company_id} not found`);
  }
  const milestones = db.all<{ id: string }>(`SELECT id FROM milestones WHERE company_id = ?`, [company_id]);
  const tasks = db.all<TaskRow>(`SELECT * FROM tasks WHERE company_id = ? ORDER BY created_at ASC`, [company_id]);
  const agents = db.all<AgentRow>(`SELECT * FROM agents WHERE company_id = ? ORDER BY created_at ASC`, [company_id]);
  const founder_documents = scheduler.get_founder_documents(company_id);

  const ceo = agents.find((agent) => is_ceo_agent(agent));
  const mission = founder_documents.find((doc) => doc.type === "mission");
  const current_plan = founder_documents.find((doc) => doc.type === "plan");
  const founder_brief = founder_documents.find(
    (doc) => doc.type === "daily_update" || doc.type === "executive_brief",
  );
  const nonCeoAgents = agents.filter((agent) => !is_ceo_agent(agent) && agent.status !== "terminated");
  const foundingNonCeoAgents = nonCeoAgents.filter((agent) =>
    agent.blueprint_id ? EXPECTED_NON_CEO_LAUNCH_AGENTS.includes(agent.blueprint_id as typeof EXPECTED_NON_CEO_LAUNCH_AGENTS[number]) : false
  );
  const foundingAgents = agents.filter((agent) => agent.blueprint_id && FOUNDING_BLUEPRINT_SET.has(agent.blueprint_id));
  const delegatedTasks = tasks.filter((task) => task.owner_agent_id && task.owner_agent_id !== ceo?.id);
  const readyStates = READY_LAUNCH_STATES;
  const planIngested = milestones.length > 0 && tasks.length > 0;
  const ceoStarted = agent_has_started(ceo);
  const foundingTeamReady = planIngested && nonCeoAgents.length > 0;
  const foundingIdentityReadyCount = foundingAgents.filter((agent) => founding_agent_identity_ready(agent)).length;
  const foundingTeamIdentityReady = foundingAgents.length > 0 && foundingAgents.every((agent) => founding_agent_identity_ready(agent));
  const founderDocsReady = Boolean(mission) && Boolean(current_plan) && Boolean(founder_brief);

  // Check for early mission file (written before plan is complete)
  const missionFileExists = Boolean(company.workspace_dir) && existsSync(join(company.workspace_dir!, "docs", "mission.md"));

  let stage: LaunchStage;
  if (company.state === "failed" || company.state === "dead") {
    stage = "failed";
  } else if (company.state === "awaiting_funding") {
    stage = "awaiting_funding";
  } else if (!company.workspace_dir) {
    stage = "creating_workspace";
  } else if (!ceo) {
    stage = "creating_ceo";
  } else if (!ceoStarted) {
    stage = "ceo_planning";
  } else if (missionFileExists && !planIngested) {
    stage = "ceo_mission";
  } else if (!planIngested) {
    stage = "ceo_planning";
  } else if (!foundingTeamReady || !foundingTeamIdentityReady) {
    stage = "activating_team";
  } else if (delegatedTasks.length === 0) {
    stage = "delegating_tasks";
  } else if (!readyStates.has(company.state)) {
    stage = "finalizing";
  } else {
    stage = "ready";
  }

  const ready =
    readyStates.has(company.state)
    && Boolean(ceo)
    && planIngested
    && foundingTeamReady
    && foundingTeamIdentityReady
    && delegatedTasks.length > 0
    && ceoStarted;
  const terminal = stage === "failed" || stage === "awaiting_funding";

  const missing_items: string[] = [];
  if (!company.workspace_dir) missing_items.push("Workspace");
  if (!ceo) missing_items.push("CEO");
  if (!planIngested) missing_items.push("First plan");
  if (!foundingTeamReady) missing_items.push("Founding team");
  if (!foundingTeamIdentityReady) missing_items.push("Team identity");
  if (delegatedTasks.length === 0) missing_items.push("Delegated work");
  if (!readyStates.has(company.state) && stage !== "failed" && stage !== "awaiting_funding") {
    missing_items.push("Launch handoff");
  }

  let headline = "Provisioning your company";
  let detail = "We’re setting up the workspace and founding team.";
  if (stage === "creating_ceo") {
    headline = "Creating the CEO";
    detail = "The first agent is being provisioned so planning can begin.";
  } else if (stage === "ceo_mission") {
    headline = "Mission written — building the day's plan";
    detail = "The CEO has written the company mission and is now creating a comprehensive execution plan.";
  } else if (stage === "ceo_planning") {
    headline = "The CEO is planning the first milestone";
    detail = "The CEO is writing the mission and turning your idea into the first concrete tasks.";
  } else if (stage === "activating_team") {
    headline = "Activating the first operators";
    detail = "We’re bringing the first leadership agents online so work can start in parallel.";
  } else if (stage === "delegating_tasks") {
    headline = "Delegating the first work";
    detail = "The CEO has finished the plan and is assigning the first tracked tasks.";
  } else if (stage === "finalizing") {
    headline = "Finalizing the launch";
    detail = "The company is almost ready. We’re syncing the last founder-visible state.";
  } else if (stage === "ready") {
    headline = company.state === "paused" ? "Company launched and paused" : "Company launched";
    detail = company.state === "paused"
      ? "The company finished launching but is currently paused."
      : "The company is ready to enter. The first team tasks are live.";
  } else if (stage === "awaiting_funding") {
    headline = "Launch paused for credits";
    detail = "The company exists, but credits are required before work can continue.";
  } else if (stage === "failed") {
    headline = "Launch failed";
    detail = "Provisioning did not complete successfully.";
  }

  const steps: LaunchStep[] = [
    {
      id: "creating_workspace",
      label: "Workspace online",
      detail: company.workspace_dir ? "Workspace is ready." : "Creating the workspace.",
      state: company.workspace_dir ? "done" : stage === "creating_workspace" ? "active" : "pending",
    },
    {
      id: "creating_ceo",
      label: "CEO created",
      detail: ceo ? `${ceo.name} is available.` : "Provisioning the CEO agent.",
      state: ceo ? "done" : stage === "creating_ceo" ? "active" : "pending",
    },
    {
      id: "ceo_mission",
      label: "Mission written",
      detail: missionFileExists
        ? "The company mission is ready."
        : "The CEO is writing the company mission.",
      state: missionFileExists || planIngested ? "done" : stage === "ceo_mission" || stage === "ceo_planning" ? "active" : "pending",
    },
    {
      id: "ceo_planning",
      label: "Day plan created",
      detail: planIngested
        ? `${milestones.length} milestone${milestones.length === 1 ? "" : "s"} and ${tasks.length} task${tasks.length === 1 ? "" : "s"} created.`
        : "The CEO is building the full day's execution plan.",
      state: planIngested ? "done" : stage === "ceo_planning" ? "active" : "pending",
    },
    {
      id: "activating_team",
      label: "Leadership team activated",
      detail: `${foundingIdentityReadyCount}/${agents.length} founding agents named and avatarized.`,
      state: foundingTeamReady && foundingTeamIdentityReady ? "done" : stage === "activating_team" ? "active" : "pending",
    },
    {
      id: "delegating_tasks",
      label: "First work delegated",
      detail: `${delegatedTasks.length} tracked task${delegatedTasks.length === 1 ? "" : "s"} assigned.`,
      state: delegatedTasks.length > 0 ? "done" : stage === "delegating_tasks" ? "active" : "pending",
    },
    {
      id: "founder_briefing",
      label: "Founder brief ready",
      detail: founderDocsReady
        ? "Mission, daily brief, and current plan are ready."
        : "Founder docs keep syncing after launch; they do not block entry once the team is ready.",
      state: founderDocsReady || ready ? "done" : stage === "finalizing" ? "active" : "pending",
    },
  ];

  const team: LaunchAgentPreview[] = agents
    .slice()
    .sort((left, right) => {
      if (is_ceo_agent(left) && !is_ceo_agent(right)) return -1;
      if (!is_ceo_agent(left) && is_ceo_agent(right)) return 1;
      return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    })
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      title: agent.title ?? null,
      status: agent.status,
      icon: agent.icon ?? null,
    }));

  const agent_name_by_id = new Map<string, string>(team.map((agent) => [agent.id, agent.name]));
  const task_preview: LaunchTaskPreview[] = delegatedTasks
    .slice()
    .sort((left, right) => {
      const status_order = { in_progress: 0, ready: 1, pending: 2, blocked: 3, done: 4, failed: 5, cancelled: 6 } as const;
      return (status_order[left.status] ?? 99) - (status_order[right.status] ?? 99);
    })
    .slice(0, 6)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      owner_name: task.owner_agent_id ? agent_name_by_id.get(task.owner_agent_id) ?? null : null,
    }));

  return {
    company_id,
    name: company.name,
    state: company.state as LaunchStatusPayload["state"],
    ready,
    terminal,
    stage,
    progress_percent: launch_progress_percent(stage),
    headline,
    detail,
    missing_items,
    steps,
    team,
    task_preview,
    mission_text: mission?.content
      ?? (missionFileExists ? readFileSync(join(company.workspace_dir!, "docs", "mission.md"), "utf8").trim() || null : null)
      ?? founder_brief?.content ?? null,
  };
}

export function createApi({ config, db, scheduler, deploy_manager, llmProxyConfig }: ApiDependencies): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const companies = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM companies`)?.count ?? 0;
    const response: HealthResponse = {
      status: "ok",
      scopeUserId: config.scopeUserId,
      founderTimezone: "America/Los_Angeles",
      companies,
    };
    return c.json(response);
  });

  // ─── Hosting proxy — forwards requests to local nginx ────────
  // The CF Worker can't fetch raw IPs, so it proxies through here.
  app.all("/hosting-proxy/*", async (c) => {
    const target_path = c.req.path.replace(/^\/hosting-proxy/, "") || "/";
    const host = c.req.header("x-hosting-host");
    if (!host) {
      return json_error(c, 400, "Missing x-hosting-host header");
    }
    const query = new URL(c.req.url).search;
    const nginx_url = `http://127.0.0.1:80${target_path}${query}`;
    const upstream = await fetch(nginx_url, {
      method: c.req.method,
      headers: { Host: host, Accept: c.req.header("accept") || "*/*" },
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    });
    const headers = new Headers();
    upstream.headers.forEach((v, k) => headers.set(k, v));
    return new Response(upstream.body as ReadableStream | null, {
      status: upstream.status,
      headers,
    });
  });

  // Mount LLM proxy BEFORE the global auth middleware — it handles its own auth
  if (llmProxyConfig) {
    const llmProxy = createLlmProxy(llmProxyConfig);
    app.route("/", llmProxy);
  }

  app.use("*", (c, next) => require_internal_auth(c, next, config));

  app.post("/companies/:id/provision", async (c) => {
    const company_id = c.req.param("id");
    const raw = await c.req.json<unknown>().catch(() => null);
    const payload = parseProvisionCompanyPayload(company_id, raw);
    if (!payload) {
      return c.json({ error: "Invalid provision payload" }, { status: 400 });
    }
    const provisioned = await scheduler.provision_company({
      ...payload,
      created_at: payload.created_at ?? isoNow(),
      updated_at: payload.updated_at ?? isoNow(),
    });
    return c.json({ company: provisioned });
  });

  app.post("/companies/:id/pause", async (c) => {
    await scheduler.pause_company(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/companies/:id/resume", async (c) => {
    await scheduler.resume_company(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ─── Per-agent pause/resume ─────────────────────────────────

  app.post("/companies/:id/agents/:agentId/pause", async (c) => {
    const company_id = c.req.param("id");
    const agent_id = c.req.param("agentId");
    const agent = db.get<AgentRow>(
      `SELECT * FROM agents WHERE id = ? AND company_id = ?`,
      [agent_id, company_id],
    );
    if (!agent) {
      return json_error(c, 404, "Agent not found");
    }
    if (agent.status === "terminated") {
      return json_error(c, 400, "Cannot pause a terminated agent");
    }
    if (agent.status === "paused") {
      return c.json({ ok: true });
    }
    await scheduler.pause_agent(company_id, agent_id);
    return c.json({ ok: true });
  });

  app.post("/companies/:id/agents/:agentId/resume", async (c) => {
    const company_id = c.req.param("id");
    const agent_id = c.req.param("agentId");
    const agent = db.get<AgentRow>(
      `SELECT * FROM agents WHERE id = ? AND company_id = ?`,
      [agent_id, company_id],
    );
    if (!agent) {
      return json_error(c, 404, "Agent not found");
    }
    if (agent.status !== "paused") {
      return json_error(c, 400, "Agent is not paused");
    }
    await scheduler.resume_agent(company_id, agent_id);
    return c.json({ ok: true });
  });

  app.get("/companies/:id/status", (c) => {
    const company_id = c.req.param("id");
    const local_company = db.get<{ id: string; state: string; user_id: string }>(
      `SELECT id, state, user_id FROM companies WHERE id = ?`,
      [company_id],
    );
    if (!local_company) {
      return c.json(
        {
          error: "Company not loaded in supervisor local state",
          company_id,
          state: null,
        },
        { status: 404 },
      );
    }
    const status = scheduler.get_company_status(company_id);
    const agent_activity = scheduler.get_agent_activity(company_id);
    const founder_documents = scheduler.get_founder_documents(company_id);
    const verified_telemetry = scheduler.get_verified_telemetry_summary(company_id);
    const running_agents = db.all<{ id: string }>(
      `SELECT id FROM agents WHERE company_id = ? AND status = 'working' ORDER BY created_at ASC`,
      [company_id],
    ).map((agent) => agent.id);
    return c.json({
      ...status,
      runningAgents: running_agents,
      agent_activity,
      founder_documents,
      verified_telemetry,
    });
  });

  app.get("/companies/:id/launch-status", (c) => {
    const company_id = c.req.param("id");
    const local_company = db.get<{ id: string }>(
      `SELECT id FROM companies WHERE id = ?`,
      [company_id],
    );
    if (!local_company) {
      return c.json(
        {
          error: "Company not loaded in supervisor local state",
          company_id,
        },
        { status: 404 },
      );
    }

    return c.json(build_launch_status(company_id, scheduler, db));
  });

  app.get("/companies/:id/agents", (c) => {
    const company_id = c.req.param("id");
    const agents = db.all(
      `SELECT * FROM agents WHERE company_id = ? ORDER BY created_at ASC`,
      [company_id],
    );
    return c.json({ agents });
  });

  // ─── GET /companies/:id/agents/:agentId/blueprint-prompt ─────
  // Returns the agent's blueprint-derived system prompt (used by dashboard
  // to pre-populate the System Prompt textarea for unedited agents).
  app.get("/companies/:id/agents/:agentId/blueprint-prompt", (c) => {
    const company_id = c.req.param("id");
    const agent_id = c.req.param("agentId");
    const agent = db.get<AgentRow>(
      `SELECT * FROM agents WHERE id = ? AND company_id = ?`,
      [agent_id, company_id],
    );
    if (!agent) {
      return json_error(c, 404, "Agent not found");
    }

    // Special case: CEO agents get their dynamically-built system prompt
    if (agent.blueprint_id === "ceo" || agent.role === "ceo") {
      const company = db.get<import("./types.js").CompanyRow>(
        `SELECT * FROM companies WHERE id = ?`,
        [company_id],
      );
      if (!company) {
        return json_error(c, 404, "Company not found");
      }
      return c.json({ prompt: build_system_prompt(agent, company) });
    }

    const blueprint = agent.blueprint_id
      ? getBlueprint(agent.blueprint_id)
      : getBlueprint(agent.role);
    if (!blueprint) {
      return c.json({ prompt: null });
    }
    // Build the full blueprint prompt including identity context
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
    return c.json({ prompt: parts.join("\n") });
  });

  app.get("/companies/:id/tasks", (c) => {
    const company_id = c.req.param("id");
    const tasks = db.all(
      `SELECT * FROM tasks WHERE company_id = ? ORDER BY created_at ASC`,
      [company_id],
    );
    return c.json({ tasks });
  });

  app.get("/companies/:id/bootstrap", (c) => {
    const company_id = c.req.param("id");
    const company = db.get<{ workspace_dir: string | null }>(
      `SELECT workspace_dir FROM companies WHERE id = ?`,
      [company_id],
    );
    if (!company?.workspace_dir) {
      return c.json({
      ready: false,
      delegatedTaskCount: 0,
      foundingAgentCount: 0,
      identityReadyCount: 0,
      avatarReadyCount: 0,
      concreteDocs: {
        executionContract: false,
        plan: false,
        executiveBrief: false,
        founderDailyUpdate: false,
        },
      });
    }
    const ws = company.workspace_dir;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const docs = {
      executionContract: existsSync(join(ws, "docs", "execution-contract.json")),
      plan: existsSync(join(ws, "docs", "plan.md")),
      executiveBrief: existsSync(join(ws, "docs", "executive-brief.md")),
      founderDailyUpdate: existsSync(join(ws, "docs", `daily-update-${today}.md`)),
    };
    // Count tasks delegated to non-CEO agents
    const delegatedCount = db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM tasks
       WHERE company_id = ?
         AND owner_agent_id IS NOT NULL
         AND owner_agent_id != (
           SELECT id FROM agents WHERE company_id = ? AND blueprint_id = 'ceo' LIMIT 1
         )`,
      [company_id, company_id],
    )?.count ?? 0;
    const foundingCount = db.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM agents
       WHERE company_id = ?
         AND blueprint_id IN (${EXPECTED_NON_CEO_LAUNCH_AGENTS.map(() => "?").join(", ")})`,
      [company_id, ...EXPECTED_NON_CEO_LAUNCH_AGENTS],
    )?.count ?? 0;
    const fullFoundingAgents = db.all<Pick<AgentRow, "metadata" | "blueprint_id">>(
      `SELECT metadata, blueprint_id
       FROM agents
       WHERE company_id = ?
         AND blueprint_id IN (${FOUNDING_BLUEPRINTS.map(() => "?").join(", ")})`,
      [company_id, ...FOUNDING_BLUEPRINTS],
    );
    const identityReadyCount = fullFoundingAgents.filter((agent) =>
      Boolean(parse_agent_metadata(agent.metadata).founding_identity_ready)
    ).length;
    const avatarReadyCount = fullFoundingAgents.filter((agent) =>
      Boolean(parse_agent_metadata(agent.metadata).avatar_generated)
    ).length;
    const ready = foundingCount >= EXPECTED_NON_CEO_LAUNCH_AGENTS.length
      && fullFoundingAgents.length >= FOUNDING_BLUEPRINTS.length
      && identityReadyCount >= FOUNDING_BLUEPRINTS.length
      && avatarReadyCount >= FOUNDING_BLUEPRINTS.length
      && delegatedCount > 0;
    return c.json({
      ready,
      delegatedTaskCount: delegatedCount,
      foundingAgentCount: fullFoundingAgents.length,
      identityReadyCount,
      avatarReadyCount,
      concreteDocs: docs,
    });
  });

  app.post("/companies/:id/agents/:agentId/identity", async (c) => {
    const company_id = c.req.param("id");
    const agent_id = c.req.param("agentId");
    const body = await c.req.json<{
      name?: string;
      title?: string | null;
      icon?: string | null;
      email_address?: string | null;
      metadata?: Record<string, unknown> | null;
    }>();

    const existing = db.get<{ id: string }>(
      `SELECT id FROM agents WHERE id = ? AND company_id = ?`,
      [agent_id, company_id],
    );
    if (!existing) {
      return c.json({ error: "Agent not found" }, { status: 404 });
    }

    db.run(
      `UPDATE agents
       SET name = COALESCE(?, name),
           title = COALESCE(?, title),
           icon = COALESCE(?, icon),
           email_address = COALESCE(?, email_address),
           metadata = COALESCE(?, metadata),
           updated_at = ?
       WHERE id = ? AND company_id = ?`,
      [
        body.name?.trim() || null,
        body.title ?? null,
        body.icon ?? null,
        body.email_address ?? null,
        body.metadata ? JSON.stringify(body.metadata) : null,
        isoNow(),
        agent_id,
        company_id,
      ],
    );
    return c.json({ ok: true });
  });

  app.patch("/companies/:id/agents/:agentId", async (c) => {
    const company_id = c.req.param("id");
    const agent_id = c.req.param("agentId");
    const body = await c.req.json<{
      name?: string;
      role?: string;
      title?: string | null;
      instructions?: string;
      system_prompt?: string | null;
      model_tier?: string;
      adapter_type?: string | null;
      webhook_url?: string | null;
      reports_to?: string | null;
    }>();

    const existing = db.get<{ id: string }>(
      `SELECT id FROM agents WHERE id = ? AND company_id = ?`,
      [agent_id, company_id],
    );
    if (!existing) {
      return c.json({ error: "Agent not found" }, { status: 404 });
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) { setClauses.push("name = ?"); params.push(body.name); }
    if (body.role !== undefined) { setClauses.push("role = ?"); params.push(body.role); }
    if (body.title !== undefined) { setClauses.push("title = ?"); params.push(body.title); }
    if (body.instructions !== undefined) { setClauses.push("instructions = ?"); params.push(body.instructions); }
    if (body.system_prompt !== undefined) { setClauses.push("system_prompt = ?"); params.push(body.system_prompt); }
    if (body.model_tier !== undefined) { setClauses.push("model_tier = ?"); params.push(body.model_tier); }
    if (body.adapter_type !== undefined) { setClauses.push("adapter_type = ?"); params.push(body.adapter_type); }
    if (body.webhook_url !== undefined) { setClauses.push("webhook_url = ?"); params.push(body.webhook_url); }
    if (body.reports_to !== undefined) { setClauses.push("reports_to = ?"); params.push(body.reports_to); }

    if (setClauses.length === 0) {
      return c.json({ error: "No fields to update" }, { status: 400 });
    }

    setClauses.push("updated_at = ?");
    params.push(isoNow());
    params.push(agent_id);
    params.push(company_id);

    db.run(
      `UPDATE agents SET ${setClauses.join(", ")} WHERE id = ? AND company_id = ?`,
      params,
    );

    return c.json({ ok: true });
  });

  app.post("/companies/:id/agents/:agentId/work", async (c) => {
    const company_id = c.req.param("id");
    const agent_id = c.req.param("agentId");
    const body = await c.req.json<{ prompt?: string; sync?: boolean }>();
    const agent = db.get<AgentRow>(
      `SELECT * FROM agents WHERE id = ? AND company_id = ?`,
      [agent_id, company_id],
    );
    if (!agent) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const prompt = body.prompt || "Continue your work.";

    if (agent.blueprint_id === "ceo" || agent.role === "ceo") {
      if (body.sync) {
        await scheduler.invoke_ceo_turn(company_id, agent, prompt);
      } else {
        void scheduler.invoke_ceo_turn(company_id, agent, prompt);
      }
    } else {
      const task = agent.current_task_id
        ? db.get<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [agent.current_task_id])
        : db.get<TaskRow>(
          `SELECT * FROM tasks WHERE owner_agent_id = ? AND status IN ('ready','in_progress') ORDER BY created_at ASC LIMIT 1`,
          [agent_id],
        );
      if (!task) {
        return c.json({ error: "No actionable task for agent" }, 400);
      }
      if (body.sync) {
        await scheduler.dispatch_agent_work(agent, task, prompt);
      } else {
        void scheduler.dispatch_agent_work(agent, task, prompt);
      }
    }

    return c.json({ ok: true });
  });

  app.post("/companies/:id/message", async (c) => {
    const company_id = c.req.param("id");
    const raw = await c.req.json<unknown>().catch(() => null);
    const body = parseUserMessagePayload(raw);
    if (!body) {
      return c.json({ error: "Invalid founder message payload" }, { status: 400 });
    }
    let reply: string | null = null;
    if (body.target_agent_id) {
      reply = await scheduler.on_user_message_to_agent(
        company_id,
        body.target_agent_id,
        body.text,
        body.founder_state ?? null,
      );
    } else {
      reply = await scheduler.on_user_message(
        company_id,
        body.text,
        body.founder_state ?? null,
      );
    }
    return c.json({ ok: true, reply });
  });

  // ─── SSE streaming endpoint for CEO chat ──────────────────────
  app.post("/companies/:id/message/stream", async (c) => {
    const company_id = c.req.param("id");
    const raw = await c.req.json<unknown>().catch(() => null);
    const body = parseUserMessagePayload(raw);
    if (!body) {
      return c.json({ error: "Invalid founder message payload" }, { status: 400 });
    }

    // User messages always pass through — even when a system CEO turn is active.
    // invoke_ceo_turn() handles concurrency via is_user_facing flag and separate
    // session keys, so there's no need to block user chat at the API layer.

    const headers = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const writeSse = async (data: Record<string, unknown>) => {
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      } catch {
        // Stream closed by client
      }
    };

    // Run the streaming invocation in the background
    // Track toolId → toolName so tool_end events can include the toolName
    const toolIdToName = new Map<string, string>();

    void (async () => {
      try {
        const result = await scheduler.on_user_message_stream(
          company_id,
          body.text,
          {
            onTextDelta: async (text) => {
              await writeSse({ type: "text_delta", text });
            },
            onToolStart: (toolName, toolId) => {
              toolIdToName.set(toolId, toolName);
              const description = toolNameToDescription(toolName);
              void writeSse({ type: "tool_start", toolName, description });
            },
            onToolEnd: (toolId) => {
              const toolName = toolIdToName.get(toolId);
              void writeSse({ type: "tool_end", toolId, ...(toolName ? { toolName } : {}) });
            },
          },
          body.founder_state ?? null,
        );
        if (result.error) {
          await writeSse({ type: "error", error: result.error });
        } else {
          await writeSse({ type: "done", reply: result.reply ?? "" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[api] SSE stream error for ${company_id}:`, message);
        await writeSse({ type: "error", error: message });
      } finally {
        try {
          await writer.close();
        } catch {
          // Already closed
        }
      }
    })();

    return new Response(readable, { headers });
  });

  app.post("/companies/:id/approval/:approvalId/resolve", async (c) => {
    const company_id = c.req.param("id");
    const approval_id = c.req.param("approvalId");
    const body = await c.req.json<ApprovalResolutionPayload>();
    await scheduler.on_approval_resolved(company_id, approval_id, body.decision, body.note);
    return c.json({ ok: true });
  });

  app.post("/credits/purchased", async (c) => {
    const body = await c.req.json<CreditPurchasePayload>();
    await scheduler.on_credit_purchase(body);
    return c.json({ ok: true });
  });

  app.post("/companies/:id/telemetry/mirror", async (c) => {
    const company_id = c.req.param("id");
    const body = await c.req.json<TelemetryMirrorPayload>();
    db.run(
      `
        INSERT INTO telemetry_mirror (
          id, company_id, kind, status, source, source_event_id,
          verification_level, subject_name, subject_email, amount_cents,
          currency, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          company_id = excluded.company_id,
          kind = excluded.kind,
          status = excluded.status,
          source = excluded.source,
          source_event_id = excluded.source_event_id,
          verification_level = excluded.verification_level,
          subject_name = excluded.subject_name,
          subject_email = excluded.subject_email,
          amount_cents = excluded.amount_cents,
          currency = excluded.currency,
          occurred_at = excluded.occurred_at,
          created_at = excluded.created_at
      `,
      [
        body.id,
        company_id,
        body.kind,
        body.status,
        body.source,
        body.source_event_id,
        body.verification_level,
        body.subject_name,
        body.subject_email,
        body.amount_cents,
        body.currency,
        body.occurred_at,
        body.created_at,
      ],
    );
    return c.json({ ok: true });
  });

  app.get("/companies/:id/workspace/artifacts", (c) => {
    const company_id = c.req.param("id");
    const company = db.get<{ workspace_dir: string | null }>(
      `SELECT workspace_dir FROM companies WHERE id = ?`,
      [company_id],
    );
    if (!company?.workspace_dir) {
      return c.json({ documents: [], results: [] });
    }
    const ws = company.workspace_dir;
    const documents: Array<{ path: string; title: string; category: string; body: string; excerpt: string; updatedAt: string }> = [];
    const results: Array<{ path: string; title: string; kind: string; excerpt: string; updatedAt: string }> = [];

    // Scan for landing pages
    const landingCandidates = [
      "site/index.html",
      "src/landing/index.html",
      "src/frontend/index.html",
      "src/index.html",
      "public/index.html",
      "landing/index.html",
      "website/index.html",
    ];
    for (const candidate of landingCandidates) {
      const full = join(ws, candidate);
      if (existsSync(full)) {
        const stat = statSync(full);
        const content = readFileSync(full, "utf8");
        const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
        results.push({
          path: candidate,
          title: titleMatch?.[1] || "Landing Page",
          kind: "landing_page",
          excerpt: (titleMatch?.[1] || "Landing page").slice(0, 100),
          updatedAt: stat.mtime.toISOString(),
        });
        break;
      }
    }

    // Scan for app pages (dashboard, etc.)
    const appCandidates = [
      "src/dashboard/index.html",
      "src/app/index.html",
    ];
    for (const candidate of appCandidates) {
      const full = join(ws, candidate);
      if (existsSync(full)) {
        const stat = statSync(full);
        const content = readFileSync(full, "utf8");
        const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
        results.push({
          path: candidate,
          title: titleMatch?.[1] || "App",
          kind: "app_page",
          excerpt: (titleMatch?.[1] || "Application").slice(0, 100),
          updatedAt: stat.mtime.toISOString(),
        });
        break;
      }
    }

    // Scan for founder documents
    const docsDir = join(ws, "docs");
    if (existsSync(docsDir)) {
      try {
        const files = readdirSync(docsDir).filter((f) => f.endsWith(".md"));
        for (const file of files) {
          const full = join(docsDir, file);
          const stat = statSync(full);
          const body = readFileSync(full, "utf8");
          const title = body.split("\n").find((l) => l.startsWith("# "))?.replace(/^#\s+/, "") || file.replace(".md", "");
          documents.push({
            path: `docs/${file}`,
            title,
            category: "document",
            body,
            excerpt: body.slice(0, 200),
            updatedAt: stat.mtime.toISOString(),
          });
        }
      } catch { /* ignore read errors */ }
    }

    return c.json({ documents, results });
  });

  app.get("/companies/:id/workspace/file", (c) => {
    const company_id = c.req.param("id");
    const relative_path = c.req.query("path");
    if (!relative_path || relative_path.includes("..")) {
      return json_error(c, 400, "Invalid path");
    }
    const company = db.get<{ workspace_dir: string | null }>(
      `SELECT workspace_dir FROM companies WHERE id = ?`,
      [company_id],
    );
    if (!company?.workspace_dir) {
      return json_error(c, 404, "Company workspace not found");
    }
    const file_path = join(company.workspace_dir, relative_path);
    if (!existsSync(file_path)) {
      return json_error(c, 404, "File not found");
    }
    const ext = extname(file_path).toLowerCase();
    const mime: Record<string, string> = {
      ".html": "text/html", ".htm": "text/html", ".css": "text/css",
      ".js": "application/javascript", ".mjs": "application/javascript",
      ".json": "application/json", ".svg": "image/svg+xml",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
    };
    const content_type = mime[ext] || "application/octet-stream";
    const body = readFileSync(file_path);
    return new Response(body, {
      headers: { "Content-Type": content_type },
    });
  });

  app.post("/companies/:id/destroy", async (c) => {
    const company_id = c.req.param("id");
    const body = await c.req.json<{ removeData?: boolean }>().catch(() => ({ removeData: false }));
    await scheduler.destroy_company(company_id, body.removeData ?? false);
    return c.json({ ok: true });
  });

  app.post("/companies/:id/workspace/archive", (c) => {
    const company_id = c.req.param("id");
    const archive = scheduler.export_workspace_archive(company_id);
    return c.json(archive);
  });

  app.post("/companies/:id/workspace/import", async (c) => {
    const company_id = c.req.param("id");
    const body = await c.req.json<WorkspaceArchivePayload>();
    scheduler.import_workspace_archive(company_id, body);
    await scheduler.resume_company(company_id);
    return c.json({ ok: true });
  });

  // ─── Hosting ──────────────────────────────────────────────────

  app.post("/companies/:id/deploy", async (c) => {
    if (!deploy_manager) return json_error(c, 501, "Deploy manager not available");
    const company_id = c.req.param("id");
    const company = db.get<import("./types.js").CompanyRow>(
      `SELECT * FROM companies WHERE id = ?`,
      [company_id],
    );
    if (!company) return json_error(c, 404, "Company not found");
    await deploy_manager.deploy(company);
    const slug = deploy_manager.get_hosting_slug(company_id);
    const status = deploy_manager.get_hosting_status(company_id);
    return c.json({ ok: true, status, url: slug ? `http://${slug}.aicombinator.live` : null });
  });

  app.post("/companies/:id/undeploy", async (c) => {
    if (!deploy_manager) return json_error(c, 501, "Deploy manager not available");
    const company_id = c.req.param("id");
    await deploy_manager.undeploy(company_id);
    return c.json({ ok: true });
  });

  // ─── Companies.sh Import ─────────────────────────────────────

  app.post("/import/companies-sh/:companyId", async (c) => {
    const company_id = c.req.param("companyId");

    // Verify company exists locally
    const company = db.get<{ id: string }>(
      `SELECT id FROM companies WHERE id = ?`,
      [company_id],
    );
    if (!company) {
      return json_error(c, 404, "Company not found in supervisor");
    }

    let body: { packageRef?: string };
    try {
      body = await c.req.json<{ packageRef?: string }>();
    } catch {
      return json_error(c, 400, "Invalid JSON body");
    }

    const packageRef = body.packageRef?.trim();
    if (!packageRef) {
      return json_error(c, 400, "packageRef is required");
    }

    // Parse the companies.sh package from GitHub
    const importResult = await parseCompaniesShPackage(packageRef);

    // If the parser returned only errors and no company name, it's a bad reference
    if (!importResult.company.name && importResult.errors.length > 0) {
      return c.json(
        {
          error: "Failed to parse package",
          details: importResult.errors,
        },
        { status: 400 },
      );
    }

    // Import agents into local DB (idempotent)
    const dbResult = importToDb({
      companyId: company_id,
      importResult,
      getExistingAgentsByName: (cid: string) => {
        const agents = db.all<{ id: string; name: string }>(
          `SELECT id, name FROM agents WHERE company_id = ?`,
          [cid],
        );
        const map = new Map<string, string>();
        for (const agent of agents) {
          map.set(agent.name, agent.id);
        }
        return map;
      },
      createAgent: (agent) => {
        const id = scheduler.generate_id("agent");
        const now = isoNow();
        db.run(
          `INSERT INTO agents (
             id, company_id, name, role, title, model_tier, status,
             reports_to, source, adapter_type, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'sonnet', 'idle', ?, ?, ?, ?, ?)`,
          [
            id,
            agent.companyId,
            agent.name,
            agent.role,
            agent.title,
            agent.reportsTo,
            agent.source,
            agent.skills.length > 0 ? "http-webhook" : null,
            now,
            now,
          ],
        );
        // Enqueue sync to D1 so the dashboard picks up the new agent
        db.enqueue_sync("agents", id, "upsert", {
          id,
          company_id: agent.companyId,
          name: agent.name,
          role: agent.role,
          title: agent.title,
          model_tier: "sonnet",
          status: "idle",
          reports_to: agent.reportsTo,
          source: agent.source,
          adapter_type: agent.skills.length > 0 ? "http-webhook" : null,
          created_at: now,
          updated_at: now,
        });
        return id;
      },
      updateAgent: (agentId, updates) => {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        if (updates.role !== undefined) {
          setClauses.push("role = ?");
          params.push(updates.role);
        }
        if (updates.title !== undefined) {
          setClauses.push("title = ?");
          params.push(updates.title);
        }
        setClauses.push("updated_at = ?");
        params.push(isoNow());
        params.push(agentId);
        if (setClauses.length > 1) {
          db.run(
            `UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`,
            params,
          );
        }
      },
    });

    return c.json({
      company: importResult.company,
      agents: importResult.agents,
      skills: importResult.skills,
      import: {
        created: dbResult.created,
        skipped: dbResult.skipped,
        errors: [...importResult.errors, ...dbResult.errors],
      },
    });
  });

  // ─── Automations ─────────────────────────────────────────────

  app.get("/companies/:id/automations", (c) => {
    const company_id = c.req.param("id");
    const automations = db.all<{
      id: string;
      company_id: string;
      agent_id: string;
      title: string | null;
      description: string | null;
      schedule: string;
      prompt: string;
      enabled: number;
      last_run_at: string | null;
      created_by: string;
      created_at: string;
    }>(
      `SELECT id, company_id, agent_id, title, description, schedule, prompt, enabled, last_run_at, created_by, created_at
       FROM cron_tasks
       WHERE company_id = ? AND title IS NOT NULL
       ORDER BY created_at DESC`,
      [company_id],
    );
    return c.json({ automations });
  });

  app.post("/companies/:id/automations", async (c) => {
    const company_id = c.req.param("id");

    let body: {
      title?: string;
      description?: string;
      schedule?: string;
      prompt?: string;
    };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return json_error(c, 400, "Invalid JSON body");
    }

    const title = body.title?.trim();
    const description = body.description?.trim() ?? null;
    const schedule = body.schedule?.trim();
    const prompt = body.prompt?.trim();

    if (!title) return json_error(c, 400, "title is required");
    if (!schedule) return json_error(c, 400, "schedule is required");
    if (!prompt) return json_error(c, 400, "prompt is required");

    // Validate cron schedule format (basic: 5 fields)
    const fields = schedule.split(/\s+/);
    if (fields.length < 5) {
      return json_error(c, 400, "schedule must be a valid cron expression with 5 fields");
    }

    // The automation always targets the CEO agent
    const ceo = db.get<{ id: string }>(
      `SELECT id FROM agents WHERE company_id = ? AND (blueprint_id = 'ceo' OR role = 'ceo') LIMIT 1`,
      [company_id],
    );
    if (!ceo) return json_error(c, 404, "CEO agent not found for this company");

    const id = `automation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = isoNow();

    db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, title, description, schedule, prompt, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [id, company_id, ceo.id, title, description, schedule, prompt, ceo.id, now],
    );

    db.enqueue_sync("cron_tasks", id, "upsert", {
      id,
      company_id,
      agent_id: ceo.id,
      title,
      description,
      schedule,
      prompt,
      enabled: 1,
      last_run_at: null,
      created_by: ceo.id,
      created_at: now,
    });

    return c.json({ id, created: true });
  });

  app.patch("/companies/:id/automations/:automationId", async (c) => {
    const company_id = c.req.param("id");
    const automation_id = c.req.param("automationId");

    let body: { enabled?: boolean };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return json_error(c, 400, "Invalid JSON body");
    }

    const automation = db.get<{ id: string; company_id: string }>(
      `SELECT id, company_id FROM cron_tasks WHERE id = ? AND company_id = ?`,
      [automation_id, company_id],
    );
    if (!automation) return json_error(c, 404, "Automation not found");

    if (body.enabled !== undefined) {
      const enabled_val = body.enabled ? 1 : 0;
      db.run(`UPDATE cron_tasks SET enabled = ? WHERE id = ?`, [enabled_val, automation_id]);
      db.enqueue_sync("cron_tasks", automation_id, "upsert", {
        id: automation_id,
        company_id,
        enabled: enabled_val,
      });
    }

    return c.json({ updated: true });
  });

  return app;
}
