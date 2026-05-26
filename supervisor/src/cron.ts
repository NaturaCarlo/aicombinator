import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build_ceo_date_header, build_system_prompt, compute_day_number, extract_summary } from "./agent-runner.js";
import type { AgentInvoker } from "./agent-invoker.js";
import { isSpecialistBlueprint } from "./blueprints.js";
import {
  calculate_turn_credit_reservation,
  calculate_turn_credits,
  CreditManager,
  fit_turn_limits_to_available_credits,
} from "./credit-manager.js";
import { SupervisorDb, isoNow } from "./db.js";
import type { AgentRow, AgentTurnResult, CompanyRow, CronTaskRow, PlanUpdateDocument, SupervisorConfig } from "./types.js";
import { TaskManager, format_task_summaries } from "./task-manager.js";
import { Scheduler } from "./scheduler.js";
import { parse_json_with_error } from "./scheduler-helpers.js";

export function format_date_tz(tz: string, date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function get_last_daily_update_date(workspace_dir: string, tz: string): string | null {
  const files = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.now() - index * 86_400_000);
    return format_date_tz(tz, date);
  });
  for (const date of files) {
    const path = `${workspace_dir}/docs/daily-update-${date}.md`;
    if (existsSync(path)) {
      return date;
    }
  }
  return null;
}

export function is_due(schedule: string, last_run_at: string | null, created_at: string, tz = "America/Los_Angeles"): boolean {
  const [minuteField, hourField, dayField, monthField, weekdayField] = schedule.trim().split(/\s+/);
  if (!minuteField || !hourField || dayField !== "*" || monthField !== "*" || weekdayField !== "*") {
    return false;
  }

  const base = new Date(last_run_at ?? created_at);
  const nowMs = Date.now();
  if (!Number.isFinite(base.getTime()) || !Number.isFinite(nowMs)) {
    return false;
  }

  const matchingMinutes = parse_minute_field(minuteField);
  const matchingHours = parse_hour_field(hourField);
  if (matchingMinutes.length === 0 || matchingHours.length === 0) {
    return false;
  }

  // Use Intl.DateTimeFormat to extract timezone-aware hour and minute.
  // This correctly handles DST transitions.
  const hourFormatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
  const minuteFormatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, minute: "numeric" });

  // Start cursor 1 minute after base, truncated to the minute boundary
  let cursorMs = base.getTime();
  cursorMs -= cursorMs % 60_000; // floor to minute
  cursorMs += 60_000; // advance 1 minute

  const maxIterations = 60 * 24 * 7;
  for (let i = 0; i < maxIterations; i += 1) {
    const cursor = new Date(cursorMs);
    const cursorHour = Number(hourFormatter.format(cursor)) % 24;
    const cursorMinute = Number(minuteFormatter.format(cursor));
    if (
      matchingMinutes.includes(cursorMinute)
      && matchingHours.includes(cursorHour)
    ) {
      return cursorMs <= nowMs;
    }
    cursorMs += 60_000;
  }

  return false;
}

function parse_minute_field(field: string): number[] {
  if (field === "*") {
    return Array.from({ length: 60 }, (_, index) => index);
  }

  const everyMatch = field.match(/^\*\/(\d{1,2})$/);
  if (everyMatch) {
    const step = Number(everyMatch[1]);
    if (step <= 0) return [];
    return Array.from({ length: Math.ceil(60 / step) }, (_, index) => index * step).filter((minute) => minute < 60);
  }

  const rangeMatch = field.match(/^(\d{1,2})-(\d{1,2})\/(\d{1,2})$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    const step = Number(rangeMatch[3]);
    if (step <= 0 || start < 0 || end > 59 || start > end) {
      return [];
    }
    const minutes: number[] = [];
    for (let minute = start; minute <= end; minute += step) {
      minutes.push(minute);
    }
    return minutes;
  }

  const exact = Number(field);
  if (Number.isInteger(exact) && exact >= 0 && exact <= 59) {
    return [exact];
  }

  return [];
}

function parse_hour_field(field: string): number[] {
  if (field === "*") {
    return Array.from({ length: 24 }, (_, index) => index);
  }

  const everyMatch = field.match(/^\*\/(\d{1,2})$/);
  if (everyMatch) {
    const step = Number(everyMatch[1]);
    if (step <= 0) return [];
    return Array.from({ length: Math.ceil(24 / step) }, (_, index) => index * step).filter((hour) => hour < 24);
  }

  const rangeMatch = field.match(/^(\d{1,2})-(\d{1,2})\/(\d{1,2})$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    const step = Number(rangeMatch[3]);
    if (step <= 0 || start < 0 || end > 23 || start > end) return [];
    const hours: number[] = [];
    for (let hour = start; hour <= end; hour += step) {
      hours.push(hour);
    }
    return hours;
  }

  const rangeMatchNoStep = field.match(/^(\d{1,2})-(\d{1,2})$/);
  if (rangeMatchNoStep) {
    const start = Number(rangeMatchNoStep[1]);
    const end = Number(rangeMatchNoStep[2]);
    if (start < 0 || end > 23 || start > end) return [];
    const hours: number[] = [];
    for (let hour = start; hour <= end; hour += 1) {
      hours.push(hour);
    }
    return hours;
  }

  // Comma-separated list: "9,12,18"
  if (field.includes(",")) {
    const hours = field.split(",").map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
    return hours.length > 0 ? hours : [];
  }

  const exact = Number(field);
  if (Number.isInteger(exact) && exact >= 0 && exact <= 23) {
    return [exact];
  }

  return [];
}

export class CronManager {
  private readonly active_abort_controllers = new Map<string, AbortController>();
  private founderTimezone = "America/Los_Angeles";

  constructor(
    private readonly db: SupervisorDb,
    private readonly task_manager: TaskManager,
    private readonly credit_manager: CreditManager,
    private readonly invoker: AgentInvoker,
    private readonly scheduler: Scheduler,
    private readonly config: SupervisorConfig,
  ) {}

  set_founder_timezone(tz: string): void {
    this.founderTimezone = tz;
  }

  get_due_cron_tasks(company_id: string): CronTaskRow[] {
    const tasks = this.db.all<CronTaskRow>(
      `
        SELECT *
        FROM cron_tasks
        WHERE company_id = ?
          AND enabled = 1
        ORDER BY created_at ASC
      `,
      [company_id],
    );
    return tasks.filter((task) => is_due(task.schedule, task.last_run_at, task.created_at, this.founderTimezone));
  }

  async schedule_cron_tasks(company_id: string): Promise<void> {
    const has_work = this.task_manager.has_active_work(company_id);

    const idle_agents = this.task_manager
      .get_agents(company_id)
      .filter((agent) => agent.status === "idle");
    if (idle_agents.length === 0) return;

    const due_crons = this.get_due_cron_tasks(company_id);
    for (const cron of due_crons) {
      // Re-fetch agent status each iteration to prevent double invocation
      const agent = this.task_manager.get_agent(cron.agent_id);
      if (!agent || agent.status !== "idle") continue;

      // When no active work, only allow specialist self-update crons to fire.
      // Non-specialist crons are skipped to prevent token burn on idle companies.
      if (!has_work && (!agent.blueprint_id || !isSpecialistBlueprint(agent.blueprint_id))) continue;

      await this.invoke_cron(agent, cron).catch((err) => {
        console.error(`[cron] invoke_cron failed for agent ${agent.id}:`, err);
      });
    }
  }

  async invoke_cron(agent: AgentRow, cron: CronTaskRow): Promise<void> {
    const company = this.task_manager.get_company(cron.company_id);
    if (!company?.workspace_dir) {
      throw new Error(`Company ${cron.company_id} has no workspace_dir`);
    }
    if (!existsSync(company.workspace_dir)) {
      console.error(`[cron] Workspace missing for company ${cron.company_id}: ${company.workspace_dir}`);
      await this.scheduler.pause_company_missing_workspace(cron.company_id);
      return;
    }
    // Guard: don't start cron turns if company is paused or terminated
    if (company.state !== "running") {
      console.warn(`[cron] Skipping cron ${cron.id} for agent ${agent.id}: company ${cron.company_id} is ${company.state}`);
      return;
    }
    const base_turn_limits = this.invoker.getTurnLimits(agent);
    const available_credits = this.credit_manager.get_balance(company.user_id);
    const turn_limits = fit_turn_limits_to_available_credits(agent.model_tier, base_turn_limits, available_credits);
    const reserved_credits = calculate_turn_credit_reservation(agent.model_tier, turn_limits);
    if (!this.credit_manager.reserve_credits(company.user_id, reserved_credits, company.id)) {
      const total_balance = this.credit_manager.get_total_balance(company.user_id);
      if (total_balance <= 0) {
        await this.scheduler.pause_company(company.id);
      } else {
        console.warn(
          `[cron] Skipping cron ${cron.id} for agent ${agent.id}: ${reserved_credits} credits unavailable right now (total=${total_balance}, available=${this.credit_manager.get_balance(company.user_id)})`,
        );
      }
      return;
    }

    this.db.run(`UPDATE agents SET status = 'working', current_task_id = NULL WHERE id = ?`, [agent.id]);
    this.db.enqueue_sync("agents", agent.id, "upsert", {
      status: "working",
      current_task_id: null,
    });

    const prompt = [
      build_ceo_date_header(company),
      "",
      "# Recurring Work",
      "",
      cron.prompt,
    ].join("\n");

    const abort_controller = new AbortController();
    this.active_abort_controllers.set(agent.id, abort_controller);
    let reservation_settled = false;
    try {
      const result = await this.invoker.invoke(agent, prompt, company.workspace_dir, {
        systemPromptOverride: build_system_prompt(agent, company),
        abortController: abort_controller,
        turnLimits: turn_limits,
      });

      const company_paused = this.task_manager.get_company(company.id)?.state === "paused";
      const credits = calculate_turn_credits(agent.model_tier, result.tokenUsage);
      const billed_credits = company_paused ? 0 : credits;
      const charged_credits = this.credit_manager.settle_reserved_credits(
        company.user_id,
        reserved_credits,
        billed_credits,
        {
          company_id: company.id,
          agent_id: agent.id,
          model_tier: agent.model_tier,
          description: cron.prompt,
        },
      );
      reservation_settled = true;
      this.invoker.recordSessionCredits(agent.id, charged_credits);
      const output_summary = extract_summary(result.output, cron.prompt);
      this.db.run(
        `
          INSERT INTO turn_log (
            company_id, agent_id, task_id, input_tokens, output_tokens, credits_spent,
            tool_call_count, artifact_changed, agent_declared_done, output_summary,
            error, duration_ms, created_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
        `,
        [
          company.id,
          agent.id,
          result.tokenUsage.inputTokens,
          result.tokenUsage.outputTokens,
          charged_credits,
          result.toolCallCount,
          output_summary,
          result.error ?? null,
          result.durationMs,
          isoNow(),
        ],
      );
      const turn_log_id = this.db.get<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;

      this.db.run(
        `
          UPDATE agents
          SET status = 'idle',
              total_credits = total_credits + ?,
              session_id = COALESCE(?, session_id)
          WHERE id = ?
        `,
        [charged_credits, result.sessionId ?? null, agent.id],
      );
      this.db.run(`UPDATE cron_tasks SET last_run_at = ? WHERE id = ?`, [isoNow(), cron.id]);

      this.db.enqueue_sync("turn_log", String(turn_log_id), "upsert", {
        company_id: company.id,
        agent_id: agent.id,
        task_id: null,
        output_summary,
        credits_spent: charged_credits,
        input_tokens: result.tokenUsage.inputTokens,
        output_tokens: result.tokenUsage.outputTokens,
        tool_call_count: result.toolCallCount,
        artifact_changed: 0,
        error: result.error ?? null,
        duration_ms: result.durationMs,
        created_at: isoNow(),
      });
      this.db.enqueue_sync("agents", agent.id, "upsert", {
        status: "idle",
        total_credits: (this.task_manager.get_agent(agent.id)?.total_credits ?? agent.total_credits) + charged_credits,
        session_id: result.sessionId ?? agent.session_id,
      });
      this.db.enqueue_sync("cron_tasks", cron.id, "upsert", {
        ...cron,
        last_run_at: isoNow(),
      });

      if (company_paused) {
        this.db.run(`UPDATE agents SET status = 'paused' WHERE id = ?`, [agent.id]);
        this.db.enqueue_sync("agents", agent.id, "upsert", { status: "paused" });
        return;
      }

      const balance = this.credit_manager.get_balance(company.user_id);
      if (balance <= 0) {
        await this.scheduler.pause_company(company.id);
        return;
      }
      await this.scheduler.schedule(company.id);
    } catch (err) {
      // Reset agent to idle so it doesn't get permanently stuck in 'working'
      this.db.run(
        `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
        [agent.id],
      );
      this.db.enqueue_sync("agents", agent.id, "upsert", {
        status: "idle",
        current_task_id: null,
      });
      console.error(`[cron] invoke_cron failed for agent ${agent.id}:`, err);
      throw err;
    } finally {
      this.active_abort_controllers.delete(agent.id);
      if (!reservation_settled) {
        this.credit_manager.release_reserved_credits(company.user_id, reserved_credits, company.id);
      }
    }
  }

  async request_daily_update(company_id: string): Promise<void> {
    const company = this.task_manager.get_company(company_id);
    if (!company?.workspace_dir) return;
    // Skip daily updates when all work is done — nothing meaningful to report
    if (!this.task_manager.has_active_work(company_id)) {
      console.log(`[cron] Skipping daily update for ${company_id}: no active work`);
      return;
    }
    const today = format_date_tz(this.founderTimezone);
    const update_path = `${company.workspace_dir}/docs/daily-update-${today}.md`;

  if (existsSync(update_path)) return;

    const ceo = this.task_manager.get_ceo(company_id);
    const last_update_date = get_last_daily_update_date(company.workspace_dir, this.founderTimezone);
    const completed_tasks = this.task_manager.get_tasks_completed_since(
      company_id,
      last_update_date ? `${last_update_date}T00:00:00.000Z` : null,
    );
    const in_progress_tasks = this.task_manager.get_tasks(company_id, ["in_progress"]);
    const blocked_tasks = this.task_manager.get_tasks(company_id, ["blocked"]);
    const day_number = compute_day_number(company);

    const prompt = [
      build_ceo_date_header(company),
      "",
      `Write today's daily update to /workspace/docs/daily-update-${today}.md`,
      "",
      `Date: ${today}`,
      `Day ${day_number} of the company.`,
      "",
      "Since the last update:",
      `- Completed: ${format_task_summaries(completed_tasks)}`,
      `- In progress: ${format_task_summaries(in_progress_tasks)}`,
      `- Blocked: ${format_task_summaries(blocked_tasks)}`,
      "",
      "Rules:",
      "- 40–140 words. One short paragraph.",
      "- State what got done, what's happening now, what's blocked (if anything).",
      "- No aspirational filler (\"exciting progress!\"). Just facts.",
      "- Do not invent metrics. Only reference verified telemetry if it exists.",
    ].join("\n");

    await this.scheduler.invoke_ceo_turn(company_id, ceo, prompt, { is_user_facing: false });

    // Email the daily update to the founder
    try {
      if (existsSync(update_path)) {
        const content = readFileSync(update_path, "utf8").trim();
        if (content) {
          this.send_founder_email(company_id, ceo.id, `${company.name} — Daily Update ${today}`, content);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cron] Failed to email daily update for ${company_id}: ${msg}`);
    }
  }

  async run_daily_update_checks(): Promise<void> {
    const active_companies = this.db.all<CompanyRow>(
      `SELECT * FROM companies WHERE state = 'running' ORDER BY created_at ASC`,
    );
    for (const company of active_companies) {
      // Skip companies with exhausted balance — daily updates cost credits
      const total_balance = this.credit_manager.get_total_balance(company.user_id);
      if (total_balance <= 0) {
        continue;
      }
      await this.request_daily_update(company.id);
    }
  }

  async run_tick(): Promise<void> {
    const companies = this.db.all<CompanyRow>(
      `SELECT * FROM companies WHERE state = 'running' ORDER BY created_at ASC`,
    );
    for (const company of companies) {
      // Credit pre-check: skip companies with exhausted balance entirely
      const total_balance = this.credit_manager.get_total_balance(company.user_id);
      if (total_balance <= 0) {
        await this.scheduler.pause_company(company.id);
        continue;
      }
      // Watchdog: reset agents stuck in 'working' with no active invocation
      this.scheduler.reset_stuck_agents(company.id);
      // Only run the task scheduler when there is active work — prevents
      // no_agent_assigned CEO notifications (and token burn) on idle companies.
      if (this.task_manager.has_active_work(company.id)) {
        await this.scheduler.schedule(company.id);
      }
      await this.schedule_cron_tasks(company.id);
    }
    // Daily briefs only after 8pm in the founder's timezone
    const founderHour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: this.founderTimezone, hour: "numeric", hour12: false,
    }).format(new Date()));
    if (founderHour >= 20) {
      await this.run_daily_update_checks();
    }

    // At 8am, auto-apply pending continuation plans for manual-mode companies
    if (founderHour >= 8 && founderHour < 9) {
      await this.apply_pending_continuation_plans();
    }
  }

  private async apply_pending_continuation_plans(): Promise<void> {
    const companies = this.db.all<CompanyRow>(
      `SELECT * FROM companies WHERE state = 'running' AND mode = 'manual' ORDER BY created_at ASC`,
    );
    for (const company of companies) {
      if (!company.workspace_dir) continue;
      // Skip companies with exhausted balance — applying plans triggers agent work
      const total_balance = this.credit_manager.get_total_balance(company.user_id);
      if (total_balance <= 0) {
        continue;
      }
      const holding_path = `${company.workspace_dir}/.agent/pending_continuation_plan.json`;
      if (!existsSync(holding_path)) continue;

      try {
        const raw = readFileSync(holding_path, "utf8");
        rmSync(holding_path, { force: true });

        const parsed = parse_json_with_error<PlanUpdateDocument>(raw);
        if (parsed.ok) {
          await this.scheduler.apply_plan_update(company.id, parsed.value);
          this.scheduler.activate_pending_milestone_tasks(company.id);
          await this.scheduler.schedule(company.id);

          const ceo = this.task_manager.get_ceo(company.id);
          await this.scheduler.insert_ceo_message_internal(
            company.id,
            "Good morning! No feedback received, so I'm starting the continuation plan now.",
            ceo.id,
            true,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cron] Failed to auto-apply continuation plan for ${company.id}: ${msg}`);
      }
    }
  }

  private send_founder_email(company_id: string, from_agent_id: string, subject: string, text: string): void {
    const url = `${this.config.workerApiUrl}/api/supervisor/companies/${company_id}/founder-email`;
    void fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Supervisor-Key": this.config.internalApiKey,
      },
      body: JSON.stringify({ fromAgentId: from_agent_id, subject, text }),
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cron] Failed to email founder for ${company_id}: ${msg}`);
    });
  }

  /** Returns true if an active cron invocation exists for the given agent. */
  has_active_invocation(agent_id: string): boolean {
    return this.active_abort_controllers.has(agent_id);
  }

  abort_agent_turn(agent_id: string): void {
    this.active_abort_controllers.get(agent_id)?.abort();
  }

  abort_all_turns(): void {
    for (const abort_controller of this.active_abort_controllers.values()) {
      abort_controller.abort();
    }
    this.active_abort_controllers.clear();
  }
}
