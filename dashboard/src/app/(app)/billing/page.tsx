"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  Loader2,
  Zap,
  ArrowUpRight,
  TrendingDown,
  RefreshCw,
  Crown,
  Plus,
  Minus,
} from "lucide-react";
import { useBilling } from "@/hooks/use-billing";
import { useCreditPurchaseConfirmation } from "@/hooks/use-credit-purchase-confirmation";
import {
  createCheckoutSession,
  createPortalSession,
  updateAutoRefill,
  buyCredits,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { PageShell } from "@/components/shared/page-shell";

const TOKEN_PACKS = [
  { amount: 500_000, label: "500K", price: "$0.50" },
  { amount: 1_000_000, label: "1M", price: "$1" },
  { amount: 2_500_000, label: "2.5M", price: "$2.50" },
  { amount: 5_000_000, label: "5M", price: "$5" },
];

export default function BillingPage() {
  const { getToken } = useAuth();
  const { data: billing, error: billingFetchError, isLoading, mutate } = useBilling();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creditConfirmationState = useCreditPurchaseConfirmation({
    successPath: "/billing",
    onGranted: mutate,
  });

  const handleSubscribe = async () => {
    setActionLoading("subscribe");
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const { url } = await createCheckoutSession(token);
      window.location.href = url;
    } catch (err) {
      console.error("Checkout error:", err);
      setError("Failed to start checkout. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleManageSubscription = async () => {
    setActionLoading("portal");
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const { url } = await createPortalSession(token);
      window.location.href = url;
    } catch (err) {
      console.error("Portal error:", err);
      setError("Failed to open subscription portal. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleBuyCredits = async (amount: number) => {
    setActionLoading(`buy-${amount}`);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const { url } = await buyCredits(amount, token);
      window.location.href = url;
    } catch (err) {
      console.error("Buy credits error:", err);
      setError("Failed to start payment. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleAutoRefill = async () => {
    if (!billing) return;
    setActionLoading("auto-refill");
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await updateAutoRefill({ enabled: !billing.autoRefill.enabled }, token);
      mutate();
    } catch (err) {
      console.error("Auto-refill error:", err);
      setError("Failed to update auto-refill. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </PageShell>
    );
  }

  const plan = billing?.subscription.plan;
  const isPaid = plan === "paid" || plan === "pro" || plan === "max";
  const isMax = plan === "max";
  const isPastDue = billing?.subscription.status === "past_due";
  const balance = billing?.credits.balance;
  const monthlyTokens = billing?.entitlements?.monthlyTokens;
  const planLabel = isMax ? "Max plan" : isPaid ? "Pro plan" : "Free tier";
  const planPrice = isMax ? "$200" : "$20";

  return (
    <PageShell>
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage your subscription, tokens, and auto-refill settings.
          </p>
        </div>

        {error && (
          <div className="rounded-none bg-red-50 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {billingFetchError && (
          <div className="rounded-none bg-red-50 px-4 py-3 text-sm text-red-600">
            We couldn’t load your account balance right now.
          </div>
        )}

        {creditConfirmationState.kind !== "idle" && (
          <div
            className={`rounded-none px-4 py-3 text-sm ${
              creditConfirmationState.kind === "error"
                ? "bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400"
                : creditConfirmationState.kind === "success"
                  ? "bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-400"
                  : "bg-background text-muted-foreground border border-border"
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

        {/* Token Balance + Subscription Row */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Token Balance */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-[#ee6018]" />
                Token Balance
              </CardTitle>
              <CardDescription>1M standard tokens = $1</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold tabular-nums">
                {balance !== undefined
                  ? balance >= 1_000_000
                    ? `${(balance / 1_000_000).toFixed(1)}M`
                    : balance.toLocaleString()
                  : "—"}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {balance !== undefined
                  ? "tokens remaining"
                  : "loading token balance"}
              </p>
            </CardContent>
          </Card>

          {/* Subscription Status */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Crown className="h-4 w-4 text-[#ee6018]" />
                Subscription
              </CardTitle>
              <CardDescription>
                {planLabel}
                {isPastDue && (
                  <span className="ml-2 text-orange-600 font-medium">
                    - Payment overdue
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isPaid ? (
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold">{planPrice}</span>
                    <span className="text-muted-foreground text-sm">/month</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {monthlyTokens ? `${monthlyTokens / 1_000_000}M` : isMax ? "200M" : "20M"} tokens/month, up to {billing?.limits.maxCompanies} companies
                  </p>
                  {billing?.subscription.currentPeriodEnd && (
                    <p className="text-xs text-muted-foreground">
                      Renews{" "}
                      {new Date(billing.subscription.currentPeriodEnd).toLocaleDateString()}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    1M tokens, 1 company
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Upgrade for 20x tokens and 3 companies.
                  </p>
                </div>
              )}
            </CardContent>
            <CardFooter>
              {isPaid ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleManageSubscription}
                  disabled={actionLoading === "portal"}
                >
                  {actionLoading === "portal" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  )}
                  Manage Subscription
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="bg-[#ee6018] hover:bg-[#ee6018]/90 text-white"
                  onClick={handleSubscribe}
                  disabled={actionLoading === "subscribe"}
                >
                  {actionLoading === "subscribe" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Crown className="h-3.5 w-3.5" />
                  )}
                  Upgrade to Pro — $20/mo
                </Button>
              )}
            </CardFooter>
          </Card>
        </div>

        {/* Buy Tokens */}
        <Card>
          <CardHeader>
            <CardTitle>Buy Tokens</CardTitle>
            <CardDescription>One-time token purchase. 1M standard tokens = $1.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {TOKEN_PACKS.map((pack) => (
                <button
                  key={pack.amount}
                  onClick={() => handleBuyCredits(pack.amount)}
                  disabled={actionLoading?.startsWith("buy-")}
                  className="relative flex flex-col items-center gap-1 rounded-none border border-border p-4 hover:border-[#ee6018]/50 hover:bg-[#ee6018]/5 transition-all disabled:opacity-50"
                >
                  {actionLoading === `buy-${pack.amount}` && (
                    <Loader2 className="absolute top-2 right-2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  )}
                  <Plus className="h-4 w-4 text-[#ee6018]" />
                  <span className="text-lg font-bold">{pack.label}</span>
                  <span className="text-xs text-muted-foreground">tokens</span>
                  <span className="text-sm font-medium mt-1">{pack.price}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Auto-Refill */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4" />
              Auto-Refill
            </CardTitle>
            <CardDescription>
              Automatically purchase tokens when your balance drops below a threshold.
              {!isPaid && " Requires a paid subscription."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {billing?.autoRefill.enabled ? "Enabled" : "Disabled"}
                </p>
                {billing?.autoRefill.enabled && (
                  <p className="text-xs text-muted-foreground">
                    Refill {billing.autoRefill.amount.toLocaleString()} tokens
                    when balance drops below{" "}
                    {billing.autoRefill.threshold.toLocaleString()}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleAutoRefill}
                disabled={!isPaid || actionLoading === "auto-refill"}
              >
                {actionLoading === "auto-refill" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : billing?.autoRefill.enabled ? (
                  "Disable"
                ) : (
                  "Enable"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Token History */}
        <Card>
          <CardHeader>
            <CardTitle>Token History</CardTitle>
            <CardDescription>Recent token transactions.</CardDescription>
          </CardHeader>
          <CardContent>
            {billing?.credits.history && billing.credits.history.length > 0 ? (
              <div className="divide-y divide-border">
                {billing.credits.history.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-none ${
                          event.amount > 0
                            ? "bg-green-100 text-green-600 dark:bg-green-950/50 dark:text-green-400"
                            : "bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400"
                        }`}
                      >
                        {event.amount > 0 ? (
                          <Plus className="h-3 w-3" />
                        ) : (
                          <Minus className="h-3 w-3" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {event.amount > 0
                            ? event.description || event.type
                            : event.company_name
                              ? event.company_name
                              : event.description || "Token usage"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(event.created_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {event.amount < 0 && event.company_name && event.description && (
                            <span className="ml-1.5 text-muted-foreground/60">
                              &middot; {event.description}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      <p
                        className={`text-sm font-semibold tabular-nums ${
                          event.amount > 0
                            ? "text-green-600 dark:text-green-400"
                            : "text-foreground"
                        }`}
                      >
                        {event.amount > 0 ? "+" : ""}
                        {event.amount.toLocaleString()}
                      </p>
                      <p className="text-[11px] text-muted-foreground tabular-nums">
                        {event.balance_after.toLocaleString()} remaining
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No token transactions yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
