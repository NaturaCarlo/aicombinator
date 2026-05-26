"use client";

import { useState } from "react";
import { Coins, Activity, Cpu, ChevronDown, ChevronRight } from "lucide-react";
import type { CompanyStatus, CostByAgent, FounderState } from "@/lib/types";
import {
  formatTokenCount,
  formatTokens,
  formatCostAgentLabel,
  modelMultiplierLabel,
  modelDisplayName,
} from "@/lib/credits";

export function CompactMetrics({
  status,
  costByAgent,
  credits,
  isLoading,
}: {
  status: CompanyStatus | undefined;
  costByAgent?: CostByAgent[];
  credits?: FounderState["credits"];
  isLoading: boolean;
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showReservations, setShowReservations] = useState(false);

  if (isLoading) {
    return (
      <div className="card-clean px-3 py-3">
        <div className="space-y-2">
          <div className="shimmer h-1.5 w-full rounded-none" />
          <div className="shimmer h-4 w-20 rounded" />
        </div>
      </div>
    );
  }

  if (!status) return null;

  const spent = status.spentCents;
  const modelDisplay = modelDisplayName(status.model);
  const modelRate = modelMultiplierLabel(status.model);
  const availableCredits = credits?.available;
  const reservationBreakdown = credits?.reservations ?? [];
  const currentCompanyReservation = credits?.currentCompanyReserved ?? 0;
  const otherCompanyReserved = credits?.otherCompanyReserved ?? 0;
  const maxAgentCost = Math.max(
    1,
    ...(costByAgent?.map((agent) => agent.total_cost_cents || 0) ?? [1]),
  );

  return (
    <div className="card-clean overflow-hidden px-3 py-3">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-none bg-accent-orange/10 text-accent-orange ring-1 ring-accent-orange/15">
          <Coins className="h-3.5 w-3.5" />
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Tokens
          </div>
          <div className="text-[11px] text-muted-foreground">
            Account-wide compute budget
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-none border border-accent-orange/15 bg-gradient-to-br from-accent-orange/[0.10] via-background to-background px-3.5 py-3.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Available now
        </div>
        <div className="mt-1 text-[28px] font-bold tracking-[-0.04em] text-foreground">
          {formatTokens(availableCredits)}
        </div>
        <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Shared across your account and updated as teams spend.
        </div>
        {credits?.contentionReason && (
          <div className="mt-3 rounded-none border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            Tokens are currently tied up elsewhere: {credits.contentionReason}
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-none border border-border bg-secondary/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            Turns
          </div>
          <div className="mt-1 text-lg font-semibold tracking-tight text-foreground">
            {status.turnCount}
          </div>
        </div>

        <div className="rounded-none border border-border bg-secondary/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <Coins className="h-3.5 w-3.5" />
            Spent
          </div>
          <div className="mt-1 text-lg font-semibold tracking-tight text-foreground">
            {formatTokenCount(spent)}
          </div>
          <div className="text-[10px] text-muted-foreground">tokens</div>
        </div>

        <div className="rounded-none border border-border bg-secondary/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <Coins className="h-3.5 w-3.5" />
            Reserved
          </div>
          <div className="mt-1 text-lg font-semibold tracking-tight text-foreground">
            {formatTokenCount(credits?.reserved ?? 0)}
          </div>
          <div className="text-[10px] text-muted-foreground">tokens</div>
        </div>

        <div className="rounded-none border border-border bg-secondary/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" />
            Model
          </div>
          <div className="mt-1 text-base font-semibold tracking-tight text-foreground">
            {modelDisplay}
          </div>
          <div className="text-[10px] text-muted-foreground">{modelRate}</div>
        </div>
      </div>

      {credits && credits.reserved > 0 && (
        <div className="mt-3 rounded-none border border-border bg-secondary/20 px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Reservation pressure
              </div>
              <div className="mt-1 text-xs leading-relaxed text-foreground">
                {otherCompanyReserved > 0
                  ? `${formatTokenCount(otherCompanyReserved)} tokens are currently tied up in other companies.`
                  : currentCompanyReservation > 0
                    ? `This company is currently holding ${formatTokenCount(currentCompanyReservation)} reserved tokens for active turns.`
                    : "Reserved tokens are currently in flight."}
              </div>
            </div>
            {reservationBreakdown.length > 0 && (
              <button
                type="button"
                onClick={() => setShowReservations((current) => !current)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-none bg-background text-muted-foreground ring-1 ring-border"
                aria-label={showReservations ? "Hide reservation breakdown" : "Show reservation breakdown"}
              >
                {showReservations ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>

          {showReservations && reservationBreakdown.length > 0 && (
            <div className="mt-3 space-y-2">
              {reservationBreakdown.map((reservation) => (
                <div
                  key={reservation.companyId}
                  className="flex items-center justify-between gap-3 rounded-none border border-border bg-background/80 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-foreground">
                      {reservation.companyName}
                      {reservation.isCurrentCompany ? " · this company" : ""}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {reservation.state ? reservation.state.replaceAll("_", " ") : "runtime"}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xs font-semibold text-foreground">
                      {formatTokenCount(reservation.reserved)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">reserved</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {costByAgent && costByAgent.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <button
            onClick={() => setShowBreakdown(!showBreakdown)}
            className="flex w-full items-center justify-between rounded-none border border-border bg-secondary/20 px-3 py-2.5 text-left transition-colors hover:border-accent-orange/30 hover:bg-secondary/35"
          >
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Cost by agent
              </div>
              <div className="mt-0.5 text-xs text-foreground">
                {showBreakdown ? "Hide spend breakdown" : `See ${costByAgent.length} contributor${costByAgent.length === 1 ? "" : "s"}`}
              </div>
            </div>
            <div className="flex h-7 w-7 items-center justify-center rounded-none bg-background text-muted-foreground ring-1 ring-border">
              {showBreakdown ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </div>
          </button>

          {showBreakdown && (
            <div className="mt-2 space-y-2">
              {costByAgent.map((agent) => (
                <div
                  key={agent.agent_id || "unattributed"}
                  className="rounded-none border border-border bg-background/80 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">
                        {formatCostAgentLabel(agent.agent_name, agent.agent_id)}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {agent.event_count} turn{agent.event_count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold text-foreground">
                        {formatTokenCount(agent.total_cost_cents)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">tokens</div>
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-none bg-secondary">
                    <div
                      className="h-full rounded-none bg-accent-orange"
                      style={{
                        width: `${Math.max(8, Math.round((agent.total_cost_cents / maxAgentCost) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
