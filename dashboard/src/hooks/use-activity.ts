"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { ActivityEntry } from "@/lib/types";

export function useActivity(companyId: string | null) {
  const { getToken } = useAuth();

  return useSWR<{ entries: ActivityEntry[]; nextCursor?: string }>(
    companyId ? `/api/companies/${companyId}/activity?limit=20` : null,
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    { refreshInterval: 10000 },
  );
}
