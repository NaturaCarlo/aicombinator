import type { Env, CompanyRow } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";

/**
 * GET /api/companies/:id/activity — Paginated activity feed from D1.
 * Query params: ?limit=20&before=<iso-timestamp>
 */
export async function handleCompanyActivity(
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

  // Verify ownership
  const company = await env.DB.prepare(
    `SELECT id FROM companies WHERE id = ? AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<CompanyRow>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
  const rawLimit = Math.min(Math.max(limit * 5, limit), 200);
  const before = url.searchParams.get("before");

  let query: string;
  let params: unknown[];

  if (before) {
    query = `SELECT id, company_id, type, summary, details, created_at
             FROM activity_log
             WHERE company_id = ? AND created_at < ?
             ORDER BY created_at DESC LIMIT ?`;
    params = [companyId, before, rawLimit];
  } else {
    query = `SELECT id, company_id, type, summary, details, created_at
             FROM activity_log
             WHERE company_id = ?
             ORDER BY created_at DESC LIMIT ?`;
    params = [companyId, rawLimit];
  }

  const { results } = await env.DB.prepare(query).bind(...params).all();

  const entries = (results || [])
    .map((r: Record<string, unknown>) => ({
      id: r.id,
      type: r.type,
      summary: r.summary,
      details: r.details ? JSON.parse(r.details as string) : undefined,
      createdAt: r.created_at,
    }))
    .filter((entry) => isNotableActivity(entry.type as string, entry.summary as string))
    .slice(0, limit);

  return Response.json(
    { entries },
    { headers: corsHeaders(env) },
  );
}

function isNotableActivity(type: string, summary: string): boolean {
  const normalizedSummary = summary.toLowerCase();

  if (type === "error" || type === "milestone" || type === "state_change") {
    return true;
  }

  if (type === "relay_message" || type === "creator_message") {
    return true;
  }

  if (type === "tool_call") {
    return normalizedSummary.startsWith("creator sent message")
      || normalizedSummary.startsWith("creator chatted with ceo");
  }

  if (type.startsWith("issue.")) {
    return true;
  }

  return normalizedSummary.includes("retry")
    || normalizedSummary.includes("blocked")
    || normalizedSummary.includes("waiting on founder")
    || normalizedSummary.includes("waiting on agent")
    || normalizedSummary.includes("artifact")
    || normalizedSummary.includes("launched");
}
