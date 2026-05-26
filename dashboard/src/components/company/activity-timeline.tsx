"use client";

import { CheckCircle2, XCircle, Zap, Clock, MessageSquare } from "lucide-react";
import type { ActivityEntry } from "@/lib/types";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const typeConfig: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  turn: {
    color: "text-accent-green",
    bg: "bg-accent-green/10",
    icon: <Zap className="h-3.5 w-3.5" />,
  },
  milestone: {
    color: "text-accent-orange",
    bg: "bg-accent-orange/10",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  state_change: {
    color: "text-foreground",
    bg: "bg-secondary",
    icon: <Zap className="h-3.5 w-3.5" />,
  },
  error: {
    color: "text-accent-red",
    bg: "bg-accent-red/10",
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
  creator_message: {
    color: "text-accent-orange",
    bg: "bg-accent-orange/10",
    icon: <MessageSquare className="h-3.5 w-3.5" />,
  },
  relay_message: {
    color: "text-blue-500",
    bg: "bg-blue-500/10",
    icon: <MessageSquare className="h-3.5 w-3.5" />,
  },
  "issue.created": {
    color: "text-blue-500",
    bg: "bg-blue-500/10",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  "issue.status_changed": {
    color: "text-accent-orange",
    bg: "bg-accent-orange/10",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
};

export function ActivityTimeline({
  entries,
  isLoading,
}: {
  entries?: ActivityEntry[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="card-clean p-4 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="shimmer h-7 w-7 rounded-none" />
            <div className="flex-1 space-y-1">
              <div className="shimmer h-3.5 w-3/4 rounded" />
              <div className="shimmer h-3 w-16 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const filtered = entries || [];

  if (filtered.length === 0) {
    return (
      <div className="card-clean flex flex-col items-center justify-center py-8">
        <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-none bg-secondary text-muted-foreground">
          <Clock className="h-4 w-4" />
        </div>
        <p className="text-xs font-medium text-muted-foreground">No notable activity yet</p>
      </div>
    );
  }

  return (
    <div className="card-clean flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 shrink-0">
        <Clock className="h-3.5 w-3.5 text-accent-orange" />
        <span className="section-label">
          Activity
        </span>
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {filtered.map((entry) => {
          const isCreatorMsg =
            entry.type === "tool_call" &&
            (entry.summary.startsWith("Creator sent message") ||
              entry.summary.startsWith("Creator chatted with CEO"));
          const entryType = isCreatorMsg ? "creator_message" : entry.type;
          const config = typeConfig[entryType] || typeConfig.state_change;

          return (
            <div key={entry.id} className="flex items-start gap-3 px-4 py-3">
              <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-none ${config.bg} ${config.color}`}>
                {config.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs leading-snug">{entry.summary}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {timeAgo(entry.createdAt)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
