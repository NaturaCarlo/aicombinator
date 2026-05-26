"use client";

import { useState } from "react";
import { Package, Flag, ChevronDown, ExternalLink } from "lucide-react";
import type { CompanyDocument } from "@/lib/types";

/** Extract URLs from milestone body text */
function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
  return [...new Set(text.match(urlRegex) || [])];
}

export function ProductsSection({
  documents,
}: {
  documents: CompanyDocument[] | undefined;
}) {
  const [expanded, setExpanded] = useState(false);

  // Products = milestone documents (these represent launches, features, deliverables)
  const milestones = (documents || []).filter((d) => d.type === "milestone");

  if (milestones.length === 0) return null;

  const preview = milestones.slice(0, 3);
  const rest = milestones.slice(3);
  const shown = expanded ? milestones : preview;

  return (
    <div className="card-clean overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Package className="h-3.5 w-3.5 text-accent-orange" />
        <span className="section-label">
          Products &amp; Launches
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {milestones.length}
        </span>
      </div>

      <div className="divide-y divide-border">
        {shown.map((doc) => {
          const urls = extractUrls(doc.body);
          return (
            <div key={doc.id} className="px-4 py-2.5">
              <div className="flex items-start gap-2.5">
                <Flag className="h-3.5 w-3.5 text-accent-green shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">{doc.title}</p>
                  <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">
                    {doc.body}
                  </p>
                  {urls.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      {urls.slice(0, 3).map((url) => (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] text-accent-orange hover:underline"
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          {new URL(url).hostname.replace("www.", "")}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground/50 shrink-0">
                  {new Date(doc.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {rest.length > 0 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-center gap-1 w-full px-4 py-2 border-t border-border text-[10px] text-muted-foreground hover:text-foreground hover:bg-secondary/30 transition-colors"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Show less" : `Show ${rest.length} more`}
        </button>
      )}
    </div>
  );
}
