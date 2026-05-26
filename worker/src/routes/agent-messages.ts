import type { Env } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";

/**
 * GET /api/companies/:id/messages — Inter-agent message feed for the dashboard.
 *
 * Query params: ?limit=50&before=<iso-timestamp>&agent_id=<filter-by-agent>
 */
export async function handleCompanyMessages(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  }
  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  }

  // Verify ownership
  const company = await env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?",
  ).bind(companyId, userId).first();
  if (!company) {
    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
  const before = url.searchParams.get("before");
  const agentId = url.searchParams.get("agent_id");

  let query = `SELECT m.*,
    fa.name as from_name, fa.title as from_title, fa.role as from_role,
    ta.name as to_name, ta.title as to_title, ta.role as to_role
    FROM agent_messages m
    LEFT JOIN agents fa ON fa.id = m.from_agent_id
    LEFT JOIN agents ta ON ta.id = m.to_agent_id
    WHERE m.company_id = ?`;
  const params: unknown[] = [companyId];

  if (before) {
    query += ` AND m.created_at < ?`;
    params.push(before);
  }

  if (agentId) {
    query += ` AND (m.from_agent_id = ? OR m.to_agent_id = ?)`;
    params.push(agentId, agentId);
  }

  query += ` ORDER BY m.created_at DESC LIMIT ?`;
  params.push(limit);

  const { results } = await env.DB.prepare(query).bind(...params).all();

  const messages = (results || []).map((m: any) => ({
    id: m.id,
    companyId: m.company_id,
    fromAgentId: m.from_agent_id,
    fromName: m.from_title || m.from_name || m.from_agent_id,
    fromRole: m.from_role,
    toAgentId: m.to_agent_id,
    toName: m.to_title || m.to_name || m.to_agent_id,
    toRole: m.to_role,
    type: m.type,
    subject: m.subject,
    body: m.body,
    priority: m.priority,
    status: m.status,
    parentMessageId: m.parent_message_id,
    createdAt: m.created_at,
    readAt: m.read_at,
  }));

  return Response.json({ messages }, { headers: corsHeaders(env) });
}

/**
 * GET /api/companies/:id/agent-kv/:agentId/:key — Read agent KV value.
 */
export async function handleReadAgentKv(
  request: Request,
  env: Env,
  companyId: string,
  agentId: string,
  key: string,
): Promise<Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  }
  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  }

  // Verify ownership
  const company = await env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?",
  ).bind(companyId, userId).first();
  if (!company) {
    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  }

  // Verify agent belongs to company
  const agent = await env.DB.prepare(
    "SELECT id FROM agents WHERE id = ? AND company_id = ?",
  ).bind(agentId, companyId).first();
  if (!agent) {
    return Response.json({ error: "Agent not found" }, { status: 404, headers: corsHeaders(env) });
  }

  // DO execution removed — KV will be read from supervisor in Phase 3
  return Response.json({ value: null }, { headers: corsHeaders(env) });
}
