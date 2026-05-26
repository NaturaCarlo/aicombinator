"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import {
  ArrowLeft,
  Bot,
  Clock,
  CreditCard,
  DollarSign,
  Loader2,
  Mail,
  MessageSquare,
  Pause,
  Play,
  Rocket,
  User,
  Users,
} from "lucide-react";
import { createAuthFetcher, adminUpdateCompany, adminProvisionCompany, resolveAvatarUrl } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import type { AdminCompanyDetail, AdminCompanyAgent, AdminCompanyMessage } from "@/lib/types";
import { useState } from "react";

export default function AdminAgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { getToken } = useAuth();

  const { data, isLoading, mutate } = useSWR(
    id ? `/api/admin/companies/${id}` : null,
    async (url) => {
      const token = await getToken();
      const fetcher = createAuthFetcher(token);
      return fetcher(url) as Promise<AdminCompanyDetail>;
    },
    { refreshInterval: 10000 },
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32 fade-in-up">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="fade-in-up">
        <Link
          href="/admin/agents"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Agents
        </Link>
        <div className="card-clean flex flex-col items-center justify-center py-20">
          <Bot className="mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">
            Agent not found
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in-up">
      {/* Back link */}
      <Link
        href="/admin/agents"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Agents
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{data.name}</h1>
            <StatusBadge state={data.state} />
          </div>
          <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
            {data.owner_name && (
              <span className="flex items-center gap-1">
                <User className="h-3.5 w-3.5" /> {data.owner_name}
              </span>
            )}
            {data.email && <span>{data.email}</span>}
            <span>
              Created{" "}
              {new Date(data.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
        </div>
        <AgentActions company={data} onUpdate={() => mutate()} />
      </div>

      {/* Stats grid */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label="Budget"
          value={`$${(data.budget_cents / 100).toFixed(2)}`}
          sub={`$${(data.spent_cents / 100).toFixed(2)} spent`}
        />
        <StatCard
          icon={Bot}
          label="Model"
          value={data.inference_model || "—"}
          sub={data.state}
        />
        <StatCard
          icon={Clock}
          label="Heartbeat"
          value={
            data.heartbeat
              ? timeAgo(data.heartbeat.lastTurnTime || data.heartbeat.timestamp)
              : "None"
          }
          sub={data.heartbeat ? `${data.heartbeat.turnCount} turns` : "No data"}
        />
        <StatCard
          icon={CreditCard}
          label="Card"
          value={
            data.card
              ? `••${data.card.last_four}`
              : "No card"
          }
          sub={
            data.card
              ? `${data.card.card_brand} · ${data.card.status}`
              : "—"
          }
        />
      </div>

      {/* Founding Team (Agents) */}
      {data.agents && data.agents.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Users className="h-4 w-4 text-accent-orange" />
            Founding Team ({data.agents.length} agents)
          </h2>
          <div className="card-clean divide-y divide-border">
            {data.agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} agents={data.agents} />
            ))}
          </div>
        </div>
      )}

      {/* Inter-Agent Messages */}
      {data.messages && data.messages.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Mail className="h-4 w-4 text-accent-orange" />
            Agent Messages ({data.messages.length})
          </h2>
          <div className="card-clean divide-y divide-border max-h-[500px] overflow-y-auto">
            {data.messages.map((msg) => (
              <MessageRow key={msg.id} message={msg} />
            ))}
          </div>
        </div>
      )}

      {/* Latest thinking */}
      {data.heartbeat?.thinking && (
        <div className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <MessageSquare className="h-4 w-4 text-accent-orange" />
            Latest Thinking
          </h2>
          <div className="card-clean p-5">
            <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {data.heartbeat.thinking}
            </p>
          </div>
        </div>
      )}

      {/* Genesis prompt */}
      {data.genesis_prompt && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            Genesis Prompt
          </h2>
          <div className="card-clean p-5">
            <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {data.genesis_prompt}
            </p>
          </div>
        </div>
      )}

      {/* Recent activity */}
      {data.recentActivity && data.recentActivity.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Clock className="h-4 w-4 text-accent-orange" />
            Recent Activity
          </h2>
          <div className="card-clean divide-y divide-border">
            {data.recentActivity.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {entry.type}
                  </span>
                  <p className="text-sm">{entry.summary}</p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(entry.created_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent purchases */}
      {data.recentPurchases && data.recentPurchases.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            Recent Purchases
          </h2>
          <div className="card-clean divide-y divide-border">
            {data.recentPurchases.map((purchase) => (
              <div key={purchase.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-medium">{purchase.description}</p>
                  {purchase.url && (
                    <a
                      href={purchase.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-accent-orange hover:underline"
                    >
                      {purchase.url}
                    </a>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <span className="text-sm font-bold">
                    ${((purchase.amount_cents ?? 0) / 100).toFixed(2)}
                  </span>
                  <div className="text-xs text-muted-foreground">{purchase.status}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  agents,
}: {
  agent: AdminCompanyAgent;
  agents: AdminCompanyAgent[];
}) {
  const reportsToAgent = agent.reports_to
    ? agents.find((a) => a.id === agent.reports_to)
    : null;

  const statusColors: Record<string, string> = {
    free: "bg-gray-100 text-gray-700",
    idle: "bg-gray-100 text-gray-700",
    working: "bg-green-100 text-green-700",
    running: "bg-green-100 text-green-700",
    sleeping: "bg-blue-100 text-blue-700",
    error: "bg-red-100 text-red-700",
    offline: "bg-amber-100 text-amber-700",
    paused: "bg-amber-100 text-amber-700",
  };

  return (
    <div className="flex items-center gap-4 px-5 py-3">
      {/* Avatar */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-none bg-muted">
        {agent.icon ? (
          <img
            src={resolveAvatarUrl(agent.icon)}
            alt={agent.name}
            className="h-9 w-9 rounded-none object-cover"
          />
        ) : (
          <Bot className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{agent.name}</span>
          <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[10px] font-medium ${statusColors[agent.status] || "bg-gray-100 text-gray-700"}`}>
            {agent.status}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{agent.title || agent.role}</span>
          {reportsToAgent && (
            <span className="text-muted-foreground/60">
              reports to {reportsToAgent.title || reportsToAgent.name}
            </span>
          )}
        </div>
      </div>

      {/* Capabilities */}
      <div className="hidden shrink-0 gap-1 sm:flex">
        {(agent.capabilities || []).slice(0, 3).map((cap) => (
          <span
            key={cap}
            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {cap}
          </span>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: AdminCompanyMessage }) {
  const typeColors: Record<string, string> = {
    task: "bg-blue-100 text-blue-700",
    message: "bg-gray-100 text-gray-700",
    report: "bg-green-100 text-green-700",
    approval_request: "bg-amber-100 text-amber-700",
  };

  const priorityColors: Record<string, string> = {
    urgent: "text-red-600",
    high: "text-orange-600",
    normal: "text-muted-foreground",
    low: "text-muted-foreground/60",
  };

  return (
    <div className="px-5 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold">{message.fromName}</span>
        <span className="text-xs text-muted-foreground/50">-&gt;</span>
        <span className="text-xs font-semibold">{message.toName}</span>
        <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[10px] font-medium ${typeColors[message.type] || "bg-gray-100 text-gray-700"}`}>
          {message.type}
        </span>
        {message.priority !== "normal" && (
          <span className={`text-[10px] font-medium ${priorityColors[message.priority] || ""}`}>
            {message.priority}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {timeAgo(message.createdAt)}
        </span>
      </div>
      {message.subject && (
        <p className="text-sm font-medium mb-0.5">{message.subject}</p>
      )}
      <p className="text-xs text-muted-foreground line-clamp-2">{message.body}</p>
    </div>
  );
}

function AgentActions({
  company,
  onUpdate,
}: {
  company: AdminCompanyDetail;
  onUpdate: () => void;
}) {
  const { getToken } = useAuth();
  const [loading, setLoading] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const canProvision = company.agents.length === 0
    && company.state !== "running"
    && company.state !== "provisioning"
    && company.state !== "paused"
    && company.state !== "sleeping";

  async function handleToggle() {
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const newState = company.state === "paused" ? "running" : "paused";
      await adminUpdateCompany(company.id, { state: newState }, token);
      onUpdate();
    } finally {
      setLoading(false);
    }
  }

  async function handleProvision() {
    setProvisioning(true);
    try {
      const token = await getToken();
      if (!token) return;
      await adminProvisionCompany(company.id, token);
      onUpdate();
    } finally {
      setProvisioning(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {canProvision && (
        <button
          onClick={handleProvision}
          disabled={provisioning}
          className="inline-flex items-center gap-1.5 rounded-none border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50 disabled:opacity-50"
        >
          {provisioning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Rocket className="h-4 w-4" /> Provision
            </>
          )}
        </button>
      )}

      {/* Pause/Resume for running/paused companies */}
      {(company.state === "running" || company.state === "paused") && (
        <button
          onClick={handleToggle}
          disabled={loading}
          className={`inline-flex items-center gap-1.5 rounded-none border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
            company.state === "paused"
              ? "border-green-200 text-green-700 hover:bg-green-50"
              : "border-amber-200 text-amber-700 hover:bg-amber-50"
          }`}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : company.state === "paused" ? (
            <>
              <Play className="h-4 w-4" /> Resume
            </>
          ) : (
            <>
              <Pause className="h-4 w-4" /> Pause
            </>
          )}
        </button>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="card-clean p-5">
      <div className="mb-3 flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-xl font-bold tracking-tight">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function timeAgo(dateString: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateString).getTime()) / 1000,
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
