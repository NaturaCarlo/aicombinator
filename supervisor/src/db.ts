import BetterSqlite3 from "better-sqlite3";
import type { Database as BetterSqlite3Database, RunResult, Statement } from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { SyncQueueRow } from "./types.js";

export const SUPERVISOR_SCHEMA_SQL = String.raw`
------------------------------------------------------------
-- COMPANIES
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  goal          TEXT,
  genesis_prompt TEXT,
  state         TEXT NOT NULL DEFAULT 'provisioning',
  container_id  TEXT,
  workspace_dir TEXT,
  mode          TEXT NOT NULL DEFAULT 'autonomous',
  planning_failures INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

------------------------------------------------------------
-- AGENTS
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  blueprint_id    TEXT,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  title           TEXT,
  model_tier      TEXT NOT NULL DEFAULT 'sonnet',
  status          TEXT NOT NULL DEFAULT 'idle',
  reports_to      TEXT,
  session_id      TEXT,
  current_task_id TEXT REFERENCES tasks(id),
  total_credits   REAL NOT NULL DEFAULT 0,
  total_credits_consumed INTEGER NOT NULL DEFAULT 0,
  last_wake_at    TEXT,
  last_sleep_at   TEXT,
  department      TEXT,
  email_address   TEXT,
  metadata        TEXT,
  icon            TEXT,
  webhook_url     TEXT,
  adapter_type    TEXT,
  instructions    TEXT NOT NULL DEFAULT '',
  system_prompt   TEXT,
  source          TEXT NOT NULL DEFAULT 'internal',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

------------------------------------------------------------
-- MILESTONES
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS milestones (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id),
  title        TEXT NOT NULL,
  description  TEXT,
  sort_order   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);

------------------------------------------------------------
-- TASKS (core data structure)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  milestone_id        TEXT NOT NULL REFERENCES milestones(id),
  title               TEXT NOT NULL,
  description         TEXT,
  acceptance_criteria TEXT NOT NULL,
  depends_on          TEXT NOT NULL DEFAULT '[]',
  owner_agent_id      TEXT REFERENCES agents(id),
  status              TEXT NOT NULL DEFAULT 'pending',
  blocked_reason      TEXT,
  artifact            TEXT,
  credits_spent       REAL NOT NULL DEFAULT 0,
  turns_spent         INTEGER NOT NULL DEFAULT 0,
  parent_task_id      TEXT REFERENCES tasks(id),
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(company_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON tasks(milestone_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_agent_id, status);

------------------------------------------------------------
-- CREDIT BALANCES (local working copy)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_balances (
  user_id        TEXT PRIMARY KEY,
  balance        REAL NOT NULL DEFAULT 0,
  reserved_balance REAL NOT NULL DEFAULT 0,
  last_synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_reservations (
  user_id          TEXT NOT NULL,
  company_id       TEXT NOT NULL REFERENCES companies(id),
  reserved_balance REAL NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_credit_reservations_user
  ON credit_reservations(user_id, company_id);

------------------------------------------------------------
-- TURN LOG (for stall detection and auditing)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS turn_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  task_id             TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  credits_spent       REAL NOT NULL DEFAULT 0,
  tool_call_count     INTEGER NOT NULL DEFAULT 0,
  artifact_changed    BOOLEAN NOT NULL DEFAULT 0,
  agent_declared_done BOOLEAN NOT NULL DEFAULT 0,
  output_summary      TEXT,
  error               TEXT,
  duration_ms         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_log_task ON turn_log(task_id, created_at);

------------------------------------------------------------
-- CEO EVENT QUEUE (holds events when CEO is busy)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ceo_event_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload    TEXT NOT NULL,
  delivered  BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ceo_events_pending ON ceo_event_queue(company_id, delivered, created_at);

------------------------------------------------------------
-- MESSAGES (CEO ↔ user chat, synced to dashboard)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  agent_id   TEXT,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_company ON messages(company_id, created_at);

------------------------------------------------------------
-- CRON TASKS (recurring work, see Section 13)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_tasks (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  title       TEXT,
  description TEXT,
  schedule    TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  enabled     BOOLEAN DEFAULT 1,
  last_run_at TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

------------------------------------------------------------
-- APPROVALS (CEO-created requests for user input)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  type            TEXT NOT NULL,
  description     TEXT NOT NULL,
  related_task_id TEXT REFERENCES tasks(id),
  status          TEXT NOT NULL DEFAULT 'pending',
  resolved_at     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(company_id, status);

------------------------------------------------------------
-- TELEMETRY MIRROR (pushed from Worker, read-only locally)
-- See SUPERVISOR-SPEC-GAPS.md Section 2.8 for full details.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_mirror (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  kind               TEXT NOT NULL,
  status             TEXT NOT NULL,
  source             TEXT NOT NULL,
  source_event_id    TEXT NOT NULL,
  verification_level TEXT NOT NULL,
  subject_name       TEXT,
  subject_email      TEXT,
  amount_cents       INTEGER,
  currency           TEXT,
  occurred_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_mirror_company
  ON telemetry_mirror(company_id, kind, occurred_at DESC);

------------------------------------------------------------
-- SYNC QUEUE (outbound to D1)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name      TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  operation       TEXT NOT NULL,
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_pending ON sync_queue(next_attempt_at)
  WHERE attempts < max_attempts;

------------------------------------------------------------
-- AGENT SESSIONS (persisted across supervisor restarts)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_id    TEXT PRIMARY KEY,
  session_id  TEXT,
  turn_count  INTEGER NOT NULL DEFAULT 0,
  credits_spent REAL NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

------------------------------------------------------------
-- AGENT SKILLS (skills associated with each agent)
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  skill_slug    TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  instructions  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill_slug)
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id);
`;

export function isoNow(): string {
  return new Date().toISOString();
}

export class SupervisorDb {
  readonly sqlite: BetterSqlite3Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new BetterSqlite3(dbPath);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  migrate(): void {
    this.apply_legacy_schema_compatibility();
    try {
      this.sqlite.exec(SUPERVISOR_SCHEMA_SQL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("no such column: max_attempts")) {
        throw error;
      }

      // Older supervisor DBs can have a pre-V2 sync_queue shape. If index
      // creation races ahead of column backfill, repair the legacy table and
      // retry the schema bootstrap instead of crash-looping the VM.
      if (this.table_exists("sync_queue")) {
        this.ensure_column("sync_queue", "operation", "TEXT NOT NULL DEFAULT 'upsert'");
        this.ensure_column("sync_queue", "payload", "TEXT NOT NULL DEFAULT '{}'");
        this.ensure_column("sync_queue", "max_attempts", "INTEGER NOT NULL DEFAULT 5");
        this.ensure_column("sync_queue", "last_error", "TEXT");
        this.ensure_column("sync_queue", "created_at", "TEXT");
        this.sqlite.exec(`DROP INDEX IF EXISTS idx_sync_pending`);
      }

      this.sqlite.exec(SUPERVISOR_SCHEMA_SQL);
    }
    this.backfill_legacy_defaults();
  }

  close(): void {
    this.sqlite.close();
  }

  prepare(sql: string): Statement {
    return this.sqlite.prepare(sql);
  }

  private table_exists(table_name: string): boolean {
    const row = this.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table_name) as { name?: string } | undefined;
    return Boolean(row?.name);
  }

  private column_exists(table_name: string, column_name: string): boolean {
    if (!this.table_exists(table_name)) {
      return false;
    }
    const rows = this.sqlite.prepare(`PRAGMA table_info('${table_name.replace(/'/g, "''")}')`).all() as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === column_name);
  }

  private ensure_column(table_name: string, column_name: string, definition: string): void {
    if (this.column_exists(table_name, column_name)) {
      return;
    }
    this.sqlite.exec(`ALTER TABLE ${table_name} ADD COLUMN ${column_name} ${definition}`);
  }

  private apply_legacy_schema_compatibility(): void {
    if (this.table_exists("companies")) {
      this.ensure_column("companies", "genesis_prompt", "TEXT");
      this.ensure_column("companies", "workspace_dir", "TEXT");
      this.ensure_column("companies", "created_at", "TEXT");
      this.ensure_column("companies", "hosting_status", "TEXT DEFAULT 'none'");
      this.ensure_column("companies", "hosting_type", "TEXT DEFAULT 'none'");
      this.ensure_column("companies", "hosting_slug", "TEXT");
      this.ensure_column("companies", "hosting_port", "INTEGER");
      this.ensure_column("companies", "mode", "TEXT NOT NULL DEFAULT 'autonomous'");
      this.ensure_column("companies", "planning_failures", "INTEGER NOT NULL DEFAULT 0");
    }

    if (this.table_exists("agents")) {
      this.ensure_column("agents", "title", "TEXT");
      this.ensure_column("agents", "session_id", "TEXT");
      this.ensure_column("agents", "current_task_id", "TEXT");
      this.ensure_column("agents", "total_credits", "REAL NOT NULL DEFAULT 0");
      this.ensure_column("agents", "total_credits_consumed", "INTEGER NOT NULL DEFAULT 0");
      this.ensure_column("agents", "last_wake_at", "TEXT");
      this.ensure_column("agents", "last_sleep_at", "TEXT");
      this.ensure_column("agents", "department", "TEXT");
      this.ensure_column("agents", "email_address", "TEXT");
      this.ensure_column("agents", "metadata", "TEXT");
      this.ensure_column("agents", "icon", "TEXT");
      this.ensure_column("agents", "webhook_url", "TEXT");
      this.ensure_column("agents", "adapter_type", "TEXT");
      this.ensure_column("agents", "instructions", "TEXT NOT NULL DEFAULT ''");
      this.ensure_column("agents", "system_prompt", "TEXT");
      this.ensure_column("agents", "source", "TEXT NOT NULL DEFAULT 'internal'");
      this.ensure_column("agents", "created_at", "TEXT");
      this.ensure_column("agents", "updated_at", "TEXT");
    }

    if (this.table_exists("tasks")) {
      this.ensure_column("tasks", "milestone_id", "TEXT");
      this.ensure_column("tasks", "acceptance_criteria", "TEXT NOT NULL DEFAULT ''");
      this.ensure_column("tasks", "depends_on", "TEXT NOT NULL DEFAULT '[]'");
      this.ensure_column("tasks", "credits_spent", "REAL NOT NULL DEFAULT 0");
      this.ensure_column("tasks", "turns_spent", "INTEGER NOT NULL DEFAULT 0");
      this.ensure_column("tasks", "parent_task_id", "TEXT");
      this.ensure_column("tasks", "started_at", "TEXT");
      this.ensure_column("tasks", "completed_at", "TEXT");
    }

    if (this.table_exists("credit_balances")) {
      // Old schema used `updated_at`; current schema uses `last_synced_at`.
      // Drop and recreate if the old column exists — the table is a cache
      // that gets repopulated from D1 on bootstrap.
      if (this.column_exists("credit_balances", "updated_at")) {
        this.sqlite.exec(`DROP TABLE credit_balances`);
      } else {
        this.ensure_column("credit_balances", "reserved_balance", "REAL NOT NULL DEFAULT 0");
        this.ensure_column("credit_balances", "last_synced_at", "TEXT NOT NULL DEFAULT ''");
      }
    }

    if (this.table_exists("credit_reservations")) {
      this.ensure_column("credit_reservations", "updated_at", "TEXT NOT NULL DEFAULT ''");
    }

    if (this.table_exists("cron_tasks")) {
      this.ensure_column("cron_tasks", "title", "TEXT");
      this.ensure_column("cron_tasks", "description", "TEXT");
    }

    if (this.table_exists("sync_queue")) {
      this.rebuild_legacy_sync_queue_if_needed();
      this.ensure_column("sync_queue", "operation", "TEXT NOT NULL DEFAULT 'upsert'");
      this.ensure_column("sync_queue", "payload", "TEXT NOT NULL DEFAULT '{}'");
      this.ensure_column("sync_queue", "max_attempts", "INTEGER NOT NULL DEFAULT 5");
      this.ensure_column("sync_queue", "last_error", "TEXT");
      this.ensure_column("sync_queue", "created_at", "TEXT");
    }
  }

  private rebuild_legacy_sync_queue_if_needed(): void {
    const has_table_name = this.column_exists("sync_queue", "table_name");
    const has_record_id = this.column_exists("sync_queue", "record_id");
    if (has_table_name && has_record_id) {
      return;
    }

    const now = isoNow();
    this.sqlite.exec(`
      DROP INDEX IF EXISTS idx_sync_pending;
      ALTER TABLE sync_queue RENAME TO sync_queue_legacy;
      CREATE TABLE sync_queue (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name      TEXT NOT NULL,
        record_id       TEXT NOT NULL,
        operation       TEXT NOT NULL,
        payload         TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        max_attempts    INTEGER NOT NULL DEFAULT 5,
        last_error      TEXT,
        next_attempt_at TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
    `);

    const legacy_rows = this.all<{
      id: string | number | null;
      method?: string | null;
      path?: string | null;
      body_json?: string | null;
      entity_type?: string | null;
      operation?: string | null;
      payload?: string | null;
      attempts?: number | null;
      max_attempts?: number | null;
      last_error?: string | null;
      next_attempt_at?: string | null;
      created_at?: string | null;
    }>(`SELECT * FROM sync_queue_legacy`);

    const insert = this.prepare(`
      INSERT INTO sync_queue (
        table_name, record_id, operation, payload,
        attempts, max_attempts, last_error, next_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of legacy_rows) {
      const table_name = row.entity_type ?? "unknown";
      const record_id = row.id != null ? String(row.id) : `${table_name}:${row.path ?? "legacy"}`;
      const operation =
        row.operation ??
        (row.method?.toUpperCase() === "DELETE" ? "delete" : "upsert");
      const payload = row.payload ?? row.body_json ?? "{}";
      insert.run(
        table_name,
        record_id,
        operation,
        payload,
        row.attempts ?? 0,
        row.max_attempts ?? 5,
        row.last_error ?? null,
        row.next_attempt_at ?? now,
        row.created_at ?? now,
      );
    }

    this.sqlite.exec(`DROP TABLE sync_queue_legacy;`);
  }

  private backfill_legacy_defaults(): void {
    const now = isoNow();

    if (this.column_exists("companies", "created_at")) {
      if (this.column_exists("companies", "updated_at")) {
        this.sqlite.exec(`
          UPDATE companies
          SET created_at = COALESCE(created_at, updated_at, '${now}')
          WHERE created_at IS NULL
        `);
      } else {
        this.sqlite.exec(`
          UPDATE companies
          SET created_at = COALESCE(created_at, '${now}')
          WHERE created_at IS NULL
        `);
      }
    }

    if (this.column_exists("agents", "created_at")) {
      if (this.column_exists("agents", "updated_at")) {
        this.sqlite.exec(`
          UPDATE agents
          SET created_at = COALESCE(created_at, updated_at, '${now}')
          WHERE created_at IS NULL
        `);
      } else {
        this.sqlite.exec(`
          UPDATE agents
          SET created_at = COALESCE(created_at, '${now}')
          WHERE created_at IS NULL
        `);
      }
    }

    if (this.column_exists("agents", "total_credits") && this.column_exists("agents", "total_credits_consumed")) {
      this.sqlite.exec(`
        UPDATE agents
        SET total_credits = COALESCE(total_credits, total_credits_consumed, 0)
        WHERE total_credits IS NULL OR total_credits = 0
      `);
    }

    if (this.table_exists("milestones") && this.column_exists("tasks", "milestone_id")) {
      const companies = this.all<{ id: string; created_at: string | null }>(
        `SELECT id, created_at FROM companies`,
      );
      for (const company of companies) {
        const milestone = this.get<{ id: string }>(
          `SELECT id FROM milestones WHERE company_id = ? ORDER BY sort_order ASC LIMIT 1`,
          [company.id],
        );
        let milestone_id = milestone?.id;
        if (!milestone_id) {
          milestone_id = `milestone_bootstrap_${company.id}`;
          this.run(
            `INSERT INTO milestones (
              id, company_id, title, description, sort_order, status, created_by, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            [
              milestone_id,
              company.id,
              "Bootstrap",
              "Recovered legacy milestone",
              1,
              "active",
              "system",
              company.created_at ?? now,
            ],
          );
        }
        this.run(
          `UPDATE tasks SET milestone_id = ? WHERE company_id = ? AND (milestone_id IS NULL OR milestone_id = '')`,
          [milestone_id, company.id],
        );
      }
    }

    if (this.column_exists("tasks", "acceptance_criteria")) {
      this.sqlite.exec(`
        UPDATE tasks
        SET acceptance_criteria = 'Complete the assigned work and leave a concrete artifact in the workspace.'
        WHERE acceptance_criteria IS NULL OR TRIM(acceptance_criteria) = ''
      `);
    }

    if (this.column_exists("tasks", "depends_on")) {
      this.sqlite.exec(`
        UPDATE tasks
        SET depends_on = '[]'
        WHERE depends_on IS NULL OR TRIM(depends_on) = ''
      `);
    }

    if (this.column_exists("credit_balances", "reserved_balance")) {
      this.sqlite.exec(`
        UPDATE credit_balances
        SET reserved_balance = CASE
          WHEN reserved_balance IS NULL OR reserved_balance < 0 THEN 0
          WHEN reserved_balance > balance THEN balance
          ELSE reserved_balance
        END
      `);
    }

    if (this.table_exists("credit_reservations")) {
      this.sqlite.exec(`
        DELETE FROM credit_reservations
        WHERE reserved_balance IS NULL OR reserved_balance <= 0
      `);
    }
  }

  run(sql: string, params: unknown[] = []): RunResult {
    return this.sqlite.prepare(sql).run(...params);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): () => T {
    return this.sqlite.transaction(fn);
  }

  enqueue_sync(
    table_name: string,
    record_id: string,
    operation: "upsert" | "delete",
    payload: unknown,
    next_attempt_at = isoNow(),
  ): number {
    // Credit deductions are cumulative (amounts add up), so they must never be
    // merged or superseded — each one represents a distinct charge.
    const is_cumulative = table_name === "credit_deduction";

    let merged_payload = payload as Record<string, unknown>;

    if (!is_cumulative) {
      // For state-sync items (agents, tasks, companies, etc.), merge any older
      // pending items for the same record into this one and delete them.  This
      // prevents out-of-order replay: if an older item fails and retries after
      // a newer item succeeds, it would overwrite D1 with stale data.  By
      // merging old fields into the newest payload, we guarantee the queue
      // contains at most one item per (table_name, record_id) and it always
      // carries the most recent state.
      const older = this.all<{ id: number; payload: string }>(
        `SELECT id, payload FROM sync_queue
         WHERE table_name = ? AND record_id = ? AND operation = ?
         ORDER BY created_at ASC`,
        [table_name, record_id, operation],
      );
      if (older.length > 0) {
        // Start from oldest, layer on newer, then layer on the incoming payload
        // so the newest fields always win.
        let base: Record<string, unknown> = {};
        for (const row of older) {
          try {
            const old_payload = JSON.parse(row.payload) as Record<string, unknown>;
            base = { ...base, ...old_payload };
          } catch { /* skip malformed */ }
        }
        merged_payload = { ...base, ...(payload as Record<string, unknown>) };
        // Delete the older items
        for (const row of older) {
          this.run(`DELETE FROM sync_queue WHERE id = ?`, [row.id]);
        }
      }
    }

    const created_at = isoNow();
    const max_attempts = table_name === "credit_deduction" ? 20 : 5;
    const result = this.run(
      `
        INSERT INTO sync_queue (
          table_name, record_id, operation, payload,
          attempts, max_attempts, last_error, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)
      `,
      [table_name, record_id, operation, JSON.stringify(merged_payload), max_attempts, next_attempt_at, created_at],
    );
    return Number(result.lastInsertRowid);
  }

  get_pending_sync_items(limit = 100): SyncQueueRow[] {
    return this.all<SyncQueueRow>(
      `
        SELECT *
        FROM sync_queue
        WHERE (
          table_name = 'credit_deduction'
          OR attempts < max_attempts
        )
          AND next_attempt_at <= ?
        ORDER BY created_at ASC
        LIMIT ?
      `,
      [isoNow(), limit],
    );
  }

  delete_sync_item(id: number): void {
    this.run(`DELETE FROM sync_queue WHERE id = ?`, [id]);
  }

  update_sync_failure(id: number, attempts: number, last_error: string | null, next_attempt_at: string): void {
    this.run(
      `
        UPDATE sync_queue
        SET attempts = ?, last_error = ?, next_attempt_at = ?
        WHERE id = ?
      `,
      [attempts, last_error, next_attempt_at, id],
    );
  }

  prune_dead_sync_items(): void {
    this.run(
      `
        DELETE FROM sync_queue
        WHERE table_name != 'credit_deduction'
          AND attempts >= max_attempts
          AND created_at < datetime('now', '-24 hours')
      `,
    );
  }
}
