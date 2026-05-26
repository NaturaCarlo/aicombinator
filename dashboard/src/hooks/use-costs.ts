"use client";
import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { CostSummary, CostByAgent } from "@/lib/types";

export function useCostSummary(companyId: string | null) {
  const { getToken } = useAuth();
  return useSWR(
    companyId ? `/api/companies/${companyId}/costs/summary` : null,
    async (url) => {
      const token = await getToken();
      const data = await createAuthFetcher(token)(url);
      return data as CostSummary;
    },
    { refreshInterval: 30000 },
  );
}

export function useCostByAgent(companyId: string | null) {
  const { getToken } = useAuth();
  return useSWR(
    companyId ? `/api/companies/${companyId}/costs/by-agent` : null,
    async (url) => {
      const token = await getToken();
      const data = await createAuthFetcher(token)(url);
      return data as { agents: CostByAgent[] };
    },
    { refreshInterval: 30000 },
  );
}
