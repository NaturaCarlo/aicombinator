"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { CreditCard, RefreshCw, XCircle } from "lucide-react";
import {
  createLaunchSession,
  generateLuckyCompanyIdea,
  getLaunchSession,
  launchCompanyFromSession,
  retryLaunchSessionTurn,
  sendLaunchSessionMessage,
  streamLaunchSession,
} from "@/lib/api";
import { useBilling } from "@/hooks/use-billing";
import type { LaunchSession, LaunchSessionMode } from "@/lib/types";
import { saveLaunchSnapshot } from "@/lib/launch-snapshot";
import { isLaunchIntent } from "@/lib/launch-intent";
import { LaunchIdeaStep } from "@/components/launch/launch-idea-step";
import { LaunchProgress } from "@/components/launch/launch-progress";
import { LaunchSessionView } from "@/components/launch/launch-session-view";
import {
  buildInitialStatus,
  EMPTY_PROVISIONING,
  type ProvisioningData,
  waitForLaunchReady,
} from "@/components/launch/launch-runtime";
import {
  clearLaunchDraft,
  clearPendingLaunch,
  loadLaunchDraft,
  loadPendingLaunch,
  saveLaunchDraft,
  savePendingLaunch,
} from "@/lib/launch-state";

type Step = "idea" | "session";

const MIN_TOKENS_TO_LAUNCH = 100;
const FALLBACK_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes absolute timeout for fallback polling

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchSessionPollDelay(session: LaunchSession | null, failures: number): number {
  const base = session?.currentTurn?.status === "processing" ? 1400 : 2200;
  const hiddenMultiplier = typeof document !== "undefined" && document.hidden ? 2 : 1;
  return Math.min(8000, (base + failures * 700) * hiddenMultiplier);
}

export function LaunchForm() {
  const [step, setStep] = useState<Step>("idea");
  const [idea, setIdea] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [mode, setMode] = useState<LaunchSessionMode>("standard");
  const [launchSession, setLaunchSession] = useState<LaunchSession | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [luckyLoading, setLuckyLoading] = useState(false);
  const [, setLaunchStage] = useState("Writing mission...");
  const [error, setError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [provisioningData, setProvisioningData] = useState<ProvisioningData>(EMPTY_PROVISIONING);
  const resumedLaunchRef = useRef(false);
  const restoredSessionRef = useRef(false);
  const launchAbortRef = useRef<AbortController | null>(null);
  const [draftSessionId, setDraftSessionId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const messageSendAbortRef = useRef<AbortController | null>(null);

  const router = useRouter();
  const { getToken, isLoaded, userId } = useAuth();
  const { data: billing } = useBilling();

  const creditBalance = billing?.credits?.balance;
  const creditsKnown = typeof creditBalance === "number";
  const hasEnoughCreditsToLaunch = creditsKnown && creditBalance >= MIN_TOKENS_TO_LAUNCH;
  const sessionProcessing = Boolean(launchSession?.processing);

  async function getTokenWithRetry(): Promise<string> {
    let token: string | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      token = await getToken();
      if (token) {
        break;
      }
      await sleep(150);
    }
    if (!token) {
      throw new Error("Could not verify your session. Refresh and try again.");
    }
    return token;
  }

  useEffect(() => {
    const draft = loadLaunchDraft();
    if (draft) {
      setCompanyName(draft.companyName);
      setIdea(draft.idea);
      setMode(draft.mode ?? "standard");
      setDraftSessionId(draft.launchSessionId ?? null);
      setStep(draft.step === "session" ? "session" : "idea");
    }
  }, []);

  useEffect(() => {
    if (!companyName && !idea && !launchSession) {
      return;
    }

    // Skip auto-save if this session already launched a company (prevents
    // re-saving the draft after clearLaunchDraft on successful launch).
    if (launchSession?.launchedCompanyId) {
      return;
    }

    saveLaunchDraft({
      companyName,
      idea,
      mode,
      launchSessionId: launchSession?.id ?? draftSessionId ?? null,
      step: loading ? "session" : step,
    });
  }, [companyName, idea, mode, step, launchSession, draftSessionId, loading]);

  useEffect(() => {
    if (!isLoaded || !userId || resumedLaunchRef.current) {
      return;
    }

    const pending = loadPendingLaunch();
    if (!pending) {
      return;
    }

    resumedLaunchRef.current = true;
    setCompanyName(pending.companyName);
    setIdea(pending.idea);
    setMode(pending.mode ?? "standard");
    setDraftSessionId(pending.launchSessionId ?? null);
    setStep("session");
    setLaunchStage("Resuming provisioning...");
    setLoading(true);
    setError(null);

    const controller = new AbortController();
    launchAbortRef.current = controller;

    const resume = async () => {
      try {
        const token = await getTokenWithRetry();
        const snapshot = await waitForLaunchReady(
          pending.companyId,
          token,
          getToken,
          setLaunchStage,
          setProvisioningData,
          undefined,
          controller.signal,
        );

        saveLaunchSnapshot({
          capturedAt: new Date().toISOString(),
          status: snapshot.status,
          agents: snapshot.agents,
          tasks: snapshot.tasks,
          documents: snapshot.documents,
          artifacts: snapshot.artifacts,
        });
        clearPendingLaunch();
        clearLaunchDraft();
        setLaunchStage("Opening your company...");
        router.replace(`/company/${pending.companyId}`);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Something went wrong";
        if (
          message.includes("failed during provisioning")
          || message.includes("waiting for tokens")
          || message.includes("waiting for credits")
        ) {
          clearPendingLaunch();
        }
        setError(message);
        setLoading(false);
      }
    };

    void resume();

    return () => {
      controller.abort();
    };
  }, [getToken, isLoaded, router, userId]);

  useEffect(() => {
    if (!isLoaded || !userId || restoredSessionRef.current || !draftSessionId || launchSession || loading) {
      return;
    }

    restoredSessionRef.current = true;
    setSessionBusy(true);
    setError(null);

    const restore = async () => {
      try {
        const token = await getTokenWithRetry();
        const session = await getLaunchSession(draftSessionId, token);

        // Safety net: if the restored session already launched, reset to idea
        // step instead of restoring a dead session.
        if (session.status === "launched" || session.launchedCompanyId) {
          clearLaunchDraft();
          setDraftSessionId(null);
          setStep("idea");
          setCompanyName("");
          setIdea("");
          setLaunchSession(null);
          return;
        }

        setLaunchSession(session);
        setSessionNotice(null);
        setStep("session");
        setCompanyName(session.suggestedName || session.inputName || "");
        setIdea(session.inputIdea);
        setMode(session.mode);
      } catch (err) {
        setDraftSessionId(null);
        const message = err instanceof Error ? err.message : "Could not restore the launch session.";
        setError(message);
      } finally {
        setSessionBusy(false);
      }
    };

    void restore();
  }, [draftSessionId, getToken, isLoaded, launchSession, loading, userId]);

  useEffect(() => {
    if (!launchSession?.id || !launchSession.processing || !isLoaded || !userId || loading) {
      return;
    }

    let cancelled = false;
    let inFallbackMode = false;
    const controller = new AbortController();
    streamAbortRef.current = controller;

    // Stall recovery: if no tokens arrive for STALL_TIMEOUT_MS while
    // streamingContent is set and processing is still true, clear
    // streamingContent and fetch fresh state. This prevents the UI from
    // getting stuck with frozen text and no options.
    const STALL_TIMEOUT_MS = 15_000;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    // Token batching: accumulate incoming tokens in a buffer and flush
    // to React state every TOKEN_FLUSH_INTERVAL_MS to reduce re-renders.
    const TOKEN_FLUSH_INTERVAL_MS = 60;
    let tokenBuffer = "";
    const flushInterval = setInterval(() => {
      if (cancelled || !tokenBuffer) return;
      const batch = tokenBuffer;
      tokenBuffer = "";
      setStreamingContent((prev) => (prev ?? "") + batch);
    }, TOKEN_FLUSH_INTERVAL_MS);

    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(async () => {
        if (inFallbackMode) return;
        if (cancelled) return;
        // Stall detected — fetch fresh state FIRST, then clear streaming content.
        // Keep existing content visible while fetching so the user never sees a blank.
        try {
          const token = await getTokenWithRetry();
          const fresh = await getLaunchSession(launchSession.id, token);
          if (cancelled || inFallbackMode) return;
          setLaunchSession(fresh);
          setStreamingContent(null);
          setSessionNotice(null);
          setDraftSessionId(fresh.id);
          setCompanyName(fresh.suggestedName || fresh.inputName || "");
          setIdea(fresh.inputIdea);
          setMode(fresh.mode);
        } catch {
          // Fetch failed — keep existing streaming content visible.
          // The fallback poll will pick up recovery.
        }
      }, STALL_TIMEOUT_MS);
    };

    const updateSessionFromStream = (session: LaunchSession) => {
      if (cancelled) return;
      if (stallTimer) clearTimeout(stallTimer);
      setLaunchSession(session);
      setStreamingContent(null);
      setSessionNotice(null);
      setDraftSessionId(session.id);
      setCompanyName(session.suggestedName || session.inputName || "");
      setIdea(session.inputIdea);
      setMode(session.mode);
    };

    const attemptStream = async (): Promise<boolean> => {
      const token = await getTokenWithRetry();
      const result = await streamLaunchSession(
        launchSession.id,
        token,
        {
          onToken: (content) => {
            if (cancelled) return;
            tokenBuffer += content;
            resetStallTimer();
          },
          onProcessing: () => {
            if (cancelled) return;
            setSessionNotice(null);
            resetStallTimer();
          },
          onDone: (session) => {
            updateSessionFromStream(session);
          },
          onError: (err) => {
            if (cancelled) return;
            setSessionNotice(err);
          },
        },
        controller.signal,
      );
      if (cancelled) return true;
      if (result.complete) return true;
      // Stream ended without done — check fresh state
      const freshToken = await getTokenWithRetry();
      const fresh = await getLaunchSession(launchSession.id, freshToken);
      if (cancelled) return true;
      updateSessionFromStream(fresh);
      return !fresh.processing;
    };

    const connectStream = async () => {
      let retries = 0;
      while (!cancelled && retries < 3) {
        try {
          const done = await attemptStream();
          if (done || cancelled) return;
        } catch {
          if (cancelled) return;
        }
        retries++;
        if (!cancelled && retries < 3) {
          await sleep(2000);
        }
      }
      // All retries exhausted — fall back to polling with periodic SSE reconnection
      if (!cancelled) await fallbackPoll();
    };

    const fallbackPoll = async () => {
      // Set flag BEFORE clearing timer to prevent race: if stall callback already
      // fired but hasn't run yet, it will self-cancel on seeing inFallbackMode.
      inFallbackMode = true;
      // Clear the stall timer to prevent concurrent stall recovery + fallback poll
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
      let failures = 0;
      let iteration = 0;
      const pollStartedAt = Date.now();
      while (!cancelled) {
        // Absolute timeout: stop polling after 5 minutes to prevent infinite loops
        if (Date.now() - pollStartedAt >= FALLBACK_POLL_TIMEOUT_MS) {
          clearInterval(flushInterval);
          setSessionNotice("The launch studio is taking longer than expected. Please try sending your message again or restart the session.");
          return;
        }
        iteration++;
        // Every 3rd iteration, try SSE reconnection instead of just GET polling
        if (iteration % 3 === 0) {
          try {
            const done = await attemptStream();
            if (done || cancelled) return;
          } catch {
            // Fall through to GET poll below
          }
          if (cancelled) return;
        }
        try {
          const token = await getTokenWithRetry();
          const session = await getLaunchSession(launchSession.id, token);
          if (cancelled) return;
          setLaunchSession(session);
          setStreamingContent(null);
          setSessionNotice(null);
          setDraftSessionId(session.id);
          setCompanyName(session.suggestedName || session.inputName || "");
          setIdea(session.inputIdea);
          setMode(session.mode);
          if (!session.processing) {
            clearInterval(flushInterval);
            return;
          }
          failures = 0;
        } catch {
          failures += 1;
          if (failures >= 3) {
            setSessionNotice("We lost contact with the launch studio for a moment. It is still retrying in the background.");
          }
        }
        await sleep(launchSessionPollDelay(launchSession, failures));
      }
    };

    // Start the stall timer when streaming begins
    resetStallTimer();
    void connectStream();

    return () => {
      cancelled = true;
      if (stallTimer) clearTimeout(stallTimer);
      clearInterval(flushInterval);
      tokenBuffer = "";
      controller.abort();
      streamAbortRef.current = null;
      messageSendAbortRef.current?.abort();
      setStreamingContent(null);
    };
  }, [getToken, isLoaded, launchSession?.id, launchSession?.processing, loading, userId]);

  const startLaunchSession = async (nextCompanyName: string, nextIdea: string, nextMode: LaunchSessionMode) => {
    if (loading || sessionBusy) return;
    setSessionBusy(true);
    setError(null);
    setSessionNotice(null);

    try {
      const token = await getTokenWithRetry();
      const session = await createLaunchSession(
        {
          companyName: nextCompanyName.trim() || undefined,
          idea: nextIdea.trim(),
          mode: nextMode,
        },
        token,
      );
      setLaunchSession(session);
      setDraftSessionId(session.id);
      setCompanyName(session.suggestedName || nextCompanyName);
      setIdea(session.inputIdea);
      setMode(session.mode);
      setStep("session");
      setChatInput("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not start the launch studio.";
      setError(message);
    } finally {
      setSessionBusy(false);
    }
  };

  const handleIdeaSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!idea.trim() || idea.trim().length < 10) return;
    void startLaunchSession(companyName, idea, mode);
  };

  const handleLuckyIdea = async () => {
    if (loading || luckyLoading || sessionBusy || sessionProcessing) return;
    setLuckyLoading(true);
    setError(null);
    setSessionNotice(null);

    try {
      const token = await getTokenWithRetry();
      const lucky = await generateLuckyCompanyIdea(token);
      setCompanyName(lucky.name);
      setIdea(lucky.idea);
      await startLaunchSession(lucky.name, lucky.idea, mode);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not generate an idea right now.";
      setError(message);
    } finally {
      setLuckyLoading(false);
    }
  };

  const handleSendLaunchMessage = async (messageOverride?: string) => {
    if (!launchSession || loading || sessionBusy || launchSession.processing) return;
    const message = (messageOverride ?? chatInput).trim();
    if (!message) return;

    const controller = new AbortController();
    const { signal } = controller;
    messageSendAbortRef.current = controller;

    setSessionBusy(true);
    setError(null);
    setSessionNotice(null);

    try {
      const token = await getTokenWithRetry();
      const session = await sendLaunchSessionMessage(launchSession.id, message, token, signal);
      if (signal.aborted) return;
      setLaunchSession(session);
      setDraftSessionId(session.id);
      setCompanyName(session.suggestedName || session.inputName || companyName);
      setIdea(session.inputIdea);
      setMode(session.mode);
      setChatInput("");
    } catch (err) {
      if (signal.aborted) return;
      const messageText = err instanceof Error ? err.message : "Could not continue the launch session.";
      setError(messageText);
    } finally {
      messageSendAbortRef.current = null;
      setSessionBusy(false);
    }
  };

  const handleRetryLaunchTurn = async () => {
    if (!launchSession || loading || sessionBusy || launchSession.processing) return;

    setSessionBusy(true);
    setError(null);
    setSessionNotice(null);

    try {
      const token = await getTokenWithRetry();
      const session = await retryLaunchSessionTurn(launchSession.id, token);
      setLaunchSession(session);
      setDraftSessionId(session.id);
      setCompanyName(session.suggestedName || session.inputName || companyName);
      setIdea(session.inputIdea);
      setMode(session.mode);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : "Could not retry the CEO turn.";
      setError(messageText);
    } finally {
      setSessionBusy(false);
    }
  };

  const handleRestartLaunchSession = async () => {
    if (loading || sessionBusy) return;
    messageSendAbortRef.current?.abort();
    const nextIdea = idea.trim();
    const nextCompanyName = (launchSession?.suggestedName || companyName).trim();
    if (!nextIdea || nextIdea.length < 10) {
      setStep("idea");
      setLaunchSession(null);
      setDraftSessionId(null);
      setChatInput("");
      setError(null);
      clearLaunchDraft();
      return;
    }

    setLaunchSession(null);
    setDraftSessionId(null);
    setChatInput("");
    setError(null);
    setSessionNotice(null);
    setStreamingContent(null);
    clearPendingLaunch();
    saveLaunchDraft({
      companyName: nextCompanyName,
      idea: nextIdea,
      mode,
      launchSessionId: null,
      step: "idea",
    });
    await startLaunchSession(nextCompanyName, nextIdea, mode);
  };

  const handleLaunch = async () => {
    if (!launchSession || loading) return;
    if (!hasEnoughCreditsToLaunch) {
      setError(`You need at least ${MIN_TOKENS_TO_LAUNCH} tokens to launch a company. Add tokens, then try again.`);
      return;
    }
    if (!launchSession.ready) {
      setError("Keep shaping the company with the CEO until the brief is launch-ready.");
      return;
    }

    setLoading(true);
    setError(null);
    setSessionNotice(null);

    try {
      if (!isLoaded || !userId) {
        throw new Error("Still loading your account. Try again in a moment.");
      }

      const token = await getTokenWithRetry();
      setLaunchStage("Provisioning your company...");
      const result = await launchCompanyFromSession(launchSession.id, token);

      savePendingLaunch({
        companyId: result.id,
        companyName: launchSession.suggestedName || companyName.trim(),
        idea: idea.trim(),
        mode,
        launchSessionId: launchSession.id,
        step: "provisioning",
        createdAt: new Date().toISOString(),
      });

      const controller = new AbortController();
      launchAbortRef.current = controller;

      const readySnapshot = await waitForLaunchReady(
        result.id,
        token,
        getToken,
        setLaunchStage,
        setProvisioningData,
        buildInitialStatus(result),
        controller.signal,
      );

      saveLaunchSnapshot({
        capturedAt: new Date().toISOString(),
        status: readySnapshot.status,
        agents: readySnapshot.agents,
        tasks: readySnapshot.tasks,
        documents: readySnapshot.documents,
        artifacts: readySnapshot.artifacts,
      });
      clearPendingLaunch();
      clearLaunchDraft();

      // Clear component state so the auto-save useEffect won't re-save the
      // draft when setLoading(false) fires in the finally block.
      setCompanyName("");
      setIdea("");
      setLaunchSession(null);
      setDraftSessionId(null);

      setLaunchStage("Opening your company...");
      router.replace(`/company/${result.id}`);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Something went wrong";
      if (
        message.includes("failed during provisioning")
        || message.includes("waiting for tokens")
        || message.includes("waiting for credits")
      ) {
        clearPendingLaunch();
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 lg:px-8 lg:py-8 fade-in-up">
        <LaunchProgress companyName={companyName} data={provisioningData} />

        {error && (
          <div className="rounded-none bg-red-50 px-4 py-3 dark:bg-red-950/50">
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <XCircle className="h-4 w-4 shrink-0" />
              <span className="flex-1">{error}</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              {error.includes("Refresh") && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1.5 rounded-none border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-700 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900"
                >
                  <RefreshCw className="h-3 w-3" />
                  Refresh
                </button>
              )}
              {(error.toLowerCase().includes("token") || error.toLowerCase().includes("credit")) && (
                <Link
                  href="/billing"
                  className="inline-flex items-center gap-1.5 rounded-none border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-700 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900"
                >
                  <CreditCard className="h-3 w-3" />
                  Add Tokens
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (step === "session" && launchSession) {
    return (
      <LaunchSessionView
        session={launchSession}
        creditsKnown={creditsKnown}
        hasEnoughCreditsToLaunch={hasEnoughCreditsToLaunch}
        creditBalance={creditBalance}
        sessionBusy={sessionBusy}
        loading={loading}
        chatInput={chatInput}
        setChatInput={setChatInput}
        streamingContent={streamingContent}
        onBack={() => {
          messageSendAbortRef.current?.abort();
          setStep("idea");
          setLaunchSession(null);
          setDraftSessionId(null);
          setChatInput("");
          setError(null);
          setSessionNotice(null);
          setStreamingContent(null);
        }}
        onRestart={() => void handleRestartLaunchSession()}
        onOption={(reply) => {
          if (isLaunchIntent(reply) && launchSession?.ready) {
            void handleLaunch();
          } else {
            setChatInput(reply);
            void handleSendLaunchMessage(reply);
          }
        }}
        onSend={() => void handleSendLaunchMessage()}
        onRetry={() => void handleRetryLaunchTurn()}
        onLaunch={handleLaunch}
        error={error ?? sessionNotice}
      />
    );
  }

  return (
    <LaunchIdeaStep
      companyName={companyName}
      idea={idea}
      mode={mode}
      creditBalance={creditBalance}
      error={error}
      loading={loading}
      luckyLoading={luckyLoading}
      sessionBusy={sessionBusy}
      onCompanyNameChange={(value) => {
        setCompanyName(value);
        if (error) setError(null);
        if (sessionNotice) setSessionNotice(null);
      }}
      onIdeaChange={(value) => {
        setIdea(value);
        if (error) setError(null);
        if (sessionNotice) setSessionNotice(null);
      }}
      onModeChange={setMode}
      onSubmit={handleIdeaSubmit}
      onLuckyIdea={() => void handleLuckyIdea()}
    />
  );
}
