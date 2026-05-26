import { Play, Settings, Zap, CheckCircle2, XCircle, Clock } from "lucide-react";
import type { ActivityEntry } from "@/lib/types";

const typeConfig: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  turn: {
    color: "text-foreground",
    bg: "bg-secondary",
    icon: <Play className="h-3.5 w-3.5" />,
  },
  tool_call: {
    color: "text-muted-foreground",
    bg: "bg-secondary",
    icon: <Settings className="h-3.5 w-3.5" />,
  },
  state_change: {
    color: "text-foreground",
    bg: "bg-secondary",
    icon: <Zap className="h-3.5 w-3.5" />,
  },
  milestone: {
    color: "text-accent-orange",
    bg: "bg-accent-orange/10",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  error: {
    color: "text-accent-red",
    bg: "bg-accent-red/10",
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000,
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ActivityFeed({
  entries,
  isLoading,
}: {
  entries?: ActivityEntry[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 p-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 rounded-none p-3">
            <div className="shimmer h-7 w-7 rounded-none" />
            <div className="flex-1 space-y-1.5">
              <div className="shimmer h-4 w-3/4 rounded" />
              <div className="shimmer h-3 w-20 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-none bg-secondary text-muted-foreground">
          <Clock className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">
          No activity yet
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground/60">
          Waiting for the agent to start...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5 p-1">
      {entries.map((entry, i) => {
        const config = typeConfig[entry.type] || typeConfig.tool_call;
        return (
          <div
            key={entry.id}
            className="slide-in-right flex items-start gap-3 rounded-none p-3 transition-colors hover:bg-secondary/50"
            style={{ animationDelay: `${i * 0.03}s` }}
          >
            <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-none ${config.bg} ${config.color}`}>
              {config.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm leading-snug">{entry.summary}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {timeAgo(entry.createdAt)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
