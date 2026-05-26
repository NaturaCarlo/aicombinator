"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { Task } from "@/lib/types";

export function useTasks(
  companyId: string | null,
  status?: string,
  options?: { fallbackData?: { tasks: Task[] } | null },
) {
  const { getToken } = useAuth();

  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const q = params.toString();

  return useSWR<{ tasks: Task[] }>(
    companyId ? `/api/companies/${companyId}/tasks${q ? `?${q}` : ""}` : null,
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
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
