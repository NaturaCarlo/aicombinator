import { Coins, RefreshCw, Activity, Cpu } from "lucide-react";
import type { CompanyStatus } from "@/lib/types";
import { formatTokens, modelDisplayName } from "@/lib/credits";

export function MetricsPanel({
  status,
  isLoading,
}: {
  status?: CompanyStatus;
  isLoading: boolean;
}) {
  if (isLoading || !status) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card-clean p-4">
            <div className="shimmer mb-2 h-3 w-16 rounded" />
            <div className="shimmer h-7 w-14 rounded" />
          </div>
        ))}
      </div>
    );
  }

  const total = status.budgetCents;
  const spent = status.spentCents;
  const remaining = status.remainingCents;
  const pct = total > 0 ? (remaining / total) * 100 : 0;

  const metrics = [
    {
      label: "Tokens",
      value: formatTokens(remaining),
      sub: `of ${formatTokens(total)}`,
      icon: Coins,
    },
    {
      label: "Turns",
      value: status.turnCount.toString(),
      sub: status.lastTurnTime
        ? `last ${timeSince(status.lastTurnTime)}`
        : "none yet",
      icon: RefreshCw,
    },
    {
      label: "Spent",
      value: formatTokens(spent),
      sub: "total tokens used",
      icon: Activity,
    },
    {
      label: "Model",
      value: modelDisplayName(status.model),
      sub: "current company default",
      icon: Cpu,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {metrics.map((m, i) => (
          <div key={m.label} className={`card-clean fade-in-up stagger-${i + 1} p-4`}>
            <div className="mb-2 flex items-center gap-2">
              <m.icon className="h-4 w-4 text-accent-orange" />
              <p className="text-xs font-medium text-muted-foreground">{m.label}</p>
            </div>
            <p className="text-xl font-bold tracking-tight">{m.value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{m.sub}</p>
          </div>
        ))}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-none bg-secondary">
        <div
          className="h-2 rounded-none progress-bar"
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
    </div>
  );
}

function timeSince(dateStr: string): string {
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
