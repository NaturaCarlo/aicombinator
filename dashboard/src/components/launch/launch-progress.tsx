"use client";

import {
  CheckCircle2,
  CircleDashed,
  CreditCard,
  FileText,
  Hammer,
  Loader2,
  Rocket,
  ScrollText,
  Sparkles,
  Users,
  XCircle,
  Zap,
  Brain,
  ListChecks,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { resolveAvatarUrl } from "@/lib/api";
import type { LaunchStage, LaunchStep } from "@/lib/types";
import { DEFAULT_LAUNCH_STEPS, DEFAULT_TEAM_PLACEHOLDERS, type ProvisioningData } from "@/components/launch/launch-runtime";

function extractTimelessMission(text: string): string | null {
  if (!text?.trim()) return null;
  const lines = text.split("\n");
  const filtered: string[] = [];
  let skipSection = false;

  const operationalHeaders =
    /(?:day[\s-]*[0-9]|week[\s-]*[0-9]|first\s+(?:24|48|72)\s*hours?|immediate\s+priorities|short[\s-]*term\s+(?:goals?|plan|priorities)|action\s+items|kpis?\b|milestones?\s+(?:for|by)|sprint|deliverables?\b|timeline|next\s+steps|tasks?\s+(?:for|to)|metrics?\s+(?:for|by|to)|targets?\s+(?:for|by)|goals?\s+for\s+(?:day|week|month)|operational\s+plan|execution\s+plan|launch\s+(?:day|week)|initial\s+tasks)/i;

  for (const line of lines) {
    const isHeader =
      /^#{1,4}\s/.test(line) ||
      /^[A-Z][A-Za-z\s,/&-]+:?\s*$/.test(line.trim());

    if (isHeader) {
      skipSection = operationalHeaders.test(line);
    }

    if (!skipSection) {
      filtered.push(line);
    }
  }

  const result = filtered.join("\n").trim();
  return result || null;
}

const STAGE_ICONS: Record<LaunchStage | string, LucideIcon> = {
  creating_workspace: Sparkles,
  creating_ceo: Users,
  ceo_mission: ScrollText,
  ceo_planning: Brain,
  activating_team: Zap,
  delegating_tasks: ListChecks,
  founder_briefing: FileText,
  finalizing: Rocket,
  ready: CheckCircle2,
  awaiting_funding: CreditCard,
  failed: XCircle,
};

export function LaunchProgress({
  companyName,
  data,
}: {
  companyName: string;
  data: ProvisioningData;
}) {
  const StageIcon = STAGE_ICONS[data.stage] ?? CircleDashed;
  const visibleSteps = data.steps.length > 0 ? data.steps : DEFAULT_LAUNCH_STEPS;
  const nextMission = extractTimelessMission(data.missionText ?? "");
  const timelessMission = nextMission;
  const activeStep = visibleSteps.find((step) => step.state === "active")
    ?? visibleSteps.find((step) => step.state === "pending")
    ?? visibleSteps[visibleSteps.length - 1]
    ?? DEFAULT_LAUNCH_STEPS[0];
  const completedStepCount = visibleSteps.filter((step) => step.state === "done").length;
  const namedTeamCount = data.team.filter((agent) => Boolean(agent.name?.trim())).length;
  const avatarReadyCount = data.team.filter((agent) => Boolean(agent.icon)).length;
  const delegatedTaskCount = data.taskPreview.length;
  const activeTeamCount = data.team.filter(
    (agent) => agent.status === "working" || agent.status === "running",
  ).length;

  function stageStateLabel(state: LaunchStep["state"]): string {
    switch (state) {
      case "done":
        return "Done";
      case "active":
        return "Live";
      default:
        return "Queued";
    }
  }

  function stageCardClasses(state: LaunchStep["state"]): string {
    switch (state) {
      case "done":
        return "border-accent-orange/20 bg-accent-orange/[0.06]";
      case "active":
        return "border-accent-orange/45 bg-gradient-to-br from-accent-orange/[0.16] to-accent-orange/[0.03] shadow-[0_0_0_1px_rgba(255,102,0,0.12)]";
      default:
        return "border-border/70 bg-secondary/20";
    }
  }

  function stageIconClasses(state: LaunchStep["state"]): string {
    switch (state) {
      case "done":
        return "bg-accent-orange text-white";
      case "active":
        return "border-2 border-accent-orange bg-background text-accent-orange";
      default:
        return "border border-border bg-background text-muted-foreground/70";
    }
  }

  function stageBadgeClasses(state: LaunchStep["state"]): string {
    switch (state) {
      case "done":
        return "bg-accent-orange/12 text-accent-orange";
      case "active":
        return "bg-accent-orange text-white";
      default:
        return "bg-secondary text-muted-foreground";
    }
  }

  return (
    <div className="space-y-6 fade-in-up">
      <div className="overflow-hidden rounded-none border border-border/80 bg-[radial-gradient(circle_at_top_left,rgba(255,102,0,0.2),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(255,102,0,0.08),transparent_34%)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="mb-3 inline-flex items-center gap-2 rounded-none border border-accent-orange/20 bg-accent-orange/10 px-3 py-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-orange" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-orange">
                Live Launch
              </span>
            </div>
            {companyName && (
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                {companyName}
              </h1>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2 rounded-none border border-border/70 bg-background/75 px-3 py-1.5">
                <StageIcon className="h-4 w-4 text-accent-orange" />
                {activeStep?.label ?? data.headline}
              </span>
              <span className="inline-flex items-center rounded-none border border-border/70 bg-background/75 px-3 py-1.5">
                {completedStepCount}/{visibleSteps.length} steps cleared
              </span>
            </div>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-foreground/90">
              {data.detail}
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4 lg:w-[420px]">
            <div className="min-w-0 overflow-hidden rounded-none border border-border/70 bg-background/75 p-4 backdrop-blur-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Progress
              </p>
              <p className="mt-2 text-2xl font-semibold">{data.progressPercent}%</p>
            </div>
            <div className="min-w-0 overflow-hidden rounded-none border border-border/70 bg-background/75 p-4 backdrop-blur-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Team
              </p>
              <p className="mt-2 text-2xl font-semibold">{namedTeamCount}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">named</p>
            </div>
            <div className="min-w-0 overflow-hidden rounded-none border border-border/70 bg-background/75 p-4 backdrop-blur-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Avatars
              </p>
              <p className="mt-2 text-2xl font-semibold">{avatarReadyCount}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">ready</p>
            </div>
            <div className="min-w-0 overflow-hidden rounded-none border border-border/70 bg-background/75 p-4 backdrop-blur-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Work
              </p>
              <p className="mt-2 text-2xl font-semibold">{delegatedTaskCount}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">tracked</p>
            </div>
          </div>
        </div>
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <span>Bootstrap Progress</span>
            <span>{data.progressPercent}%</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-none bg-secondary/80">
            <div
              className="progress-bar h-full rounded-none transition-all duration-700"
              style={{ width: `${data.progressPercent}%` }}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">
          <div className="card-clean overflow-hidden p-6">
            <div className="mb-4 flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-accent-orange" />
              <p className="text-xs font-semibold uppercase tracking-wider text-accent-orange">
                Company Mission
              </p>
            </div>
            {timelessMission ? (
              <div className="space-y-2">
                {timelessMission.split("\n").map((line, i) => {
                  const trimmed = line.trim();
                  if (!trimmed) return null;
                  if (/^#{1,3}\s/.test(trimmed)) {
                    const text = trimmed.replace(/^#{1,3}\s+/, "");
                    return (
                      <h3
                        key={i}
                        className="mt-3 text-base font-semibold first:mt-0"
                      >
                        {text}
                      </h3>
                    );
                  }
                  if (/^[-*]\s/.test(trimmed)) {
                    return (
                      <div key={i} className="ml-1 flex gap-2">
                        <span className="shrink-0 text-accent-orange">•</span>
                        <p className="text-sm leading-relaxed">
                          {trimmed.replace(/^[-*]\s+/, "")}
                        </p>
                      </div>
                    );
                  }
                  if (/^\*\*[^*]+\*\*/.test(trimmed)) {
                    return (
                      <p key={i} className="text-sm font-semibold leading-relaxed">
                        {trimmed.replace(/\*\*/g, "")}
                      </p>
                    );
                  }
                  return (
                    <p key={i} className="text-sm leading-relaxed">
                      {trimmed}
                    </p>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 text-muted-foreground">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  <p className="text-sm">
                    Your CEO is crafting the company mission...
                  </p>
                </div>
                <div className="space-y-2.5">
                  <div className="h-3 w-full animate-pulse rounded bg-secondary/70" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-secondary/70" />
                  <div className="h-3 w-4/6 animate-pulse rounded bg-secondary/70" />
                </div>
              </div>
            )}
          </div>

          <div className="card-clean p-5">
            <div className="mb-4 flex items-center gap-2">
              <Hammer className="h-4 w-4 text-accent-orange" />
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Live Build Feed
              </p>
            </div>
            {data.taskPreview.length === 0 ? (
              <div className="space-y-1.5 text-sm text-muted-foreground">
                <p>The CEO is shaping the first workstreams.</p>
                <p>Tasks will appear here as agents start working.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {data.taskPreview.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-start justify-between gap-3 rounded-none border border-border px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-snug">
                        {task.title}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {task.owner_name
                          ? `→ ${task.owner_name}`
                          : "Unassigned"}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-none bg-accent-orange/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-orange">
                      {task.status.replace("_", " ")}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {data.missingItems.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Still coming: {data.missingItems.join(" · ")}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="card-clean p-5">
            <div className="mb-4 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-accent-orange" />
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Launch Stages
              </p>
            </div>
            <div className="grid gap-3">
              {visibleSteps.map((step) => {
                const Icon = STAGE_ICONS[step.id] ?? CircleDashed;
                return (
                  <div
                    key={step.id}
                    className={`rounded-none border p-4 transition-all duration-300 ${stageCardClasses(step.state)}`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-none ${stageIconClasses(step.state)}`}
                      >
                        {step.state === "done" ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <Icon className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold leading-none">
                            {step.label}
                          </p>
                          <span className={`rounded-none px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${stageBadgeClasses(step.state)}`}>
                            {stageStateLabel(step.state)}
                          </span>
                        </div>
                        {step.detail && (
                          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                            {step.detail}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card-clean p-5">
            <div className="mb-4 flex items-center gap-2">
              <Users className="h-4 w-4 text-accent-orange" />
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Founding Team
              </p>
            </div>
            <div className="space-y-2">
              {data.team.length === 0 &&
                DEFAULT_TEAM_PLACEHOLDERS.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 rounded-none border border-dashed border-border/80 p-3"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-none bg-secondary">
                      <CircleDashed className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{agent.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {agent.title}
                      </p>
                    </div>
                  </div>
                ))}
              {data.team.map((agent, i) => (
                <div
                  key={agent.id}
                  className={`fade-in-up stagger-${Math.min(i + 1, 6)} flex items-center gap-3 rounded-none border border-border/80 bg-background/70 p-3`}
                >
                  <div className="relative">
                    <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-none border border-border bg-secondary">
                      {agent.icon ? (
                        <img
                          src={resolveAvatarUrl(agent.icon)}
                          alt={agent.name}
                          className="h-10 w-10 rounded-none object-cover"
                        />
                      ) : (
                        <span className="text-xs font-bold text-muted-foreground">
                          {agent.name.charAt(0)}
                        </span>
                      )}
                    </div>
                    {(agent.status === "working" ||
                      agent.status === "running") && (
                      <div className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-none border-2 border-background bg-green-500" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {agent.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {agent.title || agent.role}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-none px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
                    agent.status === "working" || agent.status === "running"
                      ? "bg-emerald-500/12 text-emerald-400"
                      : "bg-secondary text-muted-foreground"
                  }`}>
                    {agent.status === "working" || agent.status === "running" ? "Live" : "Idle"}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-none border border-border/70 bg-secondary/20 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Agents active right now</span>
                <span className="font-semibold text-foreground">{activeTeamCount}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {!data.supervisorReachable && (
        <div className="rounded-none border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-400">
          Live updates are temporarily delayed. The launch is still being
          tracked.
        </div>
      )}
    </div>
  );
}
