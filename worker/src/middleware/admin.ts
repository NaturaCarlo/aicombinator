/**
 * Admin authentication middleware.
 *
 * Verifies that the request has a valid Clerk JWT AND the user
 * is in the ADMIN_USER_IDS allow list. Returns either an AdminAuth
 * object (success) or a Response (error).
 */

import type { Env } from "../types.js";
import { extractToken, verifyClerkJwt } from "./auth.js";
import { corsHeaders } from "./cors.js";

export interface AdminAuth {
  userId: string;
}

export async function requireAdmin(
  request: Request,
  env: Env,
): Promise<AdminAuth | Response> {
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

  const adminIds = (env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!adminIds.includes(userId)) {
    return Response.json(
      { error: "Forbidden" },
      { status: 403, headers: corsHeaders(env) },
    );
  }

  return { userId };
}
