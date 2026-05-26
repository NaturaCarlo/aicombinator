import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getAllBlueprints, getBlueprint, FOUNDING_BLUEPRINTS, isSpecialistBlueprint } from "./blueprints.js";
import { SupervisorDb, isoNow } from "./db.js";
import { canAssignTo } from "./routing.js";
import type {
  AcceptanceCriterion,
  AgentBlueprint,
  AgentRow,
  CompanyRow,
  CriterionValidationResult,
  MilestoneRow,
  PlanDocument,
  PlanMilestoneInput,
  PlanTaskInput,
  TaskRow,
  TaskStatus,
  TaskUpdateInput,
} from "./types.js";

export interface PlanValidationError {
  message: string;
}

export interface NewTaskInsertOptions {
  milestone_id: string;
  created_by: string;
  parent_task_id?: string | null;
}

function parseJsonArray<T>(value: string | null | undefined, fallback: T[] = []): T[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as T[];
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function workspaceToHostPath(workspaceDir: string, target: string): string {
  if (target.startsWith("/workspace/")) {
    return join(workspaceDir, target.slice("/workspace/".length));
  }
  if (target === "/workspace") {
    return workspaceDir;
  }
  return target;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  const pattern = escaped
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${pattern}$`);
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function humanize_criterion(criterion: AcceptanceCriterion): string {
  switch (criterion.type) {
    case "file_exists":
      return `File exists: ${criterion.path}`;
    case "file_not_empty":
      return `File is not empty: ${criterion.path}`;
    case "file_contains":
      return `File contains "${criterion.substring}": ${criterion.path}`;
    case "file_count_gte":
      return `At least ${criterion.min} files match ${criterion.glob}`;
    case "command_succeeds":
      return `Command succeeds: ${criterion.command}`;
    case "directory_exists":
      return `Directory exists: ${criterion.path}`;
    case "custom":
      return criterion.description;
  }
}

export function humanize_criteria(criteria: AcceptanceCriterion[]): string {
  return criteria.map((criterion) => `- ${humanize_criterion(criterion)}`).join("\n");
}

export class TaskManager {
  constructor(private readonly db: SupervisorDb) {}

  generate_id(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  get_company(company_id: string): CompanyRow | undefined {
    return this.db.get<CompanyRow>(`SELECT * FROM companies WHERE id = ?`, [company_id]);
  }

  upsert_company(company: CompanyRow): void {
    this.db.run(
      `
        INSERT INTO companies (
          id, user_id, name, goal, genesis_prompt, state, container_id, workspace_dir, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          name = excluded.name,
          goal = excluded.goal,
          genesis_prompt = excluded.genesis_prompt,
          state = excluded.state,
          container_id = excluded.container_id,
          workspace_dir = excluded.workspace_dir,
          updated_at = excluded.updated_at
      `,
      [
        company.id,
        company.user_id,
        company.name,
        company.goal,
        company.genesis_prompt ?? null,
        company.state,
        company.container_id,
        company.workspace_dir,
        company.created_at,
        company.updated_at,
      ],
    );
  }

  get_agent(agent_id: string): AgentRow | undefined {
    return this.db.get<AgentRow>(`SELECT * FROM agents WHERE id = ?`, [agent_id]);
  }

  get_agents(company_id: string): AgentRow[] {
    return this.db.all<AgentRow>(`SELECT * FROM agents WHERE company_id = ? ORDER BY created_at ASC`, [
      company_id,
    ]);
  }

  get_ceo(company_id: string): AgentRow {
    const ceo = this.db.get<AgentRow>(
      `
        SELECT *
        FROM agents
        WHERE company_id = ?
          AND (
            blueprint_id = 'ceo'
            OR role = 'ceo'
            OR lower(COALESCE(title, '')) = 'chief executive officer'
            OR lower(COALESCE(title, '')) = 'ceo'
          )
        ORDER BY
          CASE
            WHEN blueprint_id = 'ceo' THEN 0
            WHEN role = 'ceo' THEN 1
            ELSE 2
          END,
          created_at ASC
        LIMIT 1
      `,
      [company_id],
    );
    if (!ceo) {
      const company = this.get_company(company_id);
      if (company) {
        return this.activate_agent(company_id, "ceo");
      }
      throw new Error(`CEO not found for company ${company_id}`);
    }
    return ceo;
  }

  activate_agent(company_id: string, blueprint_id: string): AgentRow {
    const existing = this.find_agent_by_blueprint(company_id, blueprint_id);
    if (existing) {
      return existing;
    }

    const blueprint = this.require_blueprint(blueprint_id);

    // Resolve blueprint.reportsTo slug to an actual agent UUID
    let reports_to: string | null = null;
    if (blueprint.reportsTo) {
      const parent = this.find_agent_by_blueprint(company_id, blueprint.reportsTo);
      if (parent) {
        reports_to = parent.id;
      } else {
        // Fallback: if the specified manager doesn't exist, report to CEO
        const ceo = this.find_agent_by_blueprint(company_id, "ceo");
        if (ceo && blueprint_id !== "ceo") {
          reports_to = ceo.id;
          console.log(`[task-manager] ${blueprint_id} reportsTo "${blueprint.reportsTo}" not found, falling back to CEO`);
        }
      }
    }

    const agent: AgentRow = {
      id: this.generate_id("agent"),
      company_id,
      blueprint_id: blueprint.id,
      name: blueprint.name,
      role: blueprint.role,
      model_tier: blueprint.modelTier,
      status: "idle",
      reports_to,
      session_id: null,
      current_task_id: null,
      total_credits: 0,
      created_at: isoNow(),
      updated_at: isoNow(),
      title: blueprint.title,
      department: String(blueprint.department),
    };

    this.db.run(
      `
        INSERT INTO agents (
          id, company_id, blueprint_id, name, role, title, model_tier, status,
          reports_to, session_id, current_task_id, total_credits, total_credits_consumed,
          last_wake_at, last_sleep_at, department, email_address, metadata, icon,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agent.id,
        agent.company_id,
        agent.blueprint_id,
        agent.name,
        agent.role,
        agent.title ?? null,
        agent.model_tier,
        agent.status,
        reports_to,
        agent.session_id,
        agent.current_task_id,
        agent.total_credits,
        0,
        null,
        null,
        agent.department ?? null,
        null,
        null,
        null,
        agent.created_at,
        agent.updated_at,
      ],
    );
    this.db.enqueue_sync("agents", agent.id, "upsert", agent);

    // Auto-create self-update cron for specialist agents
    if (isSpecialistBlueprint(blueprint_id)) {
      this.create_specialist_cron(company_id, agent, blueprint);
    }

    return agent;
  }

  /**
   * Create a self-update cron task for a specialist agent.
   * Only creates the cron if one doesn't already exist for this agent.
   */
  private create_specialist_cron(company_id: string, agent: AgentRow, blueprint: AgentBlueprint): void {
    // Check if cron already exists for this agent
    const existing = this.db.get<{ id: string }>(
      `SELECT id FROM cron_tasks WHERE agent_id = ? AND company_id = ?`,
      [agent.id, company_id],
    );
    if (existing) return;

    const SELF_UPDATE_PROMPTS: Record<string, { title: string; description: string; schedule: string; prompt: string }> = {
      "seo-specialist": {
        title: "SEO Self-Update Scan",
        description: "Daily scan of ecosystem for new SEO tools and techniques",
        schedule: "0 7 * * *",
        prompt: `You are running your daily self-update scan. Your goal is to discover and evaluate new SEO tools, techniques, and best practices from the ecosystem.

Steps:
1. Search GitHub for trending SEO-related repositories (search: 'SEO tools', 'SEO optimization', 'content SEO', sort by recently updated)
2. Search for recent SEO technique articles and guides
3. Evaluate each finding against these criteria:
   - Does it provide specific, actionable techniques (not just marketing fluff)?
   - Is it well-documented with clear implementation steps?
   - Is it applicable to our company's domain and current strategy?
   - Does it complement or improve our existing SEO approach?
4. For findings that meet the quality bar:
   - Extract the key techniques and patterns
   - Update docs/seo-knowledge.md with new findings (append, don't overwrite)
   - If techniques change best practices, update docs/seo-guidelines.md
5. Write a brief summary of what you found and what you integrated to docs/seo-scan-log.md (append today's date and findings)

Do NOT clone external repositories. Extract techniques and integrate them into the company's existing approach.`,
      },
    };

    const cronConfig = SELF_UPDATE_PROMPTS[blueprint.id];
    if (!cronConfig) return;

    const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = isoNow();

    this.db.run(
      `INSERT INTO cron_tasks (id, company_id, agent_id, title, description, schedule, prompt, enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [id, company_id, agent.id, cronConfig.title, cronConfig.description, cronConfig.schedule, cronConfig.prompt, "system", now],
    );

    this.db.enqueue_sync("cron_tasks", id, "upsert", {
      id,
      company_id,
      agent_id: agent.id,
      title: cronConfig.title,
      description: cronConfig.description,
      schedule: cronConfig.schedule,
      prompt: cronConfig.prompt,
      enabled: 1,
      last_run_at: null,
      created_by: "system",
      created_at: now,
    });

    console.log(`[task-manager] Created self-update cron "${cronConfig.title}" for specialist ${blueprint.id} in company ${company_id}`);
  }

  deactivate_agent(company_id: string, agent_id: string): void {
    this.db.run(
      `UPDATE agents SET status = 'terminated', current_task_id = NULL WHERE id = ? AND company_id = ?`,
      [agent_id, company_id],
    );
    this.db.enqueue_sync("agents", agent_id, "upsert", { status: "terminated" });
  }

  find_agent_by_blueprint(company_id: string, blueprint_id: string): AgentRow | undefined {
    return this.db.get<AgentRow>(
      `SELECT * FROM agents WHERE company_id = ? AND blueprint_id = ? LIMIT 1`,
      [company_id, blueprint_id],
    );
  }

  /**
   * Backfill reports_to for all agents that have a blueprint_id with a reportsTo
   * value but currently have null reports_to. Resolves the blueprint's reportsTo
   * slug to the actual agent UUID in the same company.
   */
  backfill_reports_to(): number {
    const agents_needing_backfill = this.db.all<AgentRow>(
      `SELECT * FROM agents WHERE blueprint_id IS NOT NULL AND (reports_to IS NULL OR reports_to = '')`,
    );

    let updated = 0;
    for (const agent of agents_needing_backfill) {
      if (!agent.blueprint_id) continue;
      const blueprint = getBlueprint(agent.blueprint_id);
      if (!blueprint?.reportsTo) continue;

      const parent = this.find_agent_by_blueprint(agent.company_id, blueprint.reportsTo);
      if (!parent) continue;

      this.db.run(
        `UPDATE agents SET reports_to = ?, updated_at = ? WHERE id = ?`,
        [parent.id, isoNow(), agent.id],
      );
      this.db.enqueue_sync("agents", agent.id, "upsert", {
        reports_to: parent.id,
        updated_at: isoNow(),
      });
      updated++;
    }

    if (updated > 0) {
      console.log(`[backfill] Updated reports_to for ${updated} agents`);
    }

    return updated;
  }

  get_milestones(company_id: string): MilestoneRow[] {
    return this.db.all<MilestoneRow>(
      `SELECT * FROM milestones WHERE company_id = ? ORDER BY sort_order ASC, created_at ASC`,
      [company_id],
    );
  }

  get_first_milestone(company_id: string): MilestoneRow | undefined {
    return this.db.get<MilestoneRow>(
      `SELECT * FROM milestones WHERE company_id = ? ORDER BY sort_order ASC LIMIT 1`,
      [company_id],
    );
  }

  get_task(task_id: string): TaskRow | undefined {
    return this.db.get<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [task_id]);
  }

  get_tasks(company_id: string, statuses?: TaskStatus[]): TaskRow[] {
    if (!statuses || statuses.length === 0) {
      return this.db.all<TaskRow>(
        `SELECT * FROM tasks WHERE company_id = ? ORDER BY created_at ASC`,
        [company_id],
      );
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db.all<TaskRow>(
      `SELECT * FROM tasks WHERE company_id = ? AND status IN (${placeholders}) ORDER BY created_at ASC`,
      [company_id, ...statuses],
    );
  }

  get_tasks_completed_since(company_id: string, since_iso: string | null): TaskRow[] {
    if (!since_iso) {
      return this.db.all<TaskRow>(
        `
          SELECT * FROM tasks
          WHERE company_id = ? AND status = 'done'
          ORDER BY completed_at DESC
        `,
        [company_id],
      );
    }
    return this.db.all<TaskRow>(
      `
        SELECT * FROM tasks
        WHERE company_id = ? AND status = 'done' AND completed_at > ?
        ORDER BY completed_at DESC
      `,
      [company_id, since_iso],
    );
  }

  /**
   * Returns true if the company has any non-terminal milestones (active/pending)
   * or any non-terminal tasks (pending/ready/in_progress/blocked).
   * Returns false when all work is done/cancelled/failed or there are no milestones/tasks.
   */
  has_active_work(company_id: string): boolean {
    const activeMilestone = this.db.get<{ id: string }>(
      `SELECT id FROM milestones WHERE company_id = ? AND status IN ('active', 'pending') LIMIT 1`,
      [company_id],
    );
    if (activeMilestone) return true;

    const activeTask = this.db.get<{ id: string }>(
      `SELECT id FROM tasks WHERE company_id = ? AND status IN ('pending', 'ready', 'in_progress', 'blocked') LIMIT 1`,
      [company_id],
    );
    if (activeTask) return true;

    return false;
  }

  validate_plan(company_id: string, plan: PlanDocument): PlanValidationError[] {
    void company_id;
    const errors: PlanValidationError[] = [];

    if (!plan.milestones || plan.milestones.length === 0) {
      errors.push({ message: "No milestones defined" });
      return errors;
    }

    // Build a global title set across all milestones for cross-milestone dependency resolution
    const allTitleSet = new Set<string>();
    for (const milestone of plan.milestones) {
      if (milestone.tasks) {
        for (const task of milestone.tasks) {
          allTitleSet.add(task.title);
        }
      }
    }

    for (const milestone of plan.milestones) {
      if (!milestone.tasks || milestone.tasks.length === 0) {
        errors.push({ message: `Milestone '${milestone.title}' has no tasks` });
        continue;
      }

      const titleSet = new Set<string>();
      for (const task of milestone.tasks) {
        if (titleSet.has(task.title)) {
          errors.push({ message: `Duplicate task title: ${task.title}` });
        }
        titleSet.add(task.title);

        if (!getBlueprint(task.assigned_to)) {
          errors.push({ message: `Unknown agent: ${task.assigned_to}` });
        }

        if (!task.acceptance_criteria || task.acceptance_criteria.length === 0) {
          errors.push({ message: `Task '${task.title}' has no acceptance criteria` });
        } else {
          const hasFileCheck = task.acceptance_criteria.some(
            (criterion) => criterion.type === "file_exists" || criterion.type === "file_not_empty" || criterion.type === "directory_exists",
          );
          if (!hasFileCheck) {
            errors.push({
              message: `Task '${task.title}' needs at least one file-based criterion`,
            });
          }
        }
      }

      // ACL: CEO creates plans, so validate CEO can assign to each target
      for (const task of milestone.tasks) {
        if (!canAssignTo("ceo", task.assigned_to)) {
          errors.push({
            message: `CEO cannot assign tasks to '${task.assigned_to}' — not in assignment hierarchy`,
          });
        }
      }

      // Check dependencies against the global title set (cross-milestone deps are valid)
      for (const task of milestone.tasks) {
        for (const dep of task.depends_on) {
          if (!allTitleSet.has(dep)) {
            errors.push({
              message: `Task '${task.title}' references unknown dependency '${dep}'`,
            });
          }
        }
      }

      if (this.has_cycle(milestone.tasks)) {
        errors.push({ message: `Milestone '${milestone.title}' has circular dependencies` });
      }
    }

    return errors;
  }

  ingest_plan(company_id: string, plan: PlanDocument): void {
    const ceo = this.get_ceo(company_id);
    const foundingSet = new Set<string>(FOUNDING_BLUEPRINTS);
    const tx = this.db.transaction(() => {
      for (const blueprintId of (plan.agents_needed ?? [])) {
        // Only activate founding or specialist agents — unknown blueprints are skipped
        if (!foundingSet.has(blueprintId) && !isSpecialistBlueprint(blueprintId)) {
          console.warn(`[plan] Skipping unknown agent "${blueprintId}" in agents_needed for ${company_id}`);
          continue;
        }
        this.activate_agent(company_id, blueprintId);
      }

      // Pre-generate task IDs across ALL milestones so cross-milestone
      // depends_on references resolve correctly at insert time.
      const globalTitleToId = new Map<string, string>();
      for (const milestone of plan.milestones) {
        for (const task of milestone.tasks) {
          if (!globalTitleToId.has(task.title)) {
            globalTitleToId.set(task.title, this.generate_id("task"));
          }
        }
      }

      for (const [index, milestone] of plan.milestones.entries()) {
        const milestoneId = this.generate_id("milestone");
        this.db.run(
          `
            INSERT INTO milestones (
              id, company_id, title, description, sort_order, status, created_by, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
          `,
          [
            milestoneId,
            company_id,
            milestone.title,
            milestone.description,
            index,
            ceo.id,
            isoNow(),
          ],
        );
        this.insert_milestone_tasks(company_id, milestoneId, milestone.tasks, ceo.id, globalTitleToId);
        this.db.enqueue_sync("milestones", milestoneId, "upsert", this.get_milestone(milestoneId));
      }

      this.db.run(`UPDATE companies SET state = 'running', updated_at = ? WHERE id = ?`, [
        isoNow(),
        company_id,
      ]);
      this.db.enqueue_sync("companies", company_id, "upsert", { state: "running", updated_at: isoNow() });
      this.resolve_all_dependencies(company_id);
    });

    tx();
  }

  get_milestone(milestone_id: string): MilestoneRow | undefined {
    return this.db.get<MilestoneRow>(`SELECT * FROM milestones WHERE id = ?`, [milestone_id]);
  }

  insert_milestone_tasks(
    company_id: string,
    milestone_id: string,
    tasks: PlanTaskInput[],
    created_by: string,
    globalTitleToId?: Map<string, string>,
  ): string[] {
    const titleToId = globalTitleToId ?? new Map<string, string>();
    const ids: string[] = [];

    for (const task of tasks) {
      // If a global map was provided, IDs are already generated
      if (!titleToId.has(task.title)) {
        titleToId.set(task.title, this.generate_id("task"));
      }
      ids.push(titleToId.get(task.title)!);
    }

    // Resolve the creator's blueprint for ACL checks
    const creatorAgent = this.get_agent(created_by);
    const creatorBlueprint = creatorAgent?.blueprint_id ?? "ceo";

    for (const task of tasks) {
      const taskId = titleToId.get(task.title);
      if (!taskId) continue;
      const depIds = task.depends_on.map((dep) => {
        const resolved = titleToId.get(dep);
        if (!resolved) {
          throw new Error(`Task '${task.title}' references unknown dependency '${dep}'`);
        }
        return resolved;
      });

      // ACL: check that the creator can assign to this target
      if (!canAssignTo(creatorBlueprint, task.assigned_to)) {
        console.warn(
          `[acl] ${creatorBlueprint} cannot assign to "${task.assigned_to}" — blocking task "${task.title}"`,
        );
        // Insert the task as blocked instead of silently reassigning
        this.db.run(
          `
            INSERT INTO tasks (
              id, company_id, milestone_id, title, description,
              acceptance_criteria, depends_on, owner_agent_id, status,
              blocked_reason, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?)
          `,
          [
            taskId,
            company_id,
            milestone_id,
            task.title,
            task.description,
            JSON.stringify(task.acceptance_criteria),
            JSON.stringify(depIds),
            null,
            `Assignment denied: ${creatorBlueprint} cannot assign to ${task.assigned_to}`,
            created_by,
            isoNow(),
          ],
        );
        this.db.enqueue_sync("tasks", taskId, "upsert", this.get_task(taskId));
        continue;
      }

      const founding = new Set<string>(FOUNDING_BLUEPRINTS);
      let owner = this.find_agent_by_blueprint(company_id, task.assigned_to);
      if (!owner && (founding.has(task.assigned_to) || isSpecialistBlueprint(task.assigned_to))) {
        owner = this.activate_agent(company_id, task.assigned_to);
      }
      if (!owner) {
        // Unknown agent requested — assign to CEO instead
        console.warn(`[plan] Task "${task.title}" assigned to unknown agent "${task.assigned_to}", reassigning to CEO`);
        owner = this.get_ceo(company_id);
      }

      this.db.run(
        `
          INSERT INTO tasks (
            id, company_id, milestone_id, title, description,
            acceptance_criteria, depends_on, owner_agent_id, status, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `,
        [
          taskId,
          company_id,
          milestone_id,
          task.title,
          task.description,
          JSON.stringify(task.acceptance_criteria),
          JSON.stringify(depIds),
          owner.id,
          created_by,
          isoNow(),
        ],
      );
      this.db.enqueue_sync("tasks", taskId, "upsert", this.get_task(taskId));
    }

    return ids;
  }

  validate_and_insert_task(
    company_id: string,
    task_def: PlanTaskInput,
    options: NewTaskInsertOptions,
  ): string {
    // ACL: check that the creator can assign to the target
    const creatorAgent = this.get_agent(options.created_by);
    const creatorBlueprint = creatorAgent?.blueprint_id ?? "ceo";
    if (!canAssignTo(creatorBlueprint, task_def.assigned_to)) {
      console.warn(
        `[acl] ${creatorBlueprint} cannot assign to "${task_def.assigned_to}" — blocking task "${task_def.title}"`,
      );
      const taskId = this.generate_id("task");
      this.db.run(
        `
          INSERT INTO tasks (
            id, company_id, milestone_id, title, description,
            acceptance_criteria, depends_on, owner_agent_id, status,
            blocked_reason, parent_task_id, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, ?)
        `,
        [
          taskId,
          company_id,
          options.milestone_id,
          task_def.title,
          task_def.description,
          JSON.stringify(task_def.acceptance_criteria),
          JSON.stringify([]),
          null,
          `Assignment denied: ${creatorBlueprint} cannot assign to ${task_def.assigned_to}`,
          options.parent_task_id ?? null,
          options.created_by,
          isoNow(),
        ],
      );
      this.db.enqueue_sync("tasks", taskId, "upsert", this.get_task(taskId));
      return taskId;
    }

    const foundingSet = new Set<string>(FOUNDING_BLUEPRINTS);
    let agent = this.find_agent_by_blueprint(company_id, task_def.assigned_to);
    if (!agent && (foundingSet.has(task_def.assigned_to) || isSpecialistBlueprint(task_def.assigned_to))) {
      agent = this.activate_agent(company_id, task_def.assigned_to);
    }
    if (!agent) {
      console.warn(`[task] Task "${task_def.title}" assigned to unknown "${task_def.assigned_to}", reassigning to CEO`);
      agent = this.get_ceo(company_id);
    }
    const taskId = this.generate_id("task");
    const depends_on = this.resolve_company_dependency_ids(company_id, task_def.depends_on, task_def.title);
    this.db.run(
      `
        INSERT INTO tasks (
          id, company_id, milestone_id, title, description,
          acceptance_criteria, depends_on, owner_agent_id, status, parent_task_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `,
      [
        taskId,
        company_id,
        options.milestone_id,
        task_def.title,
        task_def.description,
        JSON.stringify(task_def.acceptance_criteria),
        JSON.stringify(depends_on),
        agent.id,
        options.parent_task_id ?? null,
        options.created_by,
        isoNow(),
      ],
    );
    this.db.enqueue_sync("tasks", taskId, "upsert", this.get_task(taskId));
    return taskId;
  }

  apply_task_update(task_update: TaskUpdateInput): void {
    const current = this.get_task(task_update.id);
    if (!current) {
      throw new Error(`Task ${task_update.id} not found`);
    }

    let owner_agent_id = current.owner_agent_id;
    if (task_update.assigned_to) {
      const currentCompany = this.get_company(current.company_id);
      if (!currentCompany) {
        throw new Error(`Company ${current.company_id} not found`);
      }
      const foundingSet = new Set<string>(FOUNDING_BLUEPRINTS);
      let assignee = this.find_agent_by_blueprint(currentCompany.id, task_update.assigned_to);
      if (!assignee && (foundingSet.has(task_update.assigned_to) || isSpecialistBlueprint(task_update.assigned_to))) {
        assignee = this.activate_agent(currentCompany.id, task_update.assigned_to);
      }
      if (!assignee) {
        console.warn(`[task-update] Reassignment to unknown "${task_update.assigned_to}" blocked, keeping current owner`);
        assignee = this.find_agent_by_blueprint(currentCompany.id, "ceo") ?? this.get_ceo(currentCompany.id);
      }
      owner_agent_id = assignee.id;
    }

    const depends_on = task_update.depends_on
      ? this.resolve_company_dependency_ids(
        current.company_id,
        task_update.depends_on,
        task_update.title ?? current.title,
      )
      : parseJsonArray(current.depends_on);

    this.db.run(
      `
        UPDATE tasks
        SET title = ?,
            description = ?,
            acceptance_criteria = ?,
            depends_on = ?,
            owner_agent_id = ?,
            milestone_id = ?
        WHERE id = ?
      `,
      [
        task_update.title ?? current.title,
        task_update.description ?? current.description,
        JSON.stringify(task_update.acceptance_criteria ?? parseJsonArray(current.acceptance_criteria)),
        JSON.stringify(depends_on),
        owner_agent_id,
        task_update.milestone_id ?? current.milestone_id,
        task_update.id,
      ],
    );
    this.db.enqueue_sync("tasks", task_update.id, "upsert", this.get_task(task_update.id));
  }

  resolve_all_dependencies(company_id: string): void {
    const tasks = this.get_tasks(company_id);
    // Treat both "active" and "done" milestones as schedulable — tasks added
    // to a completed milestone (via CEO plan updates) should still run.
    const schedulableMilestoneIds = new Set(
      this.get_milestones(company_id)
        .filter((milestone) => milestone.status === "active" || milestone.status === "done")
        .map((milestone) => milestone.id),
    );
    const doneSet = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));

    for (const task of tasks) {
      if (task.status === "done" || task.status === "cancelled" || task.status === "failed") {
        continue;
      }

      const deps = parseJsonArray<string>(task.depends_on);
      const allDone = deps.every((dep) => doneSet.has(dep));
      const milestoneSchedulable = schedulableMilestoneIds.has(task.milestone_id);
      const nextStatus: TaskStatus = milestoneSchedulable && allDone ? "ready" : "pending";

      if (task.status !== "in_progress" && task.status !== "blocked" && task.status !== nextStatus) {
        this.db.run(`UPDATE tasks SET status = ? WHERE id = ?`, [nextStatus, task.id]);
        this.db.enqueue_sync("tasks", task.id, "upsert", this.get_task(task.id));
      }
    }
  }

  validate_criteria(criteria: AcceptanceCriterion[], workspaceDir: string): CriterionValidationResult[] {
    return criteria.map((criterion) => {
      try {
        switch (criterion.type) {
          case "file_exists": {
            const path = workspaceToHostPath(workspaceDir, criterion.path);
            return existsSync(path)
              ? { criterion, passed: true }
              : { criterion, passed: false, reason: "File does not exist" };
          }
          case "file_not_empty": {
            const path = workspaceToHostPath(workspaceDir, criterion.path);
            if (!existsSync(path)) {
              return { criterion, passed: false, reason: "File does not exist" };
            }
            const stat = statSync(path);
            return stat.size > 0
              ? { criterion, passed: true }
              : { criterion, passed: false, reason: "File is empty" };
          }
          case "file_contains": {
            const path = workspaceToHostPath(workspaceDir, criterion.path);
            if (!existsSync(path)) {
              return { criterion, passed: false, reason: "File does not exist" };
            }
            const content = readFileSync(path, "utf8");
            return content.includes(criterion.substring)
              ? { criterion, passed: true }
              : { criterion, passed: false, reason: "Substring not found" };
          }
          case "file_count_gte": {
            const root = workspaceDir;
            const regex = globToRegExp(workspaceToHostPath(workspaceDir, criterion.glob));
            const matches = walkFiles(root).filter((file) => regex.test(file));
            return matches.length >= criterion.min
              ? { criterion, passed: true }
              : {
                  criterion,
                  passed: false,
                  reason: `Matched ${matches.length}, expected at least ${criterion.min}`,
                };
          }
          case "command_succeeds": {
            execFileSync("bash", ["-lc", criterion.command], {
              cwd: workspaceDir,
              stdio: "ignore",
              timeout: 30_000,
              maxBuffer: 1024 * 1024,
              env: { ...process.env, HOME: workspaceDir },
            });
            return { criterion, passed: true };
          }
          case "directory_exists": {
            const path = workspaceToHostPath(workspaceDir, criterion.path);
            return existsSync(path) && statSync(path).isDirectory()
              ? { criterion, passed: true }
              : { criterion, passed: false, reason: "Directory does not exist" };
          }
          case "custom":
            return { criterion, passed: true };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { criterion, passed: false, reason: message };
      }
    });
  }

  list_available_blueprints(): AgentBlueprint[] {
    return getAllBlueprints();
  }

  private has_cycle(tasks: PlanTaskInput[]): boolean {
    const graph = new Map<string, string[]>();
    const indegree = new Map<string, number>();

    for (const task of tasks) {
      graph.set(task.title, []);
      indegree.set(task.title, 0);
    }

    for (const task of tasks) {
      for (const dep of task.depends_on) {
        if (!graph.has(dep)) continue;
        graph.get(dep)?.push(task.title);
        indegree.set(task.title, (indegree.get(task.title) ?? 0) + 1);
      }
    }

    const queue = [...indegree.entries()].filter(([, value]) => value === 0).map(([title]) => title);
    let visited = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      visited += 1;
      for (const next of graph.get(current) ?? []) {
        indegree.set(next, (indegree.get(next) ?? 1) - 1);
        if ((indegree.get(next) ?? 0) === 0) {
          queue.push(next);
        }
      }
    }

    return visited !== tasks.length;
  }

  private resolve_company_dependency_ids(
    company_id: string,
    dependencies: string[],
    task_title: string,
  ): string[] {
    return dependencies.map((dependency) => {
      const direct = this.get_task(dependency);
      if (direct && direct.company_id === company_id) {
        return direct.id;
      }

      const matches = this.db.all<Pick<TaskRow, "id">>(
        `SELECT id FROM tasks WHERE company_id = ? AND title = ? ORDER BY created_at ASC`,
        [company_id, dependency],
      );
      if (matches.length === 1) {
        return matches[0].id;
      }
      if (matches.length > 1) {
        throw new Error(
          `Task '${task_title}' references ambiguous dependency title '${dependency}' in company ${company_id}`,
        );
      }

      throw new Error(`Task '${task_title}' references unknown dependency '${dependency}'`);
    });
  }

  private require_blueprint(blueprint_id: string): AgentBlueprint {
    const blueprint = getBlueprint(blueprint_id);
    if (!blueprint) {
      throw new Error(`Unknown blueprint ${blueprint_id}`);
    }
    return blueprint;
  }
}

export function format_task_summaries(tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return "none";
  }
  return tasks
    .map((task) => `[${task.id}] ${task.title} — ${task.status}`)
    .join("; ");
}

export function task_temp_reference(title: string): string {
  return `NEW_${slugify(title)}`;
}

export function relative_artifact_path(workspaceDir: string, absolutePath: string): string {
  return `/workspace/${relative(workspaceDir, absolutePath)}`;
}
