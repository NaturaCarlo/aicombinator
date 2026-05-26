"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { AgentMessage } from "@/lib/types";

export function useMessages(companyId: string) {
  const { getToken } = useAuth();

  return useSWR(
    companyId ? `/api/companies/${companyId}/messages?limit=100` : null,
    async (url) => {
      const token = await getToken();
      const fetcher = createAuthFetcher(token);
      return fetcher(url) as Promise<{ messages: AgentMessage[] }>;
    },
    { refreshInterval: 10_000 },
  );
}
