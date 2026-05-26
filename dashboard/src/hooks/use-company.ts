"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { CompanyStatus } from "@/lib/types";

export function useCompanyStatus(
  id: string | null,
  options?: { fallbackData?: CompanyStatus | null },
) {
  const { getToken } = useAuth();

  return useSWR<CompanyStatus>(
    id ? `/api/companies/${id}/status` : null,
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    {
      fallbackData: options?.fallbackData ?? undefined,
      refreshInterval: (data) => {
        if (!data) return 3000;
        switch (data.state) {
          case "awaiting_funding":
            return 10000;
          case "provisioning":
            return 3000;
          case "running":
            return 5000;
          case "paused":
            return 15000;
          default:
            return 15000;
        }
      },
      dedupingInterval: 1000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
}
