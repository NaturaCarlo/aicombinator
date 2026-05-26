"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { resolveAvatarUrl } from "@/lib/api";
import type { FounderAgentStatus, FounderVisibleAgent } from "@/lib/types";

const STATUS_COLORS: Record<FounderAgentStatus, string> = {
  free: "bg-green-500",
  working: "bg-amber-500",
  paused: "bg-gray-400",
};

function AgentRow({ agent, companyId }: { agent: FounderVisibleAgent; companyId?: string }) {
  const dotColor = STATUS_COLORS[agent.status];

  const content = (
    <div className="group flex items-center gap-2.5 rounded-none px-2 py-1.5 transition-colors hover:bg-secondary/50">
      {/* Avatar with status dot */}
      <div className="relative shrink-0">
        <div className="h-7 w-7 rounded-none bg-secondary flex items-center justify-center overflow-hidden ring-1 ring-border">
          {agent.icon ? (
            <img
              src={resolveAvatarUrl(agent.icon)}
              alt={agent.name}
              className="h-7 w-7 rounded-none object-cover"
            />
          ) : (
            <span className="text-[10px] font-semibold text-muted-foreground">
              {agent.name.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <div className="absolute -bottom-0.5 -right-0.5">
          <div className={`h-2.5 w-2.5 rounded-none border-2 border-background ${dotColor}`} />
          {agent.status === "working" && (
            <div className={`absolute inset-0 h-2.5 w-2.5 rounded-none ${dotColor} animate-ping opacity-40`} />
          )}
        </div>
      </div>
      {/* Name + role */}
      <div className="min-w-0 flex-1">
        <span className="text-xs font-medium leading-tight truncate block">{agent.name}</span>
        <span className="text-[10px] text-muted-foreground leading-tight truncate block">
          {agent.title || agent.role}
        </span>
      </div>
    </div>
  );

  if (companyId) {
    return (
      <Link href={`/company/${companyId}/team`} className="block">
        {content}
      </Link>
    );
  }

  return content;
}

export function AgentActivityFeed({
  agents,
  isLoading,
  companyId,
}: {
  agents: FounderVisibleAgent[];
  isLoading: boolean;
  companyId?: string;
}) {
  const working = agents.filter((agent) => agent.status === "working").length;
  const paused = agents.filter((agent) => agent.status === "paused").length;
  const free = agents.filter((agent) => agent.status === "free").length;

  if (isLoading) {
    return (
      <div>
        <div className="flex items-center gap-2 px-2 mb-2">
          <div className="shimmer h-4 w-4 rounded" />
          <div className="shimmer h-4 w-20 rounded" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
            <div className="shimmer h-7 w-7 rounded-none" />
            <div className="flex-1 space-y-1">
              <div className="shimmer h-3 w-24 rounded" />
              <div className="shimmer h-2.5 w-16 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 px-2 mb-1">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-muted-foreground">
          Agents
        </span>
      </div>
      <div className="px-2 pb-2 text-[10px] text-muted-foreground">
        {working} working
        {free > 0 ? ` · ${free} free` : ""}
        {paused > 0 ? ` · ${paused} paused` : ""}
      </div>
      <div className="space-y-0.5">
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} companyId={companyId} />
        ))}
      </div>
    </div>
  );
}
