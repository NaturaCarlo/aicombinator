import type { Env, TaskRow } from "../types.js";
import { fetchFromCompanySupervisor } from "./supervisor-routing.js";

export interface WorkspaceDocumentSnapshot {
  path: string;
  title: string;
  category: string;
  body: string;
  excerpt: string;
  updatedAt: string;
}

export interface WorkspaceResultSnapshot {
  path: string;
  title: string;
  kind: string;
  excerpt: string;
  updatedAt: string;
  urls?: string[];
  previewDataUrl?: string;
  openUrl?: string;
}

export interface WorkspaceSnapshot {
  documents: WorkspaceDocumentSnapshot[];
  results: WorkspaceResultSnapshot[];
}

export async function fetchWorkspaceSnapshot(
  env: Env,
  companyId: string,
): Promise<WorkspaceSnapshot> {
  try {
    const res = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/workspace/artifacts`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );
    if (!res || !res.ok) {
      return { documents: [], results: [] };
    }
    return res.json() as Promise<WorkspaceSnapshot>;
  } catch {
    return { documents: [], results: [] };
  }
}

export async function reconcileTasksWithWorkspace(
  env: Env,
  companyId: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const taskResult = await env.DB.prepare(
    `SELECT * FROM tasks WHERE company_id = ?`,
  ).bind(companyId).all<TaskRow>();

  const tasks = taskResult.results ?? [];
  if (tasks.length === 0) {
    return;
  }

  const docPaths = new Set(snapshot.documents.map((doc) => doc.path));
  const statements = [];

  for (const task of tasks) {
    const artifact = matchTaskArtifact(task.title, docPaths, snapshot.results);
    if (!artifact || task.artifact === artifact) continue;

    statements.push(
      env.DB.prepare(
        `UPDATE tasks SET artifact = ?, updated_at = datetime('now') WHERE id = ?`,
      ).bind(artifact, task.id),
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

function matchTaskArtifact(
  title: string,
  docPaths: Set<string>,
  results: WorkspaceResultSnapshot[],
): string | null {
  const lowerTitle = title.toLowerCase();
  const landingPage =
    results.find((result) => result.kind === "landing_page") ??
    results.find((result) => result.kind === "app_page");

  if (lowerTitle.includes("operating plan") && docPaths.has("docs/plan.md")) {
    return "docs/plan.md";
  }

  if (
    (lowerTitle.includes("plan") || lowerTitle.includes("execution"))
    && docPaths.has("docs/plan.md")
  ) {
    return "docs/plan.md";
  }

  if (lowerTitle.includes("architecture") && docPaths.has("docs/architecture.md")) {
    return "docs/architecture.md";
  }

  if (
    lowerTitle.includes("product shell")
    || lowerTitle.includes("landing page")
    || lowerTitle.includes("landing")
    || lowerTitle.includes("homepage")
    || lowerTitle.includes("founder-facing")
    || lowerTitle.includes("site")
  ) {
    return landingPage?.path ?? null;
  }

  if (lowerTitle.includes("backend")) {
    return null;
  }

  if (lowerTitle.includes("qa")) {
    if (docPaths.has("docs/qa-plan.md")) return "docs/qa-plan.md";
    if (docPaths.has("docs/qa/bugs.md")) return "docs/qa/bugs.md";
  }

  if (lowerTitle.includes("services") || lowerTitle.includes("dependencies")) {
    if (docPaths.has("docs/ops/api-services.md")) {
      return "docs/ops/api-services.md";
    }
  }

  if (lowerTitle.includes("positioning") || lowerTitle.includes("launch channels") || lowerTitle.includes("icp")) {
    if (docPaths.has("docs/market-analysis.md")) {
      return "docs/market-analysis.md";
    }
    if (docPaths.has("docs/marketing-plan.md")) {
      return "docs/marketing-plan.md";
    }
    if (docPaths.has("docs/marketing.md")) {
      return "docs/marketing.md";
    }
    return results.find((result) => result.kind === "creative_asset")?.path ?? null;
  }

  if (lowerTitle.includes("brief") && docPaths.has("docs/executive-brief.md")) {
    return "docs/executive-brief.md";
  }

  if ((lowerTitle.includes("mission") || lowerTitle.includes("positioning")) && docPaths.has("docs/mission.md")) {
    return "docs/mission.md";
  }

  return null;
}
