"use client";

import { ExternalLink, Globe, Link2, Mail } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CompanyStatus, FounderVisibleAgent } from "@/lib/types";

interface ServiceAccount {
  service?: string;
  name?: string;
  username?: string;
  url?: string;
  status?: string;
  [key: string]: unknown;
}

function deriveFounderStyleEmail(
  agent: FounderVisibleAgent | undefined,
  domain: string | null | undefined,
): string | null {
  if (!domain || !agent?.name?.trim()) {
    return null;
  }

  const firstName = agent.name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!firstName) {
    return null;
  }

  return `${firstName}@${domain}`;
}

function accessRows(
  status: CompanyStatus | undefined,
  ceoAgent: FounderVisibleAgent | undefined,
  emailAliases: CompanyStatus["emailAliases"] | undefined,
): Array<{
  label: string;
  value: string;
  href?: string;
  badge?: string | null;
  icon: LucideIcon;
}> {
  const rows: Array<{
    label: string;
    value: string;
    href?: string;
    badge?: string | null;
    icon: LucideIcon;
  }> = [];

  if (status?.hostedDomain) {
    rows.push({
      label: "Website",
      value: status.hostedDomain,
      href: `https://${status.hostedDomain}`,
      badge: "live",
      icon: Globe,
    });
  }

  if (status?.customDomain && status?.customDomainStatus === "live") {
    rows.push({
      label: "Custom domain",
      value: status.customDomain,
      href: `https://${status.customDomain}`,
      badge: "live",
      icon: Globe,
    });
  }

  const activeAliases = (emailAliases || []).filter((alias) => alias.status === "active");
  const salesAlias = activeAliases.find((alias) => alias.aliasType === "sales");
  const supportAlias = activeAliases.find((alias) => alias.aliasType === "support");

  if (salesAlias) {
    rows.push({
      label: "Sales inbox",
      value: salesAlias.emailAddress,
      href: `mailto:${salesAlias.emailAddress}`,
      icon: Mail,
    });
  }

  if (supportAlias) {
    rows.push({
      label: "Support inbox",
      value: supportAlias.emailAddress,
      href: `mailto:${supportAlias.emailAddress}`,
      icon: Mail,
    });
  } else if (status?.emailDomain) {
    rows.push({
      label: "Company inbox",
      value: `info@${status.emailDomain}`,
      href: `mailto:info@${status.emailDomain}`,
      icon: Mail,
    });
  }

  const ceoEmail = ceoAgent?.email_address?.trim() || deriveFounderStyleEmail(ceoAgent, status?.emailDomain);
  if (ceoEmail) {
    rows.push({
      label: "CEO inbox",
      value: ceoEmail,
      href: `mailto:${ceoEmail}`,
      icon: Mail,
    });
  }

  return rows;
}

export function LinksSection({
  status,
  ceoAgent,
  accountsJson,
}: {
  status: CompanyStatus | undefined;
  ceoAgent: FounderVisibleAgent | undefined;
  accountsJson: string | null;
}) {
  let accounts: ServiceAccount[] = [];
  if (accountsJson) {
    try {
      const parsed = JSON.parse(accountsJson);
      accounts = Array.isArray(parsed) ? parsed : [];
    } catch {
      accounts = [];
    }
  }

  const rows = accessRows(status, ceoAgent, status?.emailAliases);

  if (rows.length === 0 && accounts.length === 0) return null;

  return (
    <div className="card-clean overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Link2 className="h-3.5 w-3.5 text-accent-orange" />
        <span className="section-label">
          Links
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{rows.length + accounts.length}</span>
      </div>
      <div className="divide-y divide-border">
        {rows.map((row) => {
          const Icon = row.icon;

          return (
            <div key={`${row.label}:${row.value}`} className="flex items-center gap-2.5 px-4 py-2.5">
              <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{row.label}</p>
                <p className="text-xs font-medium truncate">{row.value}</p>
              </div>
              {row.badge && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-none ${
                  row.badge === "live"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                    : "bg-secondary text-muted-foreground"
                }`}>
                  {row.badge}
                </span>
              )}
              {row.href && (
                <a
                  href={row.href}
                  target={row.href.startsWith("http") ? "_blank" : undefined}
                  rel={row.href.startsWith("http") ? "noopener noreferrer" : undefined}
                  className="text-[10px] text-accent-orange hover:underline shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  Open
                </a>
              )}
            </div>
          );
        })}

        {accounts.map((acct, i) => {
          const name = acct.service || acct.name || `Service ${i + 1}`;
          const url = acct.url;

          return (
            <div key={i} className="flex items-center gap-2.5 px-4 py-2.5">
              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{name}</p>
                {acct.username && (
                  <p className="text-[10px] text-muted-foreground truncate">{acct.username}</p>
                )}
              </div>
              {acct.status && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-none ${
                  acct.status === "active" ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" : "bg-secondary text-muted-foreground"
                }`}>
                  {acct.status}
                </span>
              )}
              {url && (
                <a
                  href={url.startsWith("http") ? url : `https://${url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-accent-orange hover:underline shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  Open
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
