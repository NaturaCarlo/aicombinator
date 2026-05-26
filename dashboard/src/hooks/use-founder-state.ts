"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { FounderState } from "@/lib/types";

export function useFounderState(
  companyId: string | null,
  options?: { fallbackData?: FounderState | null },
) {
  const { getToken } = useAuth();

  return useSWR<FounderState>(
    companyId ? `/api/companies/${companyId}/founder-state` : null,
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    {
      fallbackData: options?.fallbackData ?? undefined,
      refreshInterval: (data) => {
        if (!data) return 5000;
        return data.state === "running" ? 5000 : 15000;
      },
      dedupingInterval: 1000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
}
