import type {
  Agent,
  AgentStatus,
  CompanyArtifact,
  CompanyLaunchStatus,
  CompanyDocument,
  CompanyStatus,
  LaunchAgentPreview,
  LaunchStage,
  LaunchStep,
  LaunchTaskPreview,
  Task,
} from "@/lib/types";

const LAUNCH_POLL_INTERVAL_MS = 1000;
const LAUNCH_SOFT_DELAY_MS = 12000;
const LAUNCH_HARD_TIMEOUT_MS = 4 * 60 * 1000;
const LAUNCH_ABSOLUTE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes absolute hard timeout regardless of progress
const LAUNCH_SNAPSHOT_TIMEOUT_MS = 5000;
const EXPECTED_FOUNDING_TEAM_SIZE = 6;

type InitialStatusInput = {
  id: string;
  name: string;
  state: string;
  budgetCents: number;
  hostedDomain?: string | null;
  emailDomain?: string | null;
  customDomainCandidate?: string | null;
  customDomainStatus?: string | null;
  runtimeTier?: string | null;
};

export interface ProvisioningData {
  stage: LaunchStage;
  progressPercent: number;
  headline: string;
  detail: string;
  steps: LaunchStep[];
  team: CompanyLaunchStatus["team"];
  taskPreview: LaunchTaskPreview[];
  companyState: CompanyStatus["state"] | null;
  missionText: string | null;
  missingItems: string[];
  supervisorReachable: boolean;
}

export const DEFAULT_LAUNCH_STEPS: LaunchStep[] = [
  { id: "creating_workspace", label: "Workspace online", detail: "Preparing the company workspace.", state: "active" },
  { id: "creating_ceo", label: "CEO created", detail: "Provisioning the first operator.", state: "pending" },
  { id: "ceo_mission", label: "Mission written", detail: "The CEO is writing the company mission.", state: "pending" },
  { id: "ceo_planning", label: "Day plan created", detail: "Building a comprehensive execution plan.", state: "pending" },
  { id: "activating_team", label: "Team activated", detail: "Bringing the needed operators online.", state: "pending" },
  { id: "delegating_tasks", label: "First work delegated", detail: "Assigning the first concrete deliverables.", state: "pending" },
  { id: "founder_briefing", label: "Founder docs syncing", detail: "Founder-facing docs keep improving after the team is ready.", state: "pending" },
];

export const DEFAULT_TEAM_PLACEHOLDERS = [
  { id: "ceo", name: "CEO", title: "CEO" },
  { id: "cto", name: "CTO", title: "CTO" },
  { id: "cmo", name: "CMO", title: "CMO" },
  { id: "frontend-dev", name: "Frontend", title: "Frontend Dev" },
  { id: "backend-dev", name: "Backend", title: "Backend Dev" },
  { id: "qa-tester", name: "QA", title: "QA" },
];

export const EMPTY_PROVISIONING: ProvisioningData = {
  stage: "creating_workspace",
  progressPercent: 0,
  headline: "Preparing the launch",
  detail: "We're getting the launch environment ready.",
  steps: DEFAULT_LAUNCH_STEPS,
  team: [],
  taskPreview: [],
  companyState: null,
  missionText: null,
  missingItems: [],
  supervisorReachable: true,
};

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function snapshotIsEnterable(snapshot: {
  status: CompanyStatus;
  agents: Agent[];
  tasks: Task[];
}, readyForMs?: number): boolean {
  // Bypass: if supervisor reported ready for >30 seconds, allow entry regardless
  // of agent personalization completeness (VAL-LAUNCH-001)
  if (typeof readyForMs === "number" && readyForMs >= 30_000) {
    return true;
  }

  const agentReady = snapshot.agents.length >= EXPECTED_FOUNDING_TEAM_SIZE
    && snapshot.agents.every((agent) => Boolean(agent.name?.trim()) && Boolean(agent.icon));
  const delegatedWorkReady = snapshot.tasks.some(
    (task) => Boolean(task.owner_agent_id) && task.status !== "cancelled",
  );
  return agentReady && delegatedWorkReady;
}

function normalizeOptionalLaunchText(value: string | null | undefined): string | null {
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

function normalizeLaunchAgentStatus(value: string | null | undefined): AgentStatus {
  switch (value) {
    case "idle":
    case "free":
    case "running":
    case "working":
    case "sleeping":
    case "offline":
    case "error":
    case "paused":
    case "terminated":
    case "pending_approval":
      return value;
    default:
      return "free";
  }
}

function normalizeLaunchTaskStatus(value: string | null | undefined): Task["status"] {
  switch (value) {
    case "in_progress":
      return "in_progress";
    case "done":
      return "done";
    case "blocked":
    case "failed":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "ready":
    case "todo":
      return "todo";
    default:
      return "todo";
  }
}

function synthesizeAgentFromLaunchPreview(
  companyId: string,
  preview: LaunchAgentPreview,
): Agent {
  const now = new Date().toISOString();
  const title = normalizeOptionalLaunchText(preview.title);
  const role = normalizeOptionalLaunchText(preview.role) || "specialist";
  return {
    id: preview.id,
    company_id: companyId,
    name: normalizeOptionalLaunchText(preview.name) || title || "Agent",
    role,
    title,
    icon: preview.icon || `/api/avatars/${preview.id}`,
    status: normalizeLaunchAgentStatus(preview.status),
    reports_to: null,
    capabilities: "[]",
    adapter_config: "{}",
    runtime_config: "{}",
    permissions: "{}",
    last_heartbeat_at: null,
    metadata: "{}",
    created_at: now,
    updated_at: now,
    blueprint_id: role,
    model_tier: "sonnet",
    email_address: null,
    total_credits_consumed: 0,
    last_wake_at: null,
    last_sleep_at: null,
    department: null,
  };
}

function mergeSnapshotAgentsWithLaunchTeam(
  companyId: string,
  agents: Agent[],
  team: LaunchAgentPreview[],
): Agent[] {
  const merged = new Map<string, Agent>(agents.map((agent) => [agent.id, agent]));
  for (const preview of team) {
    const fallback = synthesizeAgentFromLaunchPreview(companyId, preview);
    const existing = merged.get(preview.id);
    merged.set(preview.id, existing
      ? {
          ...existing,
          name: normalizeOptionalLaunchText(existing.name) || fallback.name,
          role: normalizeOptionalLaunchText(existing.role) || fallback.role,
          title: normalizeOptionalLaunchText(existing.title) || fallback.title,
          icon: existing.icon || fallback.icon,
          status: existing.status || fallback.status,
          blueprint_id: existing.blueprint_id ?? fallback.blueprint_id,
        }
      : fallback);
  }
  return Array.from(merged.values());
}

function synthesizeTasksFromLaunchPreview(
  companyId: string,
  taskPreview: LaunchTaskPreview[],
  agents: Agent[],
): Task[] {
  const now = new Date().toISOString();
  const agentIdByName = new Map(
    agents
      .map((agent) => [normalizeOptionalLaunchText(agent.name)?.toLowerCase(), agent.id] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );

  return taskPreview.map((task) => ({
    id: task.id,
    company_id: companyId,
    title: task.title,
    description: null,
    status: normalizeLaunchTaskStatus(task.status),
    owner_agent_id: normalizeOptionalLaunchText(task.owner_name)
      ? (agentIdByName.get(normalizeOptionalLaunchText(task.owner_name)!.toLowerCase()) ?? null)
      : null,
    blocked_reason: null,
    artifact: null,
    parent_task_id: null,
    created_by_agent_id: null,
    created_at: now,
    updated_at: now,
  }));
}

function ensureMissionDocument(
  missionText: string | null,
  documents: CompanyDocument[],
): CompanyDocument[] {
  if (!missionText?.trim()) {
    return documents;
  }
  if (documents.some((document) => document.type === "mission")) {
    return documents;
  }
  const now = new Date().toISOString();
  return [
    {
      id: "launch-mission",
      type: "mission",
      title: "Mission",
      body: missionText,
      excerpt: missionText,
      path: "docs/mission.md",
      createdAt: now,
    },
    ...documents,
  ];
}

function hydrateReadySnapshot(
  companyId: string,
  snapshot: {
    status: CompanyStatus;
    agents: Agent[];
    tasks: Task[];
    documents: CompanyDocument[];
    artifacts: CompanyArtifact[];
  },
  launch: CompanyLaunchStatus,
): {
  status: CompanyStatus;
  agents: Agent[];
  tasks: Task[];
  documents: CompanyDocument[];
  artifacts: CompanyArtifact[];
} {
  const agents = mergeSnapshotAgentsWithLaunchTeam(companyId, snapshot.agents, launch.team);
  const previewTasks = synthesizeTasksFromLaunchPreview(companyId, launch.taskPreview, agents);
  const previewTaskById = new Map(previewTasks.map((task) => [task.id, task]));
  const tasks = snapshot.tasks.map((task) => {
    const preview = previewTaskById.get(task.id);
    if (!preview) {
      return task;
    }
    return {
      ...task,
      owner_agent_id: task.owner_agent_id || preview.owner_agent_id,
      status: task.status || preview.status,
      updated_at: task.updated_at || preview.updated_at,
    };
  });
  const taskIds = new Set(tasks.map((task) => task.id));
  tasks.push(...previewTasks.filter((task) => !taskIds.has(task.id)));
  const documents = ensureMissionDocument(launch.missionText, snapshot.documents);

  return {
    ...snapshot,
    agents,
    tasks,
    documents,
  };
}

export function buildInitialStatus(result: InitialStatusInput): CompanyStatus {
  return {
    companyId: result.id,
    name: result.name,
    state: result.state as CompanyStatus["state"],
    turnCount: 0,
    lastTurnTime: null,
    budgetCents: result.budgetCents,
    spentCents: 0,
    remainingCents: 0,
    model: "anthropic/claude-opus-4.6",
    sandboxId: null,
    recentThinking: null,
    lastHeartbeat: null,
    publicVisible: true,
    hostedDomain: result.hostedDomain ?? null,
    emailDomain: result.emailDomain ?? null,
    customDomain: null,
    customDomainCandidate: result.customDomainCandidate ?? null,
    customDomainStatus: result.customDomainStatus ?? null,
    runtimeTier: result.runtimeTier ?? null,
    dedicatedVmStatus: "shared",
    dedicatedVmId: null,
    dedicatedVmIp: null,
    egressTier: "standard",
    recentTurns: [],
    controlPlane: {
      mode: "vm_local",
      supervisorReachable: true,
      mirrorStatus: "healthy",
      syncQueueDepth: 0,
      oldestQueuedAt: null,
      lastSuccessfulSyncAt: new Date().toISOString(),
      statusMessage: "Provisioning founder-facing state",
    },
  };
}

async function readDocumentsSnapshot(
  companyId: string,
  token: string,
  timeoutMs: number = LAUNCH_SNAPSHOT_TIMEOUT_MS,
): Promise<{ documents: CompanyDocument[]; artifacts: CompanyArtifact[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live"}/api/companies/${companyId}/documents`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: controller.signal,
    },
  );
  clearTimeout(timer);
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `Documents error: ${response.status}`));
  }
  return response.json() as Promise<{
    documents: CompanyDocument[];
    artifacts: CompanyArtifact[];
  }>;
}

async function readTasksSnapshot(
  companyId: string,
  token: string,
  timeoutMs: number = LAUNCH_SNAPSHOT_TIMEOUT_MS,
): Promise<{ tasks: Task[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live"}/api/companies/${companyId}/tasks`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: controller.signal,
    },
  );
  clearTimeout(timer);
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `Tasks error: ${response.status}`));
  }
  return response.json() as Promise<{ tasks: Task[] }>;
}

async function readStatusSnapshot(
  companyId: string,
  token: string,
  timeoutMs: number = LAUNCH_SNAPSHOT_TIMEOUT_MS,
): Promise<CompanyStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live"}/api/companies/${companyId}/status`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: controller.signal,
    },
  );
  clearTimeout(timer);
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `Status error: ${response.status}`));
  }
  return response.json() as Promise<CompanyStatus>;
}

async function readAgentsSnapshot(
  companyId: string,
  token: string,
  timeoutMs: number = LAUNCH_SNAPSHOT_TIMEOUT_MS,
): Promise<Agent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live"}/api/companies/${companyId}/agents`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: controller.signal,
    },
  );
  clearTimeout(timer);
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `Agents error: ${response.status}`));
  }
  const data = (await response.json()) as { agents: Agent[] };
  return data.agents;
}

async function readLaunchStatusSnapshot(
  companyId: string,
  token: string,
  timeoutMs: number = LAUNCH_SNAPSHOT_TIMEOUT_MS,
): Promise<CompanyLaunchStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live"}/api/companies/${companyId}/launch-status`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: controller.signal,
    },
  );
  clearTimeout(timer);
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `Launch status error: ${response.status}`));
  }
  return response.json() as Promise<CompanyLaunchStatus>;
}

async function captureReadySnapshot(
  companyId: string,
  token: string,
  fallbackStatus: CompanyStatus,
): Promise<{
  status: CompanyStatus;
  agents: Agent[];
  tasks: Task[];
  documents: CompanyDocument[];
  artifacts: CompanyArtifact[];
}> {
  const [status, agents, tasksSnapshot, documentsSnapshot] = await Promise.all([
    readStatusSnapshot(companyId, token, 8_000).catch(() => fallbackStatus),
    readAgentsSnapshot(companyId, token, 8_000).catch(() => []),
    readTasksSnapshot(companyId, token, 8_000).catch(() => ({ tasks: [] })),
    readDocumentsSnapshot(companyId, token, 8_000).catch(() => ({ documents: [], artifacts: [] })),
  ]);

  return {
    status,
    agents,
    tasks: tasksSnapshot.tasks || [],
    documents: documentsSnapshot.documents || [],
    artifacts: documentsSnapshot.artifacts || [],
  };
}

export async function waitForLaunchReady(
  companyId: string,
  token: string,
  getFreshToken: () => Promise<string | null>,
  setLaunchStage: (stage: string) => void,
  onPollUpdate?: (data: ProvisioningData) => void,
  initialStatus?: CompanyStatus,
  signal?: AbortSignal,
): Promise<{
  status: CompanyStatus;
  agents: Agent[];
  tasks: Task[];
  documents: CompanyDocument[];
  artifacts: CompanyArtifact[];
}> {
  const startedAt = Date.now();
  let provisioningSlow = false;
  let lastProgressAt = startedAt;
  let lastProgressSignature = "";
  let latestStatus: CompanyStatus = initialStatus ?? {
    companyId,
    name: "",
    state: "provisioning",
    turnCount: 0,
    lastTurnTime: null,
    budgetCents: 0,
    spentCents: 0,
    remainingCents: 0,
    model: "anthropic/claude-opus-4.6",
    sandboxId: null,
    recentThinking: null,
    lastHeartbeat: null,
    publicVisible: true,
    hostedDomain: null,
    emailDomain: null,
    customDomain: null,
    customDomainCandidate: null,
    customDomainStatus: null,
    runtimeTier: null,
    dedicatedVmStatus: "shared",
    dedicatedVmId: null,
    dedicatedVmIp: null,
    egressTier: "standard",
    recentTurns: [],
    controlPlane: {
      mode: "vm_local",
      supervisorReachable: true,
      mirrorStatus: "healthy",
      syncQueueDepth: 0,
      oldestQueuedAt: null,
      lastSuccessfulSyncAt: new Date().toISOString(),
      statusMessage: "Provisioning founder-facing state",
    },
  };
  let activeToken = token;
  let latestLaunch: CompanyLaunchStatus | null = null;
  const TOKEN_REFRESH_INTERVAL_MS = 45_000;
  let lastTokenRefresh = 0;
  let readySince: number | null = null;

  for (;;) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const elapsedMs = Date.now() - startedAt;

    if (Date.now() - lastTokenRefresh >= TOKEN_REFRESH_INTERVAL_MS) {
      const refreshed = await getFreshToken();
      if (refreshed) {
        activeToken = refreshed;
      }
      lastTokenRefresh = Date.now();
    }

    const launch = await readLaunchStatusSnapshot(companyId, activeToken, LAUNCH_SNAPSHOT_TIMEOUT_MS).catch(() => null);
    if (launch) {
      latestLaunch = launch;
      const progressSignature = JSON.stringify({
        stage: launch.stage,
        progressPercent: launch.progressPercent,
        team: launch.team.length,
        tasks: launch.taskPreview.length,
        mission: Boolean(launch.missionText),
        ready: launch.ready,
      });
      if (progressSignature !== lastProgressSignature) {
        lastProgressSignature = progressSignature;
        lastProgressAt = Date.now();
      }
      latestStatus = {
        ...latestStatus,
        companyId,
        name: launch.name,
        state: launch.engineState ?? launch.companyState,
      };
      setLaunchStage(launch.headline);
      onPollUpdate?.({
        stage: launch.stage,
        progressPercent: launch.progressPercent,
        headline: launch.headline,
        detail: launch.detail,
        steps: launch.steps,
        team: launch.team,
        taskPreview: launch.taskPreview,
        companyState: launch.companyState,
        missionText: launch.missionText,
        missingItems: launch.missingItems,
        supervisorReachable: launch.supervisorReachable,
      });
    } else if (elapsedMs >= LAUNCH_SOFT_DELAY_MS) {
      setLaunchStage("Still connecting to the launch runtime...");
    }

    if ((latestLaunch?.companyState === "failed" || latestLaunch?.companyState === "dead")) {
      throw new Error("Company launch failed during provisioning");
    }

    if (latestLaunch?.companyState === "awaiting_funding") {
      throw new Error("The company is waiting for tokens. Add tokens, then relaunch.");
    }

    if (latestLaunch?.ready) {
      if (readySince === null) {
        readySince = Date.now();
      }
      const readyForMs = Date.now() - readySince;
      const snapshot = await captureReadySnapshot(companyId, activeToken, latestStatus);
      const hydratedSnapshot = hydrateReadySnapshot(companyId, snapshot, latestLaunch);
      if (snapshotIsEnterable(hydratedSnapshot, readyForMs)) {
        return hydratedSnapshot;
      }
      setLaunchStage("Syncing the company dashboard...");
      onPollUpdate?.({
        stage: latestLaunch.stage,
        progressPercent: Math.max(latestLaunch.progressPercent, 94),
        headline: "Syncing the company dashboard",
        detail: "The company is already running. We're just waiting for the dashboard snapshot to catch up to the live launch state.",
        steps: latestLaunch.steps,
        team: latestLaunch.team,
        taskPreview: latestLaunch.taskPreview,
        companyState: latestLaunch.companyState,
        missionText: latestLaunch.missionText,
        missingItems: ["Dashboard sync"],
        supervisorReachable: latestLaunch.supervisorReachable,
      });
    } else {
      readySince = null;
    }

    if (!provisioningSlow && elapsedMs >= LAUNCH_SOFT_DELAY_MS) {
      provisioningSlow = true;
      setLaunchStage(latestLaunch?.headline ?? "Still provisioning the company...");
    }

    // Absolute hard timeout: 10 minutes regardless of progress changes
    if (elapsedMs >= LAUNCH_ABSOLUTE_TIMEOUT_MS) {
      throw new Error(
        "Launch is taking too long. Refresh the page and we'll resume tracking your launch progress.",
      );
    }

    if (
      latestLaunch
      && elapsedMs >= LAUNCH_HARD_TIMEOUT_MS
      && Date.now() - lastProgressAt >= 90_000
    ) {
      throw new Error(
        latestLaunch.terminal
          ? latestLaunch.detail
          : "Launch is still running but progress has stalled. Refresh and we'll resume the launch tracker.",
      );
    }

    await sleep(LAUNCH_POLL_INTERVAL_MS, signal);
  }
}
