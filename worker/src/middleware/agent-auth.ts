import type { Env } from "../types.js";

/**
 * Hash an API key using SHA-256 for storage/lookup.
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random API key with a recognizable prefix.
 */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ak_${key}`;
}

/**
 * Verify an agent API key from the X-Agent-Key header.
 * Returns agent/company IDs on success, or a 401 Response on failure.
 */
export async function verifyAgentApiKey(
  request: Request,
  env: Env,
): Promise<{ agentId: string; companyId: string } | Response> {
  const apiKey = request.headers.get("X-Agent-Key");
  if (!apiKey) {
    return Response.json({ error: "Missing X-Agent-Key header" }, { status: 401 });
  }

  const keyHash = await hashApiKey(apiKey);
  const row = await env.DB.prepare(
    `SELECT agent_id, company_id FROM agent_api_keys
     WHERE key_hash = ? AND revoked_at IS NULL`,
  )
    .bind(keyHash)
    .first<{ agent_id: string; company_id: string }>();

  if (!row) {
    return Response.json({ error: "Invalid or revoked API key" }, { status: 401 });
  }

  // Update last_used_at
  await env.DB.prepare(
    `UPDATE agent_api_keys SET last_used_at = datetime('now') WHERE key_hash = ?`,
  )
    .bind(keyHash)
    .run();

  return { agentId: row.agent_id, companyId: row.company_id };
}
