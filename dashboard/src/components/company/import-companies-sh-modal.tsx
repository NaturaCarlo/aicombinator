"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live";

interface ImportCompaniesShModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  onSuccess: () => void;
}

interface ImportApiResponse {
  company?: { name: string; description: string };
  import?: { created: string[]; skipped: string[]; errors: string[] };
  error?: string;
  details?: string[];
}

export function ImportCompaniesShModal({
  open,
  onOpenChange,
  companyId,
  onSuccess,
}: ImportCompaniesShModalProps) {
  const { getToken } = useAuth();
  const [packageRef, setPackageRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportApiResponse | null>(null);

  function resetForm() {
    setPackageRef("");
    setError(null);
    setResult(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setSubmitting(true);

    try {
      const token = await getToken();
      if (!token) {
        setError("Not authenticated");
        return;
      }

      const res = await fetch(
        `${API_URL}/api/companies/${companyId}/import/companies-sh`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ packageRef: packageRef.trim() }),
        },
      );

      const body = (await res.json().catch(() => null)) as ImportApiResponse | null;

      if (!res.ok) {
        const message =
          body?.error ||
          (body?.details && body.details.length > 0
            ? body.details[0]
            : `Import failed (${res.status})`);
        setError(message ?? "Import failed");
        return;
      }

      setResult(body);

      // If agents were created, notify parent to refresh
      if (body?.import?.created && body.import.created.length > 0) {
        onSuccess();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const hasResult = result?.import;
  const createdCount = result?.import?.created?.length ?? 0;
  const skippedCount = result?.import?.skipped?.length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import from companies.sh</DialogTitle>
          <DialogDescription>
            Import agents from a companies.sh package hosted on GitHub.
          </DialogDescription>
        </DialogHeader>

        {!hasResult ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Package Reference */}
            <div className="space-y-1.5">
              <label
                htmlFor="package-ref"
                className="text-xs font-medium text-muted-foreground"
              >
                Package Reference
              </label>
              <Input
                id="package-ref"
                placeholder="e.g. paperclipai/companies/gstack"
                value={packageRef}
                onChange={(e) => setPackageRef(e.target.value)}
                required
                autoFocus
              />
              <p className="text-[10px] text-muted-foreground">
                Format: owner/repo/path or a full GitHub URL
              </p>
            </div>

            {/* Error message */}
            {error && (
              <p className="text-xs text-red-500" role="alert">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={submitting || !packageRef.trim()}
                className="bg-accent-orange text-white hover:bg-accent-orange/90"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Importing…
                  </>
                ) : (
                  "Import"
                )}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-3">
            {/* Success summary */}
            <div className="rounded-none bg-green-500/10 border border-green-500/20 p-3 text-xs">
              <p className="font-medium text-green-700 dark:text-green-400">
                Import complete
              </p>
              {result.company?.name && (
                <p className="mt-1 text-muted-foreground">
                  Package: {result.company.name}
                </p>
              )}
              <p className="mt-1 text-muted-foreground">
                {createdCount > 0
                  ? `${createdCount} agent${createdCount !== 1 ? "s" : ""} imported`
                  : "No new agents imported"}
                {skippedCount > 0
                  ? ` · ${skippedCount} already existed`
                  : ""}
              </p>
              {result.import?.created && result.import.created.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  Created: {result.import.created.join(", ")}
                </p>
              )}
            </div>

            {/* Errors/warnings */}
            {result.import?.errors && result.import.errors.length > 0 && (
              <div className="rounded-none bg-amber-500/10 border border-amber-500/20 p-3 text-xs">
                <p className="font-medium text-amber-700 dark:text-amber-400">
                  Warnings
                </p>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {result.import.errors.map((err, i) => (
                    <li key={i}>• {err}</li>
                  ))}
                </ul>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  resetForm();
                  onOpenChange(false);
                }}
                className="bg-accent-orange text-white hover:bg-accent-orange/90"
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
