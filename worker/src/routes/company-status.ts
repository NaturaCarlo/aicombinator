import type { Env, CompanyRow, CompanyState } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import {
  listCompanyEmailAliases,
  maybeSyncCompanyDomainBundle,
} from "./domain-bundle.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";
import {
  type ParsedSupervisorLaunchStatus,
  parseSupervisorLaunchStatus,
  parseSupervisorStatusPayload,
} from "../utils/internal-contract.js";
import {
  loadCompanyTelemetryRows,
  summarizeTelemetryRows,
} from "../utils/company-telemetry.js";

const REQUIRED_FOUNDING_TEAM_SIZE = 6;

/** Module-level lock to prevent duplicate personalization jobs for the same company. */
const personalizationInFlight = new Set<string>();

export type SupervisorControlPlane = {
  mode: "vm_local";
  mirrorStatus: "healthy" | "delayed";
  syncQueueDepth: number;
  oldestQueuedAt: string | null;
  lastSuccessfulSyncAt: string | null;
};

export type SupervisorStatusResponse = {
  supervisorReachable: boolean;
  state: CompanyState | null;
  controlPlane: (SupervisorControlPlane & {
    supervisorReachable: boolean;
    statusMessage: string;
  }) | {
    mode: "vm_local";
    supervisorReachable: false;
    mirrorStatus: "down";
    syncQueueDepth: null;
    oldestQueuedAt: null;
    lastSuccessfulSyncAt: null;
    statusMessage: string;
  };
};

type LaunchStage =
  | "creating_workspace"
  | "creating_ceo"
  | "ceo_mission"
  | "ceo_planning"
  | "activating_team"
  | "delegating_tasks"
  | "founder_briefing"
  | "finalizing"
  | "ready"
  | "awaiting_funding"
  | "failed";

type LaunchStep = {
  id: string;
  label: string;
  detail?: string;
  state: "done" | "active" | "pending";
};

type LaunchAgentPreview = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  icon: string | null;
};

type LaunchTaskPreview = {
  id: string;
  title: string;
  status: string;
  owner_name: string | null;
};

type LaunchAgentRow = {
  id: string;
  blueprint_id: string | null;
  role: string | null;
  name: string | null;
  title: string | null;
  icon: string | null;
  status: string | null;
  metadata: string | null;
};

type SupervisorLaunchStatus = ParsedSupervisorLaunchStatus;

type CompanyLaunchStatus = {
  companyId: string;
  name: string;
  companyState: CompanyState;
  engineState: CompanyState | null;
  ready: boolean;
  terminal: boolean;
  stage: LaunchStage;
  progressPercent: number;
  headline: string;
  detail: string;
  missingItems: string[];
  steps: LaunchStep[];
  team: LaunchAgentPreview[];
  taskPreview: LaunchTaskPreview[];
  missionText: string | null;
  supervisorReachable: boolean;
};

/**
 * GET /api/companies/:id/status — Real-time status.
 *
 * Returns D1 metrics plus the supervisor's current company state.
 */
export async function handleCompanyStatus(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const payload = await buildCompanyStatusPayload(env, companyId, userId);
  if (payload instanceof Response) {
    return payload;
  }

  return Response.json(payload, { headers: corsHeaders(env) });
}

export async function buildCompanyStatusPayload(
  env: Env,
  companyId: string,
  userId: string,
): Promise<Response | Record<string, unknown>> {
  const company = await env.DB.prepare(
    `SELECT id, name, state, inference_model, budget_cents, spent_cents, container_id,
            public_visible, created_at, hosted_domain, email_domain, custom_domain,
            custom_domain_candidate, custom_domain_status, runtime_tier, dedicated_vm_status,
            dedicated_vm_id, dedicated_vm_ip, egress_tier, mode
     FROM companies WHERE id = ? AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<CompanyRow>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const [turnMetrics, supervisorState, domainBundle, emailAliases] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as turn_count, MAX(created_at) as last_turn_time
       FROM credit_events
       WHERE company_id = ? AND type = 'deduct'`,
    )
      .bind(companyId)
      .first<{ turn_count: number; last_turn_time: string | null }>(),
    fetchSupervisorState(env, companyId),
    maybeSyncCompanyDomainBundle(env, companyId),
    listCompanyEmailAliases(env, companyId),
  ]);
  const verifiedTelemetry = summarizeTelemetryRows(
    await loadCompanyTelemetryRows(env, companyId, {
      verifiedOnly: true,
      limit: 250,
    }),
    "verified",
  );

  const latestCompany = domainBundle
    ? await env.DB.prepare(
      `SELECT id, name, state, inference_model, budget_cents, spent_cents, container_id,
              public_visible, created_at, hosted_domain, email_domain, custom_domain,
              custom_domain_candidate, custom_domain_status, runtime_tier, dedicated_vm_status,
              dedicated_vm_id, dedicated_vm_ip, egress_tier, mode
       FROM companies WHERE id = ? AND user_id = ?`,
    )
        .bind(companyId, userId)
        .first<CompanyRow>()
    : company;
  const snapshot = latestCompany || company;

  // Supervisor is the authority for runtime state. D1 is the fallback.
  // Terminal/admin states in D1 (dead, awaiting_funding, failed) are never overridden.
  const d1OnlyState = snapshot.state === "dead"
    || snapshot.state === "awaiting_funding"
    || snapshot.state === "failed";
  const supervisorAvailable = supervisorState.state != null;
  const effectiveState = d1OnlyState
    ? snapshot.state
    : supervisorState.state ?? snapshot.state;

  return {
    companyId: snapshot.id,
    name: snapshot.name,
    state: effectiveState,
    stateSource: d1OnlyState ? "d1" : supervisorAvailable ? "supervisor" : "d1_fallback",
    turnCount: turnMetrics?.turn_count ?? 0,
    lastTurnTime: turnMetrics?.last_turn_time ?? null,
    budgetCents: snapshot.budget_cents,
    spentCents: snapshot.spent_cents,
    remainingCents: snapshot.budget_cents - snapshot.spent_cents,
    model: snapshot.inference_model,
    engineState: supervisorState.state ?? snapshot.state,
    controlPlane: supervisorState.controlPlane,
    sandboxId: snapshot.container_id,
    recentThinking: null,
    lastHeartbeat: null,
    publicVisible: Boolean(snapshot.public_visible),
    hostedDomain: snapshot.hosted_domain,
    emailDomain: snapshot.email_domain,
    customDomain: snapshot.custom_domain,
    customDomainCandidate: snapshot.custom_domain_candidate,
    customDomainStatus: snapshot.custom_domain_status,
    runtimeTier: snapshot.runtime_tier,
    dedicatedVmStatus: snapshot.dedicated_vm_status,
    dedicatedVmId: snapshot.dedicated_vm_id,
    dedicatedVmIp: snapshot.dedicated_vm_ip,
    egressTier: snapshot.egress_tier,
    mode: snapshot.mode ?? "autonomous",
    domainBundle,
    emailAliases,
    verifiedTelemetry,
  };
}

export async function handleCompanyLaunchStatus(
  request: Request,
  env: Env,
  companyId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const company = await env.DB.prepare(
    `SELECT id, name, state, goal, idea, created_at
     FROM companies
     WHERE id = ? AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<{ id: string; name: string; state: CompanyState; goal: string | null; idea: string | null; created_at: string }>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const [agentRowsResult, delegatedTaskCountRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id, blueprint_id, role, name, title, icon, status, metadata
       FROM agents
       WHERE company_id = ?`,
    ).bind(companyId).all<LaunchAgentRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM tasks
       WHERE company_id = ?
         AND owner_agent_id IS NOT NULL
         AND owner_agent_id != (
           SELECT id
           FROM agents
           WHERE company_id = ?
             AND (blueprint_id = 'ceo' OR lower(COALESCE(role, '')) = 'ceo')
           LIMIT 1
         )`,
    ).bind(companyId, companyId).first<{ count: number }>(),
  ]);

  const foundingBlueprintIds = new Set(["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"]);
  const agentRows = agentRowsResult.results ?? [];
  const foundingAgents = agentRows.filter((agent) => agent.blueprint_id && foundingBlueprintIds.has(agent.blueprint_id));
  const nonCeoAgentCount = foundingAgents.filter((agent) => agent.blueprint_id !== "ceo" && (agent.role ?? "").toLowerCase() !== "ceo").length;
  const identityReadyCount = foundingAgents.filter((agent) => {
    if (!agent.metadata) return false;
    try {
      return Boolean((JSON.parse(agent.metadata) as { founding_identity_ready?: boolean }).founding_identity_ready);
    } catch {
      return false;
    }
  }).length;
  const avatarReadyCount = foundingAgents.filter((agent) => {
    if (!agent.metadata) return false;
    try {
      return Boolean((JSON.parse(agent.metadata) as { avatar_generated?: boolean }).avatar_generated);
    } catch {
      return false;
    }
  }).length;

  // Hydrate + personalize agents that appeared after bootstrap (e.g. from ingest_plan).
  // Runs in background via ctx.waitUntil() so the HTTP response returns immediately.
  // The dashboard polls every 1s and will pick up the personalized state on the next poll.
  const hasUnreadyAgents = foundingAgents.some((agent) => {
    if (!agent.metadata) return true;
    try {
      return !Boolean((JSON.parse(agent.metadata) as { founding_identity_ready?: boolean }).founding_identity_ready);
    } catch {
      return true;
    }
  });
  if (hasUnreadyAgents && ctx && !personalizationInFlight.has(companyId)) {
    personalizationInFlight.add(companyId);
    ctx.waitUntil(
      import("./companies.js")
        .then(({ personalizeUnreadyAgents }) => personalizeUnreadyAgents(companyId, env))
        .catch((err) => {
          console.error(`[launch-status] Background personalization failed for ${companyId}:`, err);
        })
        .finally(() => {
          personalizationInFlight.delete(companyId);
        }),
    );
  }

  const supervisorLaunch = await fetchSupervisorLaunchStatus(env, companyId);
  const launched = reconcileLaunchStatus(company, supervisorLaunch, {
    nonCeoAgentCount,
    foundingAgentCount: foundingAgents.length,
    identityReadyCount,
    avatarReadyCount,
    delegatedTaskCount: Number(delegatedTaskCountRow?.count ?? 0),
    team: buildD1LaunchTeamPreview(foundingAgents),
  });
  return Response.json(launched, { headers: corsHeaders(env) });
}

async function fetchSupervisorState(
  env: Env,
  companyId: string,
): Promise<SupervisorStatusResponse> {
  try {
    const res = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/status`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );
    if (!res) {
      return {
        supervisorReachable: false,
        state: null,
        controlPlane: {
          mode: "vm_local",
          supervisorReachable: false,
          mirrorStatus: "down",
          syncQueueDepth: null,
          oldestQueuedAt: null,
          lastSuccessfulSyncAt: null,
          statusMessage: "We can’t refresh the company dashboard right now.",
        },
      };
    }
    if (!res.ok) {
      return {
        supervisorReachable: false,
        state: null,
        controlPlane: {
          mode: "vm_local",
          supervisorReachable: false,
          mirrorStatus: "down",
          syncQueueDepth: null,
          oldestQueuedAt: null,
          lastSuccessfulSyncAt: null,
          statusMessage: "The team may still be working, but live updates are temporarily unavailable.",
        },
      };
    }

    const data = parseSupervisorStatusPayload(await res.json());
    if (!data) {
      return {
        supervisorReachable: false,
        state: null,
        controlPlane: {
          mode: "vm_local",
          supervisorReachable: false,
          mirrorStatus: "down",
          syncQueueDepth: null,
          oldestQueuedAt: null,
          lastSuccessfulSyncAt: null,
          statusMessage: "The runtime returned an incompatible live-status payload.",
        },
      };
    }
    const controlPlane = data.controlPlane as SupervisorControlPlane | null;

    if (!controlPlane) {
      const state = (data.state as CompanyState | undefined) ?? null;
      return {
        supervisorReachable: true,
        state,
        controlPlane: {
          mode: "vm_local",
          supervisorReachable: true,
          mirrorStatus: "healthy",
          syncQueueDepth: 0,
          oldestQueuedAt: null,
          lastSuccessfulSyncAt: null,
          statusMessage: state === "paused"
            ? "This company is paused."
            : "The team is active and the dashboard is up to date.",
        },
      };
    }

    const state = (data.state as CompanyState | undefined) ?? null;
    return {
      supervisorReachable: true,
      state,
      controlPlane: {
        ...controlPlane,
        supervisorReachable: true,
        statusMessage: state === "paused"
          ? "This company is paused."
          : controlPlane.mirrorStatus === "healthy"
            ? "The team is active and the dashboard is up to date."
            : "New updates are taking a little longer to appear here.",
      },
    };
  } catch {
    return {
      supervisorReachable: false,
      state: null,
      controlPlane: {
        mode: "vm_local",
        supervisorReachable: false,
        mirrorStatus: "down",
        syncQueueDepth: null,
        oldestQueuedAt: null,
        lastSuccessfulSyncAt: null,
        statusMessage: "The team may still be working, but live updates are temporarily unavailable.",
      },
    };
  }
}

async function fetchSupervisorLaunchStatus(
  env: Env,
  companyId: string,
): Promise<{
  supervisorReachable: boolean;
  payload: SupervisorLaunchStatus | null;
}> {
  try {
    const res = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/launch-status`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );

    if (!res || !res.ok) {
      return { supervisorReachable: false, payload: null };
    }

    return {
      supervisorReachable: true,
      payload: parseSupervisorLaunchStatus(await res.json()),
    };
  } catch {
    return { supervisorReachable: false, payload: null };
  }
}

function reconcileLaunchStatus(
  company: { id: string; name: string; state: CompanyState; goal: string | null; idea: string | null; created_at: string },
  supervisorLaunch: { supervisorReachable: boolean; payload: SupervisorLaunchStatus | null },
  d1Bootstrap: {
    nonCeoAgentCount: number;
    foundingAgentCount: number;
    identityReadyCount: number;
    avatarReadyCount: number;
    delegatedTaskCount: number;
    team: LaunchAgentPreview[];
  },
): CompanyLaunchStatus {
  const d1ReadyState = company.state === "running" || company.state === "paused";
  const d1FoundingTeamReady = d1Bootstrap.foundingAgentCount >= REQUIRED_FOUNDING_TEAM_SIZE && d1ReadyState;
  const d1IdentityReady = d1Bootstrap.identityReadyCount >= REQUIRED_FOUNDING_TEAM_SIZE;
  const d1AvatarReady = d1Bootstrap.avatarReadyCount >= REQUIRED_FOUNDING_TEAM_SIZE;
  const d1DelegationReady = d1Bootstrap.delegatedTaskCount > 0;
  const d1Ready = d1ReadyState && d1FoundingTeamReady && d1IdentityReady && d1AvatarReady && d1DelegationReady;
  const derivedMissingItems = d1Ready
    ? []
    : [
        ...(d1FoundingTeamReady ? [] : ["Founding team"]),
        ...(d1IdentityReady ? [] : ["Team identity"]),
        ...(d1AvatarReady ? [] : ["Team avatars"]),
        ...(d1DelegationReady ? [] : ["Delegated work"]),
      ];
  const mergedTeam = mergeLaunchTeams(supervisorLaunch.payload?.team ?? [], d1Bootstrap.team);
  const base: CompanyLaunchStatus = supervisorLaunch.payload
    ? {
        companyId: company.id,
        name: supervisorLaunch.payload.name,
        companyState: company.state,
        engineState: supervisorLaunch.payload.state as CompanyState,
        ready: d1Ready && supervisorLaunch.payload.ready,
        terminal: supervisorLaunch.payload.terminal,
        stage: d1Ready && supervisorLaunch.payload.ready ? "ready" : supervisorLaunch.payload.stage,
        progressPercent: d1Ready && supervisorLaunch.payload.ready ? 100 : supervisorLaunch.payload.progress_percent,
        headline: d1Ready && supervisorLaunch.payload.ready
          ? company.state === "paused"
            ? "Company launched and paused"
            : "Company launched"
          : supervisorLaunch.payload.headline,
        detail: d1Ready && supervisorLaunch.payload.ready
          ? "The company is operational. Live bootstrap telemetry is catching up."
          : supervisorLaunch.payload.detail,
        missingItems: d1Ready && supervisorLaunch.payload.ready
          ? []
          : Array.from(new Set([...(supervisorLaunch.payload.missing_items ?? []), ...derivedMissingItems])),
        steps: d1Ready && supervisorLaunch.payload.ready
          ? supervisorLaunch.payload.steps.map((step) => ({ ...step, state: "done" as const }))
          : supervisorLaunch.payload.steps,
        team: mergedTeam,
        taskPreview: supervisorLaunch.payload.task_preview,
        missionText: supervisorLaunch.payload.mission_text,
        supervisorReachable: supervisorLaunch.supervisorReachable,
      }
    : {
        companyId: company.id,
        name: company.name,
        companyState: company.state,
        engineState: null,
        ready: d1Ready,
        terminal: company.state === "failed" || company.state === "awaiting_funding" || company.state === "dead",
        stage:
          company.state === "awaiting_funding"
            ? "awaiting_funding"
            : company.state === "failed" || company.state === "dead"
            ? "failed"
            : d1Ready
            ? "ready"
            : "creating_workspace",
        progressPercent:
          company.state === "provisioning"
            ? 8
            : company.state === "planning"
            ? 35
            : d1Ready
            ? 100
            : 0,
        headline:
          company.state === "awaiting_funding"
            ? "Launch paused for credits"
          : company.state === "failed" || company.state === "dead"
            ? "Launch failed"
          : d1Ready
            ? company.state === "paused"
              ? "Company launched and paused"
              : "Company launched"
            : "Provisioning your company",
        detail:
          company.state === "awaiting_funding"
            ? "Credits are required before the launch can continue."
          : company.state === "failed" || company.state === "dead"
            ? "Provisioning did not complete successfully."
          : d1Ready
            ? "The company is ready to enter. Live launch telemetry is temporarily unavailable, but the launch completed."
            : "The launch runtime has not confirmed readiness yet. We’re waiting for the full founding team and first delegated work.",
        missingItems: d1Ready
          ? []
          : derivedMissingItems,
        steps: [
          {
            id: "creating_workspace",
            label: "Workspace online",
            detail: "Preparing the workspace and launch context.",
            state: d1Ready ? "done" : "active",
          },
          {
            id: "ceo_planning",
            label: "CEO planning",
            detail: d1Ready
              ? "The launch completed, but live bootstrap detail is not available right now."
              : "Waiting for the runtime to confirm the full team and first delegated tasks.",
            state: d1Ready ? "done" : "pending",
          },
        ],
        team: d1Bootstrap.team,
        taskPreview: [],
        missionText: company.goal ?? null,
        supervisorReachable: supervisorLaunch.supervisorReachable,
      };

  if (company.state === "awaiting_funding") {
    return {
      ...base,
      companyState: "awaiting_funding",
      ready: false,
      terminal: true,
      stage: "awaiting_funding",
      progressPercent: 100,
      headline: "Launch paused for credits",
      detail: "The company exists, but credits are required before work can continue.",
    };
  }

  if (company.state === "failed" || company.state === "dead") {
    return {
      ...base,
      companyState: company.state,
      ready: false,
      terminal: true,
      stage: "failed",
      progressPercent: 100,
      headline: "Launch failed",
      detail: "Provisioning did not complete successfully.",
    };
  }

  return base;
}

function normalizeLaunchText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") {
    return null;
  }
  return trimmed;
}

function parseAgentMetadata(metadata: string | null): {
  founding_identity_ready?: boolean;
  avatar_generated?: boolean;
} {
  if (!metadata) {
    return {};
  }
  try {
    return JSON.parse(metadata) as {
      founding_identity_ready?: boolean;
      avatar_generated?: boolean;
    };
  } catch {
    return {};
  }
}

function buildD1LaunchTeamPreview(agentRows: LaunchAgentRow[]): LaunchAgentPreview[] {
  const foundingOrder = ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"];
  const indexByBlueprint = new Map(foundingOrder.map((id, index) => [id, index]));
  return [...agentRows]
    .sort((a, b) => {
      const aIndex = indexByBlueprint.get(a.blueprint_id ?? "") ?? Number.MAX_SAFE_INTEGER;
      const bIndex = indexByBlueprint.get(b.blueprint_id ?? "") ?? Number.MAX_SAFE_INTEGER;
      return aIndex - bIndex;
    })
    .map((agent) => {
      const metadata = parseAgentMetadata(agent.metadata);
      const role = normalizeLaunchText(agent.role)
        || normalizeLaunchText(agent.blueprint_id)
        || "specialist";
      const fallbackTitle = role
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      return {
        id: agent.id,
        name: normalizeLaunchText(agent.name) || normalizeLaunchText(agent.title) || "Agent",
        role,
        title: normalizeLaunchText(agent.title) || fallbackTitle,
        status: normalizeLaunchText(agent.status) || "free",
        icon: metadata.avatar_generated ? normalizeLaunchText(agent.icon) || `/api/avatars/${agent.id}` : normalizeLaunchText(agent.icon),
      };
    });
}

function mergeLaunchTeams(
  supervisorTeam: LaunchAgentPreview[],
  d1Team: LaunchAgentPreview[],
): LaunchAgentPreview[] {
  const merged = new Map<string, LaunchAgentPreview>();

  for (const agent of supervisorTeam) {
    merged.set(agent.id, { ...agent });
  }

  for (const agent of d1Team) {
    const existing = merged.get(agent.id);
    merged.set(agent.id, existing
      ? {
          ...existing,
          name: normalizeLaunchText(agent.name) || normalizeLaunchText(existing.name) || "Agent",
          role: normalizeLaunchText(agent.role) || normalizeLaunchText(existing.role) || "specialist",
          title: normalizeLaunchText(agent.title) || normalizeLaunchText(existing.title),
          icon: normalizeLaunchText(agent.icon) || normalizeLaunchText(existing.icon),
          status: normalizeLaunchText(existing.status) || normalizeLaunchText(agent.status) || "free",
        }
      : agent);
  }

  return Array.from(merged.values());
}

/**
 * GET /api/companies/:id/agents-status — Multi-agent status for the dashboard.
 */
export async function handleCompanyAgentsStatus(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  }
  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  }

  // Verify ownership
  const company = await env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?",
  ).bind(companyId, userId).first();
  if (!company) {
    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  }

  // Get all agents for the company
  const { results: agents } = await env.DB.prepare(
    `SELECT id, name, role, title, status, reports_to, capabilities, last_heartbeat_at, created_at
     FROM agents WHERE company_id = ? ORDER BY created_at ASC`,
  ).bind(companyId).all();

  if (!agents || agents.length === 0) {
    return Response.json({ agents: [] }, { headers: corsHeaders(env) });
  }

  // Query each agent's DO for live status
  const agentStatuses = await Promise.all(
    (agents as any[]).map(async (agent) => {
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        status: agent.status,
        reportsTo: agent.reports_to,
        capabilities: JSON.parse(agent.capabilities || "[]"),
        lastHeartbeatAt: agent.last_heartbeat_at,
        createdAt: agent.created_at,
        // Live data will come from supervisor in Phase 3
        engineState: null,
        turnCount: 0,
        lastTurnTime: null,
        spentCents: 0,
        recentThinking: null,
      };
    }),
  );

  return Response.json({ agents: agentStatuses }, { headers: corsHeaders(env) });
}
