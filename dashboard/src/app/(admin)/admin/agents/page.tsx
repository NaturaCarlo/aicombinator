"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import {
  Bot,
  CreditCard,
  Loader2,
  Pause,
  Play,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { useAdminCompanies } from "@/hooks/use-admin";
import { adminUpdateCompany } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import type { AdminCompany, CompanyState } from "@/lib/types";

const STATE_TABS = [
  { value: undefined, label: "All" },
  { value: "running", label: "Running" },
  { value: "sleeping", label: "Sleeping" },
  { value: "paused", label: "Paused" },
  { value: "failed", label: "Failed" },
  { value: "dead", label: "Dead" },
  { value: "awaiting_funding", label: "Awaiting Funding" },
] as const;

export default function AdminAgentsPage() {
  const [stateFilter, setStateFilter] = useState<string | undefined>(undefined);
  const { data, isLoading, mutate } = useAdminCompanies(stateFilter);

  const companies = data?.companies || [];

  return (
    <div className="fade-in-up">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Companies</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Monitor and manage all companies
        </p>
      </div>

      {/* State filter tabs */}
      <div className="mb-6 flex gap-1 rounded-none bg-secondary p-1">
        {STATE_TABS.map((tab) => (
          <button
            key={tab.label}
            onClick={() => setStateFilter(tab.value)}
            className={`rounded-none px-4 py-1.5 text-sm font-medium transition-all ${
              stateFilter === tab.value
                ? "bg-white text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : companies.length === 0 ? (
        <div className="card-clean flex flex-col items-center justify-center py-20">
          <Bot className="mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">
            No agents found
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {companies.map((company) => (
            <AgentRow
              key={company.id}
              company={company}
              onUpdate={() => mutate()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({
  company,
  onUpdate,
}: {
  company: AdminCompany;
  onUpdate: () => void;
}) {
  const { getToken } = useAuth();
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState(
    String(company.budget_cents / 100),
  );
  const [loading, setLoading] = useState(false);

  async function handleTogglePause() {
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const newState = company.state === "paused" ? "running" : "paused";
      await adminUpdateCompany(company.id, { state: newState }, token);
      onUpdate();
    } catch (err) {
      console.error("Failed to toggle pause:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleBudgetSave() {
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const cents = Math.round(parseFloat(budgetInput) * 100);
      if (isNaN(cents) || cents < 0) return;
      await adminUpdateCompany(company.id, { budget_cents: cents }, token);
      setEditingBudget(false);
      onUpdate();
    } catch (err) {
      console.error("Failed to update budget:", err);
    } finally {
      setLoading(false);
    }
  }

  const spentPercent =
    company.budget_cents > 0
      ? Math.min(100, Math.round((company.spent_cents / company.budget_cents) * 100))
      : 0;

  const isOverBudget = spentPercent >= 90;

  return (
    <Link href={`/admin/agents/${company.id}`} className="block hover-lift">
      <div className="card-clean px-5 py-4">
        <div className="flex items-center gap-4">
          {/* Name + owner */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <span className="truncate text-sm font-bold">{company.name}</span>
              <StatusBadge state={company.state as CompanyState} />
              {company.has_card > 0 && (
                <span className="inline-flex items-center gap-1 rounded-none bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                  <CreditCard className="h-3 w-3" />
                  Card
                </span>
              )}
              {company.pending_purchases > 0 && (
                <span className="inline-flex items-center gap-1 rounded-none bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                  <AlertTriangle className="h-3 w-3" />
                  {company.pending_purchases} pending
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
              <span>{company.owner_name || company.email || "—"}</span>
              <span>{company.inference_model}</span>
              <span>
                Created{" "}
                {new Date(company.created_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
          </div>

          {/* Budget bar */}
          <div className="hidden w-44 shrink-0 lg:block">
            {editingBudget ? (
              <div className="flex items-center gap-1.5" onClick={(e) => e.preventDefault()}>
                <span className="text-xs text-muted-foreground">$</span>
                <input
                  type="number"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleBudgetSave();
                    if (e.key === "Escape") setEditingBudget(false);
                  }}
                  className="w-20 rounded border border-border bg-white px-2 py-1 text-xs outline-none focus:border-accent-orange"
                  autoFocus
                />
                <button
                  onClick={(e) => { e.preventDefault(); handleBudgetSave(); }}
                  disabled={loading}
                  className="rounded bg-accent-orange px-2 py-1 text-[10px] font-bold text-white"
                >
                  Save
                </button>
              </div>
            ) : (
              <button
                onClick={(e) => { e.preventDefault(); setEditingBudget(true); }}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                  <span className={isOverBudget ? "text-accent-red font-medium" : ""}>
                    ${(company.spent_cents / 100).toFixed(2)}
                  </span>
                  <span>${(company.budget_cents / 100).toFixed(2)}</span>
                </div>
                <div className="h-1.5 rounded-none bg-border overflow-hidden">
                  <div
                    className={`h-full rounded-none transition-all ${
                      isOverBudget ? "bg-accent-red" : "bg-accent-orange"
                    }`}
                    style={{ width: `${spentPercent}%` }}
                  />
                </div>
              </button>
            )}
          </div>

          {/* Actions */}
          <div className="flex shrink-0 gap-2">
            {(company.state === "running" || company.state === "paused") && (
              <button
                onClick={(e) => { e.preventDefault(); handleTogglePause(); }}
                disabled={loading}
                className={`inline-flex items-center gap-1.5 rounded-none border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  company.state === "paused"
                    ? "border-green-200 text-green-700 hover:bg-green-50"
                    : "border-amber-200 text-amber-700 hover:bg-amber-50"
                }`}
              >
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : company.state === "paused" ? (
                  <>
                    <Play className="h-3 w-3" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="h-3 w-3" />
                    Pause
                  </>
                )}
              </button>
            )}
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground self-center" />
          </div>
        </div>
      </div>
    </Link>
  );
}
