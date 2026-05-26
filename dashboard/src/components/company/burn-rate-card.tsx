"use client";

import { Flame, TrendingDown, Clock } from "lucide-react";
import { useBurnRate } from "@/hooks/use-burn-rate";

interface BurnRateCardProps {
  companyId: string;
}

export function BurnRateCard({ companyId }: BurnRateCardProps) {
  const { data, isLoading } = useBurnRate(companyId);

  if (isLoading || !data) {
    return (
      <div className="card-clean p-4 animate-pulse">
        <div className="h-4 w-24 rounded bg-secondary mb-3" />
        <div className="h-8 w-16 rounded bg-secondary" />
      </div>
    );
  }

  const { creditsPerHour: tokensPerHour, creditsPerDay: tokensPerDay, daysRemaining, balance } = data;

  // Color coding based on days remaining
  let urgencyColor = "text-green-600 dark:text-green-400";
  let urgencyBg = "bg-green-50 dark:bg-green-950/50";
  if (daysRemaining !== null) {
    if (daysRemaining < 3) {
      urgencyColor = "text-red-600 dark:text-red-400";
      urgencyBg = "bg-red-50 dark:bg-red-950/50";
    } else if (daysRemaining < 7) {
      urgencyColor = "text-amber-600 dark:text-amber-400";
      urgencyBg = "bg-amber-50 dark:bg-amber-950/50";
    }
  }

  return (
    <div className="card-clean p-4">
      <div className="flex items-center gap-2 mb-3">
        <Flame className="h-4 w-4 text-accent-orange" />
        <span className="section-label">
          Burn Rate
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Tokens / hour</p>
          <p className="text-lg font-bold tabular-nums">
            {tokensPerHour.toFixed(1)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Tokens / day</p>
          <p className="text-lg font-bold tabular-nums">
            {tokensPerDay.toFixed(0)}
          </p>
        </div>
      </div>

      {daysRemaining !== null && tokensPerDay > 0 && (
        <div className={`mt-3 flex items-center gap-2 rounded-none px-3 py-2 ${urgencyBg}`}>
          <Clock className={`h-3.5 w-3.5 ${urgencyColor}`} />
          <span className={`text-xs font-medium ${urgencyColor}`}>
            {daysRemaining < 1
              ? `${Math.round(daysRemaining * 24)}h remaining`
              : `${Math.round(daysRemaining)} days remaining`}
          </span>
        </div>
      )}

      {tokensPerDay === 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-none bg-secondary/50 px-3 py-2">
          <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">No burn — agents free</span>
        </div>
      )}
    </div>
  );
}
