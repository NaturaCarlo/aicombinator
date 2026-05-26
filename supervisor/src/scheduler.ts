import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentInvoker } from "./agent-invoker.js";
import {
  AgentRunner,
  build_ceo_date_header,
  build_system_prompt,
  extract_summary,
} from "./agent-runner.js";
import { ContainerManager } from "./container-manager.js";
import { FOUNDING_BLUEPRINTS, isSpecialistBlueprint } from "./blueprints.js";
import {
  calculate_turn_credit_reservation,
  calculate_turn_credits,
  CreditManager,
  fit_turn_limits_to_available_credits,
} from "./credit-manager.js";
import { SupervisorDb, isoNow } from "./db.js";
import { StallDetector } from "./stall-detector.js";
import { SyncManager } from "./sync.js";
import { TaskManager, format_task_summaries, humanize_criteria, task_temp_reference } from "./task-manager.js";
import { canAssignTo, getReportTarget } from "./routing.js";
import type { DeployManager } from "./deploy-manager.js";
import {
  buildFallbackInitialPlan as build_fallback_initial_plan,
  buildFounderStateSnapshotBlock as build_founder_state_snapshot_block,
  buildInitialPlanningSystemPrompt as build_initial_planning_system_prompt_text,
  buildMissionPrompt as build_mission_prompt_text,
  buildMissionSystemPrompt as build_mission_system_prompt_text,
  buildPlanningPrompt as build_planning_prompt_text,
  buildCeoContinuationPlanPrompt as build_ceo_continuation_plan_prompt,
  deriveFallbackMission as derive_fallback_mission,
  founderBriefText as founder_brief_text,
  parseInitialPlanOutput as parse_initial_plan_output,
  parseMissionOutput as parse_mission_output,
} from "./scheduler-prompts.js";
import {
  build_ceo_blocked_task_prompt,
  build_ceo_document_revision_prompt,
  build_ceo_milestone_review_prompt,
  build_ceo_task_failed_prompt,
  build_ceo_unassigned_task_prompt,
  build_ceo_user_message_prompt,
  gather_ceo_context,
  prepare_founder_reply,
} from "./scheduler-founder.js";
import {
  materialize_early_mission as materialize_early_mission_files,
  materialize_initial_company_files as materialize_initial_company_files_to_workspace,
} from "./scheduler-documents.js";
import {
  ensure_workspace_agent_dir,
  parse_json,
  parse_json_array,
  parse_json_with_error,
} from "./scheduler-helpers.js";
import {
  get_agent_activity_entries,
  get_company_progress_metrics,
  get_verified_telemetry_summary,
} from "./scheduler-status.js";
import type {
  AcceptanceCriterion,
  AgentActivityEntry,
  AgentRow,
  AgentTurnResult,
  ApprovalRequestPayload,
  ApprovalResolutionPayload,
  AutomationRequestPayload,
  ApprovalRow,
  CEOEventQueueRow,
  CEOEventType,
  CompanyProgressMetrics,
  CompanyRow,
  CreditPurchasePayload,
  FounderDocument,
  FounderStateSnapshot,
  MessageRow,
  MilestoneRow,
  PlanDocument,
  PlanMilestoneInput,
  PlanTaskInput,
  PlanUpdateDocument,
  ProvisionCompanyPayload,
  SubtaskRequestPayload,
  SupervisorConfig,
  TurnLimits,
  TaskRow,
  TaskSignal,
  UserMessagePayload,
  VerifiedTelemetrySummary,
  WorkspaceArchivePayload,
} from "./types.js";

export interface CronCoordinator {
  schedule_cron_tasks(company_id: string): Promise<void> | void;
  has_active_invocation(agent_id: string): boolean;
  abort_agent_turn(agent_id: string): void;
  abort_all_turns(): void;
}

interface InvokeCeoOptions {
  is_user_facing?: boolean;
  skip_response_processing?: boolean;
  bill_credits?: boolean;
  turn_limits_override?: Partial<TurnLimits>;
  system_prompt_override?: string;
  /** The event type that triggered this CEO turn (used to prevent loops). */
  event_type?: string;
  /** Streaming callback for text deltas (SSE) */
  onTextDelta?: (text: string) => Promise<void> | void;
  /** Streaming callback when a tool invocation starts */
  onToolStart?: (toolName: string, toolId: string) => void;
  /** Streaming callback when a tool invocation ends */
  onToolEnd?: (toolId: string) => void;
}

interface UserMessageQueuePayload {
  text: string;
}

function format_task_list_with_ids(tasks: TaskRow[], task_manager: TaskManager): string {
  if (tasks.length === 0) return "- none";
  const lines: string[] = [];
  for (const task of tasks) {
    const agent = task.owner_agent_id ? task_manager.get_agent(task.owner_agent_id) : undefined;
    lines.push(`- [${task.id}] "${task.title}" (${agent?.name ?? "unassigned"}) — ${task.status}`);
    if (task.blocked_reason) {
      lines.push(`  Blocked: ${task.blocked_reason}`);
    }
    if (task.artifact) {
      lines.push(`  Artifact: ${task.artifact}`);
    }
  }
  return lines.join("\n");
}

function format_milestone_list(company_id: string, milestones: MilestoneRow[], task_manager: TaskManager): string {
  if (milestones.length === 0) return "- none";
  return milestones
    .map((milestone) => {
      const tasks = task_manager.get_tasks(company_id).filter((task) => task.milestone_id === milestone.id);
      const done = tasks.filter((task) => task.status === "done").length;
      return `- [${milestone.id}] "${milestone.title}" — ${milestone.status} (${done}/${tasks.length} tasks done)`;
    })
    .join("\n");
}

/**
 * Heuristic to detect whether a founder message is a work request
 * (i.e., asking the team to build/create/fix/change something).
 * Used to enforce task creation when the CEO responds conversationally
 * without writing plan_update.json.
 */
const WORK_REQUEST_VERBS = /\b(build|create|design|fix|add|implement|redesign|change|update|make|develop|write|set\s*up|setup|refactor|migrate|deploy|launch|ship|integrate|remove|delete|replace|rewrite|optimize|improve|rework|redo|overhaul|revamp|rebuild|construct|configure|install|generate|produce|draft|prepare|adjust|modify|alter|convert|transform|establish|enable|disable)\b/i;

/** Negative patterns — messages that look like questions or status checks, not work requests */
const STATUS_CHECK_PATTERNS = /^(what('?s| is| are)|how('?s| is| are)|who('?s| is| are)|where|when|show|tell|give|status|update me|any update|progress|report)\b/i;

export function is_work_request(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 5) return false;

  // Skip pure questions / status checks
  if (STATUS_CHECK_PATTERNS.test(trimmed)) return false;

  // Skip greetings and short pleasantries
  if (/^(hi|hey|hello|yo|sup|good\s+(morning|afternoon|evening|night)|thanks|thank you|ok|okay|sure|great|cool|nice|awesome|perfect|got it|sounds good)\b/i.test(trimmed) && trimmed.length < 40) {
    return false;
  }

  return WORK_REQUEST_VERBS.test(trimmed);
}

export class Scheduler {
  private readonly runner: AgentRunner;
  private readonly stall_detector: StallDetector;
  private readonly active_ceo_turns = new Set<string>();
  private readonly active_ceo_abort_controllers = new Map<string, AbortController>();
  /** Tracks consecutive infrastructure failure counts per company for backoff-based auto-pause. */
  private readonly infra_failure_counts = new Map<string, number>();
  /**
   * Tracks whether the last process_ceo_response found and consumed a plan_update.json,
   * keyed by company_id to prevent cross-company state bleed.
   */
  private last_ceo_response_had_plan_update = new Map<string, boolean>();
  private cron: CronCoordinator | null = null;

  constructor(
    private readonly db: SupervisorDb,
    private readonly config: SupervisorConfig,
    private readonly task_manager: TaskManager,
    private readonly credit_manager: CreditManager,
    private readonly sync_manager: SyncManager,
    private readonly invoker: AgentInvoker,
    private readonly container_manager: ContainerManager,
    private readonly deploy_manager?: DeployManager,
  ) {
    this.stall_detector = new StallDetector(db, task_manager);
    this.runner = new AgentRunner(db, task_manager, credit_manager, invoker, {
      on_task_completed: (task_id) => this.on_task_completed(task_id),
      notify_ceo: (company_id, event_type, payload) => this.notify_ceo(company_id, event_type, payload),
      notify_manager: (company_id, manager_blueprint_id, event_type, payload) =>
        this.notify_manager(company_id, manager_blueprint_id, event_type, payload),
      process_subtask_request: (company_id, sender_agent, request) =>
        this.process_subtask_request(company_id, sender_agent, request),
      pause_company: (company_id) => this.pause_company(company_id),
      pause_company_missing_workspace: (company_id) => this.pause_company_missing_workspace(company_id),
      schedule: (company_id) => this.schedule(company_id),
    });

    // Wire up credit exhaustion callback so CreditManager can properly
    // abort working agents (not just pause idle ones).
    // CRITICAL: Immediately mark company as paused in DB (synchronous) to prevent
    // run_tick from selecting it before the full async pause completes.
    credit_manager.set_pause_callback((company_id) => {
      // Synchronous DB update — prevents run_tick() from dispatching new work
      this.db.run('UPDATE companies SET state = ?, updated_at = ? WHERE id = ?', ['paused', isoNow(), company_id]);
      // Full async pause (aborts working agents, resets tasks, syncs to D1)
      void this.pause_company(company_id).catch(err => {
        console.error(`[credits] async pause failed for company ${company_id}:`, err instanceof Error ? err.message : err);
      });
    });
  }

  set_cron_manager(cron: CronCoordinator): void {
    this.cron = cron;
  }

  generate_id(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  get_workspace_dir(company_id: string): string {
    const company = this.task_manager.get_company(company_id);
    if (company?.workspace_dir) {
      ensure_workspace_agent_dir(company.workspace_dir);
      return company.workspace_dir;
    }
    const fallback = this.container_manager.getWorkspaceDir(company_id);
    ensure_workspace_agent_dir(fallback);
    return fallback;
  }

  /** Check if a system CEO turn is currently active for the given company. */
  is_ceo_turn_active(company_id: string): boolean {
    return this.active_ceo_turns.has(`${company_id}:system`);
  }

  /** Check if ANY CEO turn (system or user-facing) is active for the given company. */
  private is_any_ceo_turn_active(company_id: string): boolean {
    return this.active_ceo_turns.has(`${company_id}:system`) || this.active_ceo_turns.has(`${company_id}:user`);
  }

  /** Get the compound key for a CEO turn. */
  private ceo_turn_key(company_id: string, is_user_facing: boolean): string {
    return `${company_id}:${is_user_facing ? "user" : "system"}`;
  }

  async provision_company(payload: ProvisionCompanyPayload): Promise<CompanyRow> {
    const company = payload.workspace_dir || payload.container_id
      ? this.normalize_company_payload(payload)
      : await this.sync_manager.fetch_company(payload.id);

    if (this.config.scopeUserId && company.user_id !== this.config.scopeUserId) {
      throw new Error(`Company ${company.id} belongs to a different user`);
    }

    const provisional: CompanyRow = {
      ...company,
      state: company.state ?? "provisioning",
      updated_at: isoNow(),
    };
    this.task_manager.upsert_company(provisional);

    const container = await this.container_manager.create(company.id, company.name, payload.env);
    const normalized: CompanyRow = {
      ...provisional,
      workspace_dir: container.workspaceDir,
      container_id: container.containerId,
      updated_at: isoNow(),
    };
    this.task_manager.upsert_company(normalized);
    // Only activate CEO upfront — other agents get activated later by ingest_plan()
    // based on the plan's agents_needed list.
    this.task_manager.activate_agent(normalized.id, "ceo");
    await this.credit_manager.init_company_credits(normalized.id, normalized.user_id);
    // Pre-materialize mission.md from genesis_prompt (launch artifacts) so that
    // start_planning() can skip the expensive Turn 1 mission generation.
    // This MUST happen synchronously before start_planning fires.
    if (normalized.genesis_prompt?.trim()) {
      this.materialize_early_mission(normalized, normalized.genesis_prompt.trim());
      console.log(`[scheduler] pre-materialized mission.md from genesis_prompt for ${normalized.id}`);
    }
    // Fire-and-forget: start planning in background so the HTTP response
    // returns immediately. The worker polls /status to know when planning is done.
    void this.start_planning(normalized).catch((err) => {
      console.error(`[scheduler] Background planning failed for ${normalized.id}:`, err);
    });
    return this.require_company(normalized.id);
  }

  async start_planning(company: CompanyRow): Promise<void> {
    console.log(`[scheduler] start_planning: company=${company.id}`);
    this.db.run(`UPDATE companies SET state = 'planning', updated_at = ? WHERE id = ?`, [
      isoNow(),
      company.id,
    ]);
    this.db.enqueue_sync("companies", company.id, "upsert", { state: "planning", updated_at: isoNow() });
    // Ensure CEO exists (may be missing if recovered from a stuck provisioning state)
    this.task_manager.activate_agent(company.id, "ceo");
    const ceo = this.task_manager.get_ceo(company.id);

    // ── Check if mission.md already exists (pre-materialized from launch artifacts) ──
    let earlyMission: string | null = null;
    const workspace = this.get_workspace_dir(company.id);
    const missionPath = join(workspace, "docs", "mission.md");
    if (existsSync(missionPath)) {
      const existing = readFileSync(missionPath, "utf8").trim();
      if (existing.length > 0) {
        earlyMission = existing;
        console.log(`[planning] skipping mission turn — early mission already materialized`);
      }
    }

    if (!earlyMission) {
      // ── Turn 1: Mission only (fast — 1 inference, 0 tools, 90s) ──
      const t1Start = Date.now();
      const missionResult = await this.invoke_ceo_turn(company.id, ceo, this.build_mission_prompt(company), {
        skip_response_processing: true,
        turn_limits_override: {
          maxInferenceRoundsPerTurn: 1,
          maxToolCallsPerTurn: 0,
          turnTimeoutMs: 90_000,
        },
        system_prompt_override: this.build_mission_system_prompt(company),
      });
      const t1Elapsed = Date.now() - t1Start;
      console.log(`[scheduler] Turn 1 (mission) complete: company=${company.id}, chars=${missionResult.output?.length ?? 0}, time=${t1Elapsed}ms`);
      if (missionResult.aborted && missionResult.error === "Credits exhausted") {
        console.log(`[scheduler] credits exhausted during planning: company=${company.id}, stage=turn1`);
        this.db.run(`UPDATE companies SET state = 'paused', updated_at = ? WHERE id = ?`, [isoNow(), company.id]);
        this.db.enqueue_sync("companies", company.id, "upsert", { state: "paused", updated_at: isoNow() });
        await this.insert_ceo_message_internal(company.id, "Credits exhausted during initial planning. Add more tokens to continue.", undefined, true);
        return;
      }

      // Extract mission and materialize immediately so the launch UI can show it
      earlyMission = parse_mission_output(missionResult.output) ?? derive_fallback_mission(company);
      this.materialize_early_mission(company, earlyMission);
    }

    // ── Turn 2: Full day-long plan (12 rounds, 20 tools, 4min) ──
    const prompt = this.build_planning_prompt(company, earlyMission);
    const t2Start = Date.now();
    const result = await this.invoke_ceo_turn(company.id, ceo, prompt, {
      skip_response_processing: true,
      turn_limits_override: {
        maxInferenceRoundsPerTurn: 12,
        maxToolCallsPerTurn: 20,
        turnTimeoutMs: 240_000,
      },
      system_prompt_override: this.build_initial_planning_system_prompt(company),
    });
    const t2Elapsed = Date.now() - t2Start;
    console.log(`[scheduler] Turn 2 (plan) complete: company=${company.id}, chars=${result.output?.length ?? 0}, time=${t2Elapsed}ms, aborted=${result.aborted}`);
    if (result.aborted && result.error === "Credits exhausted") {
      console.log(`[scheduler] credits exhausted during planning: company=${company.id}, stage=turn2`);
      this.db.run(`UPDATE companies SET state = 'paused', updated_at = ? WHERE id = ?`, [isoNow(), company.id]);
      this.db.enqueue_sync("companies", company.id, "upsert", { state: "paused", updated_at: isoNow() });
      await this.insert_ceo_message_internal(company.id, "Credits exhausted during initial planning. Add more tokens to continue.", undefined, true);
      return;
    }
    await this.process_initial_plan(company.id, result.output);
  }

  build_mission_prompt(company: CompanyRow): string {
    return build_mission_prompt_text(company);
  }

  build_mission_system_prompt(company: CompanyRow): string {
    return build_mission_system_prompt_text(company);
  }

  build_planning_prompt(company: CompanyRow, mission?: string): string {
    return build_planning_prompt_text(company, mission);
  }

  build_initial_planning_system_prompt(company: CompanyRow): string {
    return build_initial_planning_system_prompt_text(company);
  }

  async process_initial_plan(company_id: string, direct_output?: string | null): Promise<void> {
    console.log(`[scheduler] process_initial_plan: company=${company_id}, output_length=${direct_output?.length ?? 0}`);
    if (!this.task_manager.get_company(company_id)) {
      return;
    }
    const company = this.require_company(company_id);
    const directPlan = parse_initial_plan_output(direct_output);
    console.log(`[scheduler] direct JSON parse: company=${company_id}, success=${directPlan !== null}`);
    if (directPlan) {
      const errors = this.task_manager.validate_plan(company_id, directPlan.plan);
      console.log(`[scheduler] plan validation: company=${company_id}, valid=${errors.length === 0}, errors=${JSON.stringify(errors.map(e => e.message))}`);
      if (errors.length === 0) {
        await this.finalize_initial_plan(company_id, directPlan.mission, directPlan.plan);
        return;
      }
      const fallbackPlan = build_fallback_initial_plan(company);
      const fallbackErrors = this.task_manager.validate_plan(company_id, fallbackPlan);
      if (fallbackErrors.length === 0) {
        console.log(`[scheduler] fallback plan activated: company=${company_id}`);
        await this.insert_ceo_message_internal(
          company_id,
          "I tightened the launch into a minimal bootstrap plan so the company can start moving immediately.",
          undefined,
          true,
        );
        await this.finalize_initial_plan(company_id, directPlan.mission, fallbackPlan);
        return;
      }
    }

    const workspace = this.get_workspace_dir(company_id);
    const plan_path = join(workspace, ".agent", "plan.json");
    const mission_path = join(workspace, "docs", "mission.md");
    const fallbackMission = existsSync(mission_path)
      ? readFileSync(mission_path, "utf8").trim() || derive_fallback_mission(company)
      : derive_fallback_mission(company);

    const planFileExists = existsSync(plan_path);
    console.log(`[scheduler] workspace plan.json: company=${company_id}, exists=${planFileExists}`);
    if (!planFileExists) {
      const fallbackPlan = build_fallback_initial_plan(company);
      const fallbackErrors = this.task_manager.validate_plan(company_id, fallbackPlan);
      if (fallbackErrors.length === 0) {
        console.log(`[scheduler] fallback plan activated: company=${company_id}`);
        await this.insert_ceo_message_internal(
          company_id,
          "I fell back to a minimal launch plan because the initial planning output was incomplete, but the company can still move forward.",
          undefined,
          true,
        );
        await this.finalize_initial_plan(company_id, fallbackMission, fallbackPlan);
        return;
      }
      await this.escalate_planning_failure(company_id, "CEO did not write /workspace/.agent/plan.json");
      return;
    }

    const parsed = parse_json_with_error<PlanDocument>(readFileSync(plan_path, "utf8"));
    rmSync(plan_path, { force: true });
    if (!parsed.ok) {
      const fallbackPlan = build_fallback_initial_plan(company);
      const fallbackErrors = this.task_manager.validate_plan(company_id, fallbackPlan);
      if (fallbackErrors.length === 0) {
        console.log(`[scheduler] fallback plan activated: company=${company_id}`);
        await this.insert_ceo_message_internal(
          company_id,
          "I used a deterministic bootstrap plan because the initial plan file was malformed, so launch can continue cleanly.",
          undefined,
          true,
        );
        await this.finalize_initial_plan(company_id, fallbackMission, fallbackPlan);
        return;
      }
      await this.retry_planning(company_id, [`plan.json is invalid JSON: ${parsed.message}`]);
      return;
    }
    const plan = parsed.value;

    const errors = this.task_manager.validate_plan(company_id, plan);
    console.log(`[scheduler] plan validation: company=${company_id}, valid=${errors.length === 0}, errors=${JSON.stringify(errors.map(e => e.message))}`);
    if (errors.length > 0) {
      const fallbackPlan = build_fallback_initial_plan(company);
      const fallbackErrors = this.task_manager.validate_plan(company_id, fallbackPlan);
      if (fallbackErrors.length === 0) {
        console.log(`[scheduler] fallback plan activated: company=${company_id}`);
        await this.insert_ceo_message_internal(
          company_id,
          "I converted the initial planning attempt into a smaller valid bootstrap plan so work can begin immediately.",
          undefined,
          true,
        );
        await this.finalize_initial_plan(company_id, fallbackMission, fallbackPlan);
        return;
      }
      await this.retry_planning(company_id, errors.map((error) => error.message));
      return;
    }

    const mission = existsSync(mission_path)
      ? readFileSync(mission_path, "utf8").trim()
      : founder_brief_text(company);
    await this.finalize_initial_plan(company_id, mission, plan);
  }

  private materialize_early_mission(company: CompanyRow, mission: string): void {
    materialize_early_mission_files(this.get_workspace_dir(company.id), company, mission);
  }

  private async finalize_initial_plan(company_id: string, mission: string, plan: PlanDocument): Promise<void> {
    const company = this.require_company(company_id);
    this.materialize_initial_company_files(company, mission, plan);
    this.task_manager.ingest_plan(company_id, plan);
    this.db.run('UPDATE companies SET planning_failures = 0 WHERE id = ?', [company_id]);
    const totalTasks = plan.milestones.reduce((sum, m) => sum + (m.tasks?.length ?? 0), 0);
    console.log(`[scheduler] finalize_initial_plan: company=${company_id}, milestones=${plan.milestones.length}, tasks=${totalTasks}, agents=${plan.agents_needed?.length ?? 0}`);
    await this.schedule(company_id);
  }

  private materialize_initial_company_files(company: CompanyRow, mission: string, plan: PlanDocument): void {
    materialize_initial_company_files_to_workspace(this.get_workspace_dir(company.id), company, mission, plan);
  }

  async retry_planning(company_id: string, errors: string[]): Promise<void> {
    if (!this.task_manager.get_company(company_id)) {
      return;
    }
    const attempts = (this.db.get<{planning_failures: number}>('SELECT planning_failures FROM companies WHERE id = ?', [company_id])?.planning_failures ?? 0) + 1;
    this.db.run('UPDATE companies SET planning_failures = ? WHERE id = ?', [attempts, company_id]);
    console.log(`[scheduler] retry_planning: company=${company_id}, attempt=${attempts}, errors=${errors.join("; ")}`);
    if (attempts >= 3) {
      await this.escalate_planning_failure(company_id, errors.join("\n"));
      return;
    }
    const company = this.require_company(company_id);
    const ceo = this.task_manager.get_ceo(company_id);
    const prompt = [
      build_ceo_date_header(company),
      "",
      "# Planning Validation Failed",
      "",
      "Your initial plan did not validate. Fix the following errors.",
      "Preferred path: return a single JSON object in your final response with top-level keys mission and plan.",
      "Fallback path: rewrite /workspace/docs/mission.md and /workspace/.agent/plan.json.",
      "",
      ...errors.map((error) => `- ${error}`),
    ].join("\n");
    const result = await this.invoke_ceo_turn(company_id, ceo, prompt, {
      skip_response_processing: true,
      turn_limits_override: {
        maxInferenceRoundsPerTurn: 12,
        maxToolCallsPerTurn: 40,
        turnTimeoutMs: 1000 * 60 * 8,
      },
      system_prompt_override: this.build_initial_planning_system_prompt(company),
    });
    if (result.aborted && result.error === "Credits exhausted") {
      console.log(`[scheduler] credits exhausted during planning: company=${company_id}, stage=retry`);
      this.db.run(`UPDATE companies SET state = 'paused', updated_at = ? WHERE id = ?`, [isoNow(), company_id]);
      this.db.enqueue_sync("companies", company_id, "upsert", { state: "paused", updated_at: isoNow() });
      await this.insert_ceo_message_internal(company_id, "Credits exhausted during initial planning. Add more tokens to continue.", undefined, true);
      return;
    }
    await this.process_initial_plan(company_id, result.output);
  }

  async escalate_planning_failure(company_id: string, reason: string): Promise<void> {
    if (!this.task_manager.get_company(company_id)) {
      return;
    }
    const attempts = this.db.get<{planning_failures: number}>('SELECT planning_failures FROM companies WHERE id = ?', [company_id])?.planning_failures ?? 0;
    console.log(`[scheduler] escalate_planning_failure: company=${company_id}, attempts=${attempts}, reason=${reason}`);
    if (attempts < 3) {
      await this.retry_planning(company_id, [reason]);
      return;
    }
    this.db.run(`UPDATE companies SET state = 'failed', updated_at = ? WHERE id = ?`, [isoNow(), company_id]);
    this.db.enqueue_sync("companies", company_id, "upsert", { state: "failed", updated_at: isoNow() });
    await this.insert_ceo_message_internal(
      company_id,
      `I couldn't create a valid initial plan after ${attempts} attempts. The founder needs to provide clearer goals before we can proceed.`,
      undefined,
      true,
    );
  }

  async schedule(company_id: string): Promise<void> {
    const company = this.task_manager.get_company(company_id);
    if (!company) {
      return;
    }

    if (company.state === "planning") {
      const milestone_count = this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM milestones WHERE company_id = ?`,
        [company_id],
      )?.count ?? 0;
      const real_milestone_count = this.db.get<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM milestones
          WHERE company_id = ?
            AND id NOT LIKE 'milestone_bootstrap_%'
            AND id NOT LIKE 'bootstrap-milestone-%'
            AND title NOT IN ('Bootstrap', 'Imported milestone')
        `,
        [company_id],
      )?.count ?? 0;
      const task_count = this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM tasks WHERE company_id = ?`,
        [company_id],
      )?.count ?? 0;

      if (task_count === 0 && real_milestone_count === 0 && !this.is_any_ceo_turn_active(company_id)) {
        if (milestone_count > 0) {
          this.db.run(
            `
              UPDATE milestones
              SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
              WHERE company_id = ?
                AND (
                  id LIKE 'milestone_bootstrap_%'
                  OR id LIKE 'bootstrap-milestone-%'
                  OR title IN ('Bootstrap', 'Imported milestone')
                )
            `,
            [isoNow(), company_id],
          );
        }
        await this.start_planning(company);
      }
      return;
    }

    if (company.state !== "running") {
      return;
    }

    this.activate_pending_milestone_tasks(company_id);

    const schedulable_tasks = this.db.all<TaskRow>(
      `
        SELECT t.*
        FROM tasks t
        LEFT JOIN agents a ON t.owner_agent_id = a.id
        LEFT JOIN milestones m ON t.milestone_id = m.id
        WHERE t.company_id = ?
          AND (
            t.status = 'ready'
            OR (t.status = 'in_progress' AND a.status = 'idle')
          )
        ORDER BY m.sort_order ASC, t.created_at ASC
      `,
      [company_id],
    );

    const dispatched_agent_ids = new Set<string>();

    for (const task of schedulable_tasks) {
      if (!task.owner_agent_id) {
        this.db.run(
          `UPDATE tasks SET status = 'blocked', blocked_reason = ? WHERE id = ?`,
          ["No agent assigned", task.id],
        );
        this.db.enqueue_sync("tasks", task.id, "upsert", {
          status: "blocked",
          blocked_reason: "No agent assigned",
        });
        void this.notify_ceo(company_id, "no_agent_assigned", {
          task_id: task.id,
          task_title: task.title,
        });
        continue;
      }

      const agent = this.task_manager.get_agent(task.owner_agent_id);
      if (!agent) {
        this.db.run(
          `UPDATE tasks SET status = 'blocked', blocked_reason = ? WHERE id = ?`,
          ["No agent assigned", task.id],
        );
        this.db.enqueue_sync("tasks", task.id, "upsert", {
          status: "blocked",
          blocked_reason: "No agent assigned",
        });
        void this.notify_ceo(company_id, "no_agent_assigned", {
          task_id: task.id,
          task_title: task.title,
        });
        continue;
      }

      if (agent.status === "working") {
        continue;
      }

      if (agent.status === "paused") {
        continue;
      }

      if (dispatched_agent_ids.has(agent.id)) {
        continue;
      }

      // Only pause when the real balance is zero (credits actually spent).
      // If credits are just temporarily held by other companies' reservations,
      // skip this tick — they'll free up when those turns settle.
      const total_balance = this.credit_manager.get_total_balance(company.user_id);
      if (total_balance <= 0) {
        await this.pause_company(company_id);
        return;
      }
      const available = this.credit_manager.get_balance(company.user_id);
      if (available <= 0) {
        break;
      }

      dispatched_agent_ids.add(agent.id);
      void this.runner.wake_agent(agent, task).then(
        () => {
          // Success: reset infrastructure failure count for this company
          this.infra_failure_counts.delete(company_id);
        },
        async (err) => {
          console.error(`[scheduler] wake_agent failed for agent ${agent.id} on task ${task.id}:`, err);
          // Track infrastructure failures (EACCES, ENOENT) for backoff-based auto-pause
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "EACCES" || code === "ENOENT") {
            const count = (this.infra_failure_counts.get(company_id) ?? 0) + 1;
            this.infra_failure_counts.set(company_id, count);
            if (count >= 3) {
              console.warn(
                `[scheduler] Company ${company_id} auto-paused: ${count} consecutive infrastructure failures (${code})`,
              );
              this.infra_failure_counts.delete(company_id);
              await this.pause_company_missing_workspace(company_id);
            }
          }
        },
      );
    }

    await this.maybe_check_stalls(company_id);
    await this.cron?.schedule_cron_tasks(company_id);
  }

  async on_task_completed(task_id: string): Promise<void> {
    const task = this.task_manager.get_task(task_id);
    if (!task) return;
    const company = this.require_company(task.company_id);
    if (!company.workspace_dir) {
      throw new Error(`Company ${company.id} has no workspace_dir`);
    }

    const criteria = parse_json_array<AcceptanceCriterion>(task.acceptance_criteria);
    const results = this.task_manager.validate_criteria(criteria, company.workspace_dir);
    const all_pass = results.every((result) => result.passed);

    if (all_pass) {
      this.db.run(
        `
          UPDATE tasks
          SET status = 'done',
              completed_at = ?
          WHERE id = ?
        `,
        [isoNow(), task_id],
      );
      if (task.owner_agent_id) {
        this.db.run(
          `
            UPDATE agents
            SET status = 'idle',
                current_task_id = NULL
            WHERE id = ?
          `,
          [task.owner_agent_id],
        );
        this.db.enqueue_sync("agents", task.owner_agent_id, "upsert", {
          status: "idle",
          current_task_id: null,
        });
      }
      this.db.enqueue_sync("tasks", task_id, "upsert", {
        status: "done",
        completed_at: isoNow(),
      });

      this.task_manager.resolve_all_dependencies(task.company_id);

      const remaining = this.db.get<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE milestone_id = ?
            AND status NOT IN ('done', 'cancelled')
        `,
        [task.milestone_id],
      )?.count ?? 0;

      if (remaining === 0) {
        this.db.run(
          `
            UPDATE milestones
            SET status = 'done',
                completed_at = ?
            WHERE id = ?
          `,
          [isoNow(), task.milestone_id],
        );
        this.db.enqueue_sync("milestones", task.milestone_id, "upsert", {
          status: "done",
          completed_at: isoNow(),
        });
        await this.advance_to_next_milestone(task.company_id);
      }

      await this.schedule(task.company_id);

      // Auto-deploy if workspace has servable content
      if (this.deploy_manager) {
        void this.deploy_manager.maybe_deploy(company).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[deploy] Auto-deploy failed for ${company.id}: ${msg}`);
        });
      }

      return;
    }

    const failures = results.filter((result) => !result.passed);
    const agent = task.owner_agent_id ? this.task_manager.get_agent(task.owner_agent_id) : undefined;
    if (!agent) return;
    const feedback_prompt = [
      "# Acceptance Criteria Not Met",
      "",
      "You declared this task done, but the following checks failed:",
      "",
      ...failures.map(
        (failure) => `- ${failure.reason ?? "check failed"} — ${JSON.stringify(failure.criterion)}`,
      ),
      "",
      "Fix these issues. The system will re-check the acceptance criteria after your next turn.",
    ].join("\n");
    // wake_agent handles the idle→working transition internally;
    // set idle first so its guard check passes, then await to prevent
    // the scheduler from assigning a different task to this agent concurrently.
    this.db.run(`UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`, [agent.id]);
    this.db.enqueue_sync("agents", agent.id, "upsert", { status: "idle", current_task_id: null });
    await this.runner.wake_agent(agent, task, feedback_prompt);
  }

  async advance_to_next_milestone(company_id: string): Promise<void> {
    const current = this.db.get<MilestoneRow>(
      `SELECT * FROM milestones WHERE company_id = ? AND status = 'active' ORDER BY sort_order ASC LIMIT 1`,
      [company_id],
    );
    const next = this.db.get<MilestoneRow>(
      `SELECT * FROM milestones WHERE company_id = ? AND status = 'pending' ORDER BY sort_order ASC LIMIT 1`,
      [company_id],
    );

    if (next) {
      this.db.run(`UPDATE milestones SET status = 'active' WHERE id = ?`, [next.id]);
      this.db.enqueue_sync("milestones", next.id, "upsert", { status: "active" });
      await this.activate_milestone_tasks(company_id, next.id);
      await this.notify_ceo(company_id, "milestone_review", {
        completed_milestone_id: current?.id ?? null,
        next_milestone_id: next.id,
      });
      return;
    }

    // Check for other active milestones that still have non-terminal tasks.
    // activate_pending_milestone_tasks() sets ALL pending milestones to 'active' so agents
    // can work concurrently. This means the pending query above finds nothing even though
    // other milestones still have in-progress/ready/pending tasks. We must check for those
    // before declaring all work complete.
    const active_milestones_with_work = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM milestones
       WHERE company_id = ? AND status = 'active'
       AND id != ?
       AND id IN (SELECT DISTINCT milestone_id FROM tasks WHERE status NOT IN ('done', 'cancelled'))`,
      [company_id, current?.id ?? ""],
    )?.count ?? 0;
    if (active_milestones_with_work > 0) {
      console.log(`[scheduler] Milestone complete for ${company_id}, but ${active_milestones_with_work} other active milestone(s) still have work`);
      return;
    }

    // All milestones complete — stop auto-continuation to prevent infinite work generation.
    // Instead of invoking a heavy CEO continuation planning turn (which in autonomous mode
    // immediately creates NEW milestones/tasks, causing an infinite loop), send a completion
    // message and set mode to 'manual' so the founder must explicitly request more work.
    // Dedup: skip if already sent a completion message recently.
    const recentContinuation = this.db.get<{ id: string }>(
      `SELECT id FROM messages WHERE company_id = ? AND role = 'ceo'
       AND content LIKE '%milestones%complete%'
       AND created_at > datetime('now', '-30 minutes')
       ORDER BY created_at DESC LIMIT 1`,
      [company_id],
    );
    if (recentContinuation) return;

    const ceo = this.task_manager.get_ceo(company_id);

    // Set company mode to 'manual' to stop any autonomous continuation
    this.db.run(`UPDATE companies SET mode = 'manual', updated_at = ? WHERE id = ?`, [isoNow(), company_id]);
    this.db.enqueue_sync("companies", company_id, "upsert", { mode: "manual", updated_at: isoNow() });
    console.log(`[scheduler] All milestones complete for ${company_id}, switching to manual mode`);

    await this.insert_ceo_message_internal(
      company_id,
      "All planned milestones are complete. Send me a message if you'd like to plan more work.",
      ceo.id,
      true,
    );
  }

  private async handle_continuation_plan(
    company_id: string,
    result: AgentTurnResult,
  ): Promise<void> {
    const company = this.require_company(company_id);
    const ceo = this.task_manager.get_ceo(company_id);
    const workspace = this.get_workspace_dir(company_id);
    const update_path = join(workspace, ".agent", "plan_update.json");

    if (!existsSync(update_path)) {
      await this.insert_ceo_message_internal(
        company_id,
        "All milestones are complete! I've reviewed the work but couldn't determine clear next steps. Let me know what you'd like to focus on next.",
        ceo.id,
        true,
      );
      return;
    }

    const mode = company.mode ?? "autonomous";

    if (mode === "autonomous") {
      // Apply immediately
      await this.process_ceo_response(company_id, result, false);
      await this.insert_ceo_message_internal(
        company_id,
        "All milestones complete. I've planned the next phase and the team is already working on it.",
        ceo.id,
        true,
      );
    } else {
      // Manual mode: store the plan, present to user, wait for feedback or 8am deadline
      const raw = readFileSync(update_path, "utf8");
      const holding_path = join(workspace, ".agent", "pending_continuation_plan.json");
      writeFileSync(holding_path, raw);
      rmSync(update_path, { force: true });

      const summary = this.summarize_plan_for_founder(raw);

      await this.insert_ceo_message_internal(
        company_id,
        `All milestones complete! Here's my proposed next phase:\n\n${summary}\n\nReply with feedback or adjustments. If I don't hear back by 8am tomorrow, I'll start executing this plan automatically.`,
        ceo.id,
        true,
      );

      // Email the continuation plan to the founder
      this.send_founder_email(company_id, ceo.id, `${company.name} — Next Phase Plan Ready`, `${summary}\n\nReply with feedback or adjustments. If I don't hear back by 8am tomorrow, I'll start executing this plan automatically.`);
    }
  }

  private summarize_plan_for_founder(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as { add_milestones?: Array<{ title: string; tasks?: unknown[] }> };
      const milestones = parsed.add_milestones ?? [];
      if (milestones.length === 0) return "A continuation plan has been prepared.";
      const lines = milestones.map((m) => `- **${m.title}** (${m.tasks?.length ?? 0} tasks)`);
      return `**Proposed milestones:**\n${lines.join("\n")}`;
    } catch {
      return "A continuation plan has been prepared.";
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
      console.error(`[scheduler] Failed to email founder for ${company_id}: ${msg}`);
    });
  }

  async activate_milestone_tasks(company_id: string, milestone_id: string): Promise<void> {
    this.db.run(
      `
        UPDATE tasks
        SET status = 'ready'
        WHERE milestone_id = ?
          AND depends_on = '[]'
          AND status = 'pending'
      `,
      [milestone_id],
    );
    const tasks = this.db.all<TaskRow>(
      `SELECT * FROM tasks WHERE milestone_id = ? AND depends_on = '[]' AND status = 'ready'`,
      [milestone_id],
    );
    for (const task of tasks) {
      this.db.enqueue_sync("tasks", task.id, "upsert", task);
    }
    await this.schedule(company_id);
  }

  activate_pending_milestone_tasks(company_id: string): void {
    const bootstrap_milestone_id = `bootstrap-milestone-${company_id}`;
    const placeholder = this.db.get<MilestoneRow>(
      `
        SELECT *
        FROM milestones
        WHERE company_id = ?
          AND status = 'active'
          AND (id = ? OR title = 'Imported milestone')
        ORDER BY sort_order ASC
        LIMIT 1
      `,
      [company_id, bootstrap_milestone_id],
    );

    if (placeholder) {
      const placeholder_open_tasks = this.db.get<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE milestone_id = ?
            AND status NOT IN ('done', 'cancelled')
        `,
        [placeholder.id],
      )?.count ?? 0;
      const next_real_milestone = this.db.get<MilestoneRow>(
        `
          SELECT *
          FROM milestones
          WHERE company_id = ?
            AND status = 'pending'
            AND id != ?
          ORDER BY sort_order ASC, created_at ASC
          LIMIT 1
        `,
        [company_id, placeholder.id],
      );

      if (placeholder_open_tasks === 0 && next_real_milestone) {
        const completed_at = isoNow();
        this.db.run(
          `UPDATE milestones SET status = 'done', completed_at = ? WHERE id = ?`,
          [completed_at, placeholder.id],
        );
        this.db.enqueue_sync("milestones", placeholder.id, "upsert", {
          status: "done",
          completed_at,
        });
      }
    }

    // Activate ALL pending milestones so agents can work across milestones concurrently.
    // Task-level depends_on still enforces ordering where it matters; milestone sort_order
    // determines dispatch priority in the schedule loop.
    const pending_milestones = this.db.all<MilestoneRow>(
      `
        SELECT *
        FROM milestones
        WHERE company_id = ?
          AND status = 'pending'
        ORDER BY sort_order ASC, created_at ASC
      `,
      [company_id],
    );
    for (const milestone of pending_milestones) {
      this.db.run(`UPDATE milestones SET status = 'active' WHERE id = ?`, [milestone.id]);
      this.db.enqueue_sync("milestones", milestone.id, "upsert", { status: "active" });
    }

    const active_milestones = this.db.all<Pick<MilestoneRow, "id">>(
      `SELECT id FROM milestones WHERE company_id = ? AND status IN ('active', 'done')`,
      [company_id],
    );
    for (const milestone of active_milestones) {
      this.db.run(
        `
          UPDATE tasks
          SET status = 'ready'
          WHERE milestone_id = ?
            AND depends_on = '[]'
            AND status = 'pending'
        `,
        [milestone.id],
      );
      const tasks = this.db.all<TaskRow>(
        `SELECT * FROM tasks WHERE milestone_id = ? AND depends_on = '[]' AND status = 'ready'`,
        [milestone.id],
      );
      for (const task of tasks) {
        this.db.enqueue_sync("tasks", task.id, "upsert", task);
      }
    }

    // Auto-complete active milestones that have zero non-terminal tasks.
    // This handles milestones created with no tasks (or all tasks already done/cancelled),
    // which would otherwise sit in 'active' state forever since on_task_completed never fires.
    const active_milestones_to_check = this.db.all<Pick<MilestoneRow, "id">>(
      `SELECT id FROM milestones WHERE company_id = ? AND status = 'active'`,
      [company_id],
    );
    for (const milestone of active_milestones_to_check) {
      const open_tasks = this.db.get<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE milestone_id = ?
            AND status NOT IN ('done', 'cancelled')
        `,
        [milestone.id],
      )?.count ?? 0;
      if (open_tasks === 0) {
        // Only auto-complete if there's at least one done task (or zero tasks total).
        // A milestone with only cancelled tasks should stay active so the CEO can
        // add new tasks to it instead of entering a cancel/recreate loop.
        const done_count = this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM tasks WHERE milestone_id = ? AND status = 'done'`,
          [milestone.id],
        )?.count ?? 0;
        const total_count = this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM tasks WHERE milestone_id = ?`,
          [milestone.id],
        )?.count ?? 0;
        if (total_count === 0 || done_count > 0) {
          const completed_at = isoNow();
          this.db.run(
            `UPDATE milestones SET status = 'done', completed_at = ? WHERE id = ?`,
            [completed_at, milestone.id],
          );
          this.db.enqueue_sync("milestones", milestone.id, "upsert", {
            status: "done",
            completed_at,
          });
          console.log(`[scheduler] Auto-completed empty milestone ${milestone.id} (zero non-terminal tasks)`);
        }
      }
    }
  }

  async invoke_ceo_turn(
    company_id: string,
    ceo: AgentRow,
    prompt: string,
    options: InvokeCeoOptions = {},
  ): Promise<AgentTurnResult> {
    const turn_key = this.ceo_turn_key(company_id, Boolean(options.is_user_facing));
    if (this.active_ceo_turns.has(turn_key)) {
      console.warn(`[scheduler] Skipping CEO turn for ${company_id} (${options.is_user_facing ? "user" : "system"}) — already in progress`);
      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: "CEO turn already in progress",
        aborted: false,
        toolCallCount: 0,
        durationMs: 0,
      };
    }
    // Per-hour CEO turn rate limit: prevent runaway CEO loops.
    // User-facing turns (responses to founder messages) always bypass this check.
    if (!options.is_user_facing) {
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recentCeoTurns = this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM messages WHERE company_id = ? AND role = 'ceo' AND created_at > ?`,
        [company_id, cutoff],
      )?.count ?? 0;
      if (recentCeoTurns >= Scheduler.CEO_MAX_TURNS_PER_HOUR) {
        console.warn(
          `[scheduler] CEO turn rate limited for ${company_id}: ${recentCeoTurns} turns in the past hour (limit: ${Scheduler.CEO_MAX_TURNS_PER_HOUR})`,
        );
        return {
          success: false,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          error: `CEO turn rate limited: ${recentCeoTurns} turns in the past hour exceeds limit of ${Scheduler.CEO_MAX_TURNS_PER_HOUR}`,
          aborted: false,
          toolCallCount: 0,
          durationMs: 0,
        };
      }
    }
    const company = this.require_company(company_id);
    if (!company.workspace_dir) {
      throw new Error(`Company ${company_id} has no workspace_dir`);
    }
    if (!existsSync(company.workspace_dir)) {
      console.error(`[scheduler] Workspace missing for company ${company_id}: ${company.workspace_dir}`);
      await this.pause_company_missing_workspace(company_id);
      return {
        success: false,
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: "Workspace missing",
        aborted: false,
        toolCallCount: 0,
        durationMs: 0,
      };
    }
    if (options.bill_credits !== false) {
      const base_turn_limits = {
        ...this.invoker.getTurnLimits(ceo),
        ...(options.turn_limits_override ?? {}),
      };
      const available_credits = this.credit_manager.get_balance(company.user_id);
      const turn_limits = fit_turn_limits_to_available_credits(ceo.model_tier, base_turn_limits, available_credits);
      const reserved_credits = calculate_turn_credit_reservation(ceo.model_tier, turn_limits);
      if (!this.credit_manager.reserve_credits(company.user_id, reserved_credits, company.id)) {
        const total_balance = this.credit_manager.get_total_balance(company.user_id);
        if (total_balance <= 0) {
          await this.pause_company(company_id);
        } else {
          console.warn(
            `[scheduler] Deferring CEO turn for ${company_id}: ${reserved_credits} credits unavailable right now (total=${total_balance}, available=${this.credit_manager.get_balance(company.user_id)})`,
          );
        }
        return {
          success: false,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          error: total_balance <= 0 ? "Credits exhausted" : "Credits temporarily reserved by another active turn",
          aborted: total_balance <= 0,
          toolCallCount: 0,
          durationMs: 0,
        };
      }
      try {
        return await this.invoke_ceo_turn_reserved(company, ceo, prompt, options, reserved_credits, turn_limits);
      } catch (error) {
        this.credit_manager.release_reserved_credits(company.user_id, reserved_credits, company.id);
        throw error;
      }
    }

    return this.invoke_ceo_turn_reserved(
      company,
      ceo,
      prompt,
      options,
      0,
      {
        ...this.invoker.getTurnLimits(ceo),
        ...(options.turn_limits_override ?? {}),
      },
    );
  }

  private async invoke_ceo_turn_reserved(
    company: CompanyRow,
    ceo: AgentRow,
    prompt: string,
    options: InvokeCeoOptions,
    reserved_credits: number,
    turn_limits = this.invoker.getTurnLimits(ceo),
  ): Promise<AgentTurnResult> {
    const company_id = company.id;
    if (!company.workspace_dir) {
      throw new Error(`Company ${company_id} has no workspace_dir`);
    }

    const full_prompt = prompt.startsWith("Current date:")
      ? prompt
      : `${build_ceo_date_header(company)}\n\n${prompt}`;

    const turn_key = this.ceo_turn_key(company_id, Boolean(options.is_user_facing));
    const owns_turn_lock = !this.active_ceo_turns.has(turn_key);
    if (owns_turn_lock) {
      this.active_ceo_turns.add(turn_key);
    }
    const ceo_wake_at = isoNow();
    this.db.run(`UPDATE agents SET status = 'working', last_wake_at = ? WHERE id = ?`, [ceo_wake_at, ceo.id]);
    this.db.enqueue_sync("agents", ceo.id, "upsert", { status: "working", last_wake_at: ceo_wake_at });
    const abort_controller = new AbortController();
    const original_abort = abort_controller.abort.bind(abort_controller);
    abort_controller.abort = (...args: Parameters<typeof original_abort>) => {
      console.error(`[scheduler] CEO abort triggered for ${company_id}`, new Error("abort trace").stack);
      return original_abort(...args);
    };
    if (owns_turn_lock) {
      this.active_ceo_abort_controllers.set(turn_key, abort_controller);
    }
    let turnResult: AgentTurnResult | undefined;
    try {
      const invokerSessionKey = options.is_user_facing ? `${ceo.id}:founder-chat` : ceo.id;
      const result = await this.invoker.invoke(ceo, full_prompt, company.workspace_dir, {
        systemPromptOverride:
          options.system_prompt_override
          ?? build_system_prompt(ceo, company, this.runner.get_telemetry_rows(company_id)),
        abortController: abort_controller,
        turnLimits: turn_limits,
        sessionKey: invokerSessionKey,
        onTextDelta: options.onTextDelta,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      });

      const company_paused = this.task_manager.get_company(company_id)?.state === "paused";
      const credits = options.bill_credits === false || company_paused
        ? 0
        : calculate_turn_credits(ceo.model_tier, result.tokenUsage);
      const charged_credits = options.bill_credits === false
        ? 0
        : this.credit_manager.settle_reserved_credits(
          company.user_id,
          reserved_credits,
          credits,
          {
            company_id,
            agent_id: ceo.id,
            model_tier: ceo.model_tier,
            description: "CEO coordination",
          },
        );
      const output_summary = extract_summary(result.output, "CEO coordination");
      this.db.run(
        `
          INSERT INTO turn_log (
            company_id, agent_id, task_id, input_tokens, output_tokens, credits_spent,
            tool_call_count, artifact_changed, agent_declared_done, output_summary,
            error, duration_ms, created_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
        `,
        [
          company_id,
          ceo.id,
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

      const agentSessionId = options.is_user_facing ? ceo.session_id : (result.sessionId ?? ceo.session_id);
      this.db.run(
        `UPDATE agents SET total_credits = total_credits + ?, session_id = COALESCE(?, session_id) WHERE id = ?`,
        [charged_credits, options.is_user_facing ? null : (result.sessionId ?? null), ceo.id],
      );
      this.invoker.recordSessionCredits(ceo.id, charged_credits);
      this.db.enqueue_sync("turn_log", String(turn_log_id), "upsert", {
        company_id,
        agent_id: ceo.id,
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
      this.db.enqueue_sync("agents", ceo.id, "upsert", {
        status: "working",
        total_credits: (this.task_manager.get_agent(ceo.id)?.total_credits ?? ceo.total_credits) + charged_credits,
        session_id: agentSessionId,
      });

      if (company_paused) {
        return result;
      }

      if (!options.skip_response_processing && this.require_company(company_id).state !== "planning") {
        await this.process_ceo_response(company_id, result, Boolean(options.is_user_facing), options.event_type);
      }

      await this.check_ceo_signals(company_id, ceo, result, Boolean(options.is_user_facing));
      turnResult = result;
    } finally {
      if (owns_turn_lock) {
        // Only reset CEO status to idle if no other CEO turn type is active
        const other_key = this.ceo_turn_key(company_id, !Boolean(options.is_user_facing));
        const other_turn_active = this.active_ceo_turns.has(other_key);
        if (!other_turn_active) {
          const currentCompany = this.task_manager.get_company(company_id);
          const nextStatus = currentCompany?.state === "paused" ? "paused" : "idle";
          const ceo_sleep_at = isoNow();
          this.db.run(`UPDATE agents SET status = ?, last_sleep_at = ? WHERE id = ?`, [nextStatus, ceo_sleep_at, ceo.id]);
          this.db.enqueue_sync("agents", ceo.id, "upsert", { status: nextStatus, last_sleep_at: ceo_sleep_at });
        }
        this.active_ceo_turns.delete(turn_key);
        this.active_ceo_abort_controllers.delete(turn_key);
      }
    }
    // drain_ceo_event_queue MUST run after the finally block releases the turn lock,
    // otherwise events get marked delivered=1 but the inner invoke_ceo_turn is skipped
    // by the active_ceo_turns guard, silently losing events.
    if (owns_turn_lock && !options.is_user_facing) {
      await this.drain_ceo_event_queue(company_id);
    }
    // For user-facing turns, schedule a deferred drain so the user gets their
    // response immediately but queued system events (task_failed, task_blocked, etc.)
    // are still processed shortly after. The system-turn check is INSIDE the callback
    // so it evaluates at execution time — if a system turn started between scheduling
    // and execution, the drain is skipped (the system turn will drain when it finishes).
    if (owns_turn_lock && options.is_user_facing) {
      setTimeout(() => {
        const systemTurnKey = this.ceo_turn_key(company_id, false);
        if (this.active_ceo_turns.has(systemTurnKey)) {
          return; // system turn will drain when it finishes
        }
        this.drain_ceo_event_queue(company_id).catch((err) => {
          console.error(`[scheduler] Deferred CEO event drain failed for ${company_id}:`, err);
        });
      }, 0);
    }
    return turnResult!;
  }

  async check_ceo_signals(company_id: string, ceo: AgentRow, result?: AgentTurnResult, is_user_facing = false): Promise<void> {
    const workspace = this.get_workspace_dir(company_id);
    const approval_path = join(workspace, ".agent", "approval_request.json");
    if (existsSync(approval_path)) {
      const raw = parse_json<ApprovalRequestPayload | ApprovalRequestPayload[]>(readFileSync(approval_path, "utf8"));
      rmSync(approval_path, { force: true });

      const requests = Array.isArray(raw) ? raw : [raw];
      for (const request of requests) {
        await this.create_approval(company_id, ceo, request);
      }

      if (result?.output && !is_user_facing) {
        await this.insert_ceo_message_internal(company_id, result.output, ceo.id, true);
      }
    }

    // Check for automation creation requests from the CEO
    const automation_path = join(workspace, ".agent", "create_automation_request.json");
    if (existsSync(automation_path)) {
      const raw_automation = parse_json<AutomationRequestPayload | AutomationRequestPayload[]>(
        readFileSync(automation_path, "utf8"),
      );
      rmSync(automation_path, { force: true });

      const automation_requests = Array.isArray(raw_automation) ? raw_automation : [raw_automation];
      for (const req of automation_requests) {
        this.create_automation(company_id, ceo, req);
      }
    }
  }

  private async create_approval(
    company_id: string,
    ceo: AgentRow,
    request: ApprovalRequestPayload,
  ): Promise<void> {
    // Auto-infer related_task_id if the CEO didn't provide one
    let related_task_id = request.related_task_id ?? null;
    if (!related_task_id && ceo.current_task_id) {
      related_task_id = ceo.current_task_id;
    }

    const approval_id = this.generate_id("approval");
    const approval: ApprovalRow = {
      id: approval_id,
      company_id,
      type: request.type,
      description: request.description,
      related_task_id,
      status: "pending",
      resolved_at: null,
      created_at: isoNow(),
    };
    this.db.run(
      `
        INSERT INTO approvals (id, company_id, type, description, related_task_id, status, resolved_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        approval.id,
        approval.company_id,
        approval.type,
        approval.description,
        approval.related_task_id,
        approval.status,
        approval.resolved_at,
        approval.created_at,
      ],
    );
    this.db.enqueue_sync("approvals", approval.id, "upsert", approval);

    // Auto-block the related task so the dashboard shows the approval inline
    if (approval.related_task_id) {
      const task = this.task_manager.get_task(approval.related_task_id);
      if (task && task.status !== "done" && task.status !== "cancelled" && task.status !== "failed") {
        this.db.run(
          `UPDATE tasks SET status = 'blocked', blocked_reason = ? WHERE id = ?`,
          [`Waiting on founder: ${approval.description.slice(0, 120)}`, task.id],
        );
        this.db.enqueue_sync("tasks", task.id, "upsert", {
          status: "blocked",
          blocked_reason: `Waiting on founder: ${approval.description.slice(0, 120)}`,
        });
      }
    }

  }

  private create_automation(
    company_id: string,
    ceo: AgentRow,
    request: AutomationRequestPayload,
  ): void {
    const title = request.title?.trim();
    const schedule = request.schedule?.trim();
    const prompt = request.prompt?.trim();
    if (!title || !schedule || !prompt) {
      console.warn(`[scheduler] Skipping automation creation: missing title, schedule, or prompt`);
      return;
    }
    const description = request.description?.trim() ?? null;
    const id = `automation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = isoNow();

    this.db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, title, description, schedule, prompt, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [id, company_id, ceo.id, title, description, schedule, prompt, ceo.id, now],
    );

    this.db.enqueue_sync("cron_tasks", id, "upsert", {
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

    console.log(`[scheduler] Created automation "${title}" (${id}) for company ${company_id}`);
  }

  /**
   * Process CEO response after a turn completes.
   * Returns true if plan_update.json was found and processed, false otherwise.
   */
  async process_ceo_response(
    company_id: string,
    result: AgentTurnResult,
    is_user_facing = false,
    event_type?: string,
  ): Promise<boolean> {
    const ceo = this.task_manager.get_ceo(company_id);
    const workspace = this.get_workspace_dir(company_id);
    const update_path = join(workspace, ".agent", "plan_update.json");

    // For user-facing turns, the reply is returned via the HTTP response
    // and stored as a founder_chat entry by the worker. Do NOT insert a
    // separate ceo_notice here — that creates duplicate messages in the chat.
    // Only insert for non-user-facing turns where we want a proactive notice.

    // Skip document budget checks when the turn was triggered by a document_revision
    // event to prevent infinite revision loops, or when there's no active work.
    const skip_doc_budgets = event_type === "document_revision" || !this.task_manager.has_active_work(company_id);

    if (!existsSync(update_path)) {
      this.last_ceo_response_had_plan_update.set(company_id, false);
      this.activate_pending_milestone_tasks(company_id);
      await this.schedule(company_id);
      if (!skip_doc_budgets) this.runner.check_document_budgets(company_id);
      return false;
    }

    this.last_ceo_response_had_plan_update.set(company_id, true);

    const parsed = parse_json_with_error<PlanUpdateDocument>(readFileSync(update_path, "utf8"));
    rmSync(update_path, { force: true });
    if (!parsed.ok) {
      await this.notify_ceo(company_id, "task_failed", {
        task_id: "ceo_plan_update",
        task_title: "CEO plan update",
        reason: `plan_update.json is invalid JSON: ${parsed.message}`,
      });
      this.activate_pending_milestone_tasks(company_id);
      await this.schedule(company_id);
      if (!skip_doc_budgets) this.runner.check_document_budgets(company_id);
      return true;
    }
    const update = parsed.value;
    try {
      await this.apply_plan_update(company_id, update);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plan-update] Failed to apply plan update for ${company_id}: ${msg}`);
    }
    this.activate_pending_milestone_tasks(company_id);
    await this.schedule(company_id);
    if (!skip_doc_budgets) this.runner.check_document_budgets(company_id);
    return true;
  }

  async apply_plan_update(company_id: string, update: PlanUpdateDocument): Promise<void> {
    const ceo = this.task_manager.get_ceo(company_id);
    const company = this.require_company(company_id);

    if (update.goal) {
      this.db.run(`UPDATE companies SET goal = ?, updated_at = ? WHERE id = ?`, [
        update.goal,
        isoNow(),
        company_id,
      ]);
      this.db.enqueue_sync("companies", company_id, "upsert", {
        goal: update.goal,
        updated_at: isoNow(),
      });
    }

    if (update.cancel_tasks) {
      for (const task_id of update.cancel_tasks) {
        this.cancel_task(task_id);
      }
    }

    if (update.cancel_milestones) {
      for (const milestone_id of update.cancel_milestones) {
        this.db.run(`UPDATE milestones SET status = 'cancelled' WHERE id = ?`, [milestone_id]);
        this.db.enqueue_sync("milestones", milestone_id, "upsert", { status: "cancelled" });
        const tasks_to_cancel = this.db.all<Pick<TaskRow, "id">>(
          `SELECT id FROM tasks WHERE milestone_id = ? AND status NOT IN ('done', 'cancelled')`,
          [milestone_id],
        );
        for (const task of tasks_to_cancel) {
          this.cancel_task(task.id);
        }
      }
    }

    const new_task_ids = new Map<string, string>();

    if (update.add_milestones) {
      const max_order = this.db.get<{ max_order: number | null }>(
        `SELECT MAX(sort_order) AS max_order FROM milestones WHERE company_id = ?`,
        [company_id],
      )?.max_order ?? -1;
      update.add_milestones.forEach((milestone, index) => {
        try {
          const milestone_id = this.generate_id("milestone");
          this.db.run(
            `
              INSERT INTO milestones (
                id, company_id, title, description, sort_order, status, created_by, created_at, completed_at
              ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
            `,
            [
              milestone_id,
              company_id,
              milestone.title,
              milestone.description,
              max_order + 1 + index,
              ceo.id,
              isoNow(),
            ],
          );
          this.db.enqueue_sync("milestones", milestone_id, "upsert", this.task_manager.get_milestone(milestone_id));
          const task_ids = this.task_manager.insert_milestone_tasks(
            company_id,
            milestone_id,
            milestone.tasks,
            ceo.id,
          );
          milestone.tasks.forEach((task_def, task_index) => {
            const id = task_ids[task_index];
            if (id) {
              new_task_ids.set(task_temp_reference(task_def.title), id);
            }
          });

          // Auto-complete milestones created with zero tasks
          if (milestone.tasks.length === 0) {
            const completed_at = isoNow();
            this.db.run(
              `UPDATE milestones SET status = 'done', completed_at = ? WHERE id = ?`,
              [completed_at, milestone_id],
            );
            this.db.enqueue_sync("milestones", milestone_id, "upsert", {
              status: "done",
              completed_at,
            });
            console.log(`[scheduler] Auto-completed empty milestone ${milestone_id} at creation (zero tasks)`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[plan-update] Skipping milestone "${milestone.title}": ${msg}`);
        }
      });
    }

    // Lazily created continuation milestone for orphan tasks (no milestone_id, no active/done milestones)
    let continuation_milestone_id: string | null = null;

    if (update.add_tasks) {
      for (const task_def of update.add_tasks) {
        try {
          let milestone_id = task_def.milestone_id ?? this.get_active_milestone_id(company_id);
          if (!milestone_id) {
            // Instead of silently dropping the task, auto-create a continuation milestone
            if (!continuation_milestone_id) {
              const max_order = this.db.get<{ max_order: number | null }>(
                `SELECT MAX(sort_order) AS max_order FROM milestones WHERE company_id = ?`,
                [company_id],
              )?.max_order ?? -1;
              continuation_milestone_id = this.generate_id("milestone");
              this.db.run(
                `INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by, created_at, completed_at)
                 VALUES (?, ?, 'Continuation', 'Auto-created milestone for tasks without a target milestone', ?, 'active', ?, ?, NULL)`,
                [continuation_milestone_id, company_id, max_order + 1, ceo.id, isoNow()],
              );
              this.db.enqueue_sync("milestones", continuation_milestone_id, "upsert",
                this.task_manager.get_milestone(continuation_milestone_id));
              console.log(`[plan-update] Auto-created continuation milestone for orphan tasks`);
            }
            milestone_id = continuation_milestone_id;
          }
          const inserted = this.task_manager.validate_and_insert_task(company_id, task_def, {
            milestone_id,
            created_by: ceo.id,
          });
          new_task_ids.set(task_temp_reference(task_def.title), inserted);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[plan-update] Skipping task "${task_def.title}": ${msg}`);
        }
      }
    }

    if (update.update_tasks) {
      for (const task_update of update.update_tasks) {
        const resolved_depends_on = task_update.depends_on?.map(
          (dep) => new_task_ids.get(dep) ?? dep,
        );
        this.task_manager.apply_task_update({
          ...task_update,
          depends_on: resolved_depends_on,
        });
      }
    }

    if (update.activate_agents) {
      const foundingSet = new Set<string>(FOUNDING_BLUEPRINTS);
      for (const blueprint_id of update.activate_agents) {
        if (!foundingSet.has(blueprint_id) && !isSpecialistBlueprint(blueprint_id)) {
          console.warn(`[plan-update] Blocked activation of unknown agent "${blueprint_id}" for ${company_id}`);
          continue;
        }
        this.task_manager.activate_agent(company_id, blueprint_id);
      }
    }

    if (update.deactivate_agents) {
      for (const agent_id of update.deactivate_agents) {
        this.task_manager.deactivate_agent(company_id, agent_id);
      }
    }

    this.task_manager.resolve_all_dependencies(company_id);
    this.activate_pending_milestone_tasks(company_id);
    await this.schedule(company_id);
  }

  async notify_ceo(
    company_id: string,
    event_type: CEOEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const company = this.task_manager.get_company(company_id);
    if (!company || company.state === "paused" || company.state === "failed") {
      return;
    }
    // Drop non-user events when there is no active work — prevents token burn
    // on idle companies. user_message must always go through (founder is talking).
    if (event_type !== "user_message" && !this.task_manager.has_active_work(company_id)) {
      return;
    }
    const ceo = this.task_manager.get_ceo(company_id);
    if (ceo.status === "working" || this.is_any_ceo_turn_active(company_id)) {
      this.db.run(
        `INSERT INTO ceo_event_queue (company_id, event_type, payload, delivered, created_at) VALUES (?, ?, ?, 0, ?)`,
        [company_id, event_type, JSON.stringify(payload), isoNow()],
      );
      return;
    }
    await this.deliver_ceo_event(company_id, {
      id: 0,
      company_id,
      event_type,
      payload: JSON.stringify(payload),
      delivered: 0,
      created_at: isoNow(),
    });
  }

  /**
   * Notify a manager agent (by blueprint_id) of a status event.
   * The manager is woken with a contextual prompt describing the event.
   * If the manager can't be found or isn't active, falls back to CEO.
   */
  async notify_manager(
    company_id: string,
    manager_blueprint_id: string,
    event_type: CEOEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const manager = this.task_manager.find_agent_by_blueprint(company_id, manager_blueprint_id);
    if (!manager || manager.status === "terminated") {
      // Fallback to CEO if manager doesn't exist
      await this.notify_ceo(company_id, event_type, payload);
      return;
    }

    // If manager is working, queue for CEO instead (manager will see results when done)
    if (manager.status === "working") {
      await this.notify_ceo(company_id, event_type, payload);
      return;
    }

    // Build a prompt for the manager and wake them on a lightweight task
    const company = this.task_manager.get_company(company_id);
    if (!company?.workspace_dir) {
      await this.notify_ceo(company_id, event_type, payload);
      return;
    }

    const task_title = String(payload.task_title ?? "Unknown task");
    const task_id = String(payload.task_id ?? "unknown");
    const reason = String(payload.reason ?? "Unknown");

    let prompt: string;
    if (event_type === "task_failed") {
      prompt = [
        `# Event: Task Failed (escalated to you as ${manager_blueprint_id})`,
        "",
        `Task [${task_id}] "${task_title}" failed after retries.`,
        `Error: ${reason}`,
        "",
        "You can resolve this by writing /workspace/.agent/${agent_id}/subtask_request.json to:",
        "- Create replacement subtasks with simpler requirements",
        "- Reassign the work to a different engineer",
        "",
        "Or, if you cannot resolve it, write /workspace/.agent/${agent_id}/task_blocked.json to",
        "escalate to the CEO.",
      ].join("\n");
    } else if (event_type === "task_blocked") {
      prompt = [
        `# Event: Task Blocked (escalated to you as ${manager_blueprint_id})`,
        "",
        `Task [${task_id}] "${task_title}" is blocked.`,
        `Reason: ${reason}`,
        "",
        "You can resolve this by writing /workspace/.agent/${agent_id}/subtask_request.json to:",
        "- Create prerequisite subtasks that unblock this work",
        "- Reassign the work to a different engineer",
        "",
        "Or, if you cannot resolve it, write /workspace/.agent/${agent_id}/task_blocked.json to",
        "escalate to the CEO.",
      ].join("\n");
    } else {
      // Unexpected event type for manager — fall back to CEO
      await this.notify_ceo(company_id, event_type, payload);
      return;
    }

    // Find or create a task for the manager to work on (use their current task if any)
    const manager_task = manager.current_task_id
      ? this.task_manager.get_task(manager.current_task_id)
      : undefined;

    if (manager_task) {
      void this.runner.wake_agent(manager, manager_task, prompt);
    } else {
      // No current task — notify CEO instead (manager needs a task to be woken)
      await this.notify_ceo(company_id, event_type, payload);
    }
  }

  /**
   * Process a subtask delegation request from an agent (e.g. CTO creating tasks for engineers).
   * Validates ACL, creates the task, and notifies CEO informally.
   */
  async process_subtask_request(
    company_id: string,
    sender_agent: AgentRow,
    request: SubtaskRequestPayload,
  ): Promise<void> {
    const sender_blueprint = sender_agent.blueprint_id ?? "unknown";

    // Validate ACL: can this agent assign to the target?
    if (!canAssignTo(sender_blueprint, request.assigned_to)) {
      console.warn(
        `[scheduler] ${sender_blueprint} cannot delegate to "${request.assigned_to}" — subtask blocked`,
      );
      return;
    }

    // Find active milestone for the subtask
    const milestone_id = this.get_active_milestone_id(company_id);
    if (!milestone_id) {
      console.warn(`[scheduler] No active milestone for subtask delegation in company ${company_id}`);
      return;
    }

    // Auto-add the sender's current task as a dependency if not already included.
    // This prevents QA/verification subtasks from running before the parent task completes.
    const depends_on = request.depends_on ?? [];
    if (
      sender_agent.current_task_id
      && !depends_on.includes(sender_agent.current_task_id)
      && request.parent_task_id !== sender_agent.current_task_id
    ) {
      depends_on.push(sender_agent.current_task_id);
    }

    // Create the task
    const task_def: PlanTaskInput = {
      title: request.title,
      description: request.description,
      assigned_to: request.assigned_to,
      depends_on,
      acceptance_criteria: request.acceptance_criteria,
    };

    // Use the explicit parent_task_id from the request, or fall back to the sender's current task
    const parent_task_id = request.parent_task_id ?? sender_agent.current_task_id ?? null;

    const task_id = this.task_manager.validate_and_insert_task(company_id, task_def, {
      milestone_id,
      created_by: sender_agent.id,
      parent_task_id,
    });

    console.log(
      `[scheduler] ${sender_blueprint} delegated subtask "${request.title}" → ${request.assigned_to} (${task_id})`,
    );

    // Resolve dependencies and schedule
    this.task_manager.resolve_all_dependencies(company_id);
    this.activate_pending_milestone_tasks(company_id);
    await this.schedule(company_id);
  }

  async drain_ceo_event_queue(company_id: string): Promise<void> {
    if (!this.task_manager.get_company(company_id)) {
      this.db.run(`DELETE FROM ceo_event_queue WHERE company_id = ?`, [company_id]);
      return;
    }
    const events = this.db.all<CEOEventQueueRow>(
      `
        SELECT *
        FROM ceo_event_queue
        WHERE company_id = ? AND delivered = 0
        ORDER BY created_at ASC
      `,
      [company_id],
    );

    if (events.length === 0) return;

    const user_msgs = events.filter((event) => event.event_type === "user_message");
    const other_events = events.filter((event) => event.event_type !== "user_message");

    // When no active work exists, clear non-user events to prevent token burn.
    // User messages must still be delivered (founder is talking).
    if (!this.task_manager.has_active_work(company_id)) {
      if (other_events.length > 0) {
        const allIds = other_events.map((e) => e.id);
        this.db.run(
          `UPDATE ceo_event_queue SET delivered = 1 WHERE id IN (${allIds.map(() => "?").join(", ")})`,
          allIds,
        );
      }
      // If there are no user messages either, we're done
      if (user_msgs.length === 0) return;
    }

    // User messages always take priority and batch together
    if (user_msgs.length > 0) {
      const combined = user_msgs
        .map((event) => {
          const payload = parse_json<UserMessageQueuePayload>(event.payload);
          return `[${event.created_at}] ${payload.text}`;
        })
        .join("\n\n");
      // Deliver first, then mark delivered — if delivery fails, events remain in queue
      await this.deliver_queued_user_messages(company_id, combined);
      this.db.run(
        `UPDATE ceo_event_queue SET delivered = 1 WHERE id IN (${user_msgs.map(() => "?").join(", ")})`,
        user_msgs.map((event) => event.id),
      );
      return;
    }

    if (other_events.length > 0) {
      // Deduplicate: for document_revision events, keep only the latest per document
      // and batch all same-type events into a single CEO turn
      const deduped = this.dedup_events(other_events);
      // Deliver the highest-priority event (task_blocked/failed first, then others)
      const priority: Record<string, number> = {
        task_blocked: 3,
        task_failed: 3,
        no_agent_assigned: 3,
        milestone_review: 2,
        approval_decided: 2,
        document_revision: 1,
      };
      deduped.sort((a, b) => (priority[b.event_type] ?? 0) - (priority[a.event_type] ?? 0));
      for (const event of deduped) {
        await this.deliver_ceo_event(company_id, event);
      }
      // Mark ALL original events as delivered AFTER successful delivery
      // If delivery fails (throws), events remain in the queue for the next drain attempt
      const allIds = other_events.map((e) => e.id);
      this.db.run(
        `UPDATE ceo_event_queue SET delivered = 1 WHERE id IN (${allIds.map(() => "?").join(", ")})`,
        allIds,
      );
    }
  }

  /** Deduplicate queued events: collapse multiple document_revision events for
   *  the same doc into one, and collapse repeated task_blocked/failed for the
   *  same task into one (keeping the latest). */
  private dedup_events(events: CEOEventQueueRow[]): CEOEventQueueRow[] {
    const seen = new Map<string, CEOEventQueueRow>();
    for (const event of events) {
      const payload = parse_json<Record<string, unknown>>(event.payload);
      let key: string;
      if (event.event_type === "document_revision") {
        key = `doc:${payload.path ?? payload.title ?? "unknown"}`;
      } else if (event.event_type === "task_blocked" || event.event_type === "task_failed") {
        key = `${event.event_type}:${payload.task_id ?? "unknown"}`;
      } else {
        key = `${event.event_type}:${event.id}`;
      }
      seen.set(key, event); // later event overwrites earlier
    }
    return [...seen.values()];
  }

  async deliver_queued_user_messages(
    company_id: string,
    combined_text: string,
    founder_state?: FounderStateSnapshot | null,
  ): Promise<void> {
    if (!this.task_manager.get_company(company_id)) {
      return;
    }
    const ceo = this.task_manager.get_ceo(company_id);
    const company = this.require_company(company_id);
    const prompt = build_ceo_user_message_prompt(combined_text, company, {
      db: this.db,
      task_manager: this.task_manager,
      credit_manager: this.credit_manager,
    }, founder_state);
    await this.invoke_ceo_turn(company_id, ceo, prompt, {
      is_user_facing: true,
    });
  }

  async deliver_ceo_event(company_id: string, event: CEOEventQueueRow): Promise<void> {
    if (!this.task_manager.get_company(company_id)) {
      return;
    }
    const ceo = this.task_manager.get_ceo(company_id);
    const payload = parse_json<Record<string, unknown>>(event.payload);
    switch (event.event_type) {
      case "task_blocked":
        await this.invoke_ceo_turn(company_id, ceo, build_ceo_blocked_task_prompt(company_id, payload, {
          db: this.db,
          task_manager: this.task_manager,
          credit_manager: this.credit_manager,
        }));
        return;
      case "milestone_review":
        await this.invoke_ceo_turn(company_id, ceo, build_ceo_milestone_review_prompt(company_id, payload, {
          db: this.db,
          task_manager: this.task_manager,
          credit_manager: this.credit_manager,
        }));
        return;
      case "task_failed":
        await this.invoke_ceo_turn(company_id, ceo, build_ceo_task_failed_prompt(company_id, payload, {
          db: this.db,
          task_manager: this.task_manager,
          credit_manager: this.credit_manager,
        }));
        return;
      case "no_agent_assigned":
        await this.invoke_ceo_turn(company_id, ceo, build_ceo_unassigned_task_prompt(company_id, payload, {
          db: this.db,
          task_manager: this.task_manager,
          credit_manager: this.credit_manager,
        }));
        return;
      case "document_revision":
        await this.invoke_ceo_turn(company_id, ceo, build_ceo_document_revision_prompt(company_id, payload, {
          db: this.db,
          task_manager: this.task_manager,
          credit_manager: this.credit_manager,
        }), { event_type: "document_revision" });
        return;
      case "user_message":
        await this.deliver_queued_user_messages(
          company_id,
          String(payload.text ?? ""),
          (payload.founder_state as FounderStateSnapshot | null | undefined) ?? null,
        );
        return;
    }
  }

  private static readonly FOUNDER_MSG_RATE_LIMIT = 40;
  private static readonly FOUNDER_MSG_RATE_WINDOW_MS = 60 * 60 * 1000;
  private static readonly CEO_MAX_TURNS_PER_HOUR = 30;

  private is_founder_rate_limited(company_id: string): boolean {
    const cutoff = new Date(Date.now() - Scheduler.FOUNDER_MSG_RATE_WINDOW_MS).toISOString();
    const count = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM messages WHERE company_id = ? AND role = 'user' AND created_at > ?`,
      [company_id, cutoff],
    )?.count ?? 0;
    return count >= Scheduler.FOUNDER_MSG_RATE_LIMIT;
  }

  async on_user_message(
    company_id: string,
    text: string,
    founder_state?: FounderStateSnapshot | null,
  ): Promise<string | null> {
    if (this.is_founder_rate_limited(company_id)) {
      return "You've sent too many messages recently. Please wait a bit before sending another — the team is still working on your previous requests.";
    }

    const ceo = this.task_manager.get_ceo(company_id);
    const msg_id = this.generate_id("msg");
    const created_at = isoNow();
    this.db.run(
      `INSERT INTO messages (id, company_id, agent_id, role, content, created_at) VALUES (?, ?, NULL, 'user', ?, ?)`,
      [msg_id, company_id, text, created_at],
    );

    const company = this.require_company(company_id);
    const deps = {
      db: this.db,
      task_manager: this.task_manager,
      credit_manager: this.credit_manager,
    };
    const prompt = build_ceo_user_message_prompt(text, company, deps, founder_state);
    try {
      const result = await this.invoke_ceo_turn(company_id, ceo, prompt, {
        is_user_facing: true,
        bill_credits: false,
      });
      if (!result.success) {
        console.warn(`[scheduler] CEO turn failed for ${company_id}: ${result.error ?? "unknown"}`);
        if (result.error === "CEO turn already in progress") {
          return "I'm still working on your previous message. Give me a moment to finish.";
        }
      }
      if (!result.output?.trim()) {
        console.warn(`[scheduler] CEO produced empty output for ${company_id} (success=${result.success}, error=${result.error ?? "none"}), resetting session and retrying`);
        // Stale/corrupted session — reset and retry once without resume
        const founderSessionKey = `${ceo.id}:founder-chat`;
        this.invoker.resetSession(founderSessionKey);
        const retry = await this.invoke_ceo_turn(company_id, ceo, prompt, {
          is_user_facing: true,
          bill_credits: false,
        });
        if (!retry.output?.trim()) {
          console.warn(`[scheduler] CEO retry also produced empty output for ${company_id}`);
        }
        return prepare_founder_reply(company_id, retry.output, deps, founder_state);
      }

      // Enforcement: if the founder's message was a work request but the CEO
      // responded conversationally without writing plan_update.json, fire a follow-up
      // turn with a stricter prompt that forces task creation.
      const companyState = this.require_company(company_id).state;
      if (
        result.success
        && companyState !== "planning"
        && is_work_request(text)
        && !this.last_ceo_response_had_plan_update.get(company_id)
      ) {
        console.warn(
          `[scheduler] CEO responded to work request without writing plan_update.json for ${company_id}. `
          + `Founder message: "${text.slice(0, 100)}". Firing enforcement turn.`,
        );
        await this.invoke_ceo_turn(company_id, ceo, this.build_task_creation_enforcement_prompt(text, company_id), {
          is_user_facing: false,
          bill_credits: false,
        });
      }

      return prepare_founder_reply(company_id, result.output, deps, founder_state);
    } catch (err) {
      console.error(`[scheduler] on_user_message invoke failed for ${company_id}:`, err);
      return prepare_founder_reply(company_id, null, deps, founder_state);
    }
  }

  async on_user_message_to_agent(
    company_id: string,
    target_agent_id: string,
    text: string,
    founder_state?: FounderStateSnapshot | null,
  ): Promise<string | null> {
    const target = this.task_manager.get_agent(target_agent_id);
    const augmented = target
      ? `[Message intended for ${target.name} (${target.role})]: ${text}`
      : text;
    return this.on_user_message(company_id, augmented, founder_state);
  }

  /**
   * Streaming variant of on_user_message.
   * Accepts streaming callbacks that are threaded through to the adapter.
   * Returns { reply, error } — the SSE endpoint should emit an error event
   * when `error` is set, rather than masking failures as done events.
   */
  async on_user_message_stream(
    company_id: string,
    text: string,
    callbacks: {
      onTextDelta?: (text: string) => Promise<void> | void;
      onToolStart?: (toolName: string, toolId: string) => void;
      onToolEnd?: (toolId: string) => void;
    },
    founder_state?: FounderStateSnapshot | null,
  ): Promise<{ reply: string | null; error?: string }> {
    if (this.is_founder_rate_limited(company_id)) {
      return { reply: null, error: "rate_limited" };
    }

    const ceo = this.task_manager.get_ceo(company_id);
    const msg_id = this.generate_id("msg");
    const created_at = isoNow();
    this.db.run(
      `INSERT INTO messages (id, company_id, agent_id, role, content, created_at) VALUES (?, ?, NULL, 'user', ?, ?)`,
      [msg_id, company_id, text, created_at],
    );

    const company = this.require_company(company_id);
    const deps = {
      db: this.db,
      task_manager: this.task_manager,
      credit_manager: this.credit_manager,
    };
    const prompt = build_ceo_user_message_prompt(text, company, deps, founder_state);
    try {
      const result = await this.invoke_ceo_turn(company_id, ceo, prompt, {
        is_user_facing: true,
        bill_credits: false,
        onTextDelta: callbacks.onTextDelta,
        onToolStart: callbacks.onToolStart,
        onToolEnd: callbacks.onToolEnd,
      });
      if (!result.success) {
        console.warn(`[scheduler] CEO stream turn failed for ${company_id}: ${result.error ?? "unknown"}`);
        return { reply: null, error: result.error ?? "CEO turn failed" };
      }
      if (!result.output?.trim()) {
        console.warn(`[scheduler] CEO stream produced empty output for ${company_id}, resetting session and retrying`);
        const founderSessionKey = `${ceo.id}:founder-chat`;
        this.invoker.resetSession(founderSessionKey);
        const retry = await this.invoke_ceo_turn(company_id, ceo, prompt, {
          is_user_facing: true,
          bill_credits: false,
          onTextDelta: callbacks.onTextDelta,
          onToolStart: callbacks.onToolStart,
          onToolEnd: callbacks.onToolEnd,
        });
        if (!retry.success) {
          return { reply: null, error: retry.error ?? "CEO turn retry failed" };
        }
        if (!retry.output?.trim()) {
          console.warn(`[scheduler] CEO stream retry also produced empty output for ${company_id}`);
        }
        return { reply: prepare_founder_reply(company_id, retry.output, deps, founder_state) };
      }

      // Enforcement: if the founder's message was a work request but the CEO
      // responded conversationally without writing plan_update.json, fire a follow-up turn.
      const companyState = this.require_company(company_id).state;
      if (
        result.success
        && companyState !== "planning"
        && is_work_request(text)
        && !this.last_ceo_response_had_plan_update.get(company_id)
      ) {
        console.warn(
          `[scheduler] CEO responded to work request without writing plan_update.json for ${company_id}. `
          + `Founder message: "${text.slice(0, 100)}". Firing enforcement turn.`,
        );
        await this.invoke_ceo_turn(company_id, ceo, this.build_task_creation_enforcement_prompt(text, company_id), {
          is_user_facing: false,
          bill_credits: false,
        });
      }

      return { reply: prepare_founder_reply(company_id, result.output, deps, founder_state) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] on_user_message_stream invoke failed for ${company_id}:`, message);
      return { reply: null, error: message };
    }
  }

  /**
   * Build an enforcement prompt that forces the CEO to create tasks via plan_update.json
   * when the founder requested work but the initial turn responded conversationally.
   */
  private build_task_creation_enforcement_prompt(founderMessage: string, company_id: string): string {
    const company = this.require_company(company_id);
    const milestones = this.db.all<MilestoneRow>(
      `SELECT * FROM milestones WHERE company_id = ? AND status IN ('active', 'pending') ORDER BY sort_order LIMIT 3`,
      [company_id],
    );
    const targetMilestone = milestones.length > 0
      ? `Use milestone "${milestones[0].title}" [${milestones[0].id}] or create a new one.`
      : "Create a new milestone for this work.";

    return [
      build_ceo_date_header(company),
      "",
      "# ENFORCEMENT: Task Creation Required",
      "",
      "The founder just sent this work request:",
      `"${founderMessage}"`,
      "",
      "You responded conversationally but did NOT create any tasks.",
      "The founder expects work to actually start — not just a verbal acknowledgment.",
      "",
      "You MUST write /workspace/.agent/plan_update.json with at least one task.",
      `${targetMilestone}`,
      "",
      "Example plan_update.json:",
      "```json",
      "{",
      '  "add_tasks": [',
      "    {",
      `      "title": "Short descriptive title based on the founder's request",`,
      `      "description": "Clear description of what to build/fix/change",`,
      `      "milestone_id": "${milestones[0]?.id ?? "CREATE_NEW_MILESTONE"}"`,
      "    }",
      "  ]",
      "}",
      "```",
      "",
      "Do NOT respond with text. Just write the file. Your text output will not be shown.",
    ].join("\n");
  }

  async on_approval_resolved(
    company_id: string,
    approval_id: string,
    decision: ApprovalResolutionPayload["decision"],
    founder_note?: string | null,
  ): Promise<void> {
    const approval = this.db.get<ApprovalRow>(`SELECT * FROM approvals WHERE id = ?`, [approval_id]);
    if (!approval) {
      throw new Error(`Approval ${approval_id} not found`);
    }
    this.db.run(`UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?`, [decision, isoNow(), approval_id]);
    this.db.enqueue_sync("approvals", approval_id, "upsert", {
      status: decision,
      resolved_at: isoNow(),
    });

    if (!approval.related_task_id) {
      // No related task — still notify CEO so they know the founder responded
      await this.notify_ceo(company_id, "approval_decided", {
        approval_id,
        decision,
        description: approval.description,
        founder_note: founder_note || null,
      });
      return;
    }

    const task = this.task_manager.get_task(approval.related_task_id);
    if (!task || !task.owner_agent_id) return;

    if (decision === "approved") {
      if (task.status === "cancelled" || task.status === "done" || task.status === "failed") {
        await this.notify_ceo(company_id, "task_blocked", {
          task_id: task.id,
          task_title: task.title,
          reason: `Founder approved "${approval.description}", but the related task is already ${task.status}. Replan instead of reviving it automatically.`,
        });
        return;
      }
      const agent = this.task_manager.get_agent(task.owner_agent_id);
      if (!agent) return;
      this.db.run(`UPDATE tasks SET status = 'in_progress', blocked_reason = NULL WHERE id = ?`, [task.id]);
      this.db.enqueue_sync("tasks", task.id, "upsert", {
        status: "in_progress",
        blocked_reason: null,
      });
      const notePart = founder_note ? `\nFounder's reply: ${founder_note}` : "";
      const prompt = `Your blocker has been resolved. The founder APPROVED: ${approval.description}${notePart}\nContinue your task.`;
      void this.runner.wake_agent(agent, task, prompt);
      return;
    }

    const notePart = founder_note ? ` — Founder's note: ${founder_note}` : "";
    await this.notify_ceo(company_id, "task_blocked", {
      task_id: task.id,
      task_title: task.title,
      reason: `Founder rejected: ${approval.description}${notePart}`,
    });
  }

  async on_credit_purchase(payload: CreditPurchasePayload): Promise<void> {
    const resumed_company_ids = this.credit_manager.apply_credit_purchase(payload.user_id, payload.amount);
    for (const company_id of resumed_company_ids) {
      await this.schedule(company_id);
    }
  }

  /**
   * Watchdog: detect agents stuck in 'working' state.
   *
   * Two cases:
   * 1. No active abort controller + working >5 min → invocation completed but status
   *    update was lost (e.g., unhandled rejection, OOM partial, or logic gap). Reset.
   * 2. Active abort controller + working >30 min → process is almost certainly hung
   *    (child process died silently, async iterator stuck). Force abort and reset.
   */
  reset_stuck_agents(company_id: string): void {
    const working_agents = this.task_manager
      .get_agents(company_id)
      .filter((a) => a.status === "working");

    const SOFT_STUCK_THRESHOLD_MS = 5 * 60 * 1000;  // 5 minutes — no abort controller
    const HARD_STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes — with abort controller

    for (const agent of working_agents) {
      const wake_time = agent.last_wake_at ? new Date(agent.last_wake_at).getTime() : 0;
      const working_duration_ms = Date.now() - wake_time;
      const has_runner_invocation = this.runner.has_active_invocation(agent.id);
      const has_cron_invocation = this.cron?.has_active_invocation(agent.id) ?? false;
      const has_ceo_invocation = agent.role === "ceo" && (
        this.active_ceo_abort_controllers.has(`${company_id}:system`) ||
        this.active_ceo_abort_controllers.has(`${company_id}:user`)
      );
      const has_active_invocation = has_runner_invocation || has_cron_invocation || has_ceo_invocation;

      if (has_active_invocation) {
        // Hard timeout: force abort agents stuck >30 min even with active abort controller
        if (working_duration_ms < HARD_STUCK_THRESHOLD_MS) continue;

        console.warn(
          `[scheduler] Watchdog: force-aborting stuck agent ${agent.id} (${agent.name}) — ` +
          `working since ${agent.last_wake_at} for ${Math.round(working_duration_ms / 60_000)}min with active abort controller`,
        );
        // Force abort the running process and clean up the abort controller
        this.runner.abort_agent_turn(agent.id);
        this.runner.clear_abort_controller(agent.id);
        this.cron?.abort_agent_turn(agent.id);
      } else {
        // Soft timeout: no active invocation, reset after 5 min
        if (working_duration_ms < SOFT_STUCK_THRESHOLD_MS) continue;

        console.warn(
          `[scheduler] Watchdog: resetting stuck agent ${agent.id} (${agent.name}) — ` +
          `working since ${agent.last_wake_at} with no active invocation`,
        );
      }

      this.db.run(
        `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
        [agent.id],
      );
      this.db.enqueue_sync("agents", agent.id, "upsert", {
        status: "idle",
        current_task_id: null,
      });
    }
  }

  async pause_company(company_id: string): Promise<void> {
    const agents_before_pause = this.task_manager.get_agents(company_id);
    const company = this.task_manager.get_company(company_id);
    this.db.run(`UPDATE companies SET state = 'paused', updated_at = ? WHERE id = ?`, [isoNow(), company_id]);
    this.db.run(
      `
        UPDATE agents
        SET status = CASE
          WHEN status = 'terminated' THEN status
          WHEN status = 'error' THEN status
          ELSE 'paused'
        END,
            current_task_id = CASE
              WHEN status IN ('terminated', 'error') THEN current_task_id
              ELSE NULL
            END
        WHERE company_id = ?
      `,
      [company_id],
    );
    const paused_agents = agents_before_pause
      .filter((agent) => agent.status !== "terminated" && agent.status !== "error");
    for (const agent of paused_agents) {
      if (agent.status === "working") {
        this.runner.abort_agent_turn(agent.id);
        this.cron?.abort_agent_turn(agent.id);
      }
      const interrupted_tasks = this.db.all<Pick<TaskRow, "id">>(
        `
          SELECT id
          FROM tasks
          WHERE company_id = ?
            AND owner_agent_id = ?
            AND status = 'in_progress'
        `,
        [company_id, agent.id],
      );
      this.db.run(
        `
          UPDATE tasks
          SET status = 'ready',
              started_at = NULL
          WHERE company_id = ?
            AND owner_agent_id = ?
            AND status = 'in_progress'
        `,
        [company_id, agent.id],
      );
      for (const task of interrupted_tasks) {
        this.db.enqueue_sync("tasks", task.id, "upsert", { status: "ready", started_at: null });
      }
    }

    // Synchronous push to D1 — worker is waiting for this response
    await this.sync_manager.push_company_now(company_id, { state: "paused", updated_at: isoNow() });
    await Promise.all(
      paused_agents.map((agent) =>
        this.sync_manager.push_agent_now(agent.id, { status: "paused", current_task_id: null }),
      ),
    );
    this.active_ceo_abort_controllers.get(`${company_id}:system`)?.abort();
    this.active_ceo_abort_controllers.get(`${company_id}:user`)?.abort();
    // Release only THIS company's credit reservations — other companies may still have
    // active turns whose reservations must be preserved.
    if (company?.user_id) {
      const company_reserved = this.credit_manager.get_company_reserved_balance(company.user_id, company_id);
      this.credit_manager.release_reserved_credits(company.user_id, company_reserved, company_id);
    }
  }

  /**
   * Pause a company because its workspace/container is missing.
   * This prevents infinite retry loops that burn API credits after a VM reboot
   * or container loss. The pause is synced to D1 so it survives supervisor restarts.
   */
  async pause_company_missing_workspace(company_id: string): Promise<void> {
    const company = this.task_manager.get_company(company_id);
    if (!company || company.state === "paused" || company.state === "completed" || company.state === "failed" || company.state === "dead") {
      return;
    }
    console.warn(
      `[scheduler] Company ${company_id} paused: workspace missing (${company.workspace_dir}). Container may need recreation.`,
    );
    await this.pause_company(company_id);
  }

  async destroy_company(company_id: string, removeData = false): Promise<void> {
    // 1. Abort all running agent turns
    const agents = this.task_manager.get_agents(company_id);
    for (const agent of agents) {
      if (agent.status === "working") {
        this.runner.abort_agent_turn(agent.id);
      }
    }

    // 2. Destroy container / workspace
    await this.container_manager.destroy(company_id, removeData);

    // 3. Remove all local data
    const user_id = this.db.get<{ user_id: string }>(`SELECT user_id FROM companies WHERE id = ?`, [company_id])?.user_id;
    const tables_by_company_id = ["turn_log", "approvals", "tasks", "milestones", "agents", "cron_tasks", "telemetry_mirror"];
    for (const table of tables_by_company_id) {
      try { this.db.run(`DELETE FROM ${table} WHERE company_id = ?`, [company_id]); } catch {}
    }
    // Clean sync_queue entries for records belonging to this company
    try { this.db.run(`DELETE FROM sync_queue WHERE record_id = ?`, [company_id]); } catch {}
    // Delete sync items whose record_id matches any agent/task/milestone from this company
    // (the bulk delete above already removed those rows, so we match on known record prefixes)
    const agent_ids = this.db.all<{ id: string }>(`SELECT id FROM agents WHERE company_id = ?`, [company_id]);
    const task_ids = this.db.all<{ id: string }>(`SELECT id FROM tasks WHERE company_id = ?`, [company_id]);
    const milestone_ids = this.db.all<{ id: string }>(`SELECT id FROM milestones WHERE company_id = ?`, [company_id]);
    const all_record_ids = [...agent_ids, ...task_ids, ...milestone_ids].map((r) => r.id);
    for (const rid of all_record_ids) {
      try { this.db.run(`DELETE FROM sync_queue WHERE record_id = ?`, [rid]); } catch {}
    }
    // Release this company's credit reservations without touching other companies
    if (user_id) {
      try { this.db.run(`DELETE FROM credit_reservations WHERE user_id = ? AND company_id = ?`, [user_id, company_id]); } catch {}
    }
    try { this.db.run(`DELETE FROM companies WHERE id = ?`, [company_id]); } catch {}

    console.log(`[scheduler] Company ${company_id} destroyed (removeData=${removeData})`);
  }

  abort_all_active_turns(): void {
    this.runner.abort_all_turns();
    this.cron?.abort_all_turns();
    for (const abort_controller of this.active_ceo_abort_controllers.values()) {
      abort_controller.abort();
    }
  }

  async resume_company(company_id: string): Promise<void> {
    const milestone_count = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM milestones WHERE company_id = ?`,
      [company_id],
    )?.count ?? 0;
    const task_count = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM tasks WHERE company_id = ?`,
      [company_id],
    )?.count ?? 0;
    const resumed_state = milestone_count === 0 && task_count === 0 ? "planning" : "running";

    // Query paused agents BEFORE updating them so we can sync the change to D1
    const paused_agents = this.task_manager.get_agents(company_id).filter((agent) => agent.status === "paused");

    this.db.run(`UPDATE companies SET state = ?, updated_at = ? WHERE id = ?`, [resumed_state, isoNow(), company_id]);
    this.db.run(
      `
        UPDATE agents
        SET status = 'idle',
            current_task_id = NULL
        WHERE company_id = ?
          AND status = 'paused'
      `,
      [company_id],
    );
    // Synchronous push to D1 — worker is waiting for this response
    await this.sync_manager.push_company_now(company_id, { state: resumed_state, updated_at: isoNow() });
    await Promise.all(
      paused_agents.map((agent) =>
        this.sync_manager.push_agent_now(agent.id, { status: "idle", current_task_id: null }),
      ),
    );
    if (resumed_state === "running") {
      this.activate_pending_milestone_tasks(company_id);
    }
    void this.schedule(company_id).catch((error) => {
      console.error(
        `[scheduler] resume_company schedule failed for ${company_id}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }

  async pause_agent(company_id: string, agent_id: string): Promise<void> {
    const agent = this.task_manager.get_agent(agent_id);
    if (!agent) {
      throw new Error(`Agent ${agent_id} not found`);
    }

    // If agent is currently working, abort the turn
    if (agent.status === "working") {
      this.runner.abort_agent_turn(agent_id);
      this.cron?.abort_agent_turn(agent_id);
    }

    this.db.run(
      `UPDATE agents SET status = 'paused', current_task_id = NULL, updated_at = ? WHERE id = ?`,
      [isoNow(), agent_id],
    );

    // Reset any in-progress tasks back to ready
    const interrupted_tasks = this.db.all<Pick<TaskRow, "id">>(
      `SELECT id FROM tasks WHERE owner_agent_id = ? AND status = 'in_progress'`,
      [agent_id],
    );
    if (interrupted_tasks.length > 0) {
      this.db.run(
        `UPDATE tasks SET status = 'ready', started_at = NULL WHERE owner_agent_id = ? AND status = 'in_progress'`,
        [agent_id],
      );
      for (const task of interrupted_tasks) {
        this.db.enqueue_sync("tasks", task.id, "upsert", { status: "ready", started_at: null });
      }
    }

    // Synchronous push to D1
    await this.sync_manager.push_agent_now(agent_id, { status: "paused", current_task_id: null });
  }

  async resume_agent(company_id: string, agent_id: string): Promise<void> {
    this.db.run(
      `UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?`,
      [isoNow(), agent_id],
    );

    // Synchronous push to D1
    await this.sync_manager.push_agent_now(agent_id, { status: "idle", current_task_id: null });

    // Trigger scheduling so the resumed agent can pick up work
    const company = this.task_manager.get_company(company_id);
    if (company?.state === "running") {
      void this.schedule(company_id).catch((error) => {
        console.error(
          `[scheduler] post-agent-resume schedule failed for ${company_id}:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
  }

  async dispatch_agent_work(agent: AgentRow, task: TaskRow, prompt: string | null): Promise<void> {
    await this.runner.wake_agent(agent, task, prompt);
  }

  get_company_status(company_id: string): CompanyProgressMetrics {
    return get_company_progress_metrics(company_id, {
      db: this.db,
      task_manager: this.task_manager,
      credit_manager: this.credit_manager,
      stall_detector: this.stall_detector,
    });
  }

  get_agent_activity(company_id: string): AgentActivityEntry[] {
    return get_agent_activity_entries(company_id, {
      db: this.db,
      task_manager: this.task_manager,
    });
  }

  get_founder_documents(company_id: string): FounderDocument[] {
    return this.runner.get_founder_documents(company_id).map((document) => ({
      type: document.type as FounderDocument["type"],
      title: document.title,
      content: document.content,
      path: document.path,
      date: document.date,
      created_at: document.created_at,
    }));
  }

  get_verified_telemetry_summary(company_id: string): VerifiedTelemetrySummary {
    return get_verified_telemetry_summary(this.runner.get_telemetry_rows(company_id));
  }

  export_workspace_archive(company_id: string): WorkspaceArchivePayload {
    const workspace_dir = this.get_workspace_dir(company_id);
    const archive_path = join(workspace_dir, "..", `${company_id}.tar.gz`);
    execFileSync("tar", ["-czf", archive_path, "-C", workspace_dir, "."], { stdio: "ignore" });
    const archiveBase64 = readFileSync(archive_path).toString("base64");
    rmSync(archive_path, { force: true });
    return { archiveBase64 };
  }

  import_workspace_archive(company_id: string, payload: WorkspaceArchivePayload): void {
    const workspace_dir = this.get_workspace_dir(company_id);
    mkdirSync(workspace_dir, { recursive: true });
    const archive_path = join(workspace_dir, "..", `${company_id}.import.tar.gz`);
    writeFileSync(archive_path, Buffer.from(payload.archiveBase64, "base64"));
    execFileSync("tar", ["-xzf", archive_path, "-C", workspace_dir], { stdio: "ignore" });
    rmSync(archive_path, { force: true });
  }

  private normalize_company_payload(payload: ProvisionCompanyPayload): CompanyRow {
    return {
      id: payload.id,
      user_id: payload.user_id,
      name: payload.name,
      goal: payload.goal,
      state: payload.state ?? "provisioning",
      workspace_dir: payload.workspace_dir ?? null,
      container_id: payload.container_id ?? null,
      mode: "mode" in payload && payload.mode === "manual" ? "manual" : "autonomous",
      created_at: payload.created_at,
      updated_at: payload.updated_at ?? isoNow(),
    };
  }

  private require_company(company_id: string): CompanyRow {
    const company = this.task_manager.get_company(company_id);
    if (!company) {
      throw new Error(`Company ${company_id} not found`);
    }
    return company;
  }

  private get_active_milestone_id(company_id: string): string | null {
    // Prefer active milestones
    const active = this.db.get<{ id: string }>(
      `SELECT id FROM milestones WHERE company_id = ? AND status = 'active' ORDER BY sort_order ASC LIMIT 1`,
      [company_id],
    )?.id ?? null;
    if (active) return active;

    // Fallback: most recent done milestone (by sort_order DESC) so tasks added
    // after all milestones complete still have a target instead of being dropped.
    return this.db.get<{ id: string }>(
      `SELECT id FROM milestones WHERE company_id = ? AND status = 'done' ORDER BY sort_order DESC LIMIT 1`,
      [company_id],
    )?.id ?? null;
  }

  private cancel_task(task_id: string): void {
    const task = this.task_manager.get_task(task_id);
    if (!task) return;
    if (task.owner_agent_id) {
      const agent = this.task_manager.get_agent(task.owner_agent_id);
      if (agent?.status === "working") {
        this.runner.abort_agent_turn(agent.id);
      }
      if (agent) {
        this.db.run(
          `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
          [agent.id],
        );
        this.db.enqueue_sync("agents", agent.id, "upsert", {
          status: "idle",
          current_task_id: null,
        });
      }
    }
    this.db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, [task_id]);
    this.db.enqueue_sync("tasks", task_id, "upsert", { status: "cancelled" });
  }

  private async insert_ceo_message(company_id: string, content: string, agent_id?: string): Promise<void> {
    await this.insert_ceo_message_internal(company_id, content, agent_id, true);
  }

  async insert_ceo_message_internal(
    company_id: string,
    content: string,
    agent_id: string | undefined,
    mirror_to_worker: boolean,
  ): Promise<void> {
    const id = this.generate_id("msg");
    const created_at = isoNow();
    const ceo = agent_id ?? this.task_manager.get_ceo(company_id).id;
    const message: MessageRow = {
      id,
      company_id,
      agent_id: ceo,
      role: "ceo",
      content,
      created_at,
    };
    this.db.run(
      `INSERT INTO messages (id, company_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [message.id, message.company_id, message.agent_id, message.role, message.content, message.created_at],
    );
    if (mirror_to_worker) {
      this.db.enqueue_sync("messages", message.id, "upsert", message);
    }
  }

  private async maybe_check_stalls(company_id: string): Promise<void> {
    const total_turns = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM turn_log WHERE company_id = ?`,
      [company_id],
    )?.count ?? 0;
    if (total_turns === 0 || total_turns % 3 !== 0) {
      return;
    }
    const stalls = this.stall_detector.check_stalls(company_id);
    for (const stall of stalls) {
      await this.stall_detector.handle_stall(stall, {
        wake_agent: (agent, task, override_prompt) => this.runner.wake_agent(agent, task, override_prompt ?? null),
        escalate_to_ceo: async (task, reason) => {
          this.db.run(`UPDATE tasks SET status = 'failed', blocked_reason = ? WHERE id = ?`, [reason, task.id]);
          this.db.enqueue_sync("tasks", task.id, "upsert", {
            status: "failed",
            blocked_reason: reason,
          });
          await this.notify_ceo(task.company_id, "task_failed", {
            task_id: task.id,
            task_title: task.title,
            reason,
          });
        },
      });
    }
  }
}
