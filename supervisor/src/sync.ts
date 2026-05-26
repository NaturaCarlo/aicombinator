import { SupervisorDb, isoNow } from "./db.js";
import { INTERNAL_RUNTIME_CONTRACT_VERSION } from "./internal-contract.js";
import type {
  AgentRow,
  ApprovalRow,
  CompanyRow,
  CronTaskRow,
  MessageRow,
  MilestoneRow,
  ProvisionCompanyPayload,
  SupervisorConfig,
  SyncQueueRow,
  TaskRow,
  TelemetryMirrorPayload,
  TelemetryMirrorRow,
  TurnLogRow,
} from "./types.js";

// Re-export used types for callers
export type { CompanyRow };

type RemoteRecord =
  | CompanyRow
  | AgentRow
  | TaskRow
  | MilestoneRow
  | ApprovalRow
  | MessageRow
  | CronTaskRow
  | TurnLogRow
  | TelemetryMirrorRow
  | ProvisionCompanyPayload;

interface RemoteFounderChatEntry {
  id: string;
  founderMessage: string;
  ceoReply: string | null;
  createdAt: string;
}

interface RemoteChatMessageEntry {
  id: string;
  role: MessageRow["role"];
  content: string;
  createdAt: string;
  agentId?: string | null;
}

function default_milestone_id(company_id: string): string {
  return `bootstrap-milestone-${company_id}`;
}

function normalize_task_row(
  task: Partial<TaskRow> & Pick<TaskRow, "id" | "company_id" | "title">,
  fallback_milestone_id: string,
  fallback_created_at: string,
): TaskRow {
  const raw_status = typeof (task as Record<string, unknown>).status === "string"
    ? String((task as Record<string, unknown>).status)
    : undefined;
  const normalized_status = raw_status === "todo"
    ? "pending"
    : (raw_status ?? "pending");
  return {
    id: task.id,
    company_id: task.company_id,
    milestone_id: task.milestone_id ?? fallback_milestone_id,
    title: task.title,
    description: task.description ?? null,
    acceptance_criteria:
      task.acceptance_criteria ?? "Produce the requested artifact or a concrete blocking reason.",
    depends_on: task.depends_on ?? "[]",
    owner_agent_id: task.owner_agent_id ?? null,
    status: normalized_status as TaskRow["status"],
    blocked_reason: task.blocked_reason ?? null,
    artifact: task.artifact ?? null,
    credits_spent: task.credits_spent ?? 0,
    turns_spent: task.turns_spent ?? 0,
    parent_task_id: task.parent_task_id ?? null,
    created_by: task.created_by ?? task.owner_agent_id ?? "system",
    created_at: task.created_at ?? fallback_created_at,
    started_at: task.started_at ?? null,
    completed_at: task.completed_at ?? null,
  };
}

export class SyncManager {
  constructor(
    private readonly db: SupervisorDb,
    private readonly config: SupervisorConfig,
  ) {}

  async bootstrapFromRemote(): Promise<CompanyRow[]> {
    const companies = await this.fetch_companies();

    // Flush stale sync queue items (except credit deductions) before overwriting
    // local state from D1. Without this, pending sync items would push stale data
    // back to D1 after the bootstrap overwrites local state.
    const flushTx = this.db.transaction(() => {
      this.db.run(
        `DELETE FROM sync_queue WHERE table_name != 'credit_deduction'`,
      );
    });
    flushTx();

    const remoteIds = new Set(companies.map((c) => c.id));
    const tx = this.db.transaction(() => {
      for (const company of companies) {
        this.db.run(
          `
            INSERT INTO companies (
              id, user_id, name, goal, genesis_prompt, state, container_id, workspace_dir, mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              name = excluded.name,
              goal = excluded.goal,
              genesis_prompt = excluded.genesis_prompt,
              state = excluded.state,
              container_id = excluded.container_id,
              workspace_dir = excluded.workspace_dir,
              mode = excluded.mode,
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
            company.mode ?? "autonomous",
            company.created_at,
            company.updated_at,
          ],
        );
      }

      // Reconcile: delete local companies that no longer exist in D1
      const localCompanies = this.db.all<{ id: string }>(
        `SELECT id FROM companies`,
      );
      for (const local of localCompanies) {
        if (!remoteIds.has(local.id)) {
          console.log(`[sync] Removing orphaned company ${local.id} (not in D1)`);
          for (const table of [
            "turn_log", "approvals", "tasks", "milestones",
            "agents", "cron_tasks", "telemetry_mirror", "ceo_event_queue",
          ]) {
            try { this.db.run(`DELETE FROM ${table} WHERE company_id = ?`, [local.id]); } catch {}
          }
          this.db.run(`DELETE FROM companies WHERE id = ?`, [local.id]);
        }
      }
    });
    tx();

    for (const company of companies) {
      const balance = await this.fetch_credit_balance(company.user_id);
      this.db.run(
        `
          INSERT INTO credit_balances (user_id, balance, reserved_balance, last_synced_at)
          VALUES (?, ?, 0, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            balance = excluded.balance,
            reserved_balance = MIN(COALESCE(credit_balances.reserved_balance, 0), excluded.balance),
            last_synced_at = excluded.last_synced_at
        `,
        [company.user_id, balance, isoNow()],
      );

      const telemetry = await this.fetch_telemetry(company.id);
      const telemetryTx = this.db.transaction(() => {
        for (const row of telemetry) {
          this.db.run(
            `
              INSERT INTO telemetry_mirror (
                id, company_id, kind, status, source, source_event_id,
                verification_level, subject_name, subject_email, amount_cents,
                currency, occurred_at, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                company_id = excluded.company_id,
                kind = excluded.kind,
                status = excluded.status,
                source = excluded.source,
                source_event_id = excluded.source_event_id,
                verification_level = excluded.verification_level,
                subject_name = excluded.subject_name,
                subject_email = excluded.subject_email,
                amount_cents = excluded.amount_cents,
                currency = excluded.currency,
                occurred_at = excluded.occurred_at,
                created_at = excluded.created_at
            `,
            [
              row.id,
              row.company_id,
              row.kind,
              row.status,
              row.source,
              row.source_event_id,
              row.verification_level,
              row.subject_name,
              row.subject_email,
              row.amount_cents,
              row.currency,
              row.occurred_at,
              row.created_at,
            ],
          );
        }
      });
      telemetryTx();

      // Restore agents, milestones, and tasks so a fresh VM can resume work
      const agents = await this.fetch_agents(company.id);
      const agentsTx = this.db.transaction(() => {
        for (const agent of agents) {
          this.db.run(
            `
              INSERT INTO agents (
                id, company_id, blueprint_id, name, role, title, model_tier, status,
                reports_to, session_id, current_task_id, total_credits, total_credits_consumed,
                last_wake_at, last_sleep_at, department, email_address, metadata, icon,
                instructions, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                blueprint_id = excluded.blueprint_id,
                name = excluded.name,
                role = excluded.role,
                title = excluded.title,
                model_tier = excluded.model_tier,
                status = excluded.status,
                reports_to = excluded.reports_to,
                session_id = excluded.session_id,
                current_task_id = excluded.current_task_id,
                total_credits = excluded.total_credits,
                total_credits_consumed = excluded.total_credits_consumed,
                last_wake_at = excluded.last_wake_at,
                last_sleep_at = excluded.last_sleep_at,
                department = excluded.department,
                email_address = excluded.email_address,
                metadata = excluded.metadata,
                icon = excluded.icon,
                instructions = excluded.instructions,
                updated_at = excluded.updated_at
            `,
            [
              agent.id,
              agent.company_id,
              agent.blueprint_id ?? null,
              agent.name,
              agent.role,
              agent.title ?? null,
              agent.model_tier ?? "sonnet",
              agent.status ?? "idle",
              agent.reports_to ?? null,
              agent.session_id ?? null,
              agent.current_task_id ?? null,
              agent.total_credits ?? 0,
              Number((agent as { total_credits_consumed?: number }).total_credits_consumed ?? agent.total_credits ?? 0),
              agent.last_wake_at ?? null,
              agent.last_sleep_at ?? null,
              agent.department ?? null,
              agent.email_address ?? null,
              agent.metadata ?? null,
              agent.icon ?? null,
              (agent as { instructions?: string }).instructions ?? "",
              agent.created_at ?? isoNow(),
              agent.updated_at ?? agent.created_at ?? isoNow(),
            ],
          );
        }
      });
      agentsTx();

      const fetched_milestones = await this.fetch_milestones(company.id);
      const milestones = fetched_milestones.length > 0
        ? fetched_milestones
        : [{
            id: default_milestone_id(company.id),
            company_id: company.id,
            title: "Imported milestone",
            description: "Recovered from mirrored task state during bootstrap.",
            sort_order: 0,
            status: company.state === "running" ? "active" : "pending",
            created_by: "system",
            created_at: company.created_at,
            completed_at: null,
          } satisfies MilestoneRow];
      const milestonesTx = this.db.transaction(() => {
        if (fetched_milestones.length > 0) {
          this.db.run(
            `DELETE FROM milestones WHERE company_id = ? AND id = ?`,
            [company.id, default_milestone_id(company.id)],
          );
        }
        for (const ms of milestones) {
          this.db.run(
            `
              INSERT INTO milestones (
                id, company_id, title, description, sort_order, status,
                created_by, created_at, completed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                completed_at = excluded.completed_at
            `,
            [
              ms.id, ms.company_id, ms.title, ms.description,
              ms.sort_order, ms.status, ms.created_by, ms.created_at,
              ms.completed_at,
            ],
          );
        }
      });
      milestonesTx();

      const raw_tasks = await this.fetch_tasks(company.id);
      const fallback_milestone_id = milestones[0]?.id ?? default_milestone_id(company.id);
      const tasks = raw_tasks.map((task) => normalize_task_row(task, fallback_milestone_id, company.created_at));
      const tasksTx = this.db.transaction(() => {
        for (const task of tasks) {
          this.db.run(
            `
              INSERT INTO tasks (
                id, company_id, milestone_id, title, description,
                acceptance_criteria, depends_on, owner_agent_id, status,
                blocked_reason, artifact, credits_spent, turns_spent,
                created_by, created_at, started_at, completed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                blocked_reason = excluded.blocked_reason,
                artifact = excluded.artifact,
                credits_spent = excluded.credits_spent,
                turns_spent = excluded.turns_spent,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at
            `,
            [
              task.id, task.company_id, task.milestone_id, task.title,
              task.description, task.acceptance_criteria, task.depends_on,
              task.owner_agent_id, task.status, task.blocked_reason,
              task.artifact, task.credits_spent, task.turns_spent,
              task.created_by, task.created_at, task.started_at,
              task.completed_at,
            ],
          );
        }
      });
      tasksTx();

      const cron_tasks = await this.fetch_cron_tasks(company.id);
      const cronTx = this.db.transaction(() => {
        for (const cron of cron_tasks) {
          this.db.run(
            `
              INSERT INTO cron_tasks (
                id, company_id, agent_id, title, description, schedule, prompt, enabled, last_run_at, created_by, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                agent_id = excluded.agent_id,
                title = excluded.title,
                description = excluded.description,
                schedule = excluded.schedule,
                prompt = excluded.prompt,
                enabled = excluded.enabled,
                last_run_at = excluded.last_run_at
            `,
            [
              cron.id,
              cron.company_id,
              cron.agent_id,
              cron.title ?? null,
              cron.description ?? null,
              cron.schedule,
              cron.prompt,
              cron.enabled,
              cron.last_run_at,
              cron.created_by,
              cron.created_at,
            ],
          );
        }
      });
      cronTx();

      const approvals = await this.fetch_approvals(company.id);
      const approvalsTx = this.db.transaction(() => {
        for (const approval of approvals) {
          this.db.run(
            `
              INSERT INTO approvals (
                id, company_id, type, description, related_task_id, status, resolved_at, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                type = excluded.type,
                description = excluded.description,
                related_task_id = excluded.related_task_id,
                status = excluded.status,
                resolved_at = excluded.resolved_at
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
        }
      });
      approvalsTx();

      const founder_chats = await this.fetch_founder_chats(company.id);
      const mirrored_messages = await this.fetch_chat_messages(company.id);
      const ceo = agents.find((agent) => agent.role === "ceo" || agent.blueprint_id === "ceo");
      const messagesTx = this.db.transaction(() => {
        for (const entry of founder_chats) {
          this.db.run(
            `
              INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
              VALUES (?, ?, NULL, 'user', ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                content = excluded.content,
                created_at = excluded.created_at
            `,
            [`${entry.id}:user`, company.id, entry.founderMessage, entry.createdAt],
          );
          if (entry.ceoReply?.trim()) {
            this.db.run(
              `
                INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
                VALUES (?, ?, ?, 'ceo', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  agent_id = excluded.agent_id,
                  content = excluded.content,
                  created_at = excluded.created_at
              `,
              [`${entry.id}:ceo`, company.id, ceo?.id ?? null, entry.ceoReply, entry.createdAt],
            );
          }
        }
        for (const entry of mirrored_messages) {
          this.db.run(
            `
              INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                agent_id = excluded.agent_id,
                role = excluded.role,
                content = excluded.content,
                created_at = excluded.created_at
            `,
            [
              entry.id,
              company.id,
              entry.agentId ?? null,
              entry.role,
              entry.content,
              entry.createdAt,
            ],
          );
        }
      });
      messagesTx();
    }

    return companies;
  }

  async run_sync_cycle(): Promise<void> {
    const pending = this.db.get_pending_sync_items(100);
    for (const item of pending) {
      try {
        await this.push_to_d1(item);
        this.db.delete_sync_item(item.id);
      } catch (error) {
        // Standard exponential backoff: 5s, 10s, 20s, 40s, 80s (capped at 5 min)
        const next_delay_s = Math.min(300, 5 * 2 ** item.attempts);
        const next_attempt_at = new Date(Date.now() + next_delay_s * 1000).toISOString();
        const message = error instanceof Error ? error.message : String(error);
        this.db.update_sync_failure(item.id, item.attempts + 1, message, next_attempt_at);
      }
    }

    this.db.prune_dead_sync_items();
  }

  /**
   * Push company state to D1 synchronously (bypasses the async queue).
   * Used for pause/resume where the worker is waiting for the supervisor to
   * confirm and D1 must be up-to-date before the response is sent.
   */
  async push_company_now(company_id: string, payload: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `/api/supervisor/companies/${company_id}`, payload);
  }

  /**
   * Push agent state to D1 synchronously (bypasses the async queue).
   * Mirrors the agent-sync logic from push_to_d1 but callable directly.
   */
  async push_agent_now(agent_id: string, payload: { status?: string; current_task_id?: string | null }): Promise<void> {
    const patchPayload: Record<string, unknown> = {};
    if (payload.status !== undefined) patchPayload.status = payload.status;
    if (payload.current_task_id !== undefined) patchPayload.current_task_id = payload.current_task_id;
    await this.request("PATCH", `/api/supervisor/agents/${agent_id}`, patchPayload).catch((error) => {
      if (!this.is_not_found_error(error)) throw error;
      // Agent doesn't exist in D1 yet — skip, the next full sync will create it
    });
  }

  async fetch_credit_balance(user_id: string): Promise<number> {
    const response = await this.request<{ balance: number }>(
      "GET",
      `/api/supervisor/credits/${encodeURIComponent(user_id)}`,
    );
    return response.balance;
  }

  async fetch_company(company_id: string): Promise<CompanyRow> {
    const response = await this.request<{ company?: Partial<CompanyRow> } | Partial<CompanyRow>>(
      "GET",
      `/api/supervisor/companies/${company_id}/info`,
    );
    const raw = ("company" in (response as Record<string, unknown>))
      ? (response as { company?: Partial<CompanyRow> }).company
      : (response as Partial<CompanyRow>);
    if (!raw?.id || !raw.user_id || !raw.name) {
      throw new Error(`GET /api/supervisor/companies/${company_id}/info failed: invalid company payload`);
    }
    return {
      id: raw.id,
      user_id: raw.user_id,
      name: raw.name,
      goal: raw.goal ?? null,
      genesis_prompt: raw.genesis_prompt ?? null,
      state: raw.state ?? "provisioning",
      container_id: raw.container_id ?? null,
      workspace_dir: raw.workspace_dir ?? null,
      mode: raw.mode === "manual" ? "manual" : "autonomous",
      created_at: raw.created_at ?? isoNow(),
      updated_at: raw.updated_at ?? raw.created_at ?? isoNow(),
    };
  }

  async fetch_companies(): Promise<CompanyRow[]> {
    const search = new URLSearchParams();
    if (this.config.scopeUserId) {
      search.set("userId", this.config.scopeUserId);
    }
    const path = search.size > 0
      ? `/api/supervisor/companies?${search.toString()}`
      : "/api/supervisor/companies";
    const response = await this.request<{ companies?: Partial<CompanyRow>[] } | Partial<CompanyRow>[]>("GET", path);
    const raw = Array.isArray(response) ? response : response.companies ?? [];
    const now = isoNow();
    return raw
      .filter((c): c is Partial<CompanyRow> & { id: string; user_id: string; name: string } =>
        Boolean(c.id && c.user_id && c.name))
      .map((c) => ({
        id: c.id,
        user_id: c.user_id,
        name: c.name,
        goal: c.goal ?? null,
        genesis_prompt: c.genesis_prompt ?? null,
        state: c.state ?? "provisioning",
        container_id: c.container_id ?? null,
        workspace_dir: c.workspace_dir ?? null,
        mode: c.mode === "manual" ? "manual" : "autonomous",
        created_at: c.created_at ?? now,
        updated_at: c.updated_at ?? c.created_at ?? now,
      }));
  }

  async fetch_agents(company_id: string): Promise<AgentRow[]> {
    const response = await this.request<{ agents?: AgentRow[] } | AgentRow[]>(
      "GET",
      `/api/supervisor/companies/${company_id}/agents`,
    );
    return Array.isArray(response) ? response : response.agents ?? [];
  }

  async fetch_milestones(company_id: string): Promise<MilestoneRow[]> {
    try {
      const response = await this.request<{ milestones?: MilestoneRow[] } | MilestoneRow[]>(
        "GET",
        `/api/supervisor/companies/${company_id}/milestones`,
      );
      return Array.isArray(response) ? response : response.milestones ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(" 404 ")) {
        return [];
      }
      throw error;
    }
  }

  async fetch_tasks(company_id: string): Promise<TaskRow[]> {
    const response = await this.request<{ tasks?: TaskRow[] } | TaskRow[]>(
      "GET",
      `/api/supervisor/companies/${company_id}/tasks`,
    );
    return Array.isArray(response) ? response : response.tasks ?? [];
  }

  async fetch_cron_tasks(company_id: string): Promise<CronTaskRow[]> {
    const response = await this.request<{ tasks?: Array<Partial<CronTaskRow>> } | Array<Partial<CronTaskRow>>>(
      "GET",
      `/api/supervisor/cron-tasks?companyId=${encodeURIComponent(company_id)}`,
    );
    const rows = Array.isArray(response) ? response : response.tasks ?? [];
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      company_id: String(row.company_id ?? company_id),
      agent_id: String(row.agent_id ?? ""),
      title: typeof row.title === "string" ? row.title : null,
      description: typeof row.description === "string" ? row.description : null,
      schedule: String(row.schedule ?? ""),
      prompt: String(row.prompt ?? ""),
      enabled: Number(row.enabled ?? 1),
      last_run_at: typeof row.last_run_at === "string" ? row.last_run_at : null,
      created_by: typeof row.created_by === "string" ? row.created_by : "system",
      created_at: typeof row.created_at === "string" ? row.created_at : isoNow(),
    }));
  }

  async fetch_approvals(company_id: string): Promise<ApprovalRow[]> {
    const response = await this.request<{ approvals?: ApprovalRow[] } | ApprovalRow[]>(
      "GET",
      `/api/supervisor/companies/${company_id}/approvals`,
    );
    return Array.isArray(response) ? response : response.approvals ?? [];
  }

  async fetch_founder_chats(company_id: string): Promise<RemoteFounderChatEntry[]> {
    const response = await this.request<{ entries?: RemoteFounderChatEntry[] } | RemoteFounderChatEntry[]>(
      "GET",
      `/api/supervisor/companies/${company_id}/founder-chats?limit=50`,
    );
    return Array.isArray(response) ? response : response.entries ?? [];
  }

  async fetch_chat_messages(company_id: string): Promise<RemoteChatMessageEntry[]> {
    const response = await this.request<{ messages?: RemoteChatMessageEntry[] } | RemoteChatMessageEntry[]>(
      "GET",
      `/api/supervisor/companies/${company_id}/chat-messages`,
    );
    return Array.isArray(response) ? response : response.messages ?? [];
  }

  async fetch_telemetry(company_id: string): Promise<TelemetryMirrorPayload[]> {
    const response = await this.request<{ telemetry?: TelemetryMirrorPayload[] } | TelemetryMirrorPayload[]>(
      "GET",
      `/api/supervisor/companies/${company_id}/telemetry?scope=verified`,
    );
    return Array.isArray(response) ? response : response.telemetry ?? [];
  }

  private async push_to_d1(item: SyncQueueRow): Promise<void> {
    const payload = JSON.parse(item.payload) as Record<string, unknown>;

    switch (item.table_name) {
      case "credit_deduction": {
        await this.request(
          "POST",
          `/api/supervisor/credits/${encodeURIComponent(item.record_id)}/deduct`,
          payload,
        );
        return;
      }
      case "credit_balance":
      case "credit_initialization":
      case "credit_exhausted": {
        // The Worker ledger is authoritative. These legacy sync item types are
        // intentionally ignored so a stale local snapshot can never overwrite
        // D1 balance without a matching credit_events ledger row.
        return;
      }
      case "companies": {
        await this.request("PATCH", `/api/supervisor/companies/${item.record_id}`, payload);
        return;
      }
      case "agents": {
        // PATCH expects { status?, metadataPatch?, lastWakeAt?, lastSleepAt?, reportsTo? }
        const patchPayload: Record<string, unknown> = {};
        if (payload.status !== undefined) patchPayload.status = payload.status;
        if (payload.metadata !== undefined) {
          try {
            patchPayload.metadataPatch = typeof payload.metadata === "string"
              ? JSON.parse(payload.metadata)
              : payload.metadata;
          } catch {
            // Skip corrupted metadata
          }
        }
        if (payload.last_wake_at !== undefined) patchPayload.lastWakeAt = payload.last_wake_at;
        if (payload.last_sleep_at !== undefined) patchPayload.lastSleepAt = payload.last_sleep_at;
        if (payload.reports_to !== undefined) patchPayload.reportsTo = payload.reports_to;

        try {
          await this.request("PATCH", `/api/supervisor/agents/${item.record_id}`, patchPayload);
        } catch (error) {
          if (!this.is_not_found_error(error)) {
            throw error;
          }
          // Agent doesn't exist in D1 — look up full agent data from local DB
          const localAgent = this.db.get<Record<string, unknown>>(
            `SELECT * FROM agents WHERE id = ?`,
            [item.record_id],
          );
          const agentData = localAgent ?? payload;
          const company_id = String(agentData.company_id ?? payload.company_id ?? "");
          // POST expects camelCase: { id, blueprintId, name, role, title, department, reportsTo, modelTier }
          const createPayload = {
            id: agentData.id ?? item.record_id,
            blueprintId: agentData.blueprint_id ?? null,
            name: agentData.name ?? "Agent",
            role: agentData.role ?? "specialist",
            title: agentData.title ?? agentData.name ?? "Agent",
            department: agentData.department ?? "operations",
            reportsTo: agentData.reports_to ?? null,
            modelTier: agentData.model_tier ?? "sonnet",
          };
          await this.request("POST", `/api/supervisor/companies/${company_id}/agents`, createPayload);
        }
        return;
      }
      case "tasks": {
        const company_id = String(payload.company_id ?? "");
        // PATCH expects snake_case fields matching D1 columns, blocked_reason → blocked_on
        const taskPatch: Record<string, unknown> = { ...payload };
        // Worker maps blocked_reason → blocked_on
        if (payload.blocked_reason !== undefined) {
          taskPatch.blocked_reason = payload.blocked_reason;
        }
        try {
          await this.request("PATCH", `/api/supervisor/tasks/${item.record_id}`, taskPatch);
        } catch (error) {
          if (!this.is_not_found_error(error)) {
            throw error;
          }
          await this.request("POST", `/api/supervisor/companies/${company_id}/tasks`, taskPatch);
        }
        return;
      }
      case "messages": {
        if (payload.role !== "ceo") {
          return;
        }
        const company_id = String(payload.company_id ?? "");
        await this.request("POST", `/api/supervisor/companies/${company_id}/chat-messages`, payload);
        return;
      }
      case "approvals": {
        const company_id = String(payload.company_id ?? "");
        // Worker expects camelCase: requestedByAgentId, resolved_at → decided_at
        const approvalPayload: Record<string, unknown> = {
          ...payload,
          requestedByAgentId: payload.requested_by_agent_id ?? payload.requestedByAgentId ?? null,
        };
        if (payload.resolved_at !== undefined) {
          approvalPayload.resolved_at = payload.resolved_at;
        }
        await this.request("POST", `/api/supervisor/companies/${company_id}/approvals`, approvalPayload);
        return;
      }
      case "cron_tasks":
      case "cron-tasks": {
        if (item.operation === "delete") {
          await this.request("PATCH", `/api/supervisor/cron-tasks/${item.record_id}`, { enabled: false });
        } else {
          await this.request("POST", "/api/supervisor/cron-tasks", payload);
        }
        return;
      }
      case "turn_log":
      case "activity":
      case "activity_log": {
        const company_id = String(payload.company_id ?? "");
        // Worker expects { id?, type, summary, details? }
        // turn_log has { agent_id, task_id, output_summary, credits_spent, ... }
        const activityPayload = {
          id: item.table_name === "turn_log" ? `turn_${item.record_id}` : (payload.id ?? undefined),
          type: String(payload.type ?? "agent_turn"),
          summary: String(
            payload.summary
            ?? payload.output_summary
            ?? `Agent turn completed (${Number(payload.credits_spent ?? 0).toFixed(1)} credits)`,
          ),
          details: payload.details ?? {
            agent_id: payload.agent_id,
            task_id: payload.task_id,
            credits_spent: payload.credits_spent,
            input_tokens: payload.input_tokens,
            output_tokens: payload.output_tokens,
            duration_ms: payload.duration_ms,
          },
        };
        await this.request("POST", `/api/supervisor/companies/${company_id}/activity`, activityPayload);
        return;
      }
      case "telemetry": {
        const company_id = String(payload.company_id ?? "");
        await this.request("POST", `/api/supervisor/companies/${company_id}/telemetry`, payload);
        return;
      }
      case "milestones": {
        const company_id = String(payload.company_id ?? "");
        try {
          await this.request("PATCH", `/api/supervisor/milestones/${item.record_id}`, payload);
        } catch (error) {
          if (!this.is_not_found_error(error)) {
            throw error;
          }
          await this.request("POST", `/api/supervisor/companies/${company_id}/milestones`, payload);
        }
        return;
      }
      case "agent_skills": {
        // record_id is agent_id; payload is { skills: [...] }
        const skills = Array.isArray(payload.skills) ? payload.skills : [];
        await this.request("POST", `/api/supervisor/agents/${item.record_id}/skills`, { skills });
        return;
      }
      default:
        return;
    }
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(new URL(path, this.config.workerApiUrl), {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Supervisor-Key": this.config.internalApiKey,
        "X-AIC-Contract-Version": INTERNAL_RUNTIME_CONTRACT_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return await response.json() as T;
  }

  private is_not_found_error(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(" failed: 404 ");
  }
}
