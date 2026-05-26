"use client";

import { AlertTriangle, RefreshCw, ServerCrash } from "lucide-react";
import type { CompanyStatus } from "@/lib/types";

function formatRelativeTime(value: string | null | undefined): string | null {
  if (!value) return null;

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const diffMs = timestamp - Date.now();
  const absSeconds = Math.round(Math.abs(diffMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (absSeconds < 60) return rtf.format(Math.round(diffMs / 1000), "second");

  const absMinutes = Math.round(absSeconds / 60);
  if (absMinutes < 60) return rtf.format(Math.round(diffMs / 60_000), "minute");

  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) return rtf.format(Math.round(diffMs / 3_600_000), "hour");

  return rtf.format(Math.round(diffMs / 86_400_000), "day");
}

function ageMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Date.now() - timestamp);
}

export function RuntimeStatusBanner({
  status,
}: {
  status: CompanyStatus | undefined;
}) {
  const controlPlane = status?.controlPlane;
  if (!controlPlane || controlPlane.mirrorStatus === "healthy") {
    return null;
  }

  const delayed = controlPlane.mirrorStatus === "delayed";
  const lastSuccessAgeMs = ageMs(controlPlane.lastSuccessfulSyncAt);
  if (
    delayed
    && lastSuccessAgeMs !== null
    && lastSuccessAgeMs <= 30_000
  ) {
    return null;
  }

  const Icon = delayed ? RefreshCw : ServerCrash;
  const queueText = controlPlane.syncQueueDepth != null
    ? `${controlPlane.syncQueueDepth} ${controlPlane.syncQueueDepth === 1 ? "update" : "updates"} still syncing`
    : null;
  const oldestQueued = formatRelativeTime(controlPlane.oldestQueuedAt);
  const lastSuccess = formatRelativeTime(controlPlane.lastSuccessfulSyncAt);

  return (
    <div
      className={`rounded-none border px-4 py-3 ${
        delayed
          ? "border-amber-300/60 bg-amber-50/70 dark:border-amber-700/40 dark:bg-amber-950/50"
          : "border-red-300/60 bg-red-50/70 dark:border-red-700/40 dark:bg-red-950/50"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-none ${
            delayed ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400" : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400"
          }`}
        >
          <Icon className={`h-4 w-4 ${delayed ? "animate-spin [animation-duration:2s]" : ""}`} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground">
              {delayed ? "Updates Are Catching Up" : "Live Updates Unavailable"}
            </p>
            <span className="rounded-none bg-white/80 dark:bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {delayed ? "Syncing Recent Changes" : "Check Back Soon"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {controlPlane.statusMessage}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {status?.state && <span>Company is {status.state.replaceAll("_", " ")}</span>}
            {queueText && <span>{queueText}</span>}
            {oldestQueued && delayed && <span>Longest delay {oldestQueued}</span>}
            {lastSuccess && <span>Last dashboard update {lastSuccess}</span>}
            {!delayed && (
              <span className="inline-flex items-center gap-1 text-red-700">
                <AlertTriangle className="h-3 w-3" />
                Recent changes may take a little longer to appear here.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
