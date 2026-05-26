"use client";
import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { Agent } from "@/lib/types";

export function useAgents(
  companyId: string | null,
  options?: { fallbackData?: { agents: Agent[] } | null },
) {
  const { getToken } = useAuth();
  return useSWR(
    companyId ? `/api/companies/${companyId}/agents` : null,
    async (url) => {
      const token = await getToken();
      const data = await createAuthFetcher(token)(url);
      return data as { agents: Agent[] };
    },
    {
      fallbackData: options?.fallbackData ?? undefined,
      refreshInterval: companyId ? 5000 : 0,
      dedupingInterval: 1000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
}

export function useAgent(agentId: string | null) {
  const { getToken } = useAuth();
  return useSWR(
    agentId ? `/api/agents/${agentId}` : null,
    async (url) => {
      const token = await getToken();
      const data = await createAuthFetcher(token)(url);
      return data as { agent: Agent };
    },
    { refreshInterval: 10000 },
  );
}
