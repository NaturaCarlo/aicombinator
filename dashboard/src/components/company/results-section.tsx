"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ChevronDown, ExternalLink, FileCode2, ImageIcon, LayoutTemplate } from "lucide-react";
import { resolveApiUrl } from "@/lib/api";
import type { CompanyArtifact } from "@/lib/types";

const KIND_LABELS: Record<string, string> = {
  landing_page: "Landing page",
  app_page: "App page",
  report_asset: "Report",
  creative_asset: "Creative asset",
  content_asset: "Content asset",
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function iconForKind(kind: string) {
  switch (kind) {
    case "landing_page":
    case "app_page":
      return <LayoutTemplate className="h-3.5 w-3.5 text-accent-orange" />;
    case "creative_asset":
      return <ImageIcon className="h-3.5 w-3.5 text-accent-green" />;
    default:
      return <FileCode2 className="h-3.5 w-3.5 text-blue-500" />;
  }
}

export function ResultsSection({
  artifacts,
}: {
  artifacts: CompanyArtifact[] | undefined;
}) {
  const { getToken } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [openingArtifact, setOpeningArtifact] = useState<string | null>(null);
  const visibleArtifacts = artifacts || [];

  const preview = visibleArtifacts.slice(0, 3);
  const rest = visibleArtifacts.slice(3);
  const shown = expanded ? visibleArtifacts : preview;

  async function handleOpenArtifact(openUrl: string, title: string) {
    const token = await getToken();
    if (!token) return;

    setOpeningArtifact(openUrl);

    try {
      const res = await fetch(resolveApiUrl(openUrl), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Artifact fetch failed: ${res.status}`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const popup = window.open(blobUrl, "_blank", "noopener,noreferrer");
      if (popup) {
        popup.document.title = title;
      }
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } finally {
      setOpeningArtifact(null);
    }
  }

  return (
    <div className="card-clean overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <FileCode2 className="h-3.5 w-3.5 text-accent-orange" />
        <span className="section-label">
          Artifacts
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{visibleArtifacts.length}</span>
      </div>

      {visibleArtifacts.length === 0 ? (
        <div className="px-4 py-4">
          <p className="text-xs font-medium text-foreground">
            No artifacts yet.
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            This block will show founder-viewable outputs like landing pages, PDFs, presentations, and creative assets once the team produces them.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {shown.map((artifact) => (
            <div key={artifact.path} className="px-4 py-3">
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5 shrink-0">{iconForKind(artifact.kind)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-xs font-medium truncate">{artifact.title}</p>
                    <span className="shrink-0 rounded-none bg-secondary px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                      {KIND_LABELS[artifact.kind] || artifact.kind.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground break-all">
                    {artifact.path}
                  </p>
                  {artifact.previewDataUrl ? (
                    <img
                      src={artifact.previewDataUrl}
                      alt={artifact.title}
                      className="mt-2 h-28 w-full rounded-none border border-border object-cover"
                    />
                  ) : (
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      {artifact.excerpt}
                    </p>
                  )}
                  {artifact.openUrl && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleOpenArtifact(artifact.openUrl!, artifact.title)}
                        className="inline-flex items-center gap-1 text-[10px] text-accent-orange hover:underline"
                        disabled={openingArtifact === artifact.openUrl}
                      >
                        <ExternalLink className="h-2.5 w-2.5" />
                        {openingArtifact === artifact.openUrl ? "Opening..." : "Open artifact"}
                      </button>
                    </div>
                  )}
                  <p className="mt-2 text-[10px] text-muted-foreground/70">
                    Updated {timeAgo(artifact.updatedAt)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {rest.length > 0 && visibleArtifacts.length > 0 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-center gap-1 border-t border-border px-4 py-2 text-[10px] text-muted-foreground transition-colors hover:bg-secondary/30 hover:text-foreground"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
          {expanded ? "Show less" : `Show ${rest.length} more`}
        </button>
      )}
    </div>
  );
}
