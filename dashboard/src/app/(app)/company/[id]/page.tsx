"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import {
  Coins,
  Loader2,
  MessageSquare,
  Pause,
  Play,
} from "lucide-react";
import { useFounderState } from "@/hooks/use-founder-state";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useRealtimeStatus } from "@/hooks/use-realtime-status";
import {
  createAuthFetcher,
  updateCompany,
} from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { CeoChatPanel } from "@/components/company/ceo-chat-panel";
import { HomeTab } from "@/components/company/home-tab";
import { CompanySidebar } from "@/components/company/company-sidebar";
import { TokenBalanceCard } from "@/components/company/token-balance-card";
import { RuntimeStatusBanner } from "@/components/company/runtime-status-banner";
import type { AdminCompanyDetail } from "@/lib/types";

export default function CompanyPage() {
  const { id } = useParams<{ id: string }>();
  const { getToken } = useAuth();
  const { isAdmin } = useIsAdmin();
  const [chatOpen, setChatOpen] = useState(false);

  // ─── Data hooks ──────────────────────────────────────────────
  const {
    data: founderState,
    error: founderStateError,
    isLoading: founderStateLoading,
    mutate: mutateFounderState,
  } = useFounderState(id);

  // Admin data (only fetched if admin)
  const { mutate: mutateAdmin } = useSWR(
    isAdmin ? `/api/admin/companies/${id}` : null,
    async (url) => {
      const token = await getToken();
      const fetcher = createAuthFetcher(token);
      return fetcher(url) as Promise<AdminCompanyDetail>;
    },
    { refreshInterval: 10_000 },
  );

  const status = founderState?.status;
  const agents = founderState?.agents || [];
  const tasks = founderState?.tasks || [];
  const ceoAgent = agents.find((a) => a.role === "ceo" || a.title === "CEO");
  const availableCredits = founderState?.credits.available;

  const showZeroCreditState = availableCredits !== undefined && availableCredits <= 0;

  useRealtimeStatus(id, () => {
    void mutateFounderState();
  });

  if (!founderStateLoading && founderStateError && !founderState) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-none border border-border bg-background px-6 py-6 shadow-sm">
          <div className="text-sm font-semibold text-foreground">Company dashboard not available yet</div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {founderStateError.message || "This company is still provisioning or temporarily unavailable."}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Link
              href="/portfolio"
              className="inline-flex items-center justify-center rounded-none bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Back to portfolio
            </Link>
            <button
              type="button"
              onClick={() => mutateFounderState()}
              className="inline-flex items-center justify-center rounded-none border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Default: Home view ──────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Sidebar ──────────────────────────────────────────── */}
      <CompanySidebar
        companyId={id}
        agents={agents}
        agentsLoading={founderStateLoading}
      />

      {/* ── Main area (no top navbar) ──────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Content area */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Center column */}
          <div className="flex-1 overflow-y-auto p-4 lg:p-6 min-w-0">
            {/* Company name + actions row */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                {founderStateLoading ? (
                  <>
                    <div className="shimmer h-7 w-44 rounded-none" />
                    <div className="shimmer h-5 w-16 rounded-none" />
                  </>
                ) : (
                  <>
                    <h1 className="text-2xl font-bold tracking-tight">
                      {status?.name || "Loading..."}
                    </h1>
                    {status && <StatusBadge state={status.state} />}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <AdminActions
                  companyId={id}
                  state={status?.state}
                  availableCredits={availableCredits}
                  onUpdate={async () => {
                    await Promise.all([
                      mutateAdmin(),
                      mutateFounderState(),
                    ]);
                  }}
                  onOptimisticStateChange={(nextState) => {
                    void mutateFounderState(
                      (current) =>
                        current
                          ? {
                              ...current,
                              state: nextState,
                              status: {
                                ...current.status,
                                state: nextState,
                              },
                              agents: current.agents.map((agent) => ({
                                ...agent,
                                status: nextState === "paused" ? "paused" : agent.status,
                              })),
                              tasks: current.tasks.map((task) => ({
                                ...task,
                                status: task.status === "done"
                                  ? task.status
                                  : nextState === "paused"
                                    ? "paused"
                                    : task.status,
                              })),
                            }
                          : current,
                      { revalidate: false },
                    );
                  }}
                />
                <button
                  onClick={() => setChatOpen(!chatOpen)}
                  className="xl:hidden inline-flex items-center gap-1.5 rounded-none border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-secondary"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="space-y-5">
              <TokenBalanceCard
                availableCredits={availableCredits}
                isLoading={founderStateLoading}
                companyId={id}
                status={status}
              />

              <RuntimeStatusBanner status={status} />

              {showZeroCreditState && (
                <div className="rounded-none border border-accent-orange/20 bg-accent-orange/[0.05] p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-accent-orange">
                        <Coins className="h-4 w-4" />
                        <span className="text-xs font-semibold uppercase tracking-wider">No tokens remaining</span>
                      </div>
                      <p className="mt-2 text-sm text-foreground">
                        This company can stay visible and paused, but it cannot keep working until your account is topped up.
                      </p>
                    </div>
                    <Link
                      href="/billing"
                      className="inline-flex items-center justify-center rounded-none bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      Add tokens
                    </Link>
                  </div>
                </div>
              )}

              {/* Home tab content (tasks, docs, links, campaigns, products) */}
              <HomeTab
                companyId={id}
                status={status}
                tasks={tasks}
                agents={agents}
                documents={founderState?.documents}
                artifacts={founderState?.artifacts}
                tasksLoading={founderStateLoading}
                documentsLoading={founderStateLoading}
                onTaskAction={() => mutateFounderState()}
                onMutate={() => mutateFounderState()}
              />
            </div>
          </div>

          {/* Right panel: CEO Chat */}
          <div className="hidden xl:flex flex-col w-80 shrink-0 border-l border-border">
            <CeoChatPanel companyId={id} status={status} ceoAgent={ceoAgent} agents={agents} tasks={tasks} />
          </div>

          {/* Mobile: slide-over chat */}
          {chatOpen && (
            <>
              <div
                className="xl:hidden fixed inset-0 bg-black/30 z-40"
                onClick={() => setChatOpen(false)}
              />
              <div className="xl:hidden fixed right-0 top-0 bottom-0 w-[min(24rem,85vw)] bg-background border-l border-border z-50 flex flex-col">
                <CeoChatPanel companyId={id} status={status} ceoAgent={ceoAgent} agents={agents} tasks={tasks} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Admin subcomponents ─────────────────────────────────────

function AdminActions({
  companyId,
  state,
  availableCredits,
  onUpdate,
  onOptimisticStateChange,
}: {
  companyId: string;
  state?: string;
  availableCredits?: number;
  onUpdate: () => void | Promise<void>;
  onOptimisticStateChange?: (nextState: "running" | "paused") => void;
}) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeBlocked = state === "paused" && availableCredits !== undefined && availableCredits <= 0;

  async function handleToggle() {
    if (state === "paused" && resumeBlocked) {
      router.push("/billing");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const newState = (state === "paused" ? "running" : "paused") as "running" | "paused";
      onOptimisticStateChange?.(newState);
      await updateCompany(companyId, { state: newState }, token);
      await onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update company state.");
      await onUpdate();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {(state === "running" || state === "paused") && (
        <button
          onClick={handleToggle}
          disabled={loading}
          className={`inline-flex items-center gap-1.5 rounded-none border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            state === "paused"
              ? "border-green-200 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-950/50"
              : "border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/50"
          }`}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : state === "paused" ? (
            <><Play className="h-3.5 w-3.5" /> {resumeBlocked ? "Add tokens" : "Resume"}</>
          ) : (
            <><Pause className="h-3.5 w-3.5" /> Pause</>
          )}
        </button>
      )}
      {error && (
        <p className="max-w-56 text-right text-[10px] text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}


