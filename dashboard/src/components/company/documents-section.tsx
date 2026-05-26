"use client";

import { useState } from "react";
import { ChevronDown, FileText } from "lucide-react";
import { MarkdownContent } from "./markdown-content";
import type { CompanyDocument } from "@/lib/types";

type FounderDocumentKind = "mission" | "daily_brief" | "current_plan" | "deliverable";

function classifyFounderDocument(doc: CompanyDocument): FounderDocumentKind | null {
  const path = (doc.path || "").toLowerCase();
  const title = doc.title.toLowerCase();

  if (doc.type === "mission" || path === "docs/mission.md" || path === "genesis_prompt" || title.includes("mission")) {
    return "mission";
  }

  if (
    doc.type === "daily_report"
    || path.includes("executive-brief")
    || path.includes("daily-update")
    || title.includes("executive brief")
    || title.includes("daily executive brief")
    || title.includes("daily update")
  ) {
    return "daily_brief";
  }

  if (
    path === "docs/plan.md"
    || title.includes("current plan")
    || title.includes("operating plan")
  ) {
    return "current_plan";
  }

  // Workspace documents that are task deliverables (e.g. positioning, competitor brief, buyer persona)
  if (doc.type === "workspace_document" && doc.category === "workspace") {
    return "deliverable";
  }

  return null;
}

function founderDocumentPriority(kind: FounderDocumentKind): number {
  switch (kind) {
    case "mission":
      return 0;
    case "daily_brief":
      return 1;
    case "current_plan":
      return 2;
    case "deliverable":
      return 3;
  }
}

function founderDocumentTitle(doc: CompanyDocument, kind: FounderDocumentKind): string {
  if (kind === "mission") {
    return "Mission";
  }

  if (kind === "daily_brief") {
    const dateLabel = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "America/Los_Angeles",
    }).format(new Date(doc.createdAt));
    return `Daily Executive Brief — ${dateLabel}`;
  }

  if (kind === "current_plan") {
    return "Current Plan";
  }

  // Deliverable: use the document's own title
  return doc.title;
}

function selectFounderDocuments(documents: CompanyDocument[]): Array<CompanyDocument & { founderKind: FounderDocumentKind }> {
  const mission = documents
    .filter((doc) => classifyFounderDocument(doc) === "mission")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 1)
    .map((doc) => ({ ...doc, founderKind: "mission" as const }));

  const currentPlan = documents
    .filter((doc) => classifyFounderDocument(doc) === "current_plan")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 1)
    .map((doc) => ({ ...doc, founderKind: "current_plan" as const }));

  const dailyBriefs = documents
    .filter((doc) => classifyFounderDocument(doc) === "daily_brief")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 7)
    .map((doc) => ({ ...doc, founderKind: "daily_brief" as const }));

  const deliverables = documents
    .filter((doc) => classifyFounderDocument(doc) === "deliverable")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10)
    .map((doc) => ({ ...doc, founderKind: "deliverable" as const }));

  return [...mission, ...dailyBriefs, ...currentPlan, ...deliverables].sort((a, b) => {
    const priority = founderDocumentPriority(a.founderKind) - founderDocumentPriority(b.founderKind);
    if (priority !== 0) return priority;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function DocumentRow({ doc }: { doc: CompanyDocument & { founderKind: FounderDocumentKind } }) {
  const [expanded, setExpanded] = useState(false);
  const title = founderDocumentTitle(doc, doc.founderKind);
  const body = (doc.body || "").trim();

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-start gap-2.5">
          <FileText className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${doc.founderKind === "mission" ? "text-blue-500" : doc.founderKind === "deliverable" ? "text-orange-500" : "text-muted-foreground"}`} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate">{title}</p>
            {!expanded && (
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground line-clamp-2">
                {doc.excerpt || body}
              </p>
            )}
            <p className="mt-1 text-[10px] text-muted-foreground/60">
              {new Date(doc.createdAt).toLocaleDateString()}
              {doc.agentName && ` · ${doc.agentName}`}
            </p>
          </div>
          <ChevronDown className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
        </div>
      </button>
      {expanded && body && (
        <div className="px-4 pb-4 pl-[42px]">
          <div className="rounded-none border border-border bg-secondary/20 px-4 py-3 max-h-[60vh] overflow-y-auto">
            <MarkdownContent content={body} className="text-[12px] leading-relaxed text-foreground" />
          </div>
        </div>
      )}
    </div>
  );
}

export function DocumentsSection({
  documents,
  isLoading,
}: {
  documents: CompanyDocument[] | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="card-clean p-4">
        <div className="shimmer h-4 w-32 rounded mb-3" />
        <div className="space-y-2">
          <div className="shimmer h-8 w-full rounded" />
          <div className="shimmer h-8 w-full rounded" />
        </div>
      </div>
    );
  }

  const outputDocs = selectFounderDocuments(
    (documents || [])
    .filter((doc) => doc.type !== "question")
  );

  if (outputDocs.length === 0) return null;

  return (
    <div className="card-clean overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <FileText className="h-3.5 w-3.5 text-blue-500" />
        <span className="section-label">
          Documents
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{outputDocs.length}</span>
      </div>
      <div className="divide-y divide-border">
        {outputDocs.map((doc) => (
          <DocumentRow key={doc.id} doc={doc} />
        ))}
      </div>
    </div>
  );
}
