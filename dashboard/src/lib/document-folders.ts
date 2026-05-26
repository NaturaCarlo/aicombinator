import type { CompanyDocument, CompanyArtifact } from "./types";

// ─── Folder Types ────────────────────────────────────────────

export type FolderName = "Reports" | "Mission" | "Plans" | "Deliverables" | "Workspace";

export const FOLDER_ORDER: FolderName[] = [
  "Reports",
  "Mission",
  "Plans",
  "Deliverables",
  "Workspace",
];

export interface FolderItem {
  id: string;
  kind: "document" | "artifact";
  title: string;
  body: string;
  agentName?: string;
  date: string;
  previewDataUrl?: string;
  /** Original document type for icon derivation */
  docType?: string;
  /** Whether this is an artifact with an image preview */
  isImage: boolean;
}

export interface FolderDefinition {
  name: FolderName;
  items: FolderItem[];
}

// ─── Classification ──────────────────────────────────────────

export function classifyDocument(doc: CompanyDocument): FolderName {
  const path = (doc.path || "").toLowerCase();
  const title = doc.title.toLowerCase();

  // Reports: daily_report type
  if (
    doc.type === "daily_report"
    || path.includes("executive-brief")
    || path.includes("daily-update")
    || title.includes("executive brief")
    || title.includes("daily update")
  ) {
    return "Reports";
  }

  // Mission: mission type
  if (
    doc.type === "mission"
    || path === "docs/mission.md"
    || path === "genesis_prompt"
    || title.includes("mission")
  ) {
    return "Mission";
  }

  // Plans: current_plan classified
  if (
    path === "docs/plan.md"
    || title.includes("current plan")
    || title.includes("operating plan")
  ) {
    return "Plans";
  }

  // Deliverables: deliverable/workspace type with workspace category
  if (doc.type === "workspace_document" && doc.category === "workspace") {
    return "Deliverables";
  }

  // Workspace: catch-all
  return "Workspace";
}

// ─── Build Folders ───────────────────────────────────────────

function documentToFolderItem(doc: CompanyDocument): FolderItem {
  return {
    id: doc.id,
    kind: "document",
    title: doc.title,
    body: doc.body || "",
    agentName: doc.agentName,
    date: doc.createdAt,
    docType: doc.type,
    isImage: false,
  };
}

function artifactToFolderItem(artifact: CompanyArtifact): FolderItem {
  return {
    id: artifact.path,
    kind: "artifact",
    title: artifact.title,
    body: artifact.excerpt || "",
    agentName: undefined,
    date: artifact.updatedAt,
    previewDataUrl: artifact.previewDataUrl,
    docType: artifact.kind,
    isImage: Boolean(artifact.previewDataUrl),
  };
}

export function buildFolders(
  documents: CompanyDocument[],
  artifacts?: CompanyArtifact[],
): FolderDefinition[] {
  // Filter out questions
  const filtered = documents.filter((doc) => doc.type !== "question");

  // Initialize folder map
  const folderMap = new Map<FolderName, FolderItem[]>();
  for (const name of FOLDER_ORDER) {
    folderMap.set(name, []);
  }

  // Classify documents into folders
  for (const doc of filtered) {
    const folder = classifyDocument(doc);
    folderMap.get(folder)!.push(documentToFolderItem(doc));
  }

  // Add artifacts to Workspace folder
  if (artifacts) {
    for (const artifact of artifacts) {
      folderMap.get("Workspace")!.push(artifactToFolderItem(artifact));
    }
  }

  // Sort items in each folder by date descending
  for (const items of folderMap.values()) {
    items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  return FOLDER_ORDER.map((name) => ({
    name,
    items: folderMap.get(name)!,
  }));
}

export function countAllItems(folders: FolderDefinition[]): number {
  return folders.reduce((sum, f) => sum + f.items.length, 0);
}
