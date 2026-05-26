import type { SupervisorDb } from "./db.js";
import { calculate_burn_rate_per_hour, minutes_since } from "./scheduler-helpers.js";
import type { CreditManager } from "./credit-manager.js";
import type { StallDetector } from "./stall-detector.js";
import type { TaskManager } from "./task-manager.js";
import type { AgentActivityEntry, CompanyProgressMetrics, TelemetryMirrorRow, VerifiedTelemetrySummary } from "./types.js";

interface CompanyStatusDeps {
  db: SupervisorDb;
  task_manager: TaskManager;
  credit_manager: CreditManager;
  stall_detector: StallDetector;
}

export function get_company_progress_metrics(
  company_id: string,
  { db, task_manager, credit_manager, stall_detector }: CompanyStatusDeps,
): CompanyProgressMetrics {
  const company = task_manager.get_company(company_id);
  if (!company) {
    throw new Error(`Company ${company_id} not found`);
  }
  const milestones = task_manager.get_milestones(company_id);
  const tasks = task_manager.get_tasks(company_id);
  const agents = task_manager.get_agents(company_id);
  const spent_total = tasks.reduce((sum, task) => sum + task.credits_spent, 0);
  const spent_24h = db.get<{ spent: number }>(
    `
      SELECT COALESCE(SUM(credits_spent), 0) AS spent
      FROM turn_log
      WHERE company_id = ?
        AND created_at >= datetime('now', '-24 hours')
    `,
    [company_id],
  )?.spent ?? 0;
  const burn_rate_per_hour = calculate_burn_rate_per_hour(spent_24h);
  const available_balance = credit_manager.get_balance(company.user_id);
  const total_balance = credit_manager.get_total_balance(company.user_id);
  const reserved_total = credit_manager.get_reserved_balance(company.user_id);
  const current_company_reserved = credit_manager.get_company_reserved_balance(company.user_id, company_id);
  const reservation_breakdown = credit_manager.list_company_reservations(company.user_id);
  const estimated_hours_remaining = burn_rate_per_hour > 0 ? available_balance / burn_rate_per_hour : null;
  const last_task_completed_at = db.get<{ completed_at: string | null }>(
    `
      SELECT completed_at
      FROM tasks
      WHERE company_id = ? AND status = 'done'
      ORDER BY completed_at DESC
      LIMIT 1
    `,
    [company_id],
  )?.completed_at ?? null;

  return {
    company_id,
    state: company.state,
    milestones: {
      total: milestones.length,
      done: milestones.filter((row) => row.status === "done").length,
      active: milestones.filter((row) => row.status === "active").length,
      pending: milestones.filter((row) => row.status === "pending").length,
    },
    tasks: {
      total: tasks.length,
      done: tasks.filter((task) => task.status === "done").length,
      in_progress: tasks.filter((task) => task.status === "in_progress").length,
      ready: tasks.filter((task) => task.status === "ready").length,
      pending: tasks.filter((task) => task.status === "pending").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      blocked: tasks.filter((task) => task.status === "blocked").length,
    },
    credits: {
      balance: available_balance,
      total_balance,
      available_balance,
      reserved_total,
      current_company_reserved,
      reservation_breakdown,
      spent_total,
      spent_24h,
      burn_rate_per_hour,
      estimated_hours_remaining,
    },
    health: {
      last_task_completed_at,
      minutes_since_progress: minutes_since(last_task_completed_at),
      stalled_tasks: stall_detector.check_stalls(company_id).length,
      failed_tasks: tasks.filter((task) => task.status === "failed").length,
    },
    agents: {
      total: agents.length,
      working: agents.filter((agent) => agent.status === "working").length,
      idle: agents.filter((agent) => agent.status === "idle").length,
      paused: agents.filter((agent) => agent.status === "paused").length,
    },
  };
}

export function get_agent_activity_entries(company_id: string, { db, task_manager }: Pick<CompanyStatusDeps, "db" | "task_manager">): AgentActivityEntry[] {
  const agents = task_manager.get_agents(company_id);
  const activity = agents.map((agent) => {
    const latest_turn = db.get<{ output_summary: string | null; created_at: string }>(
      `
        SELECT output_summary, created_at
        FROM turn_log
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [agent.id],
    );
    const current_task = agent.current_task_id ? task_manager.get_task(agent.current_task_id) : undefined;
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      agent_role: agent.role,
      status: agent.status,
      current_task: current_task?.title ?? null,
      last_activity: latest_turn?.output_summary ?? null,
      last_active_at: latest_turn?.created_at ?? agent.created_at,
    };
  });

  return activity.sort((a, b) => {
    if (a.status === "working" && b.status !== "working") return -1;
    if (b.status === "working" && a.status !== "working") return 1;
    return new Date(b.last_active_at).getTime() - new Date(a.last_active_at).getTime();
  });
}

export function get_verified_telemetry_summary(rows: TelemetryMirrorRow[]): VerifiedTelemetrySummary {
  const summary: VerifiedTelemetrySummary = {
    outreach: { total: 0, sent: 0, replied: 0 },
    leads: { total: 0, new: 0, qualified: 0 },
    meetings: { total: 0, scheduled: 0, completed: 0 },
    revenue: { events: 0, paidCount: 0, paidCents: 0 },
  };
  for (const row of rows) {
    switch (row.kind) {
      case "outreach":
        summary.outreach.total += 1;
        if (row.status === "sent") summary.outreach.sent += 1;
        if (row.status === "replied") summary.outreach.replied += 1;
        break;
      case "lead":
        summary.leads.total += 1;
        if (row.status === "new") summary.leads.new += 1;
        if (row.status === "qualified") summary.leads.qualified += 1;
        break;
      case "meeting":
        summary.meetings.total += 1;
        if (row.status === "scheduled") summary.meetings.scheduled += 1;
        if (row.status === "completed") summary.meetings.completed += 1;
        break;
      case "revenue":
        summary.revenue.events += 1;
        if (row.status === "paid") {
          summary.revenue.paidCount += 1;
          summary.revenue.paidCents += row.amount_cents ?? 0;
        }
        break;
    }
  }
  return summary;
}
