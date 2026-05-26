"use client";

import Link from "next/link";
import { Activity, BarChart3, Coins } from "lucide-react";
import { formatTokens, formatTokenCount } from "@/lib/credits";
import { useBurnRate } from "@/hooks/use-burn-rate";
import type { CompanyStatus } from "@/lib/types";

export function TokenBalanceCard({
  availableCredits,
  isLoading,
  companyId,
  status,
}: {
  availableCredits: number | undefined;
  isLoading: boolean;
  companyId?: string;
  status?: CompanyStatus;
}) {
  const { data: burnRate } = useBurnRate(companyId ?? null);

  if (isLoading) {
    return (
      <div className="card-clean p-4">
        <div className="flex items-center gap-3">
          <div className="shimmer h-9 w-9 rounded-none" />
          <div className="flex-1 space-y-1.5">
            <div className="shimmer h-3 w-20 rounded" />
            <div className="shimmer h-5 w-28 rounded" />
          </div>
        </div>
      </div>
    );
  }

  const showLow = availableCredits !== undefined && availableCredits <= 0;
  const totalSpent = status?.spentCents ?? 0;
  const turnCount = status?.turnCount ?? 0;
  const tokensLast24h = burnRate?.creditsLast24h;
  const tokensPerHour = burnRate?.creditsPerHour;

  return (
    <div className="card-clean p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-none bg-accent-orange/10 text-accent-orange">
            <Coins className="h-4 w-4" />
          </div>
          <div>
            <p className="section-label">
              Available tokens
            </p>
            <p className="text-lg font-bold tracking-tight text-foreground">
              {formatTokens(availableCredits)}
            </p>
          </div>
        </div>
        <Link
          href="/billing"
          className={`inline-flex items-center justify-center rounded-none px-3 py-1.5 text-xs font-medium transition-colors ${
            showLow
              ? "bg-accent-orange text-white hover:bg-accent-orange/90"
              : "border border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          {showLow ? "Add tokens" : "Manage"}
        </Link>
      </div>

      {/* Spend breakdown */}
      {(totalSpent > 0 || turnCount > 0 || tokensLast24h !== undefined) && (
        <div className="mt-3 grid grid-cols-3 gap-3 border-t border-border pt-3">
          <div className="flex items-start gap-1.5">
            <BarChart3 className="mt-0.5 h-3 w-3 text-muted-foreground" />
            <div>
              <p className="text-[10px] text-muted-foreground">Total used</p>
              <p className="text-sm font-semibold tabular-nums">{formatTokenCount(totalSpent)}</p>
            </div>
          </div>
          <div className="flex items-start gap-1.5">
            <Activity className="mt-0.5 h-3 w-3 text-muted-foreground" />
            <div>
              <p className="text-[10px] text-muted-foreground">Last 24h</p>
              <p className="text-sm font-semibold tabular-nums">
                {tokensLast24h !== undefined ? formatTokenCount(tokensLast24h) : "—"}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-1.5">
            <Activity className="mt-0.5 h-3 w-3 text-muted-foreground" />
            <div>
              <p className="text-[10px] text-muted-foreground">Burn rate</p>
              <p className="text-sm font-semibold tabular-nums">
                {tokensPerHour !== undefined ? `${formatTokenCount(tokensPerHour)}/h` : "—"}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
