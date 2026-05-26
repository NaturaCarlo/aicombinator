export const INTERNAL_RUNTIME_CONTRACT_VERSION = "2026-03-22.v1";

type ParsedReservation = {
  company_id: string;
  company_name: string;
  company_state: string | null;
  reserved_balance: number;
};

export type ParsedSupervisorStatusPayload = {
  state: string | null;
  controlPlane: {
    mode: "vm_local";
    mirrorStatus: "healthy" | "delayed" | "down";
    syncQueueDepth: number | null;
    oldestQueuedAt: string | null;
    lastSuccessfulSyncAt: string | null;
    statusMessage: string;
  } | null;
  credits: {
    available: number | null;
    total: number | null;
    reserved: number | null;
    currentCompanyReserved: number | null;
    reservationBreakdown: ParsedReservation[];
  } | null;
};

export type ParsedSupervisorLaunchStatus = {
  company_id: string;
  name: string;
  state: string;
  ready: boolean;
  terminal: boolean;
  stage:
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
  progress_percent: number;
  headline: string;
  detail: string;
  missing_items: string[];
  steps: Array<{
    id: string;
    label: string;
    detail?: string;
    state: "done" | "active" | "pending";
  }>;
  team: Array<{
    id: string;
    name: string;
    role: string;
    title: string | null;
    status: string;
    icon: string | null;
  }>;
  task_preview: Array<{
    id: string;
    title: string;
    status: string;
    owner_name: string | null;
  }>;
  mission_text: string | null;
};

type ParsedLaunchStep = ParsedSupervisorLaunchStatus["steps"][number];
type ParsedLaunchTeamMember = ParsedSupervisorLaunchStatus["team"][number];
type ParsedLaunchTaskPreview = ParsedSupervisorLaunchStatus["task_preview"][number];

export function isCompatibleInternalContractVersion(
  value: string | null | undefined,
): boolean {
  if (!value) {
    return true;
  }
  return value === INTERNAL_RUNTIME_CONTRACT_VERSION;
}

export function buildInternalContractHeaders(
  headers?: HeadersInit,
): Headers {
  const merged = new Headers(headers);
  merged.set("X-AIC-Contract-Version", INTERNAL_RUNTIME_CONTRACT_VERSION);
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function parseSupervisorStatusPayload(
  value: unknown,
): ParsedSupervisorStatusPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const state = asNullableString(value.state);
  const controlPlaneRaw = isRecord(value.controlPlane) ? value.controlPlane : null;
  const creditsRaw = isRecord(value.credits) ? value.credits : null;

  const mirrorStatus: "healthy" | "delayed" | "down" =
    controlPlaneRaw?.mirrorStatus === "healthy"
    || controlPlaneRaw?.mirrorStatus === "delayed"
    || controlPlaneRaw?.mirrorStatus === "down"
      ? controlPlaneRaw.mirrorStatus
      : "down";

  const controlPlane = controlPlaneRaw
    ? {
        mode: "vm_local" as const,
        mirrorStatus,
        syncQueueDepth: asNumber(controlPlaneRaw.syncQueueDepth),
        oldestQueuedAt: asNullableString(controlPlaneRaw.oldestQueuedAt),
        lastSuccessfulSyncAt: asNullableString(controlPlaneRaw.lastSuccessfulSyncAt),
        statusMessage: asString(controlPlaneRaw.statusMessage) || "Live updates are temporarily unavailable.",
      }
    : null;

  const credits = creditsRaw
    ? {
        available: asNumber(creditsRaw.available_balance ?? creditsRaw.balance),
        total: asNumber(creditsRaw.total_balance),
        reserved: asNumber(creditsRaw.reserved_total),
        currentCompanyReserved: asNumber(creditsRaw.current_company_reserved),
        reservationBreakdown: Array.isArray(creditsRaw.reservation_breakdown)
          ? creditsRaw.reservation_breakdown
              .map((entry) => {
                if (!isRecord(entry)) {
                  return null;
                }
                const company_id = asString(entry.company_id);
                const company_name = asString(entry.company_name);
                const company_state = asNullableString(entry.company_state);
                const reserved_balance = asNumber(entry.reserved_balance);
                if (!company_id || !company_name || reserved_balance === null) {
                  return null;
                }
                return {
                  company_id,
                  company_name,
                  company_state,
                  reserved_balance,
                };
              })
              .filter((entry): entry is ParsedReservation => entry !== null)
          : [],
      }
    : null;

  return {
    state,
    controlPlane,
    credits,
  };
}

export function parseSupervisorLaunchStatus(
  value: unknown,
): ParsedSupervisorLaunchStatus | null {
  if (!isRecord(value)) {
    return null;
  }

  const company_id = asString(value.company_id);
  const name = asString(value.name);
  const state = asString(value.state);
  const ready = asBoolean(value.ready);
  const terminal = asBoolean(value.terminal);
  const stage =
    value.stage === "creating_workspace"
    || value.stage === "creating_ceo"
    || value.stage === "ceo_mission"
    || value.stage === "ceo_planning"
    || value.stage === "activating_team"
    || value.stage === "delegating_tasks"
    || value.stage === "founder_briefing"
    || value.stage === "finalizing"
    || value.stage === "ready"
    || value.stage === "awaiting_funding"
    || value.stage === "failed"
      ? value.stage
      : null;
  const progress_percent = asNumber(value.progress_percent);
  const headline = asString(value.headline);
  const detail = asString(value.detail);
  const mission_text = asNullableString(value.mission_text);

  if (
    !company_id
    || !name
    || !state
    || ready === null
    || terminal === null
    || !stage
    || progress_percent === null
    || !headline
    || !detail
  ) {
    return null;
  }

  const missing_items = Array.isArray(value.missing_items)
    ? value.missing_items.filter((item): item is string => typeof item === "string")
    : [];
  const steps: ParsedLaunchStep[] = [];
  if (Array.isArray(value.steps)) {
    for (const step of value.steps) {
      if (!isRecord(step)) {
        continue;
      }
      const id = asString(step.id);
      const label = asString(step.label);
      const detailValue = asNullableString(step.detail);
      const stateValue =
        step.state === "done" || step.state === "active" || step.state === "pending"
          ? step.state
          : null;
      if (!id || !label || !stateValue) {
        continue;
      }
      steps.push({ id, label, detail: detailValue ?? undefined, state: stateValue });
    }
  }
  const team: ParsedLaunchTeamMember[] = [];
  if (Array.isArray(value.team)) {
    for (const agent of value.team) {
      if (!isRecord(agent)) {
        continue;
      }
      const id = asString(agent.id);
      const agentName = asString(agent.name);
      const role = asString(agent.role);
      const title = asNullableString(agent.title);
      const status = asString(agent.status);
      const icon = asNullableString(agent.icon);
      if (!id || !agentName || !role || !status) {
        continue;
      }
      team.push({ id, name: agentName, role, title, status, icon });
    }
  }
  const task_preview: ParsedLaunchTaskPreview[] = [];
  if (Array.isArray(value.task_preview)) {
    for (const task of value.task_preview) {
      if (!isRecord(task)) {
        continue;
      }
      const id = asString(task.id);
      const title = asString(task.title);
      const status = asString(task.status);
      const owner_name = asNullableString(task.owner_name);
      if (!id || !title || !status) {
        continue;
      }
      task_preview.push({ id, title, status, owner_name });
    }
  }

  return {
    company_id,
    name,
    state,
    ready,
    terminal,
    stage,
    progress_percent,
    headline,
    detail,
    missing_items,
    steps,
    team,
    task_preview,
    mission_text,
  };
}
