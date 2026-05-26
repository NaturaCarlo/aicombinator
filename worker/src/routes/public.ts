import type { Env, CompanyRow } from "../types.js";
import { corsHeaders } from "../middleware/cors.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";

const PUBLIC_SITE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".ico",
]);

const PUBLIC_SITE_PREFIXES = [
  "site/",
  "app/",
  "src/",
  "src/frontend/",
  "src/landing/",
  "public/",
  "website/",
  "landing/",
  "artifacts/landing/",
];

/**
 * GET /api/public/:slug — Public profile data (no auth required).
 */
export async function handlePublicProfile(
  _request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const company = await env.DB.prepare(
    `SELECT id, name, slug, idea, state, inference_model, budget_cents, spent_cents, created_at,
            (SELECT COUNT(*) FROM credit_events ce WHERE ce.company_id = companies.id AND ce.type = 'deduct') as turn_count
     FROM companies WHERE slug = ? AND public_visible = 1`,
  )
    .bind(slug)
    .first<CompanyRow>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // Get recent activity (summaries only, no details)
  const { results: activity } = await env.DB.prepare(
    `SELECT type, summary, created_at
     FROM activity_log
     WHERE company_id = ?
     ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(company.id)
    .all();

  // Calculate uptime from creation
  const created = new Date(company.created_at).getTime();
  const elapsed = Date.now() - created;
  const days = Math.floor(elapsed / 86_400_000);
  const hours = Math.floor((elapsed % 86_400_000) / 3_600_000);
  const uptime = days > 0 ? `${days}d ${hours}h` : `${hours}h`;

  return Response.json(
    {
      name: company.name,
      slug: company.slug,
      idea: company.idea,
      state: company.state,
      model: company.inference_model,
      turnCount: Number((company as CompanyRow & { turn_count?: number }).turn_count || 0),
      spentCents: company.spent_cents,
      createdAt: company.created_at,
      uptime,
      recentActivity: (activity as Array<{ summary: string; created_at: string }>).map((a) => ({
        summary: a.summary,
        timestamp: a.created_at,
      })),
    },
    { headers: corsHeaders(env) },
  );
}

export async function handlePublicLandingFile(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const company = await resolvePublicCompany(env, {
    slug,
    host: `${slug}.aicombinator.live`,
  });

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const requestedPath = normalizePublicSitePath(new URL(request.url).searchParams.get("path"));
  if (!requestedPath) {
    return Response.json(
      { error: "Invalid path" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  for (const candidate of publicSiteCandidates(requestedPath)) {
    const response = await fetchFromCompanySupervisor(
      env,
      company.id,
      `/companies/${company.id}/workspace/file?path=${encodeURIComponent(candidate)}`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );

    if (!response || !response.ok) {
      continue;
    }

    const headers = new Headers(corsHeaders(env));
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Type", response.headers.get("Content-Type") || "application/octet-stream");
    headers.set(
      "Content-Disposition",
      response.headers.get("Content-Disposition") || "inline",
    );

    return new Response(response.body, {
      status: 200,
      headers,
    });
  }

  return Response.json(
    { error: "Landing file not found" },
    { status: 404, headers: corsHeaders(env) },
  );
}

export async function handlePublicLandingFileByHost(
  request: Request,
  env: Env,
): Promise<Response> {
  const host = new URL(request.url).searchParams.get("host")?.trim().toLowerCase() || "";
  if (!host) {
    return Response.json(
      { error: "Host is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const company = await resolvePublicCompany(env, { host });
  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  return handlePublicLandingFile(request, env, company.slug);
}

async function resolvePublicCompany(
  env: Env,
  input: { slug?: string; host?: string },
): Promise<{ id: string; slug: string } | null> {
  const slug = input.slug || null;
  const host = input.host || null;

  return env.DB.prepare(
    `SELECT id, slug
     FROM companies
     WHERE (?1 IS NOT NULL AND slug = ?1)
        OR (?2 IS NOT NULL AND (hosted_domain = ?2 OR custom_domain = ?2))
     LIMIT 1`,
  )
    .bind(slug, host)
    .first<{ id: string; slug: string }>();
}

function normalizePublicSitePath(path: string | null): string | null {
  const raw = (path || "").trim();
  if (!raw) {
    return "index.html";
  }

  let normalized = raw.replace(/^\/+/, "");
  if (!normalized) {
    normalized = "index.html";
  }
  if (normalized.endsWith("/")) {
    normalized = `${normalized}index.html`;
  }
  if (normalized.includes("..")) {
    return null;
  }

  const lower = normalized.toLowerCase();
  const extensionIndex = lower.lastIndexOf(".");
  if (extensionIndex === -1) {
    normalized = `${normalized}.html`;
  } else if (!PUBLIC_SITE_EXTENSIONS.has(lower.slice(extensionIndex))) {
    return null;
  }

  return normalized;
}

function publicSiteCandidates(requestedPath: string): string[] {
  if (requestedPath === "index.html") {
    return [
      "site/index.html",
      "app/index.html",
      "src/index.html",
      "src/frontend/index.html",
      "src/landing/index.html",
      "public/index.html",
      "website/index.html",
      "landing/index.html",
      "artifacts/landing/index.html",
    ];
  }

  const directCandidate = requestedPath.startsWith("src/")
    || requestedPath.startsWith("public/")
    || requestedPath.startsWith("website/")
    || requestedPath.startsWith("landing/")
    || requestedPath.startsWith("artifacts/landing/")
    ? [requestedPath]
    : [];

  return Array.from(
    new Set([
      ...directCandidate,
      ...PUBLIC_SITE_PREFIXES.map((prefix) => `${prefix}${requestedPath}`),
    ]),
  );
}
