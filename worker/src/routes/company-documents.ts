import type { CompanyRow, Env } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import {
  fetchWorkspaceSnapshot,
  reconcileTasksWithWorkspace,
} from "../utils/company-workspace.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";

export interface SupervisorFounderDocument {
  type: "mission" | "executive_brief" | "daily_update" | "plan";
  title: string;
  content: string;
  path: string;
  date?: string;
  created_at?: string;
}

export interface FounderDocumentsSnapshot {
  documents: Array<{
    id: string;
    type: string;
    title: string;
    body: string;
    excerpt: string;
    createdAt: string;
    path: string;
    category: string;
  }>;
  artifacts: Array<{
    path: string;
    title: string;
    kind: string;
    excerpt: string;
    updatedAt: string;
    urls?: string[];
    previewDataUrl?: string;
    openUrl?: string;
  }>;
}

function documentPriority(doc: { type: string; title: string; path?: string }): number {
  if (doc.type === "mission") return 0;
  if (doc.title.toLowerCase().includes("daily executive brief")) return 1;
  if (doc.type === "executive_brief" || doc.title.toLowerCase().includes("executive brief")) return 2;
  if (doc.type === "workspace_document" && (doc.path === "docs/plan.md" || doc.title.toLowerCase().includes("plan"))) return 3;
  return 20;
}

/**
 * GET /api/companies/:id/documents — Company documents plus tangible workspace outputs.
 */
export async function handleCompanyDocuments(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const company = await requireCompanyAccess(request, env, companyId);
  if (company instanceof Response) {
    return company;
  }

  const snapshot = await loadFounderDocumentsSnapshot(env, companyId, company, {
    reconcileWorkspaceTasks: true,
  });

  return Response.json(
    snapshot,
    { headers: corsHeaders(env) },
  );
}

export async function handleCompanyArtifact(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const company = await requireCompanyAccess(request, env, companyId);
  if (company instanceof Response) {
    return company;
  }

  const path = new URL(request.url).searchParams.get("path");
  if (!path) {
    return Response.json({ error: "path is required" }, { status: 400, headers: corsHeaders(env) });
  }

  const supervisorRes = await fetchFromCompanySupervisor(
    env,
    companyId,
    `/companies/${companyId}/workspace/file?path=${encodeURIComponent(path)}`,
    {
      headers: {
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
      },
    },
  );

  if (!supervisorRes || !supervisorRes.ok) {
    const body = await supervisorRes?.text().catch(() => "") ?? "";
    return Response.json(
      { error: body || "Artifact not found" },
      { status: supervisorRes?.status ?? 503, headers: corsHeaders(env) },
    );
  }

  const headers = new Headers(corsHeaders(env));
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", supervisorRes.headers.get("Content-Type") || "application/octet-stream");
  headers.set(
    "Content-Disposition",
    supervisorRes.headers.get("Content-Disposition") || "inline",
  );

  return new Response(supervisorRes.body, {
    status: 200,
    headers,
  });
}

export async function requireCompanyDocumentAccess(
  env: Env,
  companyId: string,
  userId: string,
): Promise<{ id: string; genesis_prompt: string; idea: string; created_at: string } | null> {
  return env.DB.prepare(
    "SELECT id, genesis_prompt, idea, created_at FROM companies WHERE id = ? AND user_id = ?",
  ).bind(companyId, userId).first<{ id: string; genesis_prompt: string; idea: string; created_at: string }>();
}

async function requireCompanyAccess(
  request: Request,
  env: Env,
  companyId: string,
): Promise<{ id: string; genesis_prompt: string; idea: string; created_at: string } | Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  }
  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  }

  const company = await requireCompanyDocumentAccess(env, companyId, userId);
  if (!company) {
    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  }
  return company;
}

function isFounderArtifact(
  path: string,
  kind: string,
  previewDataUrl?: string,
): boolean {
  const lowerPath = path.toLowerCase();

  if (kind === "landing_page" || kind === "app_page" || kind === "report_asset") {
    return true;
  }

  if (previewDataUrl && /\.(png|jpe?g|webp|gif|svg)$/i.test(lowerPath)) {
    return true;
  }

  return false;
}

export async function fetchFounderDocuments(
  env: Env,
  companyId: string,
  companyCreatedAt: string,
): Promise<SupervisorFounderDocument[]> {
  const res = await fetchFromCompanySupervisor(
    env,
    companyId,
    `/companies/${companyId}/status`,
    {
      headers: {
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
      },
    },
  );
  if (!res || !res.ok) {
    return [];
  }

  const payload = (await res.json().catch(() => ({}))) as {
    founder_documents?: SupervisorFounderDocument[];
  };
  const documents = Array.isArray(payload.founder_documents) ? payload.founder_documents : [];
  const dailyUpdates = documents.filter((doc) => doc.type === "daily_update");

  return documents
    .filter((doc) => {
      if (doc.type === "mission") return true;
      if (doc.type === "daily_update") return true;
      if (doc.type === "plan") return true;
      return dailyUpdates.length === 0 && doc.type === "executive_brief";
    })
    .map((doc) => {
      if (doc.type === "executive_brief" && dailyUpdates.length === 0) {
        const dayNumber = computeFounderDayNumber(companyCreatedAt, doc.date ?? undefined);
        return {
          ...doc,
          type: "daily_update",
          title: `Daily Executive Brief — Day ${dayNumber}`,
        };
      }
      return doc;
    });
}

export function resolveFounderDocumentCreatedAt(
  doc: SupervisorFounderDocument,
  companyCreatedAt: string,
): string {
  if (doc.created_at) {
    return doc.created_at;
  }

  if (doc.date) {
    return ptDateToIsoMidday(doc.date);
  }

  return companyCreatedAt;
}

export function computeFounderDayNumber(companyCreatedAt: string, ptDate?: string): number {
  const createdPt = formatPtDate(companyCreatedAt);
  const targetPt = ptDate ?? formatPtDate(new Date().toISOString());
  const createdMidday = new Date(ptDateToIsoMidday(createdPt));
  const targetMidday = new Date(ptDateToIsoMidday(targetPt));
  const days = Math.floor((targetMidday.getTime() - createdMidday.getTime()) / 86_400_000) + 1;
  return Math.max(1, days);
}

export function formatPtDate(isoDate: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(isoDate));
}

export function ptDateToIsoMidday(ptDate: string): string {
  return `${ptDate}T12:00:00.000Z`;
}

export function buildFounderDocumentExcerpt(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > 220 ? `${compact.slice(0, 220).trim()}...` : compact;
}

export async function loadFounderDocumentsSnapshot(
  env: Env,
  companyId: string,
  company: Pick<CompanyRow, "created_at" | "genesis_prompt">,
  options?: {
    reconcileWorkspaceTasks?: boolean;
  },
): Promise<FounderDocumentsSnapshot> {
  const workspace = await fetchWorkspaceSnapshot(env, companyId);
  if (options?.reconcileWorkspaceTasks) {
    await reconcileTasksWithWorkspace(env, companyId, workspace);
  }
  const founderDocuments = await fetchFounderDocuments(env, companyId, company.created_at);

  const documents: FounderDocumentsSnapshot["documents"] = [];
  const liveMission = founderDocuments.find((doc) => doc.type === "mission");
  if (liveMission) {
    documents.push({
      id: `founder_${liveMission.path}`,
      type: "mission",
      title: "Mission",
      body: liveMission.content,
      excerpt: buildFounderDocumentExcerpt(liveMission.content),
      createdAt: resolveFounderDocumentCreatedAt(liveMission, company.created_at),
      path: liveMission.path,
      category: "founder",
    });
  } else if (company.genesis_prompt) {
    documents.push({
      id: "founder_genesis_mission",
      type: "mission",
      title: "Mission",
      body: company.genesis_prompt,
      excerpt: buildFounderDocumentExcerpt(company.genesis_prompt),
      createdAt: company.created_at,
      path: "genesis_prompt",
      category: "founder",
    });
  }

  for (const doc of founderDocuments) {
    if (doc.type === "mission") continue;
    documents.push({
      id: `founder_${doc.path}`,
      type: "workspace_document",
      title: doc.title,
      body: doc.content,
      excerpt: buildFounderDocumentExcerpt(doc.content),
      createdAt: resolveFounderDocumentCreatedAt(doc, company.created_at),
      path: doc.path,
      category: "founder",
    });
  }

  // Include workspace documents (task deliverables like positioning, competitor briefs, etc.)
  // that aren't already covered by the founder documents above.
  const founderPaths = new Set(founderDocuments.map((d) => d.path));
  for (const wsDoc of workspace.documents) {
    if (founderPaths.has(wsDoc.path)) continue;
    // Skip internal/system files
    if (wsDoc.path.startsWith(".agent/") || wsDoc.path === "docs/goal.md") continue;
    documents.push({
      id: `ws_${wsDoc.path}`,
      type: "workspace_document",
      title: wsDoc.title,
      body: wsDoc.body,
      excerpt: buildFounderDocumentExcerpt(wsDoc.body),
      createdAt: wsDoc.updatedAt || company.created_at,
      path: wsDoc.path,
      category: "workspace",
    });
  }

  documents.sort((a, b) => {
    const priority = documentPriority(a) - documentPriority(b);
    if (priority !== 0) return priority;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return {
    documents,
    artifacts: workspace.results
      .filter((artifact) => isFounderArtifact(artifact.path, artifact.kind, artifact.previewDataUrl))
      .map((artifact) => ({
        ...artifact,
        openUrl: `/api/companies/${companyId}/artifacts?path=${encodeURIComponent(artifact.path)}`,
      })),
  };
}
