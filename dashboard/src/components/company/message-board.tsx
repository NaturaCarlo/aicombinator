"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { Send, Check, Loader2, MessageSquare } from "lucide-react";
import { chatWithCeo, resolveAvatarUrl } from "@/lib/api";
import { Input } from "@/components/ui/input";
import type { CompanyStatus, Agent } from "@/lib/types";

interface ChatEntry {
  id: string;
  role: "user" | "ceo";
  text: string;
  time: string;
  status?: "sending" | "sent" | "error" | "thinking";
}

const STORAGE_KEY = (id: string) => `automaton_chat_${id}`;

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

export function MessageBoard({
  companyId,
  status,
  ceoAgent,
}: {
  companyId: string;
  status: CompanyStatus | undefined;
  ceoAgent: Agent | undefined;
}) {
  const { getToken } = useAuth();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load persisted chat from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY(companyId));
      if (stored) {
        const parsed = JSON.parse(stored) as ChatEntry[];
        // Only keep messages from last 24h, exclude "thinking" status
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const recent = parsed.filter(
          (m) => new Date(m.time).getTime() > cutoff && m.status !== "thinking",
        );
        setEntries(recent);
      }
    } catch {}
  }, [companyId]);

  // Persist chat
  useEffect(() => {
    if (entries.length > 0) {
      // Don't persist "thinking" entries
      const toStore = entries.filter((e) => e.status !== "thinking");
      localStorage.setItem(STORAGE_KEY(companyId), JSON.stringify(toStore));
    }
  }, [entries, companyId]);

  // Auto-scroll on new entries
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || sending) return;

    const userMsgId = `msg_${Date.now()}`;
    const ceoReplyId = `ceo_${Date.now()}`;
    const userText = message.trim();

    // Add user message + CEO thinking placeholder
    const userEntry: ChatEntry = {
      id: userMsgId,
      role: "user",
      text: userText,
      time: new Date().toISOString(),
      status: "sending",
    };

    const thinkingEntry: ChatEntry = {
      id: ceoReplyId,
      role: "ceo",
      text: "",
      time: new Date().toISOString(),
      status: "thinking",
    };

    setEntries((prev) => [...prev, userEntry, thinkingEntry]);
    setMessage("");
    setSending(true);

    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");

      const reply = await chatWithCeo(companyId, userText, token);

      setEntries((prev) =>
        prev.map((e) => {
          if (e.id === userMsgId) return { ...e, status: "sent" as const };
          if (e.id === ceoReplyId) return { ...e, text: reply, status: undefined };
          return e;
        }),
      );
    } catch {
      setEntries((prev) =>
        prev
          .filter((e) => e.id !== ceoReplyId) // remove thinking placeholder
          .map((e) => (e.id === userMsgId ? { ...e, status: "error" as const } : e)),
      );
    } finally {
      setSending(false);
    }
  }

  const recentThinking = status?.recentThinking;
  const hasContent = entries.length > 0 || recentThinking;

  return (
    <div className="card-clean overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <MessageSquare className="h-3.5 w-3.5 text-accent-orange" />
        <span className="section-label">
          Board
        </span>
      </div>

      {/* Message thread — fixed height, always visible, scrollable */}
      <div ref={scrollRef} className="h-64 overflow-y-auto p-4 space-y-3">
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
                  <span className="text-[10px] font-semibold text-muted-foreground">A</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-muted-foreground mb-0.5">
                  {ceoAgent?.name || "Agent"}
                </div>
                <div className="rounded-none bg-secondary px-3 py-2 text-xs leading-relaxed">
                  {entry.status === "thinking" ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Thinking...
                    </span>
                  ) : (
                    entry.text
                  )}
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
                <span className="text-[10px] font-semibold text-muted-foreground">A</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-muted-foreground mb-0.5">
                {ceoAgent?.name || "Agent"} <span className="text-muted-foreground/50 italic">background</span>
              </div>
              <div className="rounded-none bg-secondary/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                {recentThinking}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="flex items-center gap-2 p-3 border-t border-border">
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
