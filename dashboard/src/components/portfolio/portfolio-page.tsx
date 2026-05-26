"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Rocket,
  Bot,
  Coins,
  Zap,
  Loader2,
} from "lucide-react";
import { useCompanies } from "@/hooks/use-companies";
import { useBilling } from "@/hooks/use-billing";
import { useCreditPurchaseConfirmation } from "@/hooks/use-credit-purchase-confirmation";
import { clearLaunchDraft } from "@/lib/launch-state";
import { StatusBadge } from "@/components/status-badge";
import { PageShell } from "@/components/shared/page-shell";
import type { Company, CompanyState } from "@/lib/types";

export function PortfolioPage() {
  const { data, isLoading } = useCompanies();
  const { data: billing, error: billingError, mutate: mutateBilling } = useBilling();
  const companies = data?.companies || [];
  const availableCredits = billing?.credits.balance;
  const creditConfirmationState = useCreditPurchaseConfirmation({
    successPath: "/portfolio",
    onGranted: mutateBilling,
  });

  if (isLoading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-32 fade-in-up">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="fade-in-up">
        {billingError && (
          <div className="mb-4 rounded-none border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
            We couldn’t load your account balance right now.
          </div>
        )}

        {creditConfirmationState.kind !== "idle" && (
          <div
            className={`mb-4 rounded-none border px-4 py-3 text-sm ${
              creditConfirmationState.kind === "error"
                ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
                : creditConfirmationState.kind === "success"
                  ? "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400"
                  : "border-border bg-background text-muted-foreground"
            }`}
          >
            <div className="flex items-center gap-2">
              {creditConfirmationState.kind === "confirming" && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              <span>{creditConfirmationState.message?.replace(/credits/gi, "tokens").replace(/credit/gi, "token")}</span>
            </div>
          </div>
        )}

        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Portfolio</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Your AI-powered companies
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden h-14 items-center rounded-none border border-border bg-background px-4 sm:flex">
              <div>
                <div className="flex items-center gap-2 text-[#ee6018]">
                  <Zap className="h-4 w-4" />
                  <span className="text-lg font-bold tabular-nums text-foreground">
                    {availableCredits !== undefined
                      ? availableCredits >= 1_000_000
                        ? `${(availableCredits / 1_000_000).toFixed(1)}M`
                        : availableCredits.toLocaleString()
                      : "—"}
                  </span>
                </div>
                <p className="-mt-0.5 text-[11px] text-muted-foreground">
                  {availableCredits !== undefined ? "available across your account" : "loading account balance"}
                </p>
              </div>
            </div>
            <Link
              href="/launch"
              onClick={clearLaunchDraft}
              className="btn-primary inline-flex h-14 shrink-0 items-center gap-2 rounded-none px-5 text-sm font-semibold tracking-tight"
            >
              <Rocket className="h-4 w-4" />
              Launch New
            </Link>
          </div>
        </div>

        {companies.length === 0 ? (
          <div className="card-clean dot-grid flex flex-col items-center justify-center py-24">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-none bg-accent-orange/10">
              <Bot className="h-7 w-7 text-accent-orange" />
            </div>
            <p className="mb-1 text-lg font-bold">No companies yet</p>
            <p className="mb-8 max-w-md text-center text-sm text-muted-foreground">
              Launch your first AI-powered company. An autonomous agent will build
              and operate it for you.
            </p>
            <Link
              href="/launch"
              onClick={clearLaunchDraft}
              className="btn-primary inline-flex h-12 items-center gap-2 rounded-none px-5 text-sm font-semibold tracking-tight"
            >
              Get Started
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {companies.map((company) => (
              <CompanyCard key={company.id} company={company} />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}

function CompanyCard({ company }: { company: Company }) {
  return (
    <Link href={`/company/${company.id}`} className="block hover-lift">
      <div className="card-clean px-5 py-4">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <span className="truncate text-sm font-bold">{company.name}</span>
              <StatusBadge state={company.state as CompanyState} />
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {company.idea}
            </p>
          </div>

          <div className="hidden min-w-[112px] shrink-0 items-end text-right sm:flex sm:flex-col">
            <div className="flex items-center gap-1 text-sm font-semibold tabular-nums text-foreground">
              <Coins className="h-3.5 w-3.5 text-muted-foreground" />
              {company.spentCents.toLocaleString()}
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              company spend
            </div>
          </div>

          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
      </div>
    </Link>
  );
}
