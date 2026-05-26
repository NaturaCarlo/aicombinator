"use client";

import { useRef, useEffect } from "react";
import { CornerDownRight } from "lucide-react";
import { resolveAvatarUrl } from "@/lib/api";
import type { AgentMessage, Agent } from "@/lib/types";

// ─── Helpers ──────────────────────────────────────────────────

const TYPE_BADGES: Record<string, { label: string; color: string }> = {
  task: { label: "task", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" },
  message: { label: "message", color: "bg-secondary text-muted-foreground" },
  report: { label: "report", color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" },
  approval_request: { label: "approval", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" },
};

function timeAgo(dateStr: string): string {
  const normalized =
    dateStr.includes("T") || dateStr.includes("Z") || dateStr.includes("+")
      ? dateStr
      : dateStr.replace(" ", "T") + "Z";
  const seconds = Math.floor(
    (Date.now() - new Date(normalized).getTime()) / 1000,
  );
  if (seconds < 0 || seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

// ─── Threading helpers ────────────────────────────────────────

interface ThreadedMessage extends AgentMessage {
  replies: ThreadedMessage[];
  depth: number;
}

/** Build a tree of messages from a flat list using parentMessageId */
function buildThreads(messages: AgentMessage[]): ThreadedMessage[] {
  const byId = new Map<string, ThreadedMessage>();
  const roots: ThreadedMessage[] = [];

  // First pass: wrap each message
  for (const msg of messages) {
    byId.set(msg.id, { ...msg, replies: [], depth: 0 });
  }

  // Second pass: attach children to parents
  for (const msg of messages) {
    const node = byId.get(msg.id)!;
    if (msg.parentMessageId && byId.has(msg.parentMessageId)) {
      const parent = byId.get(msg.parentMessageId)!;
      node.depth = parent.depth + 1;
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort roots and replies chronologically (oldest first)
  const sortByDate = (a: ThreadedMessage, b: ThreadedMessage) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  roots.sort(sortByDate);
  function sortReplies(node: ThreadedMessage) {
    node.replies.sort(sortByDate);
    node.replies.forEach(sortReplies);
  }
  roots.forEach(sortReplies);

  return roots;
}

/** Recursively set depth on nested nodes */
function setDepths(nodes: ThreadedMessage[], depth: number) {
  for (const n of nodes) {
    n.depth = depth;
    setDepths(n.replies, depth + 1);
  }
}

// ─── Component ────────────────────────────────────────────────

export function AgentMessagesTab({
  messages,
  agents,
  isLoading,
}: {
  messages: AgentMessage[] | undefined;
  agents: Agent[];
  isLoading: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  // Build threaded message tree from flat list
  // API returns DESC, reverse to get chronological
  const chronological = messages ? [...messages].reverse() : [];
  const threads = buildThreads(chronological);
  setDepths(threads, 0);

  // Auto-scroll to bottom on initial load and when message count changes
  useEffect(() => {
    const count = chronological.length;
    if (count > 0 && count !== prevCountRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: prevCountRef.current === 0 ? "instant" : "smooth",
        });
      });
    }
    prevCountRef.current = count;
  }, [chronological.length]);

  // ── Loading skeleton ────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 p-4 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <div className="shimmer h-8 w-8 rounded-none shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="shimmer h-3 w-32 rounded" />
                <div className="shimmer h-3 w-full rounded" />
                <div className="shimmer h-3 w-3/4 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Main render ─────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Message feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2">
        {threads.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-muted-foreground">No messages yet</p>
          </div>
        ) : (
          <div className="space-y-1">
            {threads.map((thread) => (
              <MessageThread
                key={thread.id}
                node={thread}
                agentMap={agentMap}
              />
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground shrink-0">
        Internal company traffic only. Send instructions through the CEO chat so creator-facing conversations stay on Opus 4.6.
      </div>
    </div>
  );
}

// ─── Threaded message rendering ──────────────────────────────

function MessageThread({
  node,
  agentMap,
}: {
  node: ThreadedMessage;
  agentMap: Map<string, Agent>;
}) {
  const isReply = node.depth > 0;
  // Cap visual indent at depth 4 to avoid excessive nesting
  const indent = Math.min(node.depth, 4);

  return (
    <div>
      <MessageRow msg={node} agentMap={agentMap} isReply={isReply} indent={indent} />
      {node.replies.length > 0 && (
        <div className="relative">
          {/* Thread connector line */}
          <div
            className="absolute top-0 bottom-3 border-l-2 border-border"
            style={{ left: `${20 + indent * 32}px` }}
          />
          {node.replies.map((reply) => (
            <MessageThread key={reply.id} node={reply} agentMap={agentMap} />
          ))}
        </div>
      )}
    </div>
  );
}

function MessageRow({
  msg,
  agentMap,
  isReply,
  indent,
}: {
  msg: AgentMessage;
  agentMap: Map<string, Agent>;
  isReply: boolean;
  indent: number;
}) {
  const fromAgent = msg.fromAgentId ? agentMap.get(msg.fromAgentId) : null;
  const toAgent = agentMap.get(msg.toAgentId);

  const isCreatorMessage =
    msg.metadata && (msg.metadata as Record<string, unknown>).from_creator;
  const displayName = isCreatorMessage ? "You (via CEO)" : msg.fromName;
  const displayTitle = isCreatorMessage
    ? null
    : fromAgent?.title || msg.fromRole;

  const avatarUrl = fromAgent?.icon ? resolveAvatarUrl(fromAgent.icon) : "";
  const initials = getInitials(msg.fromName);
  const badge = TYPE_BADGES[msg.type] || TYPE_BADGES.message;

  const avatarSize = isReply ? "h-6 w-6" : "h-8 w-8";
  const nameSize = isReply ? "text-xs" : "text-sm";
  const bodySize = isReply ? "text-xs" : "text-sm";

  return (
    <div
      className={`flex gap-2.5 py-2 px-2 rounded-none hover:bg-secondary/50 transition-colors ${isReply ? "pt-1.5 pb-1.5" : "py-3"}`}
      style={{ paddingLeft: `${8 + indent * 32}px` }}
    >
      {/* Reply indicator */}
      {isReply && (
        <CornerDownRight className="h-3 w-3 text-muted-foreground/40 shrink-0 mt-1" />
      )}

      {/* Avatar */}
      <div className={`shrink-0 ${avatarSize} rounded-none bg-secondary overflow-hidden flex items-center justify-center`}>
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={msg.fromName}
            className={`${avatarSize} rounded-none object-cover`}
          />
        ) : (
          <span className="text-[10px] font-semibold text-muted-foreground">
            {initials}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Name line */}
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className={`${nameSize} font-bold leading-tight`}>
            {displayName}
          </span>
          {displayTitle && (
            <span className="text-[10px] text-muted-foreground/70">
              {displayTitle}
            </span>
          )}
          {toAgent && (
            <span className="text-[10px] text-muted-foreground">
              <span className="text-muted-foreground/40 mx-0.5">&rarr;</span>
              {msg.toName}
            </span>
          )}
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium ${badge.color}`}
          >
            {badge.label}
          </span>
          <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">
            {timeAgo(msg.createdAt)}
          </span>
        </div>

        {/* Subject */}
        {msg.subject && (
          <p className={`${nameSize} font-semibold mt-0.5 leading-snug`}>
            {msg.subject}
          </p>
        )}

        {/* Body */}
        <p className={`${bodySize} text-muted-foreground mt-0.5 leading-relaxed whitespace-pre-wrap break-words`}>
          {msg.body}
        </p>
      </div>
    </div>
  );
}
