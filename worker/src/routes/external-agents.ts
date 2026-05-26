/**
 * External Agent Routes — /api/companies/:companyId/agents/external
 *
 * Endpoints for registering and listing external agents (webhook-based,
 * bash, codex). These agents are not part of the founding team blueprint
 * and are managed by the company founder.
 */

import type { Env, AgentRow } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import { generateId } from "../provisioning/config-builder.js";
import { logActivity } from "../utils/activity.js";

/** Known adapter types for external agents. */
const VALID_ADAPTER_TYPES = new Set([
  "http-webhook",
  "bash",
  "codex",
]);

/**
 * Validate that a string is a well-formed http:// or https:// URL.
 * Returns true if valid, false otherwise.
 */
function isValidWebhookUrl(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

// ─── POST /api/companies/:companyId/agents/external ────────────

export async function handleCreateExternalAgent(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  let body: {
    name?: string;
    role?: string;
    webhookUrl?: string;
    adapterType?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Validate name
  if (!body.name || typeof body.name !== "string" || body.name.trim().length < 1) {
    return Response.json(
      { error: "Agent name is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Validate webhookUrl
  if (!body.webhookUrl || !isValidWebhookUrl(body.webhookUrl)) {
    return Response.json(
      { error: "A valid http:// or https:// webhook URL is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Validate adapterType
  const adapterType = body.adapterType || "http-webhook";
  if (!VALID_ADAPTER_TYPES.has(adapterType)) {
    return Response.json(
      { error: `Invalid adapter type. Must be one of: ${[...VALID_ADAPTER_TYPES].join(", ")}` },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const id = generateId();
  const role = body.role || "worker";
  const name = body.name.trim();
  const webhookUrl = body.webhookUrl.trim();

  await env.DB.prepare(
    `INSERT INTO agents (
       id, company_id, name, role, status, model_tier,
       webhook_url, adapter_type, source, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, 'idle', 'sonnet', ?, ?, 'external', datetime('now'), datetime('now'))`,
  ).bind(
    id,
    companyId,
    name,
    role,
    webhookUrl,
    adapterType,
  ).run();

  await logActivity(env, {
    companyId,
    actorType: "user",
    actorId: auth.userId,
    action: "agent.created",
    entityType: "agent",
    entityId: id,
    summary: `External agent "${name}" registered (adapter: ${adapterType})`,
  });

  const agent = await env.DB.prepare("SELECT * FROM agents WHERE id = ?")
    .bind(id).first<AgentRow>();

  return Response.json({ agent }, { status: 201, headers: corsHeaders(env) });
}

// ─── GET /api/companies/:companyId/agents/external ─────────────

export async function handleListExternalAgents(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const result = await env.DB.prepare(
    `SELECT *
     FROM agents
     WHERE company_id = ? AND source = 'external'
     ORDER BY created_at ASC`,
  ).bind(companyId).all<AgentRow>();

  return Response.json(
    { agents: result.results ?? [] },
    { headers: corsHeaders(env) },
  );
}
