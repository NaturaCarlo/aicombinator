import type { CEOContextInput } from "./agent-runner.js";
import type { CreditManager } from "./credit-manager.js";
import type { SupervisorDb } from "./db.js";
import {
  buildCeoBlockedTaskPrompt as build_ceo_blocked_task_prompt_text,
  buildCeoDocumentRevisionPrompt as build_ceo_document_revision_prompt_text,
  buildCeoMilestoneReviewPrompt as build_ceo_milestone_review_prompt_text,
  buildCeoTaskFailedPrompt as build_ceo_task_failed_prompt_text,
  buildCeoUnassignedTaskPrompt as build_ceo_unassigned_task_prompt_text,
  buildCeoUserMessagePrompt as build_ceo_user_message_prompt_text,
  cleanFounderReply,
  isUnhelpfulFounderReply,
} from "./scheduler-prompts.js";
import type { TaskManager } from "./task-manager.js";
import type { CompanyRow, FounderStateSnapshot } from "./types.js";

interface FounderMessagingDeps {
  db: SupervisorDb;
  task_manager: TaskManager;
  credit_manager: CreditManager;
}

function require_company(company_id: string, task_manager: TaskManager): CompanyRow {
  const company = task_manager.get_company(company_id);
  if (!company) {
    throw new Error(`Company ${company_id} not found`);
  }
  return company;
}

export function gather_ceo_context(company_id: string, { db, task_manager, credit_manager }: FounderMessagingDeps): CEOContextInput {
  const company = require_company(company_id, task_manager);
  const milestones = task_manager.get_milestones(company_id);
  const all_tasks = task_manager.get_tasks(company_id);
  const agents = task_manager.get_agents(company_id);

  const active_tasks = all_tasks.filter(
    (t) => t.status === "in_progress" || t.status === "ready" || t.status === "blocked" || t.status === "pending",
  );
  const recent_completions = all_tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
    .slice(0, 5);
  const cancelled_tasks = all_tasks.filter(
    (t) => t.status === "cancelled" || t.status === "failed",
  );

  const spent_24h = db.get<{ spent: number }>(
    `
      SELECT COALESCE(SUM(credits_spent), 0) AS spent
      FROM turn_log
      WHERE company_id = ?
        AND created_at >= datetime('now', '-24 hours')
    `,
    [company_id],
  )?.spent ?? 0;

  return {
    company,
    milestones: milestones.map((m) => {
      const m_tasks = all_tasks.filter((t) => t.milestone_id === m.id);
      const m_non_cancelled = m_tasks.filter((t) => t.status !== "cancelled");
      const m_done = m_tasks.filter((t) => t.status === "done").length;
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        sort_order: m.sort_order,
        tasks_done: m_done,
        tasks_total: m_non_cancelled.length,
      };
    }),
    active_tasks: active_tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      owner_agent_id: t.owner_agent_id,
      blocked_reason: t.blocked_reason,
      artifact: t.artifact,
    })),
    recent_completions: recent_completions.map((t) => ({
      id: t.id,
      title: t.title,
      artifact: t.artifact,
      completed_at: t.completed_at,
    })),
    cancelled_tasks: cancelled_tasks.map((t) => ({
      id: t.id,
      title: t.title,
      owner_agent_id: t.owner_agent_id,
    })),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      title: a.title ?? null,
      status: a.status,
      current_task_id: a.current_task_id,
      source: a.source ?? "internal",
    })),
    credit_balance: credit_manager.get_balance(company.user_id),
    credit_burn_rate_per_hour: spent_24h / 24,
  };
}

export function build_grounded_founder_fallback(
  company_id: string,
  deps: FounderMessagingDeps,
  founder_state?: FounderStateSnapshot | null,
  serverCtx?: CEOContextInput | null,
): string {
  if (founder_state) {
    // Cross-reference client snapshot with server state to detect staleness
    const serverInProgressTasks = serverCtx?.active_tasks.filter((t) => t.status === "in_progress") ?? [];
    const clientActiveTasks = founder_state.tasks.filter((task) => task.status === "active");

    // Use server-side in_progress tasks if client has none active but server does
    const useServerOverride = serverInProgressTasks.length > 0 && clientActiveTasks.length === 0;

    const activeTasks = useServerOverride ? [] : clientActiveTasks; // Will use server tasks below
    const queuedTasks = founder_state.tasks.filter((task) => task.status === "queued");
    const waitingOnFounder = founder_state.tasks.filter((task) => task.status === "waiting_on_founder");
    const waitingOnDependency = founder_state.tasks.filter((task) => task.status === "waiting_on_dependency");
    const completedTasks = founder_state.tasks.filter((task) => task.status === "done");
    const lines: string[] = [];

    if (founder_state.state === "paused") {
      lines.push("The company is paused right now, so the team is visible but no task is actively running.");
    }

    if (useServerOverride) {
      // Use authoritative server-side data instead of stale client data
      const agentNameById = serverCtx ? new Map(serverCtx.agents.map((a) => [a.id, a.name])) : new Map<string, string>();
      lines.push(
        `Right now ${serverInProgressTasks
          .slice(0, 3)
          .map((task) => {
            const agentName = task.owner_agent_id ? agentNameById.get(task.owner_agent_id) : null;
            return agentName ? `${agentName} is working on "${task.title}"` : `"${task.title}" is in progress`;
          })
          .join("; ")}.`,
      );
    } else if (activeTasks.length > 0) {
      lines.push(
        `Right now ${activeTasks
          .slice(0, 3)
          .map((task) => task.ownerName ? `${task.ownerName} is working on "${task.title}"` : `"${task.title}" is active`)
          .join("; ")}.`,
      );
    } else {
      lines.push("Right now no task is actively running.");
    }

    if (queuedTasks.length > 0) {
      lines.push(
        `Queued next: ${queuedTasks
          .slice(0, 3)
          .map((task) => task.ownerName ? `${task.ownerName} on "${task.title}"` : `"${task.title}"`)
          .join("; ")}.`,
      );
    }

    if (waitingOnFounder.length > 0) {
      lines.push(
        `I still need your input on ${waitingOnFounder
          .slice(0, 2)
          .map((task) => `"${task.title}"`)
          .join(" and ")}.`,
      );
    } else if (waitingOnDependency.length > 0) {
      lines.push(
        `The blocked work is waiting on dependencies: ${waitingOnDependency
          .slice(0, 2)
          .map((task) => task.detail ? `"${task.title}" (${task.detail})` : `"${task.title}"`)
          .join("; ")}.`,
      );
    }

    if (completedTasks.length > 0) {
      lines.push(
        `Recently finished: ${completedTasks
          .slice(0, 2)
          .map((task) => task.title)
          .join("; ")}.`,
      );
    }

    if (founder_state.credits.available <= 0) {
      lines.push("There are no available credits right now, so I can't start another turn until credits free up or more are added.");
    }

    // If everything is done and paused, give a forward-looking answer
    // Cross-check with server: if server shows active tasks, don't conclude all done
    const serverHasActiveTasks = serverInProgressTasks.length > 0
      || (serverCtx?.active_tasks.some((t) => t.status === "ready" || t.status === "pending") ?? false);
    const allDone = !serverHasActiveTasks
      && activeTasks.length === 0 && queuedTasks.length === 0
      && waitingOnFounder.length === 0 && waitingOnDependency.length === 0;
    if (allDone && completedTasks.length > 0) {
      lines.push("All planned work is complete — you can add new goals or fund the company to keep the team going.");
    }

    return lines.join(" ");
  }

  const ctx = gather_ceo_context(company_id, deps);
  const agentNameById = new Map(ctx.agents.map((agent) => [agent.id, agent.name]));
  const workingTasks = ctx.active_tasks.filter((task) => task.status === "in_progress");
  const readyTasks = ctx.active_tasks.filter((task) => task.status === "ready");
  const blockedTasks = ctx.active_tasks.filter((task) => task.status === "blocked");
  const pendingTasks = ctx.active_tasks.filter((task) => task.status === "pending");

  const lines: string[] = [];

  if (workingTasks.length > 0) {
    const workingSummary = workingTasks
      .slice(0, 3)
      .map((task) => {
        const owner = task.owner_agent_id ? agentNameById.get(task.owner_agent_id) : null;
        return owner ? `${owner} is working on "${task.title}"` : `"${task.title}" is in progress`;
      })
      .join("; ");
    lines.push(`Right now ${workingSummary}.`);
  } else {
    lines.push("Right now no one is actively executing a task.");
  }

  if (readyTasks.length > 0) {
    const readySummary = readyTasks
      .slice(0, 3)
      .map((task) => {
        const owner = task.owner_agent_id ? agentNameById.get(task.owner_agent_id) : null;
        return owner ? `${owner} is up next on "${task.title}"` : `"${task.title}" is ready`;
      })
      .join("; ");
    lines.push(`Next up: ${readySummary}.`);
  } else if (pendingTasks.length > 0) {
    const pendingSummary = pendingTasks
      .slice(0, 3)
      .map((task) => {
        const owner = task.owner_agent_id ? agentNameById.get(task.owner_agent_id) : null;
        return owner ? `"${task.title}" (${owner})` : `"${task.title}"`;
      })
      .join("; ");
    lines.push(`${pendingTasks.length} task${pendingTasks.length > 1 ? "s are" : " is"} queued and waiting for dependencies to finish: ${pendingSummary}.`);
  } else if (blockedTasks.length > 0) {
    const blockedSummary = blockedTasks
      .slice(0, 2)
      .map((task) => {
        const owner = task.owner_agent_id ? agentNameById.get(task.owner_agent_id) : null;
        const prefix = owner ? `${owner}'s task "${task.title}"` : `"${task.title}"`;
        return task.blocked_reason ? `${prefix} is blocked by ${task.blocked_reason}` : `${prefix} is blocked`;
      })
      .join("; ");
    lines.push(`The rest of the work is waiting on dependencies or founder input: ${blockedSummary}.`);
  }

  if (ctx.recent_completions.length > 0) {
    const completionSummary = ctx.recent_completions
      .slice(0, 2)
      .map((task) => task.title)
      .join("; ");
    lines.push(`Recently finished: ${completionSummary}.`);
  }

  if (ctx.credit_balance <= 0) {
    lines.push("The company is out of credits, so no new work can start until credits are added.");
  }

  return lines.join(" ");
}

export function prepare_founder_reply(
  company_id: string,
  raw_output: string | undefined | null,
  deps: FounderMessagingDeps,
  founder_state?: FounderStateSnapshot | null,
): string {
  const cleaned = cleanFounderReply(raw_output);
  if (!isUnhelpfulFounderReply(cleaned)) {
    return cleaned!;
  }
  // Pass server-side context to detect stale client snapshots
  const serverCtx = gather_ceo_context(company_id, deps);
  const fallback = build_grounded_founder_fallback(company_id, deps, founder_state, serverCtx);
  if (fallback.trim()) return fallback;
  // Absolute safety net — never return empty
  return "I'm here — let me know what you'd like to work on next.";
}

export function build_ceo_user_message_prompt(
  text: string,
  company: CompanyRow,
  deps: FounderMessagingDeps,
  founder_state?: FounderStateSnapshot | null,
): string {
  const ctx = gather_ceo_context(company.id, deps);
  const recentMessages = deps.db.all<{ role: string; content: string; created_at: string }>(
    `SELECT role, content, created_at FROM messages
     WHERE company_id = ? AND role IN ('user', 'ceo') AND content IS NOT NULL AND TRIM(content) != ''
     ORDER BY created_at DESC LIMIT 15`,
    [company.id],
  ).reverse();
  return build_ceo_user_message_prompt_text(text, company, founder_state, ctx, recentMessages);
}

export function build_ceo_blocked_task_prompt(
  company_id: string,
  payload: Record<string, unknown>,
  deps: FounderMessagingDeps,
): string {
  const company = require_company(company_id, deps.task_manager);
  const ctx = gather_ceo_context(company_id, deps);
  const task_id = String(payload.task_id ?? "");
  const task = task_id ? deps.task_manager.get_task(task_id) : undefined;
  return build_ceo_blocked_task_prompt_text(company, ctx, task, payload);
}

export function build_ceo_milestone_review_prompt(
  company_id: string,
  payload: Record<string, unknown>,
  deps: FounderMessagingDeps,
): string {
  const company = require_company(company_id, deps.task_manager);
  const ctx = gather_ceo_context(company_id, deps);
  const completed = payload.completed_milestone_id
    ? deps.task_manager.get_milestone(String(payload.completed_milestone_id))
    : undefined;
  const next = payload.next_milestone_id
    ? deps.task_manager.get_milestone(String(payload.next_milestone_id))
    : undefined;
  const completed_tasks = completed
    ? deps.task_manager.get_tasks(company_id).filter((task) => task.milestone_id === completed.id && task.status === "done")
    : [];
  const next_tasks = next
    ? deps.task_manager.get_tasks(company_id).filter((task) => task.milestone_id === next.id)
    : [];
  return build_ceo_milestone_review_prompt_text(company, ctx, completed, next, completed_tasks, next_tasks, payload);
}

export function build_ceo_task_failed_prompt(
  company_id: string,
  payload: Record<string, unknown>,
  deps: FounderMessagingDeps,
): string {
  const company = require_company(company_id, deps.task_manager);
  const ctx = gather_ceo_context(company_id, deps);
  return build_ceo_task_failed_prompt_text(company, ctx, payload);
}

export function build_ceo_unassigned_task_prompt(
  company_id: string,
  payload: Record<string, unknown>,
  deps: FounderMessagingDeps,
): string {
  const company = require_company(company_id, deps.task_manager);
  const ctx = gather_ceo_context(company_id, deps);
  return build_ceo_unassigned_task_prompt_text(company, ctx, payload);
}

export function build_ceo_document_revision_prompt(company_id: string, payload: Record<string, unknown>, deps: FounderMessagingDeps): string {
  const company = require_company(company_id, deps.task_manager);
  return build_ceo_document_revision_prompt_text(company, payload);
}
