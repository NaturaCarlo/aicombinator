"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type {
  AdminApplication,
  AdminCompany,
  AdminPurchaseRequest,
  AdminHealthAgent,
  AdminHealthStats,
} from "@/lib/types";

export function useAdminApplications(status?: string) {
  const { getToken } = useAuth();
  const params = status ? `?status=${status}` : "";

  return useSWR<{ applications: AdminApplication[] }>(
    `/api/admin/applications${params}`,
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    { refreshInterval: 30000 },
  );
}

export function useAdminCompanies(state?: string) {
  const { getToken } = useAuth();
  const params = state ? `?state=${state}` : "";

  return useSWR<{ companies: AdminCompany[] }>(
    `/api/admin/companies${params}`,
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    { refreshInterval: 30000 },
  );
}

export function useAdminPurchases(status?: string) {
  const { getToken } = useAuth();
  const params = status ? `?status=${status}` : "";

  return useSWR<{ requests: AdminPurchaseRequest[] }>(
    `/api/admin/purchases${params}`,
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    { refreshInterval: 15000 },
  );
}

export function useAdminHealth() {
  const { getToken } = useAuth();

  return useSWR<{ agents: AdminHealthAgent[]; stats: AdminHealthStats }>(
    "/api/admin/health",
    async (url: string) => {
      const token = await getToken();
      return createAuthFetcher(token)(url);
    },
    { refreshInterval: 15000 },
  );
}
