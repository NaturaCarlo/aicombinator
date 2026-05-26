"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { BurnRateMetrics } from "@/lib/types";

export function useBurnRate(companyId: string | null) {
  const { getToken } = useAuth();

  return useSWR<BurnRateMetrics>(
    companyId ? `/api/companies/${companyId}/burn-rate` : null,
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    { refreshInterval: 30000 },
  );
}
