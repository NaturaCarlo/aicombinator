import type { AgentRow, Env } from "../types.js";
import { fetchFromCompanySupervisor } from "./supervisor-routing.js";

export interface LiveSupervisorRuntime {
  companyState: string | null;
  runningAgentIds: Set<string>;
}

export async function fetchLiveSupervisorAgents(
  env: Env,
  companyId: string,
): Promise<AgentRow[] | null> {
  try {
    const response = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/agents`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );

    if (!response || !response.ok) {
      return null;
    }

    const data = await response.json() as { agents?: AgentRow[] };
    return Array.isArray(data.agents) ? data.agents : null;
  } catch {
    return null;
  }
}

export async function fetchLiveSupervisorTasks(
  env: Env,
  companyId: string,
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const response = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/tasks`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );

    if (!response || !response.ok) {
      return null;
    }

    const data = await response.json() as { tasks?: Array<Record<string, unknown>> };
    return Array.isArray(data.tasks) ? data.tasks : null;
  } catch {
    return null;
  }
}

type DispatchableAgent = Pick<
  AgentRow,
  "id" | "company_id" | "name" | "status" | "last_wake_at" | "last_sleep_at"
>;

type DispatchableTask = {
  id: string;
  title: string;
  owner_agent_id: string | null;
  status: string;
  blocked_on?: string | null;
};

export async function fetchLiveSupervisorRuntime(
  env: Env,
  companyId: string,
): Promise<LiveSupervisorRuntime> {
  try {
    const response = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/status`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );

    if (!response || !response.ok) {
      return {
        companyState: null,
        runningAgentIds: new Set<string>(),
      };
    }

    const data = await response.json() as {
      state?: string | null;
      runningAgents?: string[];
    };

    return {
      companyState: data.state ?? null,
      runningAgentIds: new Set(
        Array.isArray(data.runningAgents)
          ? data.runningAgents.filter((value): value is string => typeof value === "string")
          : [],
      ),
    };
  } catch {
    return {
      companyState: null,
      runningAgentIds: new Set<string>(),
    };
  }
}

export async function maybeDispatchAssignedWork(
  env: Env,
  companyId: string,
  runtime?: LiveSupervisorRuntime,
): Promise<void> {
  const companyRow = await env.DB.prepare(
    `SELECT state
     FROM companies
     WHERE id = ?
     LIMIT 1`,
  ).bind(companyId).first<{ state: string }>();
  if (companyRow?.state && companyRow.state !== "running") {
    return;
  }

  const liveRuntime = runtime ?? await fetchLiveSupervisorRuntime(env, companyId);
  if (liveRuntime.companyState && liveRuntime.companyState !== "running") {
    return;
  }

  const [agentsResult, tasksResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, company_id, name, status, last_wake_at, last_sleep_at
       FROM agents
       WHERE company_id = ?`,
    ).bind(companyId).all<DispatchableAgent>(),
    env.DB.prepare(
      `SELECT id, title, owner_agent_id, status, blocked_on
       FROM tasks
       WHERE company_id = ?
         AND owner_agent_id IS NOT NULL
         AND status IN ('ready', 'in_progress', 'todo')`,
    ).bind(companyId).all<DispatchableTask>(),
  ]);

  const agents = agentsResult.results ?? [];
  const tasks = tasksResult.results ?? [];
  if (agents.length === 0 || tasks.length === 0) {
    return;
  }

  const actionableTaskByAgentId = new Map<string, DispatchableTask>();
  for (const task of tasks) {
    if (!task.owner_agent_id || task.blocked_on) {
      continue;
    }
    if (!actionableTaskByAgentId.has(task.owner_agent_id)) {
      actionableTaskByAgentId.set(task.owner_agent_id, task);
    }
  }

  const now = Date.now();
  const eligibleAgents = agents.filter((agent) => {
    if (!actionableTaskByAgentId.has(agent.id)) {
      return false;
    }
    if (
      agent.status === "paused"
      || agent.status === "terminated"
      || agent.status === "pending_approval"
      || agent.status === "error"
      || liveRuntime.runningAgentIds.has(agent.id)
    ) {
      return false;
    }

    const recentActivityAt = Math.max(
      toTimestamp(agent.last_wake_at) ?? 0,
      toTimestamp(agent.last_sleep_at) ?? 0,
    );

    return recentActivityAt === 0 || now - recentActivityAt >= 15_000;
  });

  await Promise.allSettled(
    eligibleAgents.map(async (agent) => {
      const task = actionableTaskByAgentId.get(agent.id);
      if (!task) {
        return;
      }

      const supervisorRes = await fetchFromCompanySupervisor(
        env,
        companyId,
        `/companies/${companyId}/agents/${agent.id}/work`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
          },
          body: JSON.stringify({
            prompt: [
              "FIRST REQUIREMENT: create or improve a concrete workspace artifact in /workspace for your assigned task.",
              `Your highest-priority assigned task is: "${task.title}".`,
              "Do not spend this turn celebrating, summarizing, or coordinating unless it directly helps you ship the artifact.",
              "Do not wait for the next scheduled wake if you still have actionable work right now.",
              "Leave a real workspace file change before ending the turn.",
            ].join("\n"),
          }),
        },
      );
      void supervisorRes;
    }),
  );
}

function toTimestamp(dateStr: string | null | undefined): number | null {
  if (!dateStr) {
    return null;
  }

  const normalized =
    dateStr.includes("T") || dateStr.includes("Z") || dateStr.includes("+")
      ? dateStr
      : `${dateStr.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sanitizeAgentText(value: string | null | undefined): string | null {
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

export function normalizeFounderVisibleAgentStatus(
  agent: AgentRow,
  runtime: LiveSupervisorRuntime,
): AgentRow {
  const normalizedAgent: AgentRow = {
    ...agent,
    name: sanitizeAgentText(agent.name) || sanitizeAgentText(agent.title) || sanitizeAgentText(agent.role) || "Agent",
    title: sanitizeAgentText(agent.title),
    icon: agent.icon || `/api/avatars/${agent.id}`,
  };

  if (runtime.companyState === "paused") {
    return {
      ...normalizedAgent,
      status:
        agent.status === "terminated" || agent.status === "error" || agent.status === "pending_approval"
          ? agent.status
          : "offline",
    };
  }

  if (agent.status === "error" || agent.status === "terminated" || agent.status === "pending_approval") {
    return normalizedAgent;
  }

  return {
    ...normalizedAgent,
    status: runtime.runningAgentIds.has(agent.id) ? "working" : "free",
  };
}
