/**
 * Real-time status routes — SSE stream + burn rate.
 *
 * GET /api/companies/:id/status/stream  → Server-Sent Events stream
 * GET /api/companies/:id/burn-rate      → Credit burn rate metrics
 * GET /api/blueprints                   → List available agent blueprints
 */

import type { Env } from "../types.js";
import { corsHeaders } from "../middleware/cors.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import {
  fetchLiveSupervisorTasks,
  fetchLiveSupervisorRuntime,
  normalizeFounderVisibleAgentStatus,
} from "../utils/live-runtime.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";
import { getAllBlueprints } from "../../../supervisor/src/blueprints.js";

async function requireCompanyAccess(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response | { userId: string }> {
  const token = extractToken(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const company = await env.DB.prepare(
    `SELECT id
     FROM companies
     WHERE id = ?
       AND user_id = ?`,
  ).bind(companyId, userId).first();

  if (!company) {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  return { userId };
}

async function requireTaskAccess(
  request: Request,
  env: Env,
  taskId: string,
): Promise<Response | { userId: string; companyId: string }> {
  const token = extractToken(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const task = await env.DB.prepare(
    `SELECT t.company_id
     FROM tasks t
     JOIN companies c ON c.id = t.company_id
     WHERE t.id = ?
       AND c.user_id = ?`,
  ).bind(taskId, userId).first<{ company_id: string }>();

  if (!task) {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  return { userId, companyId: task.company_id };
}

// ─── Burn Rate ──────────────────────────────────────────────

/** GET /api/companies/:id/burn-rate — credit burn rate metrics */
export async function handleBurnRate(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  // Get the company to find the owner
  const company = await env.DB.prepare(
    `SELECT user_id FROM companies WHERE id = ?`,
  )
    .bind(companyId)
    .first<{ user_id: string }>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // Get current credit balance
  const balanceRow = await env.DB.prepare(
    `SELECT balance FROM credit_balances WHERE user_id = ?`,
  )
    .bind(company.user_id)
    .first<{ balance: number }>();

  const balance = balanceRow?.balance ?? 0;

  // Get credit deductions in the last 24 hours
  const last24h = await env.DB.prepare(
    `SELECT amount, created_at FROM credit_events
     WHERE user_id = ? AND type = 'deduct'
     AND created_at > datetime('now', '-24 hours')
     ORDER BY created_at DESC`,
  )
    .bind(company.user_id)
    .all<{ amount: number; created_at: string }>();

  const deductions = last24h.results ?? [];

  // Calculate burn rate
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const twentyFourHoursAgo = now - 86_400_000;

  let creditsLast1h = 0;
  let creditsLast24h = 0;

  for (const d of deductions) {
    const t = new Date(d.created_at).getTime();
    const amount = Math.abs(d.amount);
    creditsLast24h += amount;
    if (t >= oneHourAgo) {
      creditsLast1h += amount;
    }
  }

  // Calculate rates
  const hoursOfData = Math.min(24, (now - twentyFourHoursAgo) / 3_600_000);
  const creditsPerHour = hoursOfData > 0 ? creditsLast24h / hoursOfData : 0;
  const creditsPerDay = creditsPerHour * 24;
  const daysRemaining =
    creditsPerDay > 0 ? balance / creditsPerDay : null;

  return Response.json(
    {
      creditsLast1h,
      creditsLast24h,
      creditsPerHour: Math.round(creditsPerHour * 10) / 10,
      creditsPerDay: Math.round(creditsPerDay),
      daysRemaining:
        daysRemaining !== null
          ? Math.round(daysRemaining * 10) / 10
          : null,
      balance,
    },
    { headers: corsHeaders(env) },
  );
}

// ─── SSE Status Stream ──────────────────────────────────────

/**
 * GET /api/companies/:id/status/stream — Server-Sent Events stream.
 *
 * Sends real-time updates by polling the supervisor status endpoint
 * and pushing changes to the client.
 *
 * Auth via ?token= query parameter (since EventSource can't set headers).
 */
export async function handleStatusStream(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const company = await env.DB.prepare(
    `SELECT id
     FROM companies
     WHERE id = ?
       AND user_id = ?`,
  ).bind(companyId, userId).first();

  if (!company) {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // For SSE, we poll the supervisor and push events.
  // Cloudflare Workers can't hold long connections indefinitely,
  // so we emit a batch of current state and close.
  // The client will reconnect via EventSource retry.

  try {
    const liveRuntime = await fetchLiveSupervisorRuntime(env, companyId);

    // Fetch current status from supervisor
    const statusRes = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/status`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );

    if (!statusRes || !statusRes.ok) {
      throw new Error(`Supervisor returned ${statusRes?.status ?? 503}`);
    }

    const status = await statusRes.json() as Record<string, unknown>;

    // Fetch agent statuses
    const agents = await env.DB.prepare(
      `SELECT id, name, status, last_wake_at, last_sleep_at
       FROM agents WHERE company_id = ?`,
    )
      .bind(companyId)
      .all<{
        id: string;
        name: string;
        status: string;
        last_wake_at: string | null;
        last_sleep_at: string | null;
      }>();

    const tasks = await env.DB.prepare(
      `SELECT id, status, owner_agent_id, updated_at
       FROM tasks
       WHERE company_id = ?
       ORDER BY updated_at DESC
       LIMIT 100`,
    ).bind(companyId).all<{
      id: string;
      status: string;
      owner_agent_id: string | null;
      updated_at: string;
    }>();

    // Build SSE response with current state
    const events: string[] = ["retry: 1000\n\n"];

    // Company state event
    events.push(
      `data: ${JSON.stringify({
        type: "company_state",
        companyId,
        data: status,
        timestamp: new Date().toISOString(),
      })}\n\n`,
    );

    // Agent status events
    for (const rawAgent of agents.results ?? []) {
      const agent = normalizeFounderVisibleAgentStatus(rawAgent as never, liveRuntime);
      events.push(
        `data: ${JSON.stringify({
          type: agent.status === "running" ? "agent_wake" : "agent_sleep",
          companyId,
          agentId: agent.id,
          data: { name: agent.name, status: agent.status },
          timestamp: new Date().toISOString(),
        })}\n\n`,
      );
    }

    events.push(
      `data: ${JSON.stringify({
        type: "task_update",
        companyId,
        data: {
          updatedAt:
            (tasks.results ?? [])[0]?.updated_at ?? new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      })}\n\n`,
    );

    // Return SSE response
    const body = events.join("");
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(env),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream error";
    return Response.json(
      { error: message },
      { status: 502, headers: corsHeaders(env) },
    );
  }
}

// ─── Blueprints ─────────────────────────────────────────────

/**
 * GET /api/blueprints — list available agent blueprints.
 * Proxies to the supervisor's blueprint endpoint.
 */
export async function handleListBlueprints(
  request: Request,
  env: Env,
): Promise<Response> {
  const blueprints = getAllBlueprints().map((bp) => ({
    id: bp.id,
    name: bp.name,
    role: bp.role,
    department: bp.department,
    modelTier: bp.modelTier,
    estimatedCreditsPerDay: bp.estimatedCreditsPerDay,
    description: bp.description,
    tested: bp.tested,
  }));

  return Response.json(
    { blueprints },
    { headers: corsHeaders(env) },
  );
}

// ─── Tasks ──────────────────────────────────────────────────

export async function loadCompanyTasksForFounder(
  env: Env,
  companyId: string,
  options?: {
    status?: string | null;
    agentId?: string | null;
  },
): Promise<unknown[]> {
  let query = `SELECT * FROM tasks WHERE company_id = ?`;
  const bindings: string[] = [companyId];

  if (options?.status) {
    query += ` AND status = ?`;
    bindings.push(options.status);
  }

  if (options?.agentId) {
    query += ` AND owner_agent_id = ?`;
    bindings.push(options.agentId);
  }

  query += ` ORDER BY updated_at DESC LIMIT 100`;

  const result = await env.DB.prepare(query)
    .bind(...bindings)
    .all();

  const dbTasks = result.results ?? [];
  const runtime = await fetchLiveSupervisorRuntime(env, companyId);
  const liveTasks = (
    runtime.companyState === "provisioning"
      || runtime.companyState === "planning"
      || runtime.companyState === "running"
      || runtime.companyState === "paused"
  )
    ? await fetchLiveSupervisorTasks(env, companyId)
    : null;

  return liveTasks && liveTasks.length > 0 ? liveTasks : dbTasks;
}

/** GET /api/companies/:id/tasks — list tasks */
export async function handleListTasks(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const tasks = await loadCompanyTasksForFounder(env, companyId, {
    status: url.searchParams.get("status"),
    agentId: url.searchParams.get("agent_id"),
  });

  return Response.json(
    { tasks },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/companies/:id/tasks — create task */
export async function handleCreateTask(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const body = (await request.json()) as {
    title: string;
    description?: string;
    owner_agent_id?: string;
    parent_task_id?: string;
  };

  if (!body.title) {
    return Response.json(
      { error: "title is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO tasks (id, company_id, title, description, status, owner_agent_id, parent_task_id, created_by)
     VALUES (?, ?, ?, ?, 'todo', ?, ?, ?)`,
  )
    .bind(
      id,
      companyId,
      body.title,
      body.description || null,
      body.owner_agent_id || null,
      body.parent_task_id || null,
      auth.userId,
    )
    .run();

  const task = await env.DB.prepare(`SELECT * FROM tasks WHERE id = ?`)
    .bind(id)
    .first();

  return Response.json(
    { task },
    { status: 201, headers: corsHeaders(env) },
  );
}

/** PATCH /api/tasks/:id — update task */
export async function handleUpdateTask(
  request: Request,
  env: Env,
  taskId: string,
): Promise<Response> {
  const auth = await requireTaskAccess(request, env, taskId);
  if (auth instanceof Response) return auth;

  const body = (await request.json()) as Record<string, unknown>;

  const allowedStatuses = ['todo', 'in_progress', 'blocked', 'done', 'cancelled', 'pending', 'ready', 'failed'];
  if (body.status && !allowedStatuses.includes(body.status as string)) {
    return Response.json(
      { error: `Invalid status. Allowed values: ${allowedStatuses.join(', ')}` },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const allowedFields = [
    "title",
    "description",
    "status",
    "owner_agent_id",
    "blocked_reason",
  ];

  const updates: string[] = [];
  const values: unknown[] = [];

  for (const field of allowedFields) {
    if (field in body) {
      updates.push(`${field} = ?`);
      values.push(body[field]);
    }
  }

  if (updates.length === 0) {
    return Response.json(
      { error: "No valid fields to update" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  updates.push(`updated_at = datetime('now')`);
  values.push(taskId);

  await env.DB.prepare(
    `UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...values)
    .run();

  const task = await env.DB.prepare(`SELECT * FROM tasks WHERE id = ?`)
    .bind(taskId)
    .first();

  return Response.json({ task }, { headers: corsHeaders(env) });
}
