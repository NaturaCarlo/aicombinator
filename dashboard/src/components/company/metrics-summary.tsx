"use client";

import { useState } from "react";
import { Coins, Cpu, Activity, ChevronDown, ChevronRight } from "lucide-react";
import type { CompanyStatus, CostByAgent } from "@/lib/types";
import {
  formatTokenCount,
  formatTokens,
  formatCostAgentLabel,
  modelDisplayName,
} from "@/lib/credits";

export function MetricsSummary({
  status,
  costByAgent,
  isLoading,
}: {
  status: CompanyStatus | undefined;
  costByAgent?: CostByAgent[];
  isLoading: boolean;
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  if (isLoading) {
    return (
      <div className="card-clean p-4 space-y-3">
        <div className="shimmer h-4 w-20 rounded" />
        <div className="shimmer h-2 w-full rounded-none" />
        <div className="shimmer h-3 w-32 rounded" />
        <div className="shimmer h-3 w-24 rounded" />
      </div>
    );
  }

  if (!status) return null;

  const budget = status.budgetCents;
  const spent = status.spentCents;
  const remaining = status.remainingCents;
  const pct = status.budgetCents > 0 ? (status.spentCents / status.budgetCents) * 100 : 0;
  const barColor = pct > 90 ? "bg-accent-red" : pct > 70 ? "bg-amber-500" : "bg-accent-green";
  const model = modelDisplayName(status.model);

  return (
    <div className="card-clean p-4">
      <div className="flex items-center gap-2 mb-3">
        <Coins className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="section-label">
          Metrics
        </span>
      </div>

      {/* Budget bar */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-sm font-bold">{formatTokens(remaining)}</span>
          <span className="text-[10px] text-muted-foreground">of {formatTokens(budget)}</span>
        </div>
        <div className="h-1.5 rounded-none bg-secondary overflow-hidden">
          <div
            className={`h-full rounded-none ${barColor} transition-all`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Activity className="h-3 w-3" />
            Turns
          </span>
          <span className="font-medium">{status.turnCount}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Coins className="h-3 w-3" />
            Spent
          </span>
          <span className="font-medium">{formatTokens(spent)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Cpu className="h-3 w-3" />
            Model
          </span>
          <span className="font-medium">{model}</span>
        </div>
      </div>

      {/* Cost by agent breakdown */}
      {costByAgent && costByAgent.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <button
            onClick={() => setShowBreakdown(!showBreakdown)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {showBreakdown ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Cost by agent
          </button>
          {showBreakdown && (
            <div className="mt-2 space-y-1">
              {costByAgent.map((agent) => (
                <div key={agent.agent_id || "unattributed"} className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground truncate">
                    {formatCostAgentLabel(agent.agent_name, agent.agent_id)}
                  </span>
                  <span className="font-medium">{formatTokenCount(agent.total_cost_cents)} tokens</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
