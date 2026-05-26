"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";

export function useIsAdmin() {
  const { getToken } = useAuth();

  const { data, error } = useSWR(
    "/api/admin/health",
    async (url) => {
      const token = await getToken();
      const fetcher = createAuthFetcher(token);
      return fetcher(url);
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
    },
  );

  return {
    isAdmin: !!data && !error,
    isLoading: !data && !error,
  };
}
