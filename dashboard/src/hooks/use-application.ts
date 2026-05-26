"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { Application } from "@/lib/types";

export function useApplication() {
  const { getToken } = useAuth();

  return useSWR<{ application: Application | null }>(
    "/api/applications",
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    {
      refreshInterval: 0,
      revalidateOnFocus: false,
    },
  );
}
