"use client";

import { useCallback, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { UserPlus, Download } from "lucide-react";
import { useFounderState } from "@/hooks/use-founder-state";

import { OrgChart } from "@/components/company/org-chart";
import { AgentSlideOver } from "@/components/company/agent-slide-over";
import { InviteExternalAgentModal } from "@/components/company/invite-external-agent-modal";
import { ImportCompaniesShModal } from "@/components/company/import-companies-sh-modal";
import { CompanySidebar } from "@/components/company/company-sidebar";

export default function TeamPage() {
  const { id } = useParams<{ id: string }>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // ─── Data hooks ──────────────────────────────────────────────
  const {
    data: founderState,
    isLoading: founderStateLoading,
    mutate: mutateFounderState,
  } = useFounderState(id);
  const agents = founderState?.agents || [];
  const recentTurns = founderState?.status?.recentTurns || [];

  // Selected agent for slide-over
  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const handleAgentClick = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
  }, []);

  const handleSlideOverClose = useCallback(() => {
    setSelectedAgentId(null);
  }, []);

  const handleSlideOverSaved = useCallback(async () => {
    await mutateFounderState();
  }, [mutateFounderState]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Sidebar ──────────────────────────────────────────── */}
      <CompanySidebar
        companyId={id}
        agents={agents}
        agentsLoading={founderStateLoading}
      />

      {/* ── Main content: Org Chart Canvas ───────────────────── */}
      <div className="flex-1 relative min-w-0 overflow-hidden dot-grid">
        {/* ── Floating action buttons ──────────────────────────── */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-none bg-background/80 backdrop-blur-sm border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-accent-orange/40 hover:text-accent-orange"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Invite External Agent
          </button>

          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-none bg-background/80 backdrop-blur-sm border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-accent-orange/40 hover:text-accent-orange"
          >
            <Download className="h-3.5 w-3.5" />
            Import from companies.sh
          </button>
        </div>

        {/* ── Org Chart Canvas ───────────────────────────────── */}
        {founderStateLoading ? (
          <div className="flex h-full w-full items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 animate-spin rounded-none border-2 border-accent-orange border-t-transparent" />
              <span className="text-xs text-muted-foreground">Loading team...</span>
            </div>
          </div>
        ) : (
          <OrgChart agents={agents} onAgentClick={handleAgentClick} />
        )}
      </div>

      {/* ── Modals ───────────────────────────────────────────── */}
      <InviteExternalAgentModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        companyId={id}
        onSuccess={() => mutateFounderState()}
      />
      <ImportCompaniesShModal
        open={importOpen}
        onOpenChange={setImportOpen}
        companyId={id}
        onSuccess={() => mutateFounderState()}
      />

      {/* ── Agent Slide-Over ─────────────────────────────── */}
      <AgentSlideOver
        agent={selectedAgent}
        agents={agents}
        recentTurns={recentTurns}
        onClose={handleSlideOverClose}
        onSaved={handleSlideOverSaved}
      />
    </div>
  );
}
