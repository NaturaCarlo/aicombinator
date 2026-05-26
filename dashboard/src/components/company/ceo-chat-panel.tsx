"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { Send, Check, Loader2, MessageSquare, RotateCcw } from "lucide-react";
import { getCeoChatHistory, resolveAvatarUrl, streamChatWithCeo } from "@/lib/api";
import { MarkdownContent } from "@/components/company/markdown-content";
import { Input } from "@/components/ui/input";
import type { CompanyStatus, FounderVisibleAgent, FounderVisibleTask } from "@/lib/types";

interface ChatEntry {
  id: string;
  role: "user" | "ceo";
  text: string;
  time: string;
  kind?: "founder_chat" | "ceo_notice";
  status?: "sending" | "sent" | "error" | "thinking" | "streaming";
}

interface ActiveFounderChat {
  id: string;
  founderMessage: string;
  createdAt: string;
  ceoReply: string;
  status: "pending" | "error";
  error?: string | null;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function friendlyErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("timed out") || lower.includes("aborted") || lower.includes("abort")) {
    return "Response timed out. Try again.";
  }
  if (lower.includes("not authenticated")) {
    return "Session expired. Please refresh the page.";
  }
  if (lower.includes("network") || lower.includes("failed to fetch")) {
    return "Network error. Check your connection and try again.";
  }
  return raw;
}

export function CeoChatPanel({
  companyId,
  status,
  ceoAgent,
  agents,
  tasks,
}: {
  companyId: string;
  status: CompanyStatus | undefined;
  ceoAgent: FounderVisibleAgent | undefined;
  agents: FounderVisibleAgent[];
  tasks: FounderVisibleTask[];
}) {
  const { getToken } = useAuth();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [activeChat, setActiveChat] = useState<ActiveFounderChat | null>(null);
  const [toolActivity, setToolActivity] = useState<{ toolName: string; description: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef("");
  const streamFrameRef = useRef<number | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const lastSentMessageRef = useRef<string>("");
  const { data: history, mutate: mutateHistory } = useSWR(
    companyId ? `/api/companies/${companyId}/chat` : null,
    async () => {
      const token = await getToken();
      if (!token) return [];
      return getCeoChatHistory(companyId, token);
    },
    {
      refreshInterval: activeChat ? 0 : 10000,
    },
  );

  const entries = flattenHistory(history ?? [], activeChat);

  // Track whether user is near bottom BEFORE DOM updates.
  // This ref is updated by a scroll event handler that fires continuously,
  // capturing the scroll position before React commits new DOM content.
  // This prevents the bug where a tall message pushes scroll away from bottom
  // before the autoscroll check happens.
  const wasNearBottomRef = useRef(true);
  const NEAR_BOTTOM_THRESHOLD = 100;

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    wasNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  }, []);

  // Attach scroll listener to keep wasNearBottomRef up to date
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.addEventListener("scroll", handleScroll, { passive: true });
    // Initialize on mount
    handleScroll();
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // Auto-scroll on new entries — uses the pre-captured wasNearBottomRef
  // so that tall messages don't defeat the near-bottom detection.
  const prevEntryCountRef = useRef(0);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const prevCount = prevEntryCountRef.current;
    const hasNewEntries = entries.length !== prevCount;
    const isInitialLoad = prevCount === 0 && entries.length > 0;
    prevEntryCountRef.current = entries.length;
    const hasStreamingEntry = entries.some((entry) =>
      entry.status === "thinking" || entry.status === "streaming",
    );
    // Read the pre-captured near-bottom state from the ref.
    // This value was set by the scroll handler BEFORE React committed
    // the new DOM content, so it reflects the user's position before
    // the new message was rendered.
    const wasNearBottom = wasNearBottomRef.current;
    // Auto-scroll rules:
    // 1. Initial load: always scroll (instant)
    // 2. Streaming: always scroll (instant, keeps cursor visible)
    // 3. New messages: only scroll if user was near bottom BEFORE DOM update (smooth)
    // This preserves user's scroll position when reading history.
    if (isInitialLoad || hasStreamingEntry || (wasNearBottom && hasNewEntries)) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: isInitialLoad || hasStreamingEntry ? "auto" : "smooth",
      });
    }
  }, [entries]);

  useEffect(() => {
    return () => {
      if (streamFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFrameRef.current);
      }
      streamAbortRef.current?.abort();
    };
  }, []);

  function flushStreamBuffer() {
    if (!streamBufferRef.current) return;
    const chunk = streamBufferRef.current;
    streamBufferRef.current = "";
    setActiveChat((current) =>
      current
        ? { ...current, ceoReply: `${current.ceoReply}${chunk}` }
        : current,
    );
  }

  function scheduleStreamFlush() {
    if (streamFrameRef.current !== null) return;
    streamFrameRef.current = window.requestAnimationFrame(() => {
      streamFrameRef.current = null;
      flushStreamBuffer();
    });
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || sending) return;

    const userText = message.trim();
    lastSentMessageRef.current = userText;
    const optimisticTime = new Date().toISOString();
    const optimisticId = `pending-${Date.now()}`;
    setMessage("");
    setSending(true);
    setActiveChat({
      id: optimisticId,
      founderMessage: userText,
      createdAt: optimisticTime,
      ceoReply: "",
      status: "pending",
      error: null,
    });

    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");

      // Abort any previous stream before starting a new one
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;

      await streamChatWithCeo(companyId, userText, token, {
        onMeta: ({ chatId, createdAt }) => {
          setActiveChat((current) =>
            current
              ? { ...current, id: chatId, createdAt }
              : current,
          );
        },
        onDelta: (text) => {
          // Text flowing means tool activity is done
          setToolActivity(null);
          streamBufferRef.current += text;
          scheduleStreamFlush();
        },
        onDone: (reply) => {
          setToolActivity(null);
          if (streamFrameRef.current !== null) {
            window.cancelAnimationFrame(streamFrameRef.current);
            streamFrameRef.current = null;
          }
          flushStreamBuffer();
          setActiveChat((current) =>
            current
              ? { ...current, ceoReply: reply }
              : current,
          );
        },
        onError: (error) => {
          setToolActivity(null);
          setActiveChat((current) =>
            current
              ? { ...current, status: "error", error }
              : current,
          );
        },
        onToolStart: ({ toolName, description }) => {
          setToolActivity({ toolName, description });
        },
        onToolEnd: () => {
          setToolActivity(null);
        },
      }, controller.signal);
      // Re-enable textbox IMMEDIATELY after stream completes — before mutateHistory
      setSending(false);
      setActiveChat(null);
      // Refresh chat history in the background (non-blocking)
      mutateHistory().catch(() => {});
    } catch (err) {
      setToolActivity(null);
      if (streamFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFrameRef.current);
        streamFrameRef.current = null;
      }
      flushStreamBuffer();
      const rawMsg = err instanceof Error ? err.message : String(err);
      const errMsg = friendlyErrorMessage(rawMsg);
      console.error("[CeoChatPanel] Chat error:", rawMsg);
      // Re-enable textbox IMMEDIATELY — before mutateHistory
      setSending(false);
      setActiveChat((current) =>
        current
          ? { ...current, status: "error", error: current.error ? friendlyErrorMessage(current.error) : errMsg }
          : current,
      );
      // Refresh chat history in the background (non-blocking)
      mutateHistory().catch(() => {});
    }
  }

  function handleRetry() {
    if (!lastSentMessageRef.current) return;
    setActiveChat(null);
    setMessage(lastSentMessageRef.current);
    // Trigger send via a microtask so state updates flush first
    setTimeout(() => {
      const form = document.querySelector<HTMLFormElement>("[data-ceo-chat-form]");
      form?.requestSubmit();
    }, 0);
  }

  const recentThinking = status?.recentThinking;
  const hasContent = entries.length > 0 || recentThinking;
  const ceoLabel = ceoAgent?.title ? `${ceoAgent.name} · ${ceoAgent.title}` : (ceoAgent?.name || "CEO");
  const ceoInitial = (ceoAgent?.name || "CEO").charAt(0).toUpperCase();
  const workingAgents = agents.filter((agent) => agent.status === "working").length;
  const activeTasks = tasks.filter((task) => task.status === "active").length;
  const queuedTasks = tasks.filter((task) => task.status === "queued").length;
  const waitingOnFounder = tasks.filter((task) => task.status === "waiting_on_founder").length;
  const waitingOnDependency = tasks.filter((task) => task.status === "waiting_on_dependency").length;
  const pausedTasks = tasks.filter((task) => task.status === "paused").length;

  return (
    <div className="flex flex-col h-full">
      {/* Compact header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <MessageSquare className="h-3.5 w-3.5 text-accent-orange" />
        <span className="section-label">
          Chat
        </span>
        {ceoAgent?.name && (
          <span className="text-xs text-muted-foreground/70 ml-auto truncate">
            {ceoLabel}
          </span>
        )}
      </div>
      <div className="border-b border-border bg-secondary/20 px-4 py-2 shrink-0">
        <div className="text-[10px] font-mono font-semibold uppercase tracking-wider text-muted-foreground">
          Live now
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
          {workingAgents} working · {activeTasks} active
          {queuedTasks > 0 ? ` · ${queuedTasks} queued` : ""}
          {waitingOnFounder > 0 ? ` · ${waitingOnFounder} waiting on founder` : ""}
          {waitingOnDependency > 0 ? ` · ${waitingOnDependency} waiting on dependency` : ""}
          {pausedTasks > 0 ? ` · ${pausedTasks} paused` : ""}
        </div>
      </div>

      {/* Message area — fills available space, scrolls */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {!hasContent && (
          <div className="h-full flex items-center justify-center">
            <p className="text-xs text-muted-foreground">No messages yet. Send a message to your CEO below.</p>
          </div>
        )}

        {/* Interleaved chat entries */}
        {entries.map((entry) =>
          entry.role === "ceo" ? (
            <div key={entry.id} className="flex gap-2.5">
              <div className="shrink-0 h-7 w-7 rounded-none bg-secondary overflow-hidden flex items-center justify-center">
                {ceoAgent?.icon ? (
                  <img src={resolveAvatarUrl(ceoAgent.icon)} alt="CEO" className="h-7 w-7 rounded-none object-cover" />
                ) : (
                  <span className="text-[10px] font-semibold text-muted-foreground">{ceoInitial}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-muted-foreground mb-0.5">
                  {ceoLabel}
                  {entry.kind === "ceo_notice" ? (
                    <span className="ml-1.5 text-muted-foreground/60 italic">notice</span>
                  ) : null}
                </div>
                <div className="rounded-none bg-secondary px-3 py-2 text-xs leading-relaxed">
                  {entry.status === "thinking" ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {toolActivity ? toolActivity.description : "Thinking..."}
                    </span>
                  ) : entry.status === "streaming" ? (
                    <span>
                      <MarkdownContent content={entry.text} className="chat-markdown" />
                      {toolActivity ? (
                        <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {toolActivity.description}
                        </span>
                      ) : (
                        <span className="ml-1 inline-block h-3 w-1 animate-pulse rounded-none bg-accent-orange align-[-1px]" />
                      )}
                    </span>
                  ) : (
                    <MarkdownContent content={entry.text} className="chat-markdown" />
                  )}
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {timeAgo(entry.time)}
                </div>
              </div>
            </div>
          ) : (
            <div key={entry.id} className="flex justify-end">
              <div className="max-w-[80%]">
                <div className="rounded-none bg-accent-orange/10 px-3 py-2 text-xs leading-relaxed">
                  {entry.text}
                </div>
                <div className="flex items-center justify-end gap-1 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    {timeAgo(entry.time)}
                  </span>
                  {entry.status === "sending" && <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />}
                  {entry.status === "sent" && <Check className="h-2.5 w-2.5 text-accent-green" />}
                  {entry.status === "error" && <span className="text-[10px] text-accent-red">Failed</span>}
                </div>
              </div>
            </div>
          ),
        )}

        {/* Background agent thinking (from status polling, not from chat) */}
        {recentThinking && !entries.some((e) => e.status === "thinking") && (
          <div className="flex gap-2.5">
            <div className="shrink-0 h-7 w-7 rounded-none bg-secondary overflow-hidden flex items-center justify-center">
              {ceoAgent?.icon ? (
                <img src={resolveAvatarUrl(ceoAgent.icon)} alt="CEO" className="h-7 w-7 rounded-none object-cover" />
              ) : (
                <span className="text-[10px] font-semibold text-muted-foreground">{ceoInitial}</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-muted-foreground mb-0.5">
                {ceoLabel} <span className="text-muted-foreground/50 italic">background</span>
              </div>
              <div className="rounded-none bg-secondary/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <MarkdownContent content={recentThinking} className="chat-markdown" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Retry bar on error */}
      {activeChat?.status === "error" && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 border-t border-accent-red/20 bg-accent-red/5 shrink-0">
          <span className="text-xs text-accent-red">{activeChat.error || "Something went wrong."}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="inline-flex items-center gap-1 rounded-none px-2 py-1 text-xs font-medium text-accent-orange hover:bg-accent-orange/10 transition-colors"
          >
            <RotateCcw className="h-3 w-3" />
            Retry
          </button>
        </div>
      )}

      {/* Input bar at bottom */}
      <form onSubmit={handleSend} data-ceo-chat-form className="flex items-center gap-2 p-3 border-t border-border shrink-0">
        <Input
          placeholder="Send a message to the CEO..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={sending}
          className="rounded-none text-sm h-9"
        />
        <button
          type="submit"
          disabled={!message.trim() || sending}
          className="btn-primary inline-flex items-center gap-1.5 rounded-none px-3 py-2 text-xs font-bold disabled:opacity-50 disabled:pointer-events-none shrink-0"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}

function flattenHistory(history: Array<{
  id: string;
  entryType: "founder_chat" | "ceo_notice";
  founderMessage: string | null;
  ceoReply: string | null;
  status: "pending" | "complete" | "error";
  error?: string | null;
  createdAt: string;
}>, activeChat: ActiveFounderChat | null): ChatEntry[] {
  const matchingPersistedChatId = activeChat
    ? history.find((entry) => {
        if (entry.entryType !== "founder_chat") {
          return false;
        }
        const sameId = entry.id === activeChat.id;
        const samePendingMessage =
          entry.status === "pending"
          && entry.founderMessage === activeChat.founderMessage
          && Math.abs(new Date(entry.createdAt).getTime() - new Date(activeChat.createdAt).getTime()) < 5_000;
        return sameId || samePendingMessage;
      })?.id
    : null;

  const mergedHistory = history.map((entry) => {
    if (!activeChat || entry.id !== matchingPersistedChatId) {
      return entry;
    }

    return {
      ...entry,
      ceoReply: activeChat.ceoReply || entry.ceoReply,
      status: activeChat.status === "error" ? "error" : entry.status,
      error: activeChat.error || entry.error,
      createdAt: activeChat.createdAt || entry.createdAt,
    };
  });

  if (activeChat && !matchingPersistedChatId) {
    mergedHistory.push({
      id: activeChat.id,
      entryType: "founder_chat",
      founderMessage: activeChat.founderMessage,
      ceoReply: activeChat.ceoReply || null,
      status: activeChat.status === "error" ? "error" : "pending",
      error: activeChat.error || null,
      createdAt: activeChat.createdAt,
    });
  }

  return mergedHistory.flatMap((entry) => {
    const rows: ChatEntry[] = [];

    if (entry.entryType === "founder_chat" && entry.founderMessage) {
      rows.push({
        id: `${entry.id}:user`,
        role: "user",
        text: entry.founderMessage,
        time: entry.createdAt,
        kind: "founder_chat",
        status: entry.status === "pending" ? "sent" : entry.status === "error" ? "error" : "sent",
      });
    }

    if (entry.status === "pending") {
      const ageMs = Date.now() - new Date(entry.createdAt).getTime();
      const timedOut = ageMs > 90_000 && !activeChat;
      rows.push({
        id: `${entry.id}:ceo`,
        role: "ceo",
        text: timedOut
          ? "This response timed out. Try sending your message again."
          : (entry.ceoReply || ""),
        time: entry.createdAt,
        kind: entry.entryType,
        status: timedOut ? undefined : (entry.ceoReply ? "streaming" : "thinking"),
      });
      return rows;
    }

    rows.push({
      id: `${entry.id}:ceo`,
      role: "ceo",
      text: entry.status === "error"
        ? (entry.error || "I hit an error while replying.")
        : (entry.ceoReply || ""),
      time: entry.createdAt,
      kind: entry.entryType,
      status: undefined,
    });

    return rows;
  });
}
