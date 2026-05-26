import type { Env, CompanyState } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import { loadFounderVisibleAgents } from "./agents.js";
import { loadCompanyTasksForFounder } from "./realtime.js";
import { loadCompanyApprovals } from "./approvals.js";
import { buildCompanyStatusPayload } from "./company-status.js";
import {
  loadFounderDocumentsSnapshot,
  requireCompanyDocumentAccess,
} from "./company-documents.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";
import { parseSupervisorStatusPayload } from "../utils/internal-contract.js";

/** Module-level lock to prevent duplicate personalization jobs for the same company. */
const personalizationInFlight = new Set<string>();

export type FounderCompanyState = "running" | "paused" | "failed";
export type FounderAgentStatus = "free" | "working" | "paused";
export type FounderTaskStatus =
  | "active"
  | "queued"
  | "waiting_on_founder"
  | "waiting_on_dependency"
  | "done"
  | "paused";

export type CompanyStatusPayload = {
  companyId: string;
  name: string;
  state: CompanyState;
  engineState?: string | null;
  turnCount: number;
  lastTurnTime: string | null;
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  model: string;
  sandboxId: string | null;
  recentThinking: string | null;
  lastHeartbeat: string | null;
  publicVisible: boolean;
  hostedDomain?: string | null;
  emailDomain?: string | null;
  customDomain?: string | null;
  customDomainCandidate?: string | null;
  customDomainStatus?: string | null;
  runtimeTier?: string | null;
  dedicatedVmStatus?: string | null;
  dedicatedVmId?: string | null;
  dedicatedVmIp?: string | null;
  egressTier?: string | null;
  domainBundle?: unknown;
  emailAliases?: unknown;
  verifiedTelemetry?: unknown;
  controlPlane?: unknown;
};

type TaskPayload = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  owner_agent_id: string | null;
  blocked_reason: string | null;
  parent_task_id: string | null;
  depends_on: string | null;
  created_at: string;
  updated_at: string;
};

type ApprovalPayload = {
  id: string;
  type: string;
  payload: string;
  related_task_id: string | null;
  requested_by_agent_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type CompanyDocumentPayload = {
  id: string;
  type: string;
  title: string;
  body: string;
  excerpt?: string;
  createdAt: string;
  path?: string;
  category?: string;
  agentName?: string;
};

export type CompanyArtifactPayload = {
  path: string;
  title: string;
  kind: string;
  excerpt: string;
  updatedAt: string;
  urls?: string[];
  previewDataUrl?: string;
  openUrl?: string;
};

export type AgentSkillBadge = {
  slug: string;
  name: string;
};

export type FounderVisibleAgent = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: FounderAgentStatus;
  email_address: string | null;
  lastActiveAt: string | null;
  lastTurnAt: string | null;
  reports_to: string | null;
  adapter_type: string | null;
  webhook_url: string | null;
  source: string;
  total_credits_consumed: number;
  model_tier: string;
  instructions: string;
  system_prompt: string | null;
  skills?: AgentSkillBadge[];
};

export type FounderTaskAction = {
  type: "founder_input";
  resolutionIds: string[];
  prompt: string | null;
  approveLabel: string;
  rejectLabel: string;
  replyPlaceholder: string | null;
  replyRequired: boolean;
};

export type FounderCreditReservation = {
  companyId: string;
  companyName: string;
  state: FounderCompanyState | null;
  reserved: number;
  isCurrentCompany: boolean;
};

export type FounderVisibleTask = {
  id: string;
  title: string;
  description: string | null;
  status: FounderTaskStatus;
  ownerAgentId: string | null;
  ownerName: string | null;
  ownerTitle: string | null;
  ownerIcon: string | null;
  updatedAt: string;
  completedAt: string | null;
  detail: string | null;
  parentTaskId: string | null;
  blockedBy?: { taskId: string; title: string }[];
  action?: FounderTaskAction | null;
};

export type FounderStatePayload = {
  companyId: string;
  name: string;
  state: FounderCompanyState;
  status: CompanyStatusPayload;
  credits: {
    balance: number;
    reserved: number;
    available: number;
    currentCompanyReserved: number;
    otherCompanyReserved: number;
    contentionReason: string | null;
    reservations: FounderCreditReservation[];
  };
  agents: FounderVisibleAgent[];
  tasks: FounderVisibleTask[];
  documents: CompanyDocumentPayload[];
  artifacts: CompanyArtifactPayload[];
  opsSummary: {
    headline: string;
    detail: string;
  };
};

type ApprovalLabels = {
  approveLabel: string;
  rejectLabel: string;
  replyPlaceholder: string | null;
  replyRequired: boolean;
};

function parseApprovalPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function approvalLabels(type: string): ApprovalLabels {
  if (type === "hire_agent") {
    return {
      approveLabel: "Approve hire",
      rejectLabel: "Reject",
      replyPlaceholder: null,
      replyRequired: false,
    };
  }

  if (type === "strategy") {
    return {
      approveLabel: "Approve plan",
      rejectLabel: "Request changes",
      replyPlaceholder: "What should change?",
      replyRequired: false,
    };
  }

  return {
    approveLabel: "Approve",
    rejectLabel: "Reject",
    replyPlaceholder: "Add the info the team needs...",
    replyRequired: false,
  };
}

function approvalText(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function approvalTitle(approval: ApprovalPayload): string {
  const payload = parseApprovalPayload(approval.payload);
  return (
    approvalText(payload, ["title", "subject", "name"])
    || approvalText(payload, ["summary", "body", "description"])
    || approval.type.replace(/_/g, " ")
  );
}

function approvalDescription(approval: ApprovalPayload): string | null {
  const payload = parseApprovalPayload(approval.payload);
  return approvalText(payload, ["summary", "body", "description"]);
}

function approvalPrompt(approvals: ApprovalPayload[]): string | null {
  const payload = approvals[0] ? parseApprovalPayload(approvals[0].payload) : {};
  return approvalText(payload, ["prompt", "question", "summary", "body", "description"]);
}

function normalizeFounderCompanyState(state: CompanyState | null | undefined): FounderCompanyState {
  if (state === "paused") {
    return "paused";
  }
  if (state === "failed" || state === "dead") {
    return "failed";
  }
  return "running";
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => {
      const normalized =
        value.includes("T") || value.includes("Z") || value.includes("+")
          ? value
          : `${value.replace(" ", "T")}Z`;
      const time = new Date(normalized).getTime();
      return Number.isFinite(time) ? { value, time } : null;
    })
    .filter((value): value is { value: string; time: number } => value !== null)
    .sort((a, b) => b.time - a.time);

  return timestamps[0]?.value ?? null;
}

function humanizeBlockedReason(reason: string | null | undefined): string | null {
  if (!reason) {
    return null;
  }

  const normalized = reason
    .trim()
    .replace(/^founder[_\s-]?approval:?/i, "Needs your approval: ")
    .replace(/^founder[_\s-]?input:?/i, "Needs your input: ")
    .replace(/[_-]+/g, " ");

  return normalized || null;
}

function isFounderBlocked(task: TaskPayload, approvals: ApprovalPayload[]): boolean {
  if (approvals.length > 0) {
    return true;
  }
  return (task.blocked_reason || "").toLowerCase().includes("founder");
}

function sortTasksForProjection(tasks: TaskPayload[]): TaskPayload[] {
  return [...tasks].sort((a, b) => {
    const createdDelta = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (createdDelta !== 0) {
      return createdDelta;
    }
    return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
  });
}

function buildFounderOpsSummary(
  state: FounderCompanyState,
  tasks: FounderVisibleTask[],
  agents: FounderVisibleAgent[],
  credits: FounderStatePayload["credits"],
): { headline: string; detail: string } {
  if (state === "paused") {
    return {
      headline: "Company paused",
      detail: "The team is visible and ready to resume, but no work is running while the company is paused.",
    };
  }

  if (state === "failed") {
    return {
      headline: "Company needs intervention",
      detail: "The company hit a platform-level failure. We need to repair it before work can continue.",
    };
  }

  const active = tasks.filter((task) => task.status === "active").length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const waitingOnFounder = tasks.filter((task) => task.status === "waiting_on_founder").length;
  const waitingOnDependency = tasks.filter((task) => task.status === "waiting_on_dependency").length;
  const workingAgents = agents.filter((agent) => agent.status === "working").length;
  const topOtherReservation = credits.reservations.find((reservation) => !reservation.isCurrentCompany);

  if (active === 0 && credits.available <= 0 && credits.otherCompanyReserved > 0) {
    return {
      headline: "Credits are tied up in other companies",
      detail: topOtherReservation
        ? `${topOtherReservation.companyName} is currently holding ${topOtherReservation.reserved} reserved credit${topOtherReservation.reserved === 1 ? "" : "s"}, so this company is waiting for budget to free up.`
        : "Your shared wallet is fully reserved by work already in progress on another company.",
    };
  }

  if (active === 0 && credits.available <= 0) {
    return {
      headline: "No credits available right now",
      detail: "This company can resume as soon as more credits are added to your account.",
    };
  }

  if (active > 0) {
    return {
      headline: `${active} active task${active === 1 ? "" : "s"} in motion`,
      detail:
        queued > 0
          ? `${workingAgents} agent${workingAgents === 1 ? "" : "s"} are working now, with ${queued} task${queued === 1 ? "" : "s"} queued behind current work.`
          : `${workingAgents} agent${workingAgents === 1 ? "" : "s"} are working now.`,
    };
  }

  if (waitingOnFounder > 0) {
    return {
      headline: `Waiting on you for ${waitingOnFounder} task${waitingOnFounder === 1 ? "" : "s"}`,
      detail: "The CEO can keep going as soon as you answer the pending request.",
    };
  }

  if (waitingOnDependency > 0) {
    return {
      headline: `${waitingOnDependency} task${waitingOnDependency === 1 ? "" : "s"} waiting on dependencies`,
      detail: "The CEO is sequencing work so these tasks can unlock cleanly.",
    };
  }

  if (queued > 0) {
    return {
      headline: `${queued} queued task${queued === 1 ? "" : "s"} ready to start`,
      detail: "The team has queued work ready to pick up as capacity opens.",
    };
  }

  return {
    headline: "Team ready for the next move",
    detail: "No task is actively running right now. The CEO should assign or re-sequence work next.",
  };
}

export async function buildFounderStatePayload(
  env: Env,
  companyId: string,
  userId: string,
  options?: {
    includeDocuments?: boolean;
  },
): Promise<Response | FounderStatePayload> {
  const includeDocuments = options?.includeDocuments !== false;
  const company = await requireCompanyDocumentAccess(env, companyId, userId);
  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const [statusPayload, initialAgents, tasks, approvals, documentsPayload, balanceRow, supervisorCredits] = await Promise.all([
    buildCompanyStatusPayload(env, companyId, userId),
    loadFounderVisibleAgents(env, companyId),
    loadCompanyTasksForFounder(env, companyId) as Promise<TaskPayload[]>,
    loadCompanyApprovals(env, companyId, null) as Promise<ApprovalPayload[]>,
    includeDocuments
      ? loadFounderDocumentsSnapshot(env, companyId, company, { reconcileWorkspaceTasks: false })
      : Promise.resolve({ documents: [], artifacts: [] }),
    env.DB.prepare(
      `SELECT balance
       FROM credit_balances
       WHERE user_id = ?`,
    ).bind(userId).first<{ balance: number }>(),
    resolveCreditsFromSupervisor(env, companyId),
  ]);

  if (statusPayload instanceof Response) {
    return statusPayload;
  }

  // Catch agents that missed personalization during launch (e.g. activated by ingest_plan after bootstrap)
  const foundingBlueprintIds = new Set(["ceo", "cto", "frontend-dev", "backend-dev", "qa-tester", "cmo"]);
  const hasUnpersonalized = initialAgents.some((agent) => {
    if (!agent.blueprint_id || !foundingBlueprintIds.has(agent.blueprint_id)) return false;
    if (!agent.metadata) return true;
    try {
      return !Boolean((JSON.parse(agent.metadata as string) as { founding_identity_ready?: boolean }).founding_identity_ready);
    } catch {
      return true;
    }
  });
  let agents = initialAgents;
  if (hasUnpersonalized && !personalizationInFlight.has(companyId)) {
    personalizationInFlight.add(companyId);
    try {
      const { personalizeUnreadyAgents } = await import("./companies.js");
      await personalizeUnreadyAgents(companyId, env);
      agents = await loadFounderVisibleAgents(env, companyId);
    } catch (err) {
      console.error(`[founder-state] Lazy personalization failed for ${companyId}:`, err);
    } finally {
      personalizationInFlight.delete(companyId);
    }
  }

  const status = statusPayload as CompanyStatusPayload;

  if (
    status.state !== "running"
    && status.state !== "paused"
    && status.state !== "failed"
  ) {
    return Response.json(
      { error: "Company is not ready for the founder dashboard yet." },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  const founderCompanyState = normalizeFounderCompanyState(status.state);
  const totalBalance = Math.max(balanceRow?.balance ?? 0, supervisorCredits?.totalBalance ?? 0);
  const available = Math.max(0, Math.min(totalBalance, supervisorCredits?.available ?? totalBalance));
  const reserved = Math.max(0, Math.min(totalBalance, supervisorCredits?.reserved ?? (totalBalance - available)));
  const currentCompanyReserved = Math.max(
    0,
    Math.min(reserved, supervisorCredits?.currentCompanyReserved ?? 0),
  );
  const reservations = (supervisorCredits?.reservations ?? []).map((reservation) => ({
    companyId: reservation.companyId,
    companyName: reservation.companyName,
    state: reservation.state ? normalizeFounderCompanyState(reservation.state as CompanyState) : null,
    reserved: reservation.reserved,
    isCurrentCompany: reservation.companyId === companyId,
  }));
  const otherCompanyReserved = Math.max(
    0,
    Math.min(
      reserved,
      supervisorCredits?.otherCompanyReserved
      ?? reservations
        .filter((reservation) => !reservation.isCurrentCompany)
        .reduce((sum, reservation) => sum + reservation.reserved, 0),
    ),
  );
  const contentionReason = available <= 0 && otherCompanyReserved > 0
    ? reservations
        .filter((reservation) => !reservation.isCurrentCompany)
        .slice(0, 2)
        .map((reservation) => `${reservation.companyName} (${reservation.reserved})`)
        .join(", ")
    : null;

  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const approvalsByTask = new Map<string, ApprovalPayload[]>();
  const orphanApprovals: ApprovalPayload[] = [];

  for (const approval of pendingApprovals) {
    if (approval.related_task_id) {
      const existing = approvalsByTask.get(approval.related_task_id) ?? [];
      existing.push(approval);
      approvalsByTask.set(approval.related_task_id, existing);
      continue;
    }
    orphanApprovals.push(approval);
  }

  const sortedTasks = sortTasksForProjection(tasks);
  const taskMap = new Map(sortedTasks.map((task) => [task.id, task]));
  const activeTaskIds = new Set(
    sortedTasks
      .filter((task) => task.status === "in_progress" && task.owner_agent_id)
      .map((task) => task.id),
  );
  const ownerActiveTaskIds = new Map<string, string>();
  for (const task of sortedTasks) {
    if (task.owner_agent_id && activeTaskIds.has(task.id) && !ownerActiveTaskIds.has(task.owner_agent_id)) {
      ownerActiveTaskIds.set(task.owner_agent_id, task.id);
    }
  }

  const projectedTasks: FounderVisibleTask[] = [];
  const readyTaskSeenByOwner = new Set<string>();

  for (const task of sortedTasks) {
    if (task.status === "failed" || task.status === "cancelled") {
      continue;
    }

    const owner = task.owner_agent_id ? agentMap.get(task.owner_agent_id) ?? null : null;
    const linkedApprovals = approvalsByTask.get(task.id) ?? [];
    const founderBlocked = isFounderBlocked(task, linkedApprovals);
    let projectedStatus: FounderTaskStatus | null = null;
    let detail: string | null = null;
    let action: FounderTaskAction | null = null;
    let blockedBy: { taskId: string; title: string }[] | undefined;

    if (task.status === "done") {
      projectedStatus = "done";
    } else if (founderCompanyState === "paused") {
      projectedStatus = "paused";
      detail = "Company is paused.";
    } else if (founderBlocked) {
      projectedStatus = "waiting_on_founder";
      detail = humanizeBlockedReason(task.blocked_reason) || approvalDescription(linkedApprovals[0]) || null;
      if (linkedApprovals.length > 0) {
        const labels = approvalLabels(linkedApprovals[0].type);
        action = {
          type: "founder_input",
          resolutionIds: linkedApprovals.map((approval) => approval.id),
          prompt: approvalPrompt(linkedApprovals),
          approveLabel: labels.approveLabel,
          rejectLabel: labels.rejectLabel,
          replyPlaceholder: labels.replyPlaceholder,
          replyRequired: labels.replyRequired,
        };
      }
    } else if (task.status === "blocked" || task.status === "pending") {
      projectedStatus = "waiting_on_dependency";
      detail = humanizeBlockedReason(task.blocked_reason);
      // Resolve dependency titles from depends_on field
      if (task.depends_on) {
        try {
          const depIds = JSON.parse(task.depends_on) as string[];
          if (Array.isArray(depIds) && depIds.length > 0) {
            const resolved = depIds
              .map((depId) => {
                const dep = taskMap.get(depId);
                return dep ? { taskId: dep.id, title: dep.title } : null;
              })
              .filter((entry): entry is { taskId: string; title: string } => entry !== null);
            if (resolved.length > 0) {
              blockedBy = resolved;
            }
          }
        } catch {
          // depends_on is not valid JSON — ignore
        }
      }
    } else if (task.status === "in_progress") {
      projectedStatus = "active";
    } else if (task.status === "ready") {
      if (!task.owner_agent_id) {
        continue;
      }
      const ownerActiveTaskId = ownerActiveTaskIds.get(task.owner_agent_id);
      if (ownerActiveTaskId && ownerActiveTaskId !== task.id) {
        projectedStatus = "queued";
        detail = "Queued behind current work.";
      } else if (readyTaskSeenByOwner.has(task.owner_agent_id)) {
        projectedStatus = "queued";
        detail = "Queued behind another ready task.";
      } else {
        projectedStatus = "active";
        readyTaskSeenByOwner.add(task.owner_agent_id);
      }
    }

    if (!projectedStatus) {
      continue;
    }

    projectedTasks.push({
      id: task.id,
      title: task.title,
      description: task.description,
      status: projectedStatus,
      ownerAgentId: task.owner_agent_id,
      ownerName: owner?.name ?? null,
      ownerTitle: owner?.title ?? null,
      ownerIcon: owner?.icon ?? null,
      updatedAt: task.updated_at,
      completedAt: projectedStatus === "done" ? task.updated_at : null,
      detail,
      parentTaskId: task.parent_task_id ?? null,
      ...(blockedBy && blockedBy.length > 0 ? { blockedBy } : {}),
      action,
    });
  }

  for (const approval of orphanApprovals) {
    const requester = approval.requested_by_agent_id
      ? agentMap.get(approval.requested_by_agent_id) ?? null
      : null;
    const labels = approvalLabels(approval.type);

    projectedTasks.push({
      id: `approval:${approval.id}`,
      title: approvalTitle(approval),
      description: approvalDescription(approval),
      status: founderCompanyState === "paused" ? "paused" : "waiting_on_founder",
      ownerAgentId: requester?.id ?? null,
      ownerName: requester?.name ?? null,
      ownerTitle: requester?.title ?? null,
      ownerIcon: requester?.icon ?? null,
      updatedAt: approval.updated_at || approval.created_at,
      completedAt: null,
      detail: approvalDescription(approval),
      parentTaskId: null,
      action: founderCompanyState === "paused"
        ? null
        : {
            type: "founder_input",
            resolutionIds: [approval.id],
            prompt: approvalPrompt([approval]),
            approveLabel: labels.approveLabel,
            rejectLabel: labels.rejectLabel,
            replyPlaceholder: labels.replyPlaceholder,
            replyRequired: labels.replyRequired,
          },
    });
  }

  const activeOwnerIds = new Set(
    projectedTasks
      .filter((task) => task.status === "active" && task.ownerAgentId)
      .map((task) => task.ownerAgentId as string),
  );

  // Load agent skills from D1
  const agentIds = agents.filter((a) => a.status !== "terminated").map((a) => a.id);
  const skillsByAgent = new Map<string, AgentSkillBadge[]>();
  if (agentIds.length > 0) {
    try {
      const placeholders = agentIds.map(() => "?").join(",");
      const skillRows = await env.DB.prepare(
        `SELECT agent_id, skill_slug, name FROM agent_skills WHERE agent_id IN (${placeholders})`,
      ).bind(...agentIds).all<{ agent_id: string; skill_slug: string; name: string }>();
      for (const row of skillRows.results ?? []) {
        const existing = skillsByAgent.get(row.agent_id) ?? [];
        existing.push({ slug: row.skill_slug, name: row.name });
        skillsByAgent.set(row.agent_id, existing);
      }
    } catch {
      // agent_skills table may not exist yet — gracefully ignore
    }
  }

  const founderAgents: FounderVisibleAgent[] = agents
    .filter((agent) => agent.status !== "terminated")
    .map((agent) => {
      const agentSkills = skillsByAgent.get(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        icon: agent.icon,
        status:
          founderCompanyState === "paused"
            ? "paused"
            : activeOwnerIds.has(agent.id)
              ? "working"
              : "free",
        email_address: agent.email_address ?? null,
        lastActiveAt: latestTimestamp(agent.last_wake_at, agent.last_sleep_at, agent.last_heartbeat_at),
        lastTurnAt: latestTimestamp(agent.last_sleep_at, agent.last_heartbeat_at),
        reports_to: agent.reports_to ?? null,
        adapter_type: agent.adapter_type ?? null,
        webhook_url: agent.webhook_url ?? null,
        source: agent.source ?? "internal",
        total_credits_consumed: agent.total_credits_consumed ?? 0,
        model_tier: agent.model_tier ?? "sonnet",
        instructions: agent.instructions ?? "",
        system_prompt: agent.system_prompt ?? null,
        ...(agentSkills && agentSkills.length > 0 ? { skills: agentSkills } : {}),
      };
    });

  const projectedState: FounderStatePayload = {
    companyId: status.companyId,
    name: status.name,
    state: founderCompanyState,
    status: {
      ...status,
      state: founderCompanyState,
    },
    credits: {
      balance: totalBalance,
      reserved,
      available,
      currentCompanyReserved,
      otherCompanyReserved,
      contentionReason,
      reservations,
    },
    agents: founderAgents,
    tasks: projectedTasks.sort((a, b) => {
      const statusOrder: Record<FounderTaskStatus, number> = {
        active: 0,
        queued: 1,
        waiting_on_founder: 2,
        waiting_on_dependency: 3,
        done: 4,
        paused: 5,
      };
      const byStatus = statusOrder[a.status] - statusOrder[b.status];
      if (byStatus !== 0) {
        return byStatus;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }),
    documents: documentsPayload.documents,
    artifacts: documentsPayload.artifacts,
    opsSummary: buildFounderOpsSummary(
      founderCompanyState,
      projectedTasks,
      founderAgents,
      {
        balance: totalBalance,
        reserved,
        available,
        currentCompanyReserved,
        otherCompanyReserved,
        contentionReason,
        reservations,
      },
    ),
  };

  return projectedState;
}

export async function handleFounderState(
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

  const projectedState = await buildFounderStatePayload(env, companyId, userId);
  if (projectedState instanceof Response) {
    return projectedState;
  }

  return Response.json(projectedState, {
    headers: corsHeaders(env),
  });
}

async function resolveCreditsFromSupervisor(
  env: Env,
  companyId: string,
): Promise<{
  totalBalance: number;
  available: number;
  reserved: number;
  currentCompanyReserved: number;
  otherCompanyReserved: number;
  reservations: FounderCreditReservation[];
} | null> {
  try {
    const supervisorResponse = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/status`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );

    if (!supervisorResponse || !supervisorResponse.ok) {
      return null;
    }

    const payload = parseSupervisorStatusPayload(await supervisorResponse.json());
    if (!payload?.credits) {
      return null;
    }

    const totalBalance = Math.max(0, payload.credits.total ?? payload.credits.available ?? 0);
    const available = Math.max(0, Math.min(totalBalance, payload.credits.available ?? totalBalance));
    const reserved = Math.max(0, Math.min(totalBalance, payload.credits.reserved ?? (totalBalance - available)));
    const currentCompanyReserved = Math.max(0, payload.credits.currentCompanyReserved ?? 0);
    const reservations = payload.credits.reservationBreakdown.map((reservation) => ({
      companyId: reservation.company_id,
      companyName: reservation.company_name,
      state: reservation.company_state ? normalizeFounderCompanyState(reservation.company_state as CompanyState) : null,
      reserved: reservation.reserved_balance,
      isCurrentCompany: reservation.company_id === companyId,
    }));
    const otherCompanyReserved = Math.max(
      0,
      reservations
        .filter((reservation) => !reservation.isCurrentCompany)
        .reduce((sum, reservation) => sum + reservation.reserved, 0),
    );

    return {
      totalBalance,
      available,
      reserved,
      currentCompanyReserved,
      otherCompanyReserved,
      reservations,
    };
  } catch {
    return null;
  }
}
