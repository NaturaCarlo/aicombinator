"use client";
import useSWR from "swr";
import { useAuth, useUser } from "@clerk/nextjs";
import { getBillingStatus } from "@/lib/api";
import type { BillingStatus } from "@/lib/types";

export function useBilling() {
  const { getToken, isLoaded } = useAuth();
  const { user, isLoaded: isUserLoaded } = useUser();
  return useSWR(
    isLoaded && isUserLoaded && user ? ["billing-status-v3", user.id] : null,
    async () => {
      const token = await getToken();
      if (!token) {
        throw new Error("Not authenticated");
      }
      return getBillingStatus(token) as Promise<BillingStatus>;
    },
    {
      revalidateOnMount: true,
      refreshInterval: 15000,
      revalidateOnFocus: true,
      dedupingInterval: 5000,
    },
  );
}
