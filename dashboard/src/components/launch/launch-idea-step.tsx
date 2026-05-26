"use client";

import { ArrowRight, Brain, Loader2, Sparkles, XCircle } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { LaunchSessionMode } from "@/lib/types";

type LaunchIdeaStepProps = {
  companyName: string;
  idea: string;
  mode: LaunchSessionMode;
  creditBalance: number | undefined;
  error: string | null;
  loading: boolean;
  luckyLoading: boolean;
  sessionBusy: boolean;
  onCompanyNameChange: (value: string) => void;
  onIdeaChange: (value: string) => void;
  onModeChange: (mode: LaunchSessionMode) => void;
  onSubmit: (event: React.FormEvent) => void;
  onLuckyIdea: () => void;
};

export function LaunchIdeaStep({
  companyName,
  idea,
  mode,
  creditBalance,
  error,
  loading,
  luckyLoading,
  sessionBusy,
  onCompanyNameChange,
  onIdeaChange,
  onModeChange,
  onSubmit,
  onLuckyIdea,
}: LaunchIdeaStepProps) {
  return (
    <form onSubmit={onSubmit} className="mx-auto flex h-full max-w-5xl flex-col overflow-y-auto xl:overflow-hidden px-4 py-3 lg:px-8 lg:py-4 fade-in-up">
      <div className="flex flex-col items-center text-center">
        <div className="mb-1.5 inline-flex items-center gap-2 rounded-none border border-accent-orange/20 bg-accent-orange/10 px-3 py-1.5">
          <Brain className="h-3.5 w-3.5 text-accent-orange" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-orange">
            CEO Cofounder Mode
          </span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          Design the company before you press launch
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The CEO shapes a vague idea into an operating brief: sharper wedge, concrete first buyer, autonomy boundaries, and a plan the team can run from.
        </p>
      </div>

      <div className="mt-4 grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(300px,0.95fr)]">
        <div className="min-w-0 space-y-4">
          <div className="card-clean overflow-hidden">
            <input
              type="text"
              placeholder="Company name (optional for now)"
              value={companyName}
              onChange={(e) => onCompanyNameChange(e.target.value)}
              className="w-full border-0 border-b border-border bg-transparent px-5 py-3 text-base font-medium focus:outline-none focus:ring-0 placeholder:text-muted-foreground/50"
            />
            <Textarea
              placeholder="Describe the company in one or two plain-language sentences. The CEO will sharpen it with you. Example: 'An AI permit desk for small construction contractors that assembles permit packets and tracks approval deadlines.'"
              value={idea}
              onChange={(e) => onIdeaChange(e.target.value)}
              rows={4}
              className="resize-none border-0 bg-transparent p-5 text-base leading-7 shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-end border-t border-border/40 px-5 py-1.5">
              <span className={`text-xs tabular-nums ${idea.trim().length < 10 ? "text-muted-foreground/50" : "text-muted-foreground"}`}>
                {idea.length} character{idea.length !== 1 ? "s" : ""}
                {idea.trim().length > 0 && idea.trim().length < 10 && (
                  <span className="ml-1 text-rose-400">· min 10</span>
                )}
              </span>
            </div>
          </div>

          <div className="card-clean p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent-orange">
              How much shaping do you want?
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {([
                {
                  value: "quick",
                  label: "Quick",
                  detail: "2–3 turns. Idea already sharp — the CEO confirms and ships.",
                },
                {
                  value: "standard",
                  label: "Standard",
                  detail: "5–7 turns. Stress-tests wedge, buyer, distribution. Best for most.",
                },
                {
                  value: "deep",
                  label: "Deep",
                  detail: "8–12 turns. Edge cases, moats, pricing. For complex ideas.",
                },
              ] as Array<{ value: LaunchSessionMode; label: string; detail: string }>).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onModeChange(option.value)}
                  className={`rounded-none border p-3 text-left transition-colors ${
                    mode === option.value
                      ? "border-accent-orange/40 bg-accent-orange/[0.08]"
                      : "border-border/70 bg-secondary/20 hover:bg-secondary/35"
                  }`}
                >
                  <p className="text-sm font-semibold">{option.label}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{option.detail}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="card-clean space-y-3 p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-accent-orange">
                What the CEO will produce before launch
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                A founder-worthy package the team can run from.
              </p>
            </div>
            <div className="space-y-2 text-sm text-foreground/90">
              <div className="rounded-none border border-border/70 bg-secondary/20 px-3 py-2.5">
                <p className="font-semibold">Detailed company spec</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">Customer, wedge, offer, model, constraints, autonomy boundaries.</p>
              </div>
              <div className="rounded-none border border-border/70 bg-secondary/20 px-3 py-2.5">
                <p className="font-semibold">Mission manifesto</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">A real mission doc, not a thin slogan or placeholder blurb.</p>
              </div>
              <div className="rounded-none border border-border/70 bg-secondary/20 px-3 py-2.5">
                <p className="font-semibold">Autonomy contract</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">What the team can decide alone vs. what needs the founder.</p>
              </div>
            </div>
          </div>

          <div className="card-clean space-y-3 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-accent-orange">
                  Tokens
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Shape the company first, fund launch when ready.
                </p>
              </div>
              <span className="text-lg font-semibold">
                {creditBalance !== undefined
                  ? creditBalance >= 1_000_000
                    ? `${(creditBalance / 1_000_000).toFixed(1)}M tokens`
                    : `${creditBalance.toLocaleString()} tokens`
                  : "--"}
              </span>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-none bg-red-50 px-4 py-2.5 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
                <XCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="submit"
                className="btn-primary flex w-full items-center justify-center gap-2 rounded-none py-3 text-sm font-bold disabled:pointer-events-none disabled:opacity-50"
                disabled={!idea.trim() || idea.trim().length < 10 || luckyLoading || sessionBusy}
              >
                {sessionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Start with the CEO
              </button>

              <button
                type="button"
                onClick={onLuckyIdea}
                className="flex w-full items-center justify-center gap-2 rounded-none border border-accent-orange/30 bg-accent-orange/10 px-4 py-3 text-sm font-semibold text-accent-orange transition-colors hover:bg-accent-orange/15 disabled:pointer-events-none disabled:opacity-60"
                disabled={loading || luckyLoading || sessionBusy}
              >
                {luckyLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    I&apos;m Feeling Lucky
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
