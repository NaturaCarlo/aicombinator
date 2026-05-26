"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CreditCard,
  Loader2,
  RefreshCw,
  Rocket,
  Sparkles,
  XCircle,
} from "lucide-react";
import { MarkdownContent } from "@/components/company/markdown-content";
import type { LaunchSession, LaunchSessionMessage } from "@/lib/types";

function formatLaunchTurnDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== "number" || durationMs <= 0) {
    return null;
  }
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
  }
  return `${durationMs}ms`;
}

function formatLaunchTurnProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  if (provider === "anthropic") return "Anthropic direct";
  if (provider === "openrouter") return "OpenRouter";
  return provider;
}

function formatLaunchAttemptOutcome(outcome: "success" | "non_ok" | "invalid_payload" | "error"): string {
  switch (outcome) {
    case "success":
      return "ok";
    case "non_ok":
      return "http error";
    case "invalid_payload":
      return "bad payload";
    case "error":
      return "request error";
    default:
      return outcome;
  }
}

function LaunchBlueprintPanel({ session, displayName }: { session: LaunchSession; displayName: string }) {
  return (
    <div className="space-y-4">
      <div className="rounded-none border border-border/70 bg-secondary/20 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-orange">
          Current thesis
        </p>
        <h2 className="mt-3 text-lg font-semibold">{displayName}</h2>
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">First buyer</p>
            <p className="mt-1 leading-6 text-foreground/90">{session.brief.targetCustomer || "Still being sharpened"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Painful problem</p>
            <p className="mt-1 leading-6 text-foreground/90">{session.brief.painfulProblem || "Still being sharpened"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">First offer</p>
            <p className="mt-1 leading-6 text-foreground/90">{session.brief.firstOffer || "Still being sharpened"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Distribution wedge</p>
            <p className="mt-1 leading-6 text-foreground/90">{session.brief.distributionWedge || "Still being sharpened"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">First milestone</p>
            <p className="mt-1 leading-6 text-foreground/90">{session.brief.firstMilestone || "Still being sharpened"}</p>
          </div>
        </div>
      </div>

      <div className="rounded-none border border-border/70 bg-background/80 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-orange">
            Readiness
          </p>
          <span className="rounded-none bg-accent-orange/10 px-3 py-1.5 text-base font-bold text-accent-orange">
            {session.readiness.score}%
          </span>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">What is already strong</p>
            <ul className="mt-2 space-y-2 text-sm text-foreground/85">
              {session.readiness.strengths.length > 0 ? session.readiness.strengths.map((strength) => (
                <li key={strength} className="leading-6">• {strength}</li>
              )) : <li className="leading-6 text-muted-foreground">No strong edges locked yet.</li>}
            </ul>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">What still needs founder input</p>
            <ul className="mt-2 space-y-2 text-sm text-foreground/85">
              {session.readiness.blockers.length > 0 ? session.readiness.blockers.map((blocker) => (
                <li key={blocker} className="leading-6">• {blocker}</li>
              )) : <li className="leading-6 text-emerald-400">No blockers left. This is launch-ready.</li>}
            </ul>
          </div>
        </div>
      </div>

      <div className="rounded-none border border-border/70 bg-background/80 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-orange">
          Autonomy shape
        </p>
        <div className="mt-3 space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Autonomy confidence</span>
            <span className="font-semibold">{session.brief.autonomyConfidence}%</span>
          </div>
          {session.brief.founderSetupTasks.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Founder setup later</p>
              <ul className="mt-2 space-y-2 text-foreground/85">
                {session.brief.founderSetupTasks.slice(0, 3).map((task) => (
                  <li key={task} className="leading-6">• {task}</li>
                ))}
              </ul>
            </div>
          )}
          {session.readiness.nextBestQuestion && (
            <div className="rounded-none border border-accent-orange/20 bg-accent-orange/[0.05] p-3 text-foreground/90">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-orange">Next best decision</p>
              <p className="mt-1 leading-6">{session.readiness.nextBestQuestion}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GeneratingOptionsCard({ elapsedSeconds }: { elapsedSeconds: number }) {
  return (
    <div className="space-y-3 rounded-none border border-accent-orange/25 bg-gradient-to-br from-accent-orange/[0.10] via-background to-secondary/20 px-5 py-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-none border border-accent-orange/25 bg-accent-orange/10 text-accent-orange">
          <Sparkles className="h-4 w-4 animate-pulse" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-semibold text-foreground">Generating your next choices</p>
            {elapsedSeconds > 0 && (
              <span className="text-[11px] font-medium text-muted-foreground">{elapsedSeconds}s</span>
            )}
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            The CEO is preparing reply options. Wait for the buttons below before continuing.
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="min-h-[64px] rounded-none border border-border/70 bg-background/70 px-4 py-3"
          >
            <div className="h-3 w-3/4 animate-pulse rounded-none bg-accent-orange/20" />
            <div className="mt-2 h-2.5 w-full animate-pulse rounded-none bg-secondary" />
            <div className="mt-1.5 h-2.5 w-2/3 animate-pulse rounded-none bg-secondary" />
          </div>
        ))}
      </div>
    </div>
  );
}

type LaunchSessionViewProps = {
  session: LaunchSession;
  creditsKnown: boolean;
  hasEnoughCreditsToLaunch: boolean;
  creditBalance: number | undefined;
  sessionBusy: boolean;
  loading: boolean;
  chatInput: string;
  setChatInput: (value: string) => void;
  streamingContent?: string | null;
  onBack: () => void;
  onRestart: () => void;
  onOption: (reply: string) => void;
  onSend: () => void;
  onRetry: () => void;
  onLaunch: () => void;
  error: string | null;
};

export function LaunchSessionView({
  session,
  creditsKnown,
  hasEnoughCreditsToLaunch,
  creditBalance,
  sessionBusy,
  loading,
  chatInput,
  setChatInput,
  streamingContent,
  onBack,
  onRestart,
  onOption,
  onSend,
  onRetry,
  onLaunch,
  error,
}: LaunchSessionViewProps) {
  const displayName = session.suggestedName || session.inputName || "Untitled company";
  const processing = session.processing;
  const currentTurn = session.currentTurn;
  const currentTurnProvider = formatLaunchTurnProvider(currentTurn?.provider);
  const currentTurnDuration = formatLaunchTurnDuration(currentTurn?.durationMs);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const lastScrollTimeRef = useRef(0);
  const SCROLL_THROTTLE_MS = 300;
  // Filter out empty pending/streaming assistant messages to prevent double CEO bubble.
  // toResponse() includes in-progress assistant messages with content="" and streaming:true.
  // Without filtering, these render as an empty bubble AND streamingContent renders another bubble.
  const visibleMessages = session.messages.filter(
    (m) => !(m.role === "assistant" && (m.pending || m.streaming) && (!m.content || !m.content.trim()))
  );
  const hasAssistantReply = session.messages.some((message) => message.role === "assistant");
  const optionClickGuardTime = useRef(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const processingStartRef = useRef<number | null>(null);
  const generatingOptions = processing && !streamingContent;

  // Track elapsed time while processing
  useEffect(() => {
    if (!processing) {
      processingStartRef.current = null;
      return;
    }
    processingStartRef.current = Date.now();
    const interval = setInterval(() => {
      if (processingStartRef.current) {
        setElapsedSeconds(Math.floor((Date.now() - processingStartRef.current) / 1000));
      }
    }, 1000);
    return () => {
      clearInterval(interval);
      setElapsedSeconds(0);
    };
  }, [processing]);

  // Scroll disengagement: detect when user manually scrolls up
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const isNearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 60;
    userScrolledUpRef.current = !isNearBottom;
  }, []);

  // Auto-scroll on new messages (non-streaming) — always scroll to bottom
  useEffect(() => {
    userScrolledUpRef.current = false;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.messages.length]);

  // Throttled auto-scroll during streaming: triggers on streamingContent
  // changes but only scrolls at most every SCROLL_THROTTLE_MS to avoid jank.
  useEffect(() => {
    if (!streamingContent || userScrolledUpRef.current) return;
    const now = Date.now();
    if (now - lastScrollTimeRef.current < SCROLL_THROTTLE_MS) return;
    lastScrollTimeRef.current = now;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [streamingContent]);

  const handleOptionClick = useCallback((reply: string) => {
    const now = Date.now();
    if (now - optionClickGuardTime.current < 200 || sessionBusy || loading || processing) return;
    optionClickGuardTime.current = now;
    onOption(reply);
  }, [sessionBusy, loading, processing, onOption]);

  const optionsDisabled = sessionBusy || loading || processing;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (chatInput.trim() && !sessionBusy && !loading && !processing) {
        onSend();
      }
    }
  };

  return (
    <div className="fade-in-up flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onBack}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{displayName}</h1>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <span className="rounded-none bg-accent-orange/10 px-3 py-1.5 text-sm font-bold text-accent-orange">
              {session.readiness.score}%
            </span>
            {session.readiness.blockers.length > 0 && (
              <span className="rounded-none bg-secondary px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                {session.readiness.blockers.length} blocker{session.readiness.blockers.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(sessionBusy || processing) && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-orange">
              {streamingContent ? (
                <span className="inline-block h-2 w-2 rounded-none bg-accent-orange animate-pulse" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              <span className="hidden sm:inline">
                {streamingContent
                  ? "CEO is streaming"
                  : processing
                    ? `Generating options${elapsedSeconds > 0 ? `... ${elapsedSeconds}s` : "..."}`
                    : "Thinking..."}
              </span>
            </span>
          )}
          <button
            type="button"
            onClick={onRestart}
            disabled={sessionBusy || loading}
            className="inline-flex items-center gap-1.5 rounded-none border border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Sparkles className="h-3 w-3" />
            Start over
          </button>
        </div>
      </div>

      <div className="h-[4px] w-full bg-secondary/60">
        <div
          className="progress-bar h-full transition-all duration-700 ease-out"
          style={{ width: `${session.readiness.score}%` }}
        />
      </div>
      <div className="flex items-center justify-between border-b border-border/40 bg-secondary/10 px-4 py-1.5 text-xs sm:px-6">
        <span className="font-medium text-foreground/70">
          {session.readiness.score}% ready
          {session.readiness.blockers.length > 0 && (
            <span className="ml-2 text-muted-foreground">
              · {session.readiness.blockers.length} blocker{session.readiness.blockers.length !== 1 ? "s" : ""} remaining
            </span>
          )}
          {session.readiness.blockers.length === 0 && session.readiness.score >= 80 && (
            <span className="ml-2 text-emerald-400">· Launch-ready</span>
          )}
        </span>
        {session.readiness.score > 70 && session.readiness.score < 100 && !session.ready && (
          <span className="font-semibold text-accent-orange">Nearly ready</span>
        )}
      </div>

      {currentTurn && (
        <div className="border-b border-border/60 bg-secondary/10 px-4 py-2 text-xs text-muted-foreground sm:px-6">
          <div className="mx-auto max-w-5xl space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-medium text-foreground/80">
              {currentTurn.status === "processing"
                ? "CEO is actively shaping the brief"
                : currentTurn.status === "pending"
                  ? "CEO turn is queued"
                  : currentTurn.status === "error"
                    ? "The last CEO turn failed"
                    : "Last CEO turn completed"}
            </span>
            {currentTurnProvider && <span>{currentTurnProvider}</span>}
            {currentTurnDuration && <span>{currentTurnDuration}</span>}
            {currentTurn.attempts > 0 && <span>{currentTurn.attempts} attempt{currentTurn.attempts === 1 ? "" : "s"}</span>}
            {currentTurn.status === "error" && currentTurn.lastError && (
              <span className="text-rose-400">{currentTurn.lastError}</span>
            )}
            {currentTurn.status === "error" && (
              <button
                type="button"
                onClick={onRetry}
                disabled={sessionBusy || loading || processing}
                className="inline-flex items-center gap-1.5 rounded-none border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-500/15 disabled:pointer-events-none disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" />
                Retry turn
              </button>
            )}
            </div>
            {currentTurn.attemptHistory.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {currentTurn.attemptHistory.slice(-3).map((attempt, index) => {
                  const provider = formatLaunchTurnProvider(attempt.provider) ?? attempt.provider;
                  const duration = formatLaunchTurnDuration(attempt.durationMs);
                  return (
                    <span
                      key={`${attempt.provider}-${attempt.model ?? "model"}-${index}-${attempt.durationMs}`}
                      className="rounded-none border border-border/70 bg-background/70 px-2.5 py-1 text-[11px]"
                      title={attempt.error ?? undefined}
                    >
                      {provider} · {formatLaunchAttemptOutcome(attempt.outcome)}
                      {duration ? ` · ${duration}` : ""}
                      {attempt.statusCode ? ` · ${attempt.statusCode}` : ""}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid h-full min-h-0 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div ref={scrollContainerRef} onScroll={handleScroll} className="min-h-0 overflow-y-auto border-b border-border/50 lg:border-b-0 lg:border-r lg:border-border/50">
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
              {currentTurn?.status === "error" && !hasAssistantReply && (
                <div className="space-y-3 rounded-none border border-rose-500/30 bg-rose-950/40 px-5 py-5">
                  <div className="flex items-center gap-2 text-sm font-semibold text-rose-300">
                    <XCircle className="h-4 w-4 text-rose-400" />
                    The CEO could not complete this turn
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Your brief is still intact. You can retry the turn, restart the session, or type a new direction below.
                  </p>
                  <button
                    type="button"
                    onClick={onRetry}
                    disabled={sessionBusy || loading || processing}
                    className="inline-flex items-center gap-1.5 rounded-none border border-rose-500/40 bg-rose-500/15 px-4 py-2 text-sm font-bold text-rose-200 transition-colors hover:bg-rose-500/25 disabled:pointer-events-none disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry turn
                  </button>
                </div>
              )}

              {visibleMessages.map((message: LaunchSessionMessage) => (
                <div key={message.id}>
                  {message.role === "assistant" ? (
                    <div className="space-y-1">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-orange/90">
                        CEO
                      </div>
                      <div className="rounded-none border border-border/70 bg-background/90 px-4 py-3 text-sm leading-7 text-foreground/95 shadow-sm">
                        <MarkdownContent content={message.content} className="chat-markdown" />
                      </div>
                      {message.options.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {message.options.map((option) => (
                            <button
                              key={`${message.id}-${option.title}`}
                              type="button"
                              onClick={() => handleOptionClick(option.founderReply || option.title)}
                              className="min-h-[44px] rounded-none border border-accent-orange/20 bg-accent-orange/[0.05] px-5 py-3 text-left transition-colors hover:bg-accent-orange/[0.1] disabled:pointer-events-none disabled:opacity-50"
                              disabled={optionsDisabled}
                              title={optionsDisabled && processing ? "Processing" : undefined}
                            >
                              <p className="text-sm font-medium">{option.title}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">{option.description}</p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex justify-end">
                      <div className="max-w-[85%]">
                        <div className="mb-2 text-right text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                          You
                        </div>
                        <div className={`rounded-none px-4 py-3 text-sm leading-7 ${message.error ? "border border-rose-500/30 bg-rose-500/10" : "bg-accent-orange/10"}`}>
                          <div className="whitespace-pre-wrap">{message.content}</div>
                        </div>
                        {message.error && (
                          <div className="mt-1.5 flex items-center justify-end gap-2">
                            <span className="text-[11px] font-medium text-rose-400">Failed to send</span>
                            <button
                              type="button"
                              onClick={onRetry}
                              disabled={sessionBusy || loading || processing}
                              className="inline-flex items-center gap-1 rounded-none border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-300 transition-colors hover:bg-rose-500/15 disabled:pointer-events-none disabled:opacity-50"
                            >
                              <RefreshCw className="h-2.5 w-2.5" />
                              Retry
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {generatingOptions && (
                <GeneratingOptionsCard elapsedSeconds={elapsedSeconds} />
              )}

              {streamingContent && (
                <div className="space-y-1">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-orange/90">
                    CEO
                  </div>
                  <div className="rounded-none border border-accent-orange/20 bg-background/90 px-4 py-3 text-sm leading-7 text-foreground/95 shadow-sm">
                    <MarkdownContent content={streamingContent} className="chat-markdown" />
                    {processing && (
                      <span className="streaming-cursor inline-block h-[1.1em] w-[2px] bg-accent-orange align-middle" />
                    )}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />

              <div className="lg:hidden">
                <LaunchBlueprintPanel session={session} displayName={displayName} />
              </div>
            </div>
          </div>

          <aside className="hidden min-h-0 overflow-y-auto lg:block">
            <div className="space-y-4 p-5">
              <LaunchBlueprintPanel session={session} displayName={displayName} />
            </div>
          </aside>
        </div>
      </div>

      <div className="border-t border-border/60 bg-background/95 backdrop-blur">
        {error && (
          <div className="mx-auto max-w-3xl px-4 pt-3 sm:px-6">
            <div className="flex items-start gap-2.5 rounded-none border border-rose-500/30 bg-rose-950/50 px-4 py-3 text-sm text-rose-300">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <div className="flex-1">
                <p>{error}</p>
                {currentTurn?.status === "error" && (
                  <button
                    type="button"
                    onClick={onRetry}
                    disabled={sessionBusy || loading || processing}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-none border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-bold text-rose-200 transition-colors hover:bg-rose-500/25 disabled:pointer-events-none disabled:opacity-50"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry turn
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        <div className="mx-auto max-w-3xl px-4 py-3 sm:px-6">
          <div className="relative flex items-end gap-2 rounded-none border border-border/80 bg-secondary/20 px-4 py-3">
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={processing}
              rows={1}
              placeholder={
                processing
                  ? "Waiting for CEO options..."
                  : (session.readiness.nextBestQuestion || "Shape the company with the CEO...")
              }
              className="min-h-[24px] max-h-[120px] flex-1 resize-none bg-transparent text-sm leading-6 text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:cursor-wait disabled:text-muted-foreground"
              style={{ height: "auto", overflow: "hidden" }}
              onInput={(event) => {
                const target = event.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
              }}
            />
            <button
              type="button"
              onClick={onSend}
              disabled={sessionBusy || loading || processing || !chatInput.trim()}
              className="shrink-0 rounded-none bg-accent-orange p-2 text-white transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground/60">
              {processing ? "The CEO is generating selectable options. You can continue when they appear." : "Enter to send, Shift+Enter for new line"}
            </p>
            <div className="flex items-center gap-2">
              {creditBalance !== undefined && (
                <span className="text-[11px] text-muted-foreground/60">
                  {creditBalance >= 1_000_000
                    ? `${(creditBalance / 1_000_000).toFixed(1)}M tokens`
                    : `${creditBalance.toLocaleString()} tokens`}
                </span>
              )}
              {session.ready && (
                !creditsKnown ? (
                  <button
                    className="btn-primary inline-flex items-center gap-1.5 rounded-none px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    disabled
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                  </button>
                ) : hasEnoughCreditsToLaunch ? (
                  <button
                    className="launch-ready-btn btn-primary inline-flex items-center gap-2 rounded-none px-5 py-2.5 text-sm font-bold disabled:pointer-events-none disabled:opacity-40"
                    onClick={onLaunch}
                    disabled={loading || sessionBusy || processing}
                  >
                    {(loading || sessionBusy || processing) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                    Launch Company
                  </button>
                ) : (
                  <Link
                    href="/billing"
                    className="btn-primary inline-flex items-center gap-1.5 rounded-none px-4 py-2 text-sm font-bold"
                  >
                    <CreditCard className="h-3.5 w-3.5" />
                    Add Tokens to Launch
                  </Link>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
