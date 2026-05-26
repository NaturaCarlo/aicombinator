import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { AgentInvoker } from "./agent-invoker.js";
import { createApi } from "./api.js";
import { ContainerManager } from "./container-manager.js";
import { CreditManager } from "./credit-manager.js";
import { CronManager } from "./cron.js";
import { SupervisorDb, isoNow } from "./db.js";
import { DeployManager } from "./deploy-manager.js";
import { RelayManager } from "./relay-manager.js";
import { Scheduler } from "./scheduler.js";
import { SyncManager } from "./sync.js";
import { TaskManager } from "./task-manager.js";
import type { CompanyRow, SupervisorConfig } from "./types.js";
import { DEFAULT_CONTAINER_RESOURCES } from "./types.js";

function required_env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional_env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function number_env(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}=${raw}`);
  }
  return parsed;
}

function boolean_env(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function build_config(): SupervisorConfig {
  return {
    workerApiUrl: required_env("WORKER_API_URL"),
    internalApiKey: required_env("INTERNAL_API_KEY"),
    anthropicApiKey: optional_env("ANTHROPIC_API_KEY", ""),
    port: number_env("PORT", 8787),
    dbPath: optional_env("SUPERVISOR_DB_PATH", "/srv/aicombinator/supervisor-state.sqlite"),
    scopeUserId: process.env.DEDICATED_USER_ID?.trim() || undefined,
    founderTimezone: optional_env("FOUNDER_TIMEZONE", "America/Los_Angeles"),
    syncIntervalMs: number_env("SYNC_INTERVAL_MS", 5_000),
    cronIntervalMs: number_env("CRON_INTERVAL_MS", 60_000),
    stallCheckEveryTurns: number_env("STALL_CHECK_EVERY_TURNS", 3),
    containerConfig: {
      companiesDir: optional_env("COMPANIES_DIR", "/srv/aicombinator/companies"),
      mcpServersDir: optional_env("MCP_SERVERS_DIR", "/srv/aicombinator/mcp-servers"),
      networkName: optional_env("DOCKER_NETWORK_NAME", "aicombinator"),
      resources: {
        cpuLimit: optional_env("CONTAINER_CPU_LIMIT", DEFAULT_CONTAINER_RESOURCES.cpuLimit),
        memoryLimit: optional_env("CONTAINER_MEMORY_LIMIT", DEFAULT_CONTAINER_RESOURCES.memoryLimit),
        cpuReservation: optional_env(
          "CONTAINER_CPU_RESERVATION",
          DEFAULT_CONTAINER_RESOURCES.cpuReservation,
        ),
        memoryReservation: optional_env(
          "CONTAINER_MEMORY_RESERVATION",
          DEFAULT_CONTAINER_RESOURCES.memoryReservation,
        ),
      },
    },
    relayConfig: {
      enabled: boolean_env("RELAY_ENABLED", false),
    },
  };
}

function reset_working_agents(db: SupervisorDb, company_id: string): void {
  const working_agents = db.all<{ id: string }>(
    `SELECT id FROM agents WHERE company_id = ? AND status = 'working'`,
    [company_id],
  );

  if (working_agents.length === 0) {
    return;
  }

  db.transaction(() => {
    db.run(
      `
        UPDATE agents
        SET status = 'idle'
          , current_task_id = NULL
        WHERE company_id = ?
          AND status = 'working'
      `,
      [company_id],
    );

    for (const agent of working_agents) {
      db.enqueue_sync("agents", agent.id, "upsert", { status: "idle", current_task_id: null });
    }
  })();
}

async function hydrate_active_companies(
  db: SupervisorDb,
  task_manager: TaskManager,
  container_manager: ContainerManager,
  credit_manager: CreditManager,
  companies: CompanyRow[],
): Promise<void> {
  for (const company of companies) {
    // Always ensure workspace_dir is set so lookups don't crash
    const local_company = task_manager.get_company(company.id);
    if (!local_company?.workspace_dir) {
      db.run(`UPDATE companies SET workspace_dir = ?, updated_at = updated_at WHERE id = ?`, [
        container_manager.getWorkspaceDir(company.id),
        company.id,
      ]);
    }

    if (!["running", "planning"].includes(company.state)) {
      continue;
    }

    if (!container_manager.isRunning(company.id)) {
      try {
        await container_manager.start(company.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[startup] Company ${company.id} paused on startup: container failed to start — ${message}`);
        db.run(`UPDATE companies SET state = 'paused', updated_at = ? WHERE id = ?`, [isoNow(), company.id]);
        db.enqueue_sync("companies", company.id, "upsert", { state: "paused", updated_at: isoNow() });
        continue; // Skip scheduling for this company
      }
    }

    reset_working_agents(db, company.id);

    const balance_row = db.get<{ balance: number }>(
      `SELECT balance FROM credit_balances WHERE user_id = ?`,
      [company.user_id],
    );
    if (!balance_row) {
      await credit_manager.init_company_credits(company.id, company.user_id);
    }
  }
}

async function bootstrap(): Promise<void> {
  const config = build_config();
  const db = new SupervisorDb(config.dbPath);
  db.migrate();

  const container_manager = new ContainerManager(config);
  await container_manager.discoverExisting();

  const sync_manager = new SyncManager(db, config);
  const credit_manager = new CreditManager(db, (user_id) => sync_manager.fetch_credit_balance(user_id));
  const task_manager = new TaskManager(db);
  const invoker = new AgentInvoker(config, db);
  const relay_manager = new RelayManager(config);
  invoker.setRelayManager(relay_manager);

  const companies = await sync_manager.bootstrapFromRemote();
  await hydrate_active_companies(db, task_manager, container_manager, credit_manager, companies);

  // Backfill reports_to for agents created from blueprints that define a
  // reportsTo hierarchy (e.g. CTO → CEO) but were inserted with null.
  task_manager.backfill_reports_to();

  // Clear stale credit reservations from the previous process — no agent turns
  // are running at this point so any reserved_balance is leaked from a prior crash/restart.
  db.run(`DELETE FROM credit_reservations`);
  db.run(`UPDATE credit_balances SET reserved_balance = 0 WHERE reserved_balance > 0`);

  const deploy_manager = new DeployManager(db, config);

  const scheduler = new Scheduler(
    db,
    config,
    task_manager,
    credit_manager,
    sync_manager,
    invoker,
    container_manager,
    deploy_manager,
  );
  const cron_manager = new CronManager(db, task_manager, credit_manager, invoker, scheduler, config);
  cron_manager.set_founder_timezone(config.founderTimezone);
  scheduler.set_cron_manager(cron_manager);

  let sync_in_progress = false;
  const sync_interval = setInterval(() => {
    if (sync_in_progress) return;
    sync_in_progress = true;
    void sync_manager
      .run_sync_cycle()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[sync] Cycle failed: ${message}`);
      })
      .finally(() => {
        sync_in_progress = false;
      });
  }, config.syncIntervalMs);

  let cron_in_progress = false;
  const cron_interval = setInterval(() => {
    if (cron_in_progress) return;
    cron_in_progress = true;
    void cron_manager
      .run_tick()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[cron] Tick failed: ${message}`);
      })
      .finally(() => {
        cron_in_progress = false;
      });
  }, config.cronIntervalMs);

  const app = createApi({
    config, db, scheduler, deploy_manager,
    llmProxyConfig: {
      internalApiKey: config.internalApiKey,
      workerApiUrl: config.workerApiUrl,
    },
  });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  const active_companies = db.all<Pick<CompanyRow, "id" | "state">>(
    `SELECT id, state FROM companies WHERE state IN ('planning', 'running') ORDER BY created_at ASC`,
  );

  // On startup, re-enqueue full sync for all agents/tasks/milestones in active
  // companies. Previous sync items may have been silently consumed without
  // creating the records in D1 (e.g. PATCH returning 200 on non-existent row).
  for (const company of active_companies) {
    const agents = db.all<{ id: string }>(`SELECT id FROM agents WHERE company_id = ?`, [company.id]);
    for (const a of agents) {
      const full = db.get<Record<string, unknown>>(`SELECT * FROM agents WHERE id = ?`, [a.id]);
      if (full) db.enqueue_sync("agents", a.id, "upsert", full);
    }
    const milestones = db.all<{ id: string }>(`SELECT id FROM milestones WHERE company_id = ?`, [company.id]);
    for (const m of milestones) {
      const full = db.get<Record<string, unknown>>(`SELECT * FROM milestones WHERE id = ?`, [m.id]);
      if (full) db.enqueue_sync("milestones", m.id, "upsert", full);
    }
    const tasks = db.all<{ id: string }>(`SELECT id FROM tasks WHERE company_id = ?`, [company.id]);
    for (const t of tasks) {
      const full = db.get<Record<string, unknown>>(`SELECT * FROM tasks WHERE id = ?`, [t.id]);
      if (full) db.enqueue_sync("tasks", t.id, "upsert", full);
    }
  }

  for (const company of active_companies) {
    scheduler.activate_pending_milestone_tasks(company.id);
    await scheduler.schedule(company.id);
  }

  // Recover companies stuck in "provisioning" — their start_planning() promise was
  // lost during a restart. Re-trigger planning so they don't stay stuck forever.
  const stuck_provisioning = db.all<CompanyRow>(
    `SELECT * FROM companies WHERE state = 'provisioning' ORDER BY created_at ASC`,
  );
  for (const company of stuck_provisioning) {
    console.log(`[startup] Recovering stuck provisioning for ${company.id} (${company.name})`);
    if (!container_manager.isRunning(company.id)) {
      try {
        await container_manager.start(company.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[startup] Failed to start container for stuck ${company.id}: ${message}`);
      }
    }
    void scheduler.start_planning(company).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[startup] Recovery planning failed for ${company.id}: ${msg}`);
    });
  }

  // Re-start web servers for previously-deployed companies
  void deploy_manager.redeploy_all().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[startup] Deploy redeploy_all failed: ${msg}`);
  });

  console.log(
    `[startup] Supervisor ready on :${config.port} (scope=${config.scopeUserId ?? "shared"}, companies=${companies.length})`,
  );

  const shutdown = create_shutdown_handler({
    db,
    server,
    sync_interval,
    cron_interval,
    scheduler,
  });

  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));
  process.on("unhandledRejection", (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[process] Unhandled rejection: ${message}`);
    shutdown(1);
  });
  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[process] Uncaught exception: ${message}`);
    shutdown(1);
  });
}

function create_shutdown_handler(deps: {
  db: SupervisorDb;
  server: ServerType;
  sync_interval: NodeJS.Timeout;
  cron_interval: NodeJS.Timeout;
  scheduler: Scheduler;
}): (exit_code?: number) => void {
  let shutting_down = false;

  return (exit_code = 0) => {
    if (shutting_down) return;
    shutting_down = true;

    clearInterval(deps.sync_interval);
    clearInterval(deps.cron_interval);
    deps.scheduler.abort_all_active_turns();

    const finish = () => {
      try {
        deps.db.close();
      } finally {
        process.exit(exit_code);
      }
    };

    try {
      deps.server.close((error?: Error) => {
        if (error) {
          console.error(`[shutdown] HTTP close failed: ${error.message}`);
        }
        finish();
      });
    } catch {
      finish();
    }
  };
}

bootstrap().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[startup] Fatal error: ${message}`);
  process.exit(1);
});
