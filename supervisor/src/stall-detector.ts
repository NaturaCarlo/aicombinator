import { SupervisorDb } from "./db.js";
import { TaskManager, humanize_criteria } from "./task-manager.js";
import type { AcceptanceCriterion, AgentRow, Stall, TaskRow } from "./types.js";

export interface StallHandlingCallbacks {
  wake_agent: (agent: AgentRow, task: TaskRow, override_prompt?: string | null) => Promise<void> | void;
  escalate_to_ceo: (
    task: TaskRow,
    reason: "no_criteria_met_after_many_turns" | "task_still_stalled",
  ) => Promise<void> | void;
}

export class StallDetector {
  constructor(
    private readonly db: SupervisorDb,
    private readonly taskManager: TaskManager,
  ) {}

  check_stalls(company_id: string): Stall[] {
    const stalls: Stall[] = [];

    const stuck_tasks = this.db.all<TaskRow>(
      `
        SELECT *
        FROM tasks
        WHERE company_id = ?
          AND status = 'in_progress'
          AND turns_spent >= 3
      `,
      [company_id],
    );

    for (const task of stuck_tasks) {
      const recent = this.db.all<{ artifact_changed: number }>(
        `
          SELECT artifact_changed
          FROM turn_log
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT 3
        `,
        [task.id],
      );

      if (recent.length >= 3 && recent.every((row) => row.artifact_changed === 0)) {
        stalls.push({ type: "no_progress", task });
      }
    }

    const chattyAgents = this.db.all<{ agent_id: string; task_id: string }>(
      `
        SELECT agent_id, task_id
        FROM turn_log
        WHERE company_id = ?
          AND tool_call_count = 0
          AND created_at > datetime('now', '-30 minutes')
        GROUP BY agent_id, task_id
        HAVING count(*) >= 2
      `,
      [company_id],
    );

    for (const row of chattyAgents) {
      stalls.push({ type: "no_tool_calls", agent_id: row.agent_id, task_id: row.task_id });
    }

    const longRunning = this.db.all<TaskRow>(
      `
        SELECT *
        FROM tasks
        WHERE company_id = ?
          AND status = 'in_progress'
          AND turns_spent > 10
      `,
      [company_id],
    );

    for (const task of longRunning) {
      stalls.push({ type: "long_running", task });
    }

    return stalls;
  }

  /**
   * Count how many stall interventions have already been attempted for a task.
   * Uses turn_log to count turns where output_summary indicates a stall retry.
   */
  private count_prior_stall_interventions(task_id: string): number {
    const row = this.db.get<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM turn_log
        WHERE task_id = ?
          AND output_summary LIKE '%without producing the required output%'
      `,
      [task_id],
    );
    return row?.count ?? 0;
  }

  private count_recent_no_tool_call_turns(agent_id: string, task_id: string): number {
    const row = this.db.get<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM turn_log
        WHERE agent_id = ?
          AND task_id = ?
          AND tool_call_count = 0
          AND created_at > datetime('now', '-30 minutes')
      `,
      [agent_id, task_id],
    );
    return row?.count ?? 0;
  }

  async handle_stall(stall: Stall, callbacks: StallHandlingCallbacks): Promise<void> {
    switch (stall.type) {
      case "no_progress": {
        if (!stall.task?.owner_agent_id) return;
        const agent = this.taskManager.get_agent(stall.task.owner_agent_id);
        if (!agent) return;

        // Progressive escalation: retry once, then escalate to CEO
        const prior = this.count_prior_stall_interventions(stall.task.id);
        if (prior >= 1) {
          await callbacks.escalate_to_ceo(stall.task, "task_still_stalled");
          return;
        }

        const criteria = JSON.parse(stall.task.acceptance_criteria) as Parameters<
          typeof humanize_criteria
        >[0];
        const prompt = [
          `You have spent ${stall.task.turns_spent} turns on "${stall.task.title}"`,
          "without producing the required output.",
          "",
          "The acceptance criteria are:",
          humanize_criteria(criteria),
          "",
          "Either:",
          "1. Complete the task now, or",
          `2. Write /workspace/.agent/${agent.id}/task_blocked.json explaining why you cannot.`,
        ].join("\n");
        await callbacks.wake_agent(agent, stall.task, prompt);
        return;
      }
      case "no_tool_calls": {
        if (!stall.agent_id || !stall.task_id) return;
        const agent = this.taskManager.get_agent(stall.agent_id);
        const task = this.taskManager.get_task(stall.task_id);
        if (!agent || !task) return;

        // Progressive escalation for no-tool-calls as well
        const noToolTurns = this.count_recent_no_tool_call_turns(stall.agent_id, stall.task_id);
        if (noToolTurns >= 3) {
          await callbacks.escalate_to_ceo(task, "task_still_stalled");
          return;
        }

        const prompt = [
          "You have been reasoning without using tools. Your task requires producing files.",
          "Use your tools now to create the required artifacts. Do not plan further — act.",
        ].join("\n");
        await callbacks.wake_agent(agent, task, prompt);
        return;
      }
      case "long_running": {
        if (!stall.task) return;
        const company = this.taskManager.get_company(stall.task.company_id);
        if (!company?.workspace_dir) return;
        const criteria = JSON.parse(stall.task.acceptance_criteria) as AcceptanceCriterion[];
        const results = this.taskManager.validate_criteria(criteria, company.workspace_dir);
        const passed = results.filter((result) => result.passed).length;
        const pct_met = results.length === 0 ? 0 : passed / results.length;
        if (pct_met === 0) {
          await callbacks.escalate_to_ceo(stall.task, "no_criteria_met_after_many_turns");
        } else {
          console.log(
            `[stall-detector] Task ${stall.task.id} at ${Math.round(pct_met * 100)}% after ${stall.task.turns_spent} turns — continuing`,
          );
        }
      }
    }
  }
}
