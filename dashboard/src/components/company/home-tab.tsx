"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { TasksSummary } from "./tasks-summary";
import { FinderDocuments } from "./finder-documents";
import { LinksSection } from "./links-section";
import { AutomationsSection } from "./automations-section";
import { ResultsSection } from "./results-section";
import { getAgentKv } from "@/lib/api";
import type { CompanyArtifact, CompanyDocument, CompanyStatus, FounderVisibleAgent, FounderVisibleTask } from "@/lib/types";

export function HomeTab({
  companyId,
  status,
  tasks,
  agents,
  documents,
  artifacts,
  tasksLoading,
  documentsLoading,
  onTaskAction,
  onMutate,
}: {
  companyId: string;
  status: CompanyStatus | undefined;
  tasks: FounderVisibleTask[];
  agents: FounderVisibleAgent[];
  documents: CompanyDocument[] | undefined;
  artifacts?: CompanyArtifact[];
  tasksLoading: boolean;
  documentsLoading: boolean;
  onTaskAction: () => void;
  onMutate: () => void;
}) {
  const { getToken } = useAuth();

  // Find the CEO agent to read its KV memory for links
  const ceoAgent = agents.find((a) => a.role === "ceo" || a.title === "CEO" || a.title === "Chief Executive Officer");

  // Fetch CEO's memory:accounts KV key for Links section
  const { data: accountsKv } = useSWR(
    ceoAgent ? `kv:${companyId}:${ceoAgent.id}:memory:accounts` : null,
    async () => {
      const token = await getToken();
      if (!token || !ceoAgent) return null;
      return getAgentKv(companyId, ceoAgent.id, "memory:accounts", token);
    },
    { refreshInterval: 60_000 },
  );

  return (
    <div className="space-y-6">
      <TasksSummary tasks={tasks} isLoading={tasksLoading} onTaskAction={onTaskAction} companyId={companyId} onMutate={onMutate} />

      <ResultsSection artifacts={artifacts} />

      <AutomationsSection companyId={companyId} />

      <LinksSection
        status={status}
        ceoAgent={ceoAgent}
        accountsJson={accountsKv ?? null}
      />

      <FinderDocuments documents={documents} artifacts={artifacts} isLoading={documentsLoading} />
    </div>
  );
}
