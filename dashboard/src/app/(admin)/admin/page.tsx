"use client";

import Link from "next/link";
import {
  Bot,
  FileText,
  ShoppingCart,
  DollarSign,
  AlertTriangle,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { useAdminHealth, useAdminApplications, useAdminPurchases } from "@/hooks/use-admin";

export default function AdminOverviewPage() {
  const { data: healthData, isLoading: healthLoading } = useAdminHealth();
  const { data: appsData, isLoading: appsLoading } = useAdminApplications("submitted");
  const { data: purchasesData, isLoading: purchasesLoading } = useAdminPurchases("pending");

  const isLoading = healthLoading || appsLoading || purchasesLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32 fade-in-up">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const stats = healthData?.stats;
  const agents = healthData?.agents || [];
  const pendingApps = appsData?.applications?.length || 0;
  const pendingPurchases = purchasesData?.requests?.length || 0;
  const unhealthyAgents = agents.filter(
    (a) => !a.isHealthy && a.state === "running",
  );

  return (
    <div className="fade-in-up">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Admin Overview</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          AI Combinator platform management
        </p>
      </div>

      {/* Stat cards */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Bot}
          label="Running Agents"
          value={stats?.running ?? 0}
          sub={`${stats?.total ?? 0} total`}
          href="/admin/agents"
        />
        <StatCard
          icon={FileText}
          label="Pending Applications"
          value={pendingApps}
          sub="awaiting review"
          href="/admin/applications"
          highlight={pendingApps > 0}
        />
        <StatCard
          icon={ShoppingCart}
          label="Pending Purchases"
          value={pendingPurchases}
          sub="awaiting approval"
          href="/admin/purchases"
          highlight={pendingPurchases > 0}
        />
        <StatCard
          icon={DollarSign}
          label="Total Spend"
          value={`$${((stats?.totalSpentCents ?? 0) / 100).toFixed(2)}`}
          sub={`${stats?.healthy ?? 0} healthy agents`}
        />
      </div>

      {/* Unhealthy agents alert */}
      {unhealthyAgents.length > 0 && (
        <div className="mb-8 rounded-none border border-amber-200 bg-amber-50 p-5">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-bold text-amber-800">
              {unhealthyAgents.length} Unhealthy Agent{unhealthyAgents.length > 1 ? "s" : ""}
            </h3>
          </div>
          <div className="space-y-2">
            {unhealthyAgents.slice(0, 5).map((agent) => (
              <div
                key={agent.companyId}
                className="flex items-center justify-between rounded-none bg-white/60 px-4 py-2.5"
              >
                <div>
                  <span className="text-sm font-medium text-amber-900">
                    {agent.name}
                  </span>
                  <span className="ml-2 text-xs text-amber-600">
                    {agent.lastHeartbeat
                      ? `Last heartbeat ${timeAgo(agent.lastHeartbeat)}`
                      : "No heartbeat"}
                  </span>
                </div>
                <Link
                  href={`/admin/agents/${agent.companyId}`}
                  className="text-xs font-medium text-amber-700 hover:text-amber-900"
                >
                  View
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <QuickAction
          href="/admin/applications"
          title="Review Applications"
          description="Review and accept Genesis Batch applicants"
          count={pendingApps}
        />
        <QuickAction
          href="/admin/purchases"
          title="Approve Purchases"
          description="Review agent purchase escalations"
          count={pendingPurchases}
        />
        <QuickAction
          href="/admin/agents"
          title="Manage Agents"
          description="Monitor, pause, or adjust agent budgets"
        />
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
  highlight,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub: string;
  href?: string;
  highlight?: boolean;
}) {
  const content = (
    <div
      className={`card-clean p-5 ${
        highlight ? "border-accent-orange/40" : ""
      }`}
    >
      <div className="mb-3 flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="text-2xl font-bold tracking-tight">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block hover-lift">
        {content}
      </Link>
    );
  }
  return content;
}

function QuickAction({
  href,
  title,
  description,
  count,
}: {
  href: string;
  title: string;
  description: string;
  count?: number;
}) {
  return (
    <Link href={href} className="card-clean block p-5 hover-lift">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold">{title}</h3>
        {count !== undefined && count > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-none bg-accent-orange px-1.5 text-[10px] font-bold text-white">
            {count}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-3 flex items-center gap-1 text-xs font-medium text-accent-orange">
        Open <ArrowRight className="h-3 w-3" />
      </div>
    </Link>
  );
}

function timeAgo(dateString: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateString).getTime()) / 1000,
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
