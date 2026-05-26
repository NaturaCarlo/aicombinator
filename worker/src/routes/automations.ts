/**
 * Automations Routes — /api/companies/:companyId/automations
 *
 * Endpoints for listing and toggling automations (cron_tasks).
 * Automations are scheduled recurring prompts that the CEO executes.
 */

import type { Env } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";

interface CronTaskRow {
  id: string;
  company_id: string;
  agent_id: string;
  title: string | null;
  description: string | null;
  schedule: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
}

/**
 * Verify JWT and check company ownership. Returns userId or error Response.
 */
async function requireCompanyAccess(
  request: Request,
  env: Env,
  companyId: string,
): Promise<{ userId: string } | Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  }
  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  }
  const company = await env.DB.prepare(
    "SELECT user_id FROM companies WHERE id = ?",
  ).bind(companyId).first<{ user_id: string }>();
  if (!company || company.user_id !== userId) {
    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  }
  return { userId };
}

// ─── GET /api/companies/:companyId/automations ─────────────────

export async function handleListAutomations(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const result = await env.DB.prepare(
    `SELECT id, company_id, agent_id, title, description, schedule, prompt, enabled, last_run_at, created_by, created_at
     FROM cron_tasks
     WHERE company_id = ? AND title IS NOT NULL
     ORDER BY created_at DESC`,
  ).bind(companyId).all<CronTaskRow>();

  return Response.json(
    { automations: result.results ?? [] },
    { headers: corsHeaders(env) },
  );
}

// ─── PATCH /api/companies/:companyId/automations/:automationId ─

export async function handleToggleAutomation(
  request: Request,
  env: Env,
  companyId: string,
  automationId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  let body: { enabled?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  if (body.enabled === undefined) {
    return Response.json(
      { error: "enabled field is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const automation = await env.DB.prepare(
    "SELECT id FROM cron_tasks WHERE id = ? AND company_id = ?",
  ).bind(automationId, companyId).first<{ id: string }>();

  if (!automation) {
    return Response.json(
      { error: "Automation not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const enabledVal = body.enabled ? 1 : 0;
  await env.DB.prepare(
    `UPDATE cron_tasks SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(enabledVal, automationId).run();

  return Response.json(
    { updated: true, id: automationId, enabled: body.enabled },
    { headers: corsHeaders(env) },
  );
}
