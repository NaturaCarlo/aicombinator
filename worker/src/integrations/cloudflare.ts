import type { Env } from "../types.js";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export interface CloudflareZoneResult {
  id: string;
  name: string;
  name_servers?: string[];
}

export interface CloudflareDnsRecordInput {
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT";
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  priority?: number;
}

function assertCloudflareConfigured(env: Env): void {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("Cloudflare API credentials are not configured");
  }
}

async function cloudflareRequest<T>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  assertCloudflareConfigured(env);

  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload: { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> } = {};
  try {
    payload = text ? JSON.parse(text) as typeof payload : {};
  } catch {
    payload = {};
  }

  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((entry) => entry.message).filter(Boolean).join("; ") || text;
    throw new Error(`Cloudflare ${method} ${path} failed: ${response.status} ${message}`);
  }

  return payload.result as T;
}

export async function ensureCloudflareZone(
  env: Env,
  domain: string,
): Promise<CloudflareZoneResult> {
  const normalized = domain.trim().toLowerCase();
  const existing = await cloudflareRequest<Array<CloudflareZoneResult>>(
    env,
    "GET",
    `/zones?name=${encodeURIComponent(normalized)}`,
  );
  const first = existing.find((zone) => zone.name === normalized);
  if (first) {
    return first;
  }

  return cloudflareRequest<CloudflareZoneResult>(
    env,
    "POST",
    "/zones",
    {
      account: { id: env.CLOUDFLARE_ACCOUNT_ID },
      name: normalized,
      type: "full",
      jump_start: false,
    },
  );
}

export async function ensureCloudflareDnsRecord(
  env: Env,
  zoneId: string,
  record: CloudflareDnsRecordInput,
): Promise<void> {
  const existing = await cloudflareRequest<Array<{
    id: string;
    type: string;
    name: string;
    content: string;
  }>>(
    env,
    "GET",
    `/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}`,
  );

  const matching = existing.find((entry) =>
    entry.type === record.type
    && entry.name.toLowerCase() === record.name.toLowerCase()
    && entry.content === record.content,
  );

  if (matching) {
    return;
  }

  await cloudflareRequest(
    env,
    "POST",
    `/zones/${encodeURIComponent(zoneId)}/dns_records`,
    {
      ...record,
      ttl: record.ttl ?? 1,
    },
  );
}

export async function ensureCloudflareWorkerRoute(
  env: Env,
  zoneId: string,
  pattern: string,
  scriptName?: string,
): Promise<string> {
  const targetScript = scriptName || env.CLOUDFLARE_DASHBOARD_SCRIPT_NAME || "aicombinator";
  const routes = await cloudflareRequest<Array<{ id: string; pattern: string; script: string | null }>>(
    env,
    "GET",
    `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
  );

  const existing = routes.find((route) => route.pattern === pattern && route.script === targetScript);
  if (existing) {
    return existing.id;
  }

  const created = await cloudflareRequest<{ id: string }>(
    env,
    "POST",
    `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
    {
      pattern,
      script: targetScript,
    },
  );

  return created.id;
}
