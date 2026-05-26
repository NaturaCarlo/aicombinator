"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import { CreditCard, LayoutDashboard, LogOut } from "lucide-react";
import { useCompanies } from "@/hooks/use-companies";
import { ThemeToggle } from "@/components/theme-toggle";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarAccountMenu({
  currentCompanyId,
  compact = false,
}: {
  currentCompanyId?: string;
  compact?: boolean;
}) {
  const pathname = usePathname();
  const clerk = useClerk();
  const { data } = useCompanies();

  const activeCompanies = (data?.companies || []).filter((company) =>
    company.state === "running" || company.state === "paused" || company.state === "failed",
  );

  const navItems = [
    {
      href: "/portfolio",
      label: "Portfolio",
      icon: LayoutDashboard,
    },
    {
      href: "/billing",
      label: "Billing",
      icon: CreditCard,
    },
  ];

  const itemClassName = compact
    ? "flex items-center gap-2.5 rounded-none px-3 py-2 text-xs font-medium transition-colors"
    : "flex items-center gap-2.5 rounded-none px-3 py-2 text-sm font-medium transition-colors";
  const activeClassName = "bg-accent-orange/10 text-accent-orange";
  const idleClassName = compact
    ? "text-muted-foreground hover:bg-secondary hover:text-foreground"
    : "text-muted-foreground hover:text-foreground hover:bg-secondary";
  const companyLabelClassName = compact
    ? "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
    : "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
  const companyItemClassName = compact
    ? "flex items-center justify-between gap-2 rounded-none px-3 py-2 text-xs transition-colors"
    : "flex items-center justify-between gap-2 rounded-none px-3 py-2 text-sm transition-colors";

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {navItems.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${itemClassName} ${active ? activeClassName : idleClassName}`}
            >
              <item.icon className="h-3.5 w-3.5 shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>

      <ThemeToggle compact />

      <button
        type="button"
        onClick={() => clerk.signOut({ redirectUrl: "/" })}
        className={`${itemClassName} w-full ${idleClassName}`}
      >
        <LogOut className="h-3.5 w-3.5 shrink-0" />
        <span>Log out</span>
      </button>

      {activeCompanies.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className={companyLabelClassName}>Active Companies</p>
          <div className="mt-2 space-y-1">
            {activeCompanies.map((company) => {
              const href = `/company/${company.id}`;
              const active = isActive(pathname, href);
              return (
                <Link
                  key={company.id}
                  href={href}
                  className={`${companyItemClassName} ${active ? activeClassName : idleClassName}`}
                >
                  <span className="min-w-0 truncate">{company.name}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {company.state}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
