"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { LayoutDashboard, Settings, UsersRound } from "lucide-react";
import { AgentActivityFeed } from "@/components/company/agent-activity-feed";
import {
  AccountMenuPanel,
  AccountMenuTrigger,
} from "@/components/shared/account-menu-surface";
import type { FounderVisibleAgent } from "@/lib/types";

function displayFounderName(
  fullName: string | null | undefined,
  email: string | null | undefined,
): string {
  if (fullName?.trim()) return fullName.trim();
  if (email?.trim()) return email.trim();
  return "Founder";
}

export function CompanySidebar({
  companyId,
  agents,
  agentsLoading,
}: {
  companyId: string;
  agents: FounderVisibleAgent[];
  agentsLoading: boolean;
}) {
  const { user } = useUser();
  const pathname = usePathname();
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const isDashboardActive = pathname === `/company/${companyId}`;
  const isTeamActive = pathname === `/company/${companyId}/team`;
  const isSettingsActive = pathname === `/company/${companyId}/settings`;

  return (
    <aside className="hidden lg:flex w-60 shrink-0 border-r border-border bg-background flex-col min-h-0">
      {/* ── Top: Logo + nav links ──────────────────────────── */}
      <div className="shrink-0 p-3 border-b border-border">
        <Link href="/portfolio" className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-none bg-[#ee6018]">
            <svg
              viewBox="0 0 48 48"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="h-full w-full"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M21.5 11.78H26.5L36.5 37.3H32.5L28.85 28H19.15L15.5 37.3H11.5L21.5 11.78ZM24 15.63L20.52 24.5H27.48L24 15.63Z"
                fill="currentColor"
                className="text-white"
              />
            </svg>
          </div>
          <span className="text-sm font-bold tracking-tight">AI Combinator</span>
        </Link>
      </div>

      <nav className="shrink-0 border-b border-border px-3 py-2 space-y-0.5">
        <Link
          href={`/company/${companyId}`}
          className={`flex items-center gap-2.5 rounded-none px-3 py-2 text-xs font-mono uppercase tracking-tight font-medium transition-colors ${
            isDashboardActive
              ? "bg-accent-orange/10 text-accent-orange"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <LayoutDashboard className="h-3.5 w-3.5 shrink-0" />
          <span>Dashboard</span>
        </Link>
        <Link
          href={`/company/${companyId}/team`}
          className={`flex items-center gap-2.5 rounded-none px-3 py-2 text-xs font-mono uppercase tracking-tight font-medium transition-colors ${
            isTeamActive
              ? "bg-accent-orange/10 text-accent-orange"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <UsersRound className="h-3.5 w-3.5 shrink-0" />
          <span>Team</span>
        </Link>
        <Link
          href={`/company/${companyId}/settings`}
          className={`flex items-center gap-2.5 rounded-none px-3 py-2 text-xs font-mono uppercase tracking-tight font-medium transition-colors ${
            isSettingsActive
              ? "bg-accent-orange/10 text-accent-orange"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <Settings className="h-3.5 w-3.5 shrink-0" />
          <span>Settings</span>
        </Link>
      </nav>

      {/* ── Middle: Scrollable agent list ──────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <AgentActivityFeed
          agents={agents}
          isLoading={agentsLoading}
          companyId={companyId}
        />
      </div>

      {/* ── Bottom: Account menu ──────────────────────────── */}
      {showAccountMenu && (
        <AccountMenuPanel
          currentCompanyId={companyId}
          compact
          className="shrink-0 border-t border-border px-3 py-3"
        />
      )}

      <div className="shrink-0 border-t border-border px-3 py-3">
        <AccountMenuTrigger
          founderName={displayFounderName(
            user?.fullName,
            user?.primaryEmailAddress?.emailAddress,
          )}
          imageUrl={user?.imageUrl}
          open={showAccountMenu}
          onClick={() => setShowAccountMenu((current) => !current)}
          compact
        />
      </div>
    </aside>
  );
}
