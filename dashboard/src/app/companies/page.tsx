"use client";

import Link from "next/link";
import { useState, useMemo } from "react";
import {
  ArrowRight,
  Search,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Rocket,
  Plus,
} from "lucide-react";
import {
  SHOWCASE_COMPANIES,
  type ShowcaseCompany,
  type ShowcaseState,
} from "@/lib/showcase-data";

const STATE_CONFIG: Record<
  ShowcaseState,
  { label: string; dot: string; bg: string; text: string }
> = {
  running: {
    label: "Active",
    dot: "bg-accent-green",
    bg: "bg-accent-green/10",
    text: "text-accent-green",
  },
  sleeping: {
    label: "Sleeping",
    dot: "bg-amber-400",
    bg: "bg-amber-400/10",
    text: "text-amber-500",
  },
  paused: {
    label: "Paused",
    dot: "bg-amber-400",
    bg: "bg-amber-400/10",
    text: "text-amber-500",
  },
  failed: {
    label: "Failed",
    dot: "bg-red-400",
    bg: "bg-red-400/10",
    text: "text-red-500",
  },
  dead: {
    label: "Dead",
    dot: "bg-neutral-400",
    bg: "bg-neutral-200",
    text: "text-neutral-500",
  },
};

const INDUSTRIES = [
  "All",
  "SaaS",
  "Consumer",
  "Fintech",
  "Education",
  "Dev Tools",
  "Marketplace",
  "E-commerce",
];

const STATUS_FILTERS = ["All", "Active", "Failed", "Sleeping"];
const SORT_OPTIONS = ["Revenue", "Newest", "Growth"];

const AVATAR_COLORS = [
  "bg-[#ee6018]",
  "bg-[#5856D6]",
  "bg-[#34C759]",
  "bg-[#FF2D55]",
  "bg-[#007AFF]",
  "bg-[#FF9500]",
  "bg-[#AF52DE]",
  "bg-[#00C7BE]",
];

function CompanyCard({
  company,
  index,
}: {
  company: ShowcaseCompany;
  index: number;
}) {
  const positive = company.growthPct >= 0;
  const stateConf = STATE_CONFIG[company.state];
  const initial = company.name.charAt(0).toUpperCase();
  const color = AVATAR_COLORS[index % AVATAR_COLORS.length];

  return (
    <Link
      href={`/showcase/${company.slug}`}
      className="group block rounded-none border border-border bg-white p-5 transition-all hover:border-accent-orange/30"
    >
      <div className="mb-3 flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-none ${color} text-white font-bold text-sm`}
        >
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold group-hover:text-accent-orange transition-colors truncate">
            {company.name}
          </h3>
          <p className="text-xs text-muted-foreground truncate">
            {company.description.slice(0, 80)}...
          </p>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="rounded-none bg-secondary px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
          {company.batch}
        </span>
        <span className="rounded-none bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {company.industry}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-none px-2 py-0.5 text-[10px] font-semibold ${stateConf.bg} ${stateConf.text}`}
        >
          <span className={`h-1.5 w-1.5 rounded-none ${stateConf.dot}`} />
          {stateConf.label}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {company.location}
        </span>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <div className="flex items-center gap-1">
          <DollarSign className="h-3 w-3 text-accent-orange" />
          <span className="text-xs font-bold font-mono">{company.earned}</span>
          <span className="text-[10px] text-muted-foreground">earned</span>
        </div>
        <div
          className={`flex items-center gap-1 text-[11px] font-bold ${
            positive ? "text-accent-orange" : "text-red-500"
          }`}
        >
          {positive ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          {positive ? "+" : ""}
          {company.growthPct.toFixed(1)}%
        </div>
      </div>
    </Link>
  );
}

export default function CompaniesPage() {
  const [search, setSearch] = useState("");
  const [industry, setIndustry] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sort, setSort] = useState("Revenue");

  const filtered = useMemo(() => {
    let list = [...SHOWCASE_COMPANIES];

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.idea.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.industry.toLowerCase().includes(q)
      );
    }

    // Industry
    if (industry !== "All") {
      list = list.filter((c) => c.industry === industry);
    }

    // Status
    if (statusFilter !== "All") {
      const map: Record<string, ShowcaseState[]> = {
        Active: ["running"],
        Failed: ["failed", "dead"],
        Sleeping: ["sleeping", "paused"],
      };
      const states = map[statusFilter] || [];
      list = list.filter((c) => states.includes(c.state));
    }

    // Sort
    if (sort === "Revenue") {
      list.sort((a, b) => {
        const aE = parseFloat(a.earned.replace("$", "").replace(",", ""));
        const bE = parseFloat(b.earned.replace("$", "").replace(",", ""));
        return bE - aE;
      });
    } else if (sort === "Growth") {
      list.sort((a, b) => b.growthPct - a.growthPct);
    }
    // "Newest" keeps original order

    return list;
  }, [search, industry, statusFilter, sort]);

  const totalEarned = SHOWCASE_COMPANIES.reduce((sum, c) => {
    const val = parseFloat(c.earned.replace("$", "").replace(",", ""));
    return sum + (isNaN(val) ? 0 : val);
  }, 0);

  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center bg-[#ee6018]">
                <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                  <path fillRule="evenodd" clipRule="evenodd" d="M21.5 11.78H26.5L36.5 37.3H32.5L28.85 28H19.15L15.5 37.3H11.5L21.5 11.78ZM24 15.63L20.52 24.5H27.48L24 15.63Z" fill="currentColor" className="text-white"/>
                </svg>
              </div>
              <span className="text-sm font-bold tracking-tight">
                AI Combinator
              </span>
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/sign-in"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Log in
            </Link>
            <Link
              href="/sign-up"
              className="btn-primary inline-flex h-8 items-center gap-1.5 rounded-none px-4 text-xs font-bold"
            >
              <Rocket className="h-3 w-3" />
              Apply for Funding
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            AI Combinator Companies
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {SHOWCASE_COMPANIES.length} startups funded &middot; $
            {totalEarned.toFixed(0)} in combined revenue
          </p>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search companies..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-none border border-border bg-white py-2.5 pl-10 pr-4 text-sm outline-none transition-colors focus:border-accent-orange focus:ring-1 focus:ring-accent-orange"
            />
          </div>
        </div>

        {/* Filters */}
        <div className="mb-8 flex flex-wrap items-center gap-3">
          {/* Industry */}
          <div className="flex flex-wrap items-center gap-1.5">
            {INDUSTRIES.map((ind) => (
              <button
                key={ind}
                onClick={() => setIndustry(ind)}
                className={`rounded-none px-3 py-1.5 text-xs font-medium transition-all ${
                  industry === ind
                    ? "bg-accent-orange text-white"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {ind}
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-border" />

          {/* Status */}
          <div className="flex items-center gap-1.5">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-none px-3 py-1.5 text-xs font-medium transition-all ${
                  statusFilter === s
                    ? "bg-accent-orange text-white"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-border" />

          {/* Sort */}
          <div className="flex items-center gap-1.5">
            {SORT_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`rounded-none px-3 py-1.5 text-xs font-medium transition-all ${
                  sort === s
                    ? "bg-foreground text-white"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((company, i) => (
            <CompanyCard
              key={company.slug}
              company={company}
              index={SHOWCASE_COMPANIES.indexOf(company)}
            />
          ))}

          {/* Propose your own card */}
          <Link
            href="/sign-up"
            className="group flex flex-col items-center justify-center rounded-none border-2 border-dashed border-border p-8 text-center transition-all hover:border-accent-orange/50 hover:bg-accent-orange/5"
          >
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-none bg-accent-orange/10 transition-colors group-hover:bg-accent-orange/20">
              <Plus className="h-6 w-6 text-accent-orange" />
            </div>
            <p className="text-sm font-bold">Propose Your Own</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Describe a startup idea and fund it
            </p>
          </Link>
        </div>

        {filtered.length === 0 && (
          <div className="py-20 text-center">
            <p className="text-sm text-muted-foreground">
              No companies match your search.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
