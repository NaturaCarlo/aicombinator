import type { Env, CompanyRow } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import { getBalance } from "../utils/credits.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";

const COMPANY_DELETE_TABLES = [
  "card_topups",
  "purchase_requests",
  "virtual_cards",
  "payments",
  "approval_comments",
  "issue_approvals",
  "approvals",
  "issue_comments",
  "issues",
  "goals",
  "projects",
  "agent_messages",
  "cron_tasks",
  "policy_counters",
  "policies",
  "telemetry_records",
  "milestones",
  "company_email_aliases",
  "domain_bundle_orders",
  "domain_bundle_quotes",
  "tasks",
  "cost_events",
  "agent_api_keys",
  "agent_task_sessions",
  "agent_runtime_state",
  "agent_wakeup_requests",
  "heartbeat_runs",
  "agents",
  "activity_log",
  "companies",
] as const;

async function getExistingTableNames(env: Env): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'`,
  ).all<{ name: string }>();

  return new Set((results ?? []).map((row) => row.name));
}

export async function deleteCompanyRecords(env: Env, companyId: string): Promise<void> {
  const existingTables = await getExistingTableNames(env);
  const tablesToDelete = COMPANY_DELETE_TABLES.filter((table) => existingTables.has(table));

  // Delete one table at a time to tolerate missing tables gracefully
  for (const table of tablesToDelete) {
    try {
      if (table === "companies") {
        await env.DB.prepare(`DELETE FROM companies WHERE id = ?`).bind(companyId).run();
      } else {
        await env.DB.prepare(`DELETE FROM ${table} WHERE company_id = ?`).bind(companyId).run();
      }
    } catch (err) {
      console.warn(`[delete] Failed to delete from ${table} for ${companyId}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function requestSupervisor(
  env: Env,
  companyId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  return fetchFromCompanySupervisor(env, companyId, path, init);
}

/**
 * GET /api/companies/:id — Get full company detail (owner only).
 */
export async function handleGetCompany(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
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
    `SELECT * FROM companies WHERE id = ? AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<CompanyRow>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // Redact sensitive fields
  return Response.json(
    {
      ...company,
      private_key_encrypted: undefined,
    },
    { headers: corsHeaders(env) },
  );
}

/**
 * PATCH /api/companies/:id — Update company settings (owner only).
 * Body: { public_visible?: boolean, state?: "paused" | "running" }
 */
export async function handleUpdateCompany(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
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
    `SELECT * FROM companies WHERE id = ? AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<CompanyRow>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const body = (await request.json()) as {
    public_visible?: boolean;
    publicVisible?: boolean;
    state?: string;
    paused?: boolean;
    mode?: string;
    name?: string;
  };

  // ── State changes: delegate to supervisor (it pushes D1 synchronously) ──
  const allowedStates = ['running', 'paused'];
  if (typeof body.state === "string" && !allowedStates.includes(body.state)) {
    return Response.json(
      { error: `Invalid state. Allowed values: ${allowedStates.join(', ')}` },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const requestedState =
    typeof body.state === "string"
      ? body.state
      : body.paused === true
        ? "paused"
        : body.paused === false
          ? "running"
          : undefined;

  let stateHandled = false;

  if (requestedState && requestedState === company.state) {
    stateHandled = true; // idempotent
  } else if (requestedState === "paused") {
    const supRes = await requestSupervisor(env, companyId, `/companies/${companyId}/pause`, {
      method: "POST",
    });
    if (!supRes) {
      return Response.json(
        { error: "Supervisor not configured" },
        { status: 503, headers: corsHeaders(env) },
      );
    }
    if (!supRes.ok) {
      return Response.json(
        { error: (await supRes.text()) || "Failed to pause company" },
        { status: supRes.status, headers: corsHeaders(env) },
      );
    }
    stateHandled = true;
  } else if (requestedState === "running" && company.state === "paused") {
    const balance = await getBalance(env, userId);
    if (balance <= 0) {
      return Response.json(
        { error: "Add credits before resuming this company." },
        { status: 400, headers: corsHeaders(env) },
      );
    }
    const supRes = await requestSupervisor(env, companyId, `/companies/${companyId}/resume`, {
      method: "POST",
    });
    if (!supRes) {
      return Response.json(
        { error: "Supervisor not configured" },
        { status: 503, headers: corsHeaders(env) },
      );
    }
    if (!supRes.ok) {
      return Response.json(
        { error: (await supRes.text()) || "Failed to resume company" },
        { status: supRes.status, headers: corsHeaders(env) },
      );
    }
    stateHandled = true;
  }

  // ── Property updates (non-state): write D1 directly ──
  const updates: string[] = [];
  const values: unknown[] = [];

  const requestedPublicVisible =
    body.publicVisible !== undefined ? body.publicVisible : body.public_visible;

  if (requestedPublicVisible !== undefined) {
    updates.push("public_visible = ?");
    values.push(requestedPublicVisible ? 1 : 0);
  }

  if (body.mode === "autonomous" || body.mode === "manual") {
    updates.push("mode = ?");
    values.push(body.mode);
  }

  // ── Name update: validate, sanitize, and persist ──
  if (typeof body.name === "string") {
    const trimmedName = body.name.trim();
    if (trimmedName.length === 0) {
      return Response.json(
        { error: "Company name cannot be empty" },
        { status: 400, headers: corsHeaders(env) },
      );
    }
    if (trimmedName.length > 200) {
      return Response.json(
        { error: "Company name must be 200 characters or fewer" },
        { status: 400, headers: corsHeaders(env) },
      );
    }
    // Strip HTML tags to prevent XSS
    const sanitizedName = trimmedName.replace(/<[^>]*>/g, "");
    if (sanitizedName.length === 0) {
      return Response.json(
        { error: "Company name cannot be empty after sanitization" },
        { status: 400, headers: corsHeaders(env) },
      );
    }
    updates.push("name = ?");
    values.push(sanitizedName);
  }

  if (updates.length === 0 && !stateHandled) {
    return Response.json(
      { error: "No valid updates" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(companyId, userId);
    await env.DB.prepare(
      `UPDATE companies SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`,
    )
      .bind(...values)
      .run();
  }

  return Response.json({ success: true }, { headers: corsHeaders(env) });
}

/**
 * DELETE /api/companies/:id — Delete company + destroy sandbox (owner only).
 */
export async function handleDeleteCompany(
  request: Request,
  env: Env,
  companyId: string,
  _ctx: ExecutionContext,
): Promise<Response> {
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
    `SELECT * FROM companies WHERE id = ? AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<CompanyRow>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  if (
    company.state !== "awaiting_funding"
    && company.state !== "failed"
    && company.state !== "dead"
  ) {
    try {
      const supRes = await requestSupervisor(
        env,
        companyId,
        `/companies/${companyId}/destroy`,
        {
          method: "POST",
          body: JSON.stringify({ removeData: true }),
        },
      );
      if (supRes && !supRes.ok) {
        console.warn(`[delete] Supervisor destroy returned ${supRes.status} for ${companyId}, proceeding with D1 cleanup`);
      }
    } catch (err) {
      console.warn(`[delete] Supervisor destroy failed for ${companyId}, proceeding with D1 cleanup:`, err instanceof Error ? err.message : err);
    }
  }

  try {
    await deleteCompanyRecords(env, companyId);
    return Response.json({ success: true }, { headers: corsHeaders(env) });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[delete] D1 cleanup failed for ${companyId}:`, errMsg);
    return Response.json(
      { error: "Failed to delete company records", detail: errMsg },
      { status: 500, headers: corsHeaders(env) },
    );
  }
}
