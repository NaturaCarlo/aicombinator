"use client";

import { useState, useCallback } from "react";
import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { Zap } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live";

interface Automation {
  id: string;
  company_id: string;
  agent_id: string;
  title: string | null;
  description: string | null;
  schedule: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
}

/**
 * Convert a cron expression to a human-readable schedule string.
 * Handles common patterns; falls back to "Custom schedule" for complex ones.
 */
function humanReadableSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every minute
  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Every minute";
  }

  // Every N minutes
  const everyNMin = minute?.match(/^\*\/(\d+)$/);
  if (everyNMin && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = Number(everyNMin[1]);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }

  // Every hour at :MM
  if (minute !== "*" && !minute?.includes("/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every hour at :${minute?.padStart(2, "0")}`;
  }

  // Every N hours
  const everyNHour = hour?.match(/^\*\/(\d+)$/);
  if (minute !== undefined && everyNHour && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = Number(everyNHour[1]);
    return n === 1 ? "Every hour" : `Every ${n} hours`;
  }

  // Daily at specific time
  if (
    minute !== "*" && !minute?.includes("/") &&
    hour !== "*" && !hour?.includes("/") &&
    dayOfMonth === "*" && month === "*" && dayOfWeek === "*"
  ) {
    const h = Number(hour);
    const m = minute?.padStart(2, "0");
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Every day at ${h12}:${m}${ampm}`;
  }

  // Weekly on specific day
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (
    minute !== "*" && !minute?.includes("/") &&
    hour !== "*" && !hour?.includes("/") &&
    dayOfMonth === "*" && month === "*" &&
    dayOfWeek !== "*" && !dayOfWeek?.includes("/") && !dayOfWeek?.includes(",")
  ) {
    const h = Number(hour);
    const m = minute?.padStart(2, "0");
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const dow = Number(dayOfWeek);
    const dayName = dayNames[dow] ?? dayOfWeek;
    return `Every ${dayName} at ${h12}:${m}${ampm}`;
  }

  return `Custom schedule (${cron})`;
}

function formatTimestamp(ts: string | null): string | null {
  if (!ts) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 0) return null;
  if (diffSec < 60) return "just now";
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ToggleSwitch({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-none border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-orange focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled ? "bg-accent-orange" : "bg-zinc-300 dark:bg-zinc-700"
      }`}
    >
      <span
        className={`pointer-events-none block h-3.5 w-3.5 rounded-none bg-white shadow-lg ring-0 transition-transform ${
          enabled ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function AutomationsSection({ companyId }: { companyId: string }) {
  const { getToken } = useAuth();
  const [togglingIds, setTogglingIds] = useState<Set<string>>(() => new Set());

  const { data, mutate } = useSWR<{ automations: Automation[] }>(
    `/api/companies/${companyId}/automations`,
    async (url: string) => {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const res = await fetch(`${API_URL}${url}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Failed to fetch automations: ${res.status}`);
      return res.json() as Promise<{ automations: Automation[] }>;
    },
    { refreshInterval: 30_000 },
  );

  const automations = data?.automations ?? [];

  const handleToggle = useCallback(
    async (automation: Automation) => {
      const newEnabled = automation.enabled === 0;
      setTogglingIds((prev) => new Set(prev).add(automation.id));

      // Optimistic update
      mutate(
        (current) => {
          if (!current) return current;
          return {
            automations: current.automations.map((a) =>
              a.id === automation.id ? { ...a, enabled: newEnabled ? 1 : 0 } : a,
            ),
          };
        },
        false, // don't revalidate yet
      );

      try {
        const token = await getToken();
        if (!token) throw new Error("Not authenticated");
        const res = await fetch(
          `${API_URL}/api/companies/${companyId}/automations/${automation.id}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ enabled: newEnabled }),
          },
        );
        if (!res.ok) {
          throw new Error(`Toggle failed: ${res.status}`);
        }
      } catch {
        // Revert on failure
        mutate();
      } finally {
        setTogglingIds((prev) => {
          const next = new Set(prev);
          next.delete(automation.id);
          return next;
        });
        // Revalidate to ensure consistency
        mutate();
      }
    },
    [companyId, getToken, mutate],
  );

  const subtitle = "Ask the CEO in chat to create new automations";

  // Empty state: show subtitle instruction only
  if (automations.length === 0) {
    return (
      <div className="card-clean overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Zap className="h-3.5 w-3.5 text-accent-orange" />
          <span className="section-label">
            Automations
          </span>
        </div>
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card-clean overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Zap className="h-3.5 w-3.5 text-accent-orange" />
        <span className="section-label">
          Automations
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{automations.length}</span>
      </div>
      <p className="px-4 pt-2 pb-1 text-[10px] text-muted-foreground">{subtitle}</p>
      <div className="divide-y divide-border">
        {automations.map((automation) => {
          const isToggling = togglingIds.has(automation.id);
          const enabled = automation.enabled === 1;
          const lastRun = formatTimestamp(automation.last_run_at);

          return (
            <div
              key={automation.id}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">
                  {automation.title || automation.prompt}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {humanReadableSchedule(automation.schedule)}
                  {lastRun ? ` · Last run ${lastRun}` : ""}
                </p>
              </div>
              <ToggleSwitch
                enabled={enabled}
                onToggle={() => handleToggle(automation)}
                disabled={isToggling}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
