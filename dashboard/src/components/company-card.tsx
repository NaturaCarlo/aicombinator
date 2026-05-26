import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { formatTokenCount } from "@/lib/credits";
import type { Company } from "@/lib/types";

/* ─── Company Card ─── */

export function CompanyCard({ company }: { company: Company }) {
  return (
    <Link href={`/company/${company.id}`}>
      <div className="card-clean group relative overflow-hidden p-5 transition-all">
        {/* Header: name + status */}
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-bold">{company.name}</h3>
          <StatusBadge state={company.state} />
        </div>

        {/* Metrics row — only spend; account-wide balance shown on portfolio header */}
        <div className="mt-3 border-t border-border pt-3">
          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <BarChart3 className="h-2.5 w-2.5 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">Spent</span>
            </div>
            <p className="text-xs font-bold font-mono">{formatTokenCount(company.spentCents)}</p>
          </div>
        </div>
      </div>
    </Link>
  );
}
