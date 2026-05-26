import type { Env } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";

async function requireCompanyAccess(
  request: Request, env: Env, companyId: string,
): Promise<{ userId: string } | Response> {
  const token = extractToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  const userId = await verifyClerkJwt(token, env);
  if (!userId) return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  const company = await env.DB.prepare("SELECT user_id FROM companies WHERE id = ?").bind(companyId).first<{ user_id: string }>();
  if (!company || company.user_id !== userId) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  return { userId };
}

// ─── GET /api/companies/:companyId/costs/summary ──────────────

export async function handleCostSummary(
  request: Request, env: Env, companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const company = await env.DB.prepare(
    "SELECT budget_monthly_cents, spent_monthly_cents FROM companies WHERE id = ?",
  ).bind(companyId).first<{ budget_monthly_cents: number; spent_monthly_cents: number }>();

  const totals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(cost_cents), 0) as total_cost_cents,
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COUNT(*) as event_count
     FROM cost_events WHERE company_id = ?`,
  ).bind(companyId).first<{
    total_cost_cents: number;
    total_input_tokens: number;
    total_output_tokens: number;
    event_count: number;
  }>();

  return Response.json({
    budgetMonthlyCents: company?.budget_monthly_cents || 0,
    spentMonthlyCents: company?.spent_monthly_cents || 0,
    totalCostCents: totals?.total_cost_cents || 0,
    totalInputTokens: totals?.total_input_tokens || 0,
    totalOutputTokens: totals?.total_output_tokens || 0,
    eventCount: totals?.event_count || 0,
  }, { headers: corsHeaders(env) });
}

// ─── GET /api/companies/:companyId/costs/by-agent ─────────────

export async function handleCostByAgent(
  request: Request, env: Env, companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(
    `SELECT
       COALESCE(ce.agent_id, '__unattributed__') as agent_id,
       CASE
         WHEN ce.agent_id IS NULL THEN 'Unattributed'
         ELSE a.name
       END as agent_name,
       COALESCE(SUM(ce.cost_cents), 0) as total_cost_cents,
       COALESCE(SUM(ce.input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(ce.output_tokens), 0) as total_output_tokens,
       COUNT(*) as event_count
     FROM cost_events ce
     LEFT JOIN agents a ON ce.agent_id = a.id
     WHERE ce.company_id = ?
     GROUP BY ce.agent_id
     ORDER BY total_cost_cents DESC`,
  ).bind(companyId).all();

  return Response.json({ agents: results }, { headers: corsHeaders(env) });
}
