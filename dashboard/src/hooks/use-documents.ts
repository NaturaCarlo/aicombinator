"use client";

import useSWR from "swr";
import { useAuth } from "@clerk/nextjs";
import { createAuthFetcher } from "@/lib/api";
import type { CompanyArtifact, CompanyDocument } from "@/lib/types";

type DocumentsResponse = {
  documents: CompanyDocument[];
  artifacts: CompanyArtifact[];
};

export function useDocuments(
  companyId: string | null,
  options?: { fallbackData?: DocumentsResponse | null },
) {
  const { getToken } = useAuth();

  return useSWR<DocumentsResponse>(
    companyId ? `/api/companies/${companyId}/documents` : null,
    async (url) => {
      const token = await getToken();
      const fetcher = createAuthFetcher(token);
      return fetcher(url) as Promise<DocumentsResponse>;
    },
    {
      fallbackData: options?.fallbackData ?? undefined,
      refreshInterval: (data) => {
        if (!data) {
          return 10_000;
        }
        const docCount = data.documents?.length ?? 0;
        const artifactCount = data.artifacts?.length ?? 0;
        if (docCount < 3 || artifactCount < 1) {
          return 5000;
        }
        return 30_000;
      },
      dedupingInterval: 500,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
}
