/**
 * Companies.sh Import Route — POST /api/companies/:companyId/import/companies-sh
 *
 * Proxies the import request to the supervisor, which parses the
 * companies.sh package and creates agents in its local DB (then syncs to D1).
 */

import type { Env } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";

/**
 * POST /api/companies/:companyId/import/companies-sh
 *
 * Body: { packageRef: string }
 * Proxies to supervisor POST /import/companies-sh/:companyId
 */
export async function handleImportCompaniesSh(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  // Auth: verify JWT and company ownership
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

  // Verify company belongs to user
  const company = await env.DB.prepare(
    "SELECT user_id FROM companies WHERE id = ?",
  ).bind(companyId).first<{ user_id: string }>();
  if (!company || company.user_id !== userId) {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // Parse request body
  let body: { packageRef?: string };
  try {
    body = (await request.json()) as { packageRef?: string };
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const packageRef = typeof body.packageRef === "string" ? body.packageRef.trim() : "";
  if (!packageRef) {
    return Response.json(
      { error: "packageRef is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Validate package reference format (must have at least owner/repo)
  const parts = packageRef.split("/").filter(Boolean);
  const isUrl = packageRef.startsWith("http://") || packageRef.startsWith("https://");
  if (!isUrl && parts.length < 2) {
    return Response.json(
      { error: "Invalid package reference. Expected format: owner/repo/path or a GitHub URL" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Proxy to supervisor
  const supervisorResp = await fetchFromCompanySupervisor(
    env,
    companyId,
    `/import/companies-sh/${companyId}`,
    {
      method: "POST",
      body: JSON.stringify({ packageRef }),
    },
  );

  if (!supervisorResp) {
    return Response.json(
      { error: "Supervisor unreachable" },
      { status: 502, headers: corsHeaders(env) },
    );
  }

  // Forward supervisor response
  const respBody = await supervisorResp.text();
  return new Response(respBody, {
    status: supervisorResp.status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}
