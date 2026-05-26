"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { Company } from "@/lib/types";

export function useCompanies() {
  const { getToken } = useAuth();

  return useSWR<{ companies: Company[] }>(
    "/api/companies",
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    { refreshInterval: 30000 },
  );
}
