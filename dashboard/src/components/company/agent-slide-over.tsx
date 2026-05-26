"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { AnimatePresence, motion } from "motion/react";
import {
  X,
  Save,
  Loader2,
  Clock,
  Coins,
  Zap,
  Check,
  ToggleLeft,
  ToggleRight,
  Brain,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { resolveAvatarUrl, updateAgent, pauseAgent, resumeAgent, fetchBlueprintPrompt } from "@/lib/api";
import type { FounderVisibleAgent, CompanyStatus } from "@/lib/types";

// ─── Adapter type options ────────────────────────────────────────

const ADAPTER_TYPE_OPTIONS = [
  { value: "claude-code", label: "Claude Code" },
  { value: "http-webhook", label: "HTTP Webhook" },
  { value: "bash", label: "Bash Script" },
  { value: "codex", label: "Codex" },
] as const;

// ─── LLM Model options (15 models, grouped by provider) ─────────

const LLM_MODEL_GROUPS = [
  {
    provider: "Anthropic",
    models: [
      { value: "haiku-4-5", label: "Haiku 4.5", multiplier: "0.4x" },
      { value: "sonnet-4-5", label: "Sonnet 4.5", multiplier: "1.2x" },
      { value: "sonnet-4-6", label: "Sonnet 4.6", multiplier: "1.2x" },
      { value: "opus-4-5", label: "Opus 4.5", multiplier: "2.0x" },
      { value: "opus-4-6", label: "Opus 4.6", multiplier: "2.0x" },
    ],
  },
  {
    provider: "OpenAI",
    models: [
      { value: "gpt-5.2", label: "GPT-5.2", multiplier: "0.7x" },
      { value: "gpt-5.2-codex", label: "GPT-5.2-Codex", multiplier: "0.7x" },
      { value: "gpt-5.3-codex", label: "GPT-5.3-Codex", multiplier: "0.7x" },
      { value: "gpt-5.4", label: "GPT-5.4", multiplier: "1.0x" },
    ],
  },
  {
    provider: "Google",
    models: [
      { value: "gemini-3-flash", label: "Gemini 3 Flash", multiplier: "0.2x" },
      { value: "gemini-3.1-pro", label: "Gemini 3.1 Pro", multiplier: "0.8x" },
    ],
  },
  {
    provider: "Z.ai",
    models: [
      { value: "glm-4.7", label: "GLM-4.7", multiplier: "0.25x" },
      { value: "glm-5", label: "GLM-5", multiplier: "0.4x" },
    ],
  },
  {
    provider: "MoonshotAI",
    models: [
      { value: "kimi-k2.5", label: "Kimi K2.5", multiplier: "0.25x" },
    ],
  },
  {
    provider: "MiniMax",
    models: [
      { value: "minimax-m2.5", label: "MiniMax M2.5", multiplier: "0.12x" },
    ],
  },
] as const;

/** Maximum system prompt length — must match worker MAX_SYSTEM_PROMPT_LENGTH */
const MAX_SYSTEM_PROMPT_LENGTH = 50_000;

/** Flat lookup of multiplier by model tier value */
const MODEL_MULTIPLIER_MAP: Record<string, string> = Object.fromEntries(
  LLM_MODEL_GROUPS.flatMap((g) =>
    g.models.map((m) => [m.value, m.multiplier]),
  ),
);

/** Map legacy tier names to current tier IDs */
const LEGACY_TIER_MAP: Record<string, string> = {
  haiku: "haiku-4-5",
  sonnet: "sonnet-4-6",
  opus: "opus-4-6",
};

/** Normalize a model tier value, mapping legacy names to current IDs */
function normalizeModelTier(tier: string): string {
  return LEGACY_TIER_MAP[tier] ?? tier;
}

// ─── Helpers (pure, testable) ────────────────────────────────────

/** Format cents as a readable cost string */
export function formatCostCents(cents: number): string {
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${Math.round(cents)}¢`;
}

/** Format token count for display in the slide-over */
export function formatTokensConsumed(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return tokens.toLocaleString();
}

/** Filter recent turns that belong to a given agent based on heuristic: agent name in thinking */
export function filterAgentTurns(
  recentTurns: CompanyStatus["recentTurns"],
  agentId: string,
): CompanyStatus["recentTurns"] {
  // recentTurns don't have agentId directly — return all for now
  // The slide-over displays them as "recent company activity"
  return recentTurns.slice(0, 10);
}

/** Format a timestamp into a relative time string */
export function formatTimeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// ─── Status color mapping ────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  free: "bg-green-500",
  working: "bg-amber-500",
  paused: "bg-gray-400",
};

const STATUS_LABEL: Record<string, string> = {
  free: "Free",
  working: "Working",
  paused: "Paused",
};

// ─── Props ───────────────────────────────────────────────────────

interface AgentSlideOverProps {
  agent: FounderVisibleAgent | null;
  agents: FounderVisibleAgent[];
  recentTurns: CompanyStatus["recentTurns"];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

// ─── Component ───────────────────────────────────────────────────

export function AgentSlideOver({
  agent,
  agents,
  recentTurns,
  onClose,
  onSaved,
}: AgentSlideOverProps) {
  const { getToken } = useAuth();
  const panelRef = useRef<HTMLDivElement>(null);

  // ─── Editable state ────────────────────────────────────────────
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [adapterType, setAdapterType] = useState("claude-code");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [reportsTo, setReportsTo] = useState<string>("none");
  const [modelTier, setModelTier] = useState("sonnet-4-6");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [blueprintPrompt, setBlueprintPrompt] = useState<string | null>(null);
  const [loadingBlueprint, setLoadingBlueprint] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic UI: overrides server status during toggle to show target state immediately
  const [optimisticStatus, setOptimisticStatus] = useState<"free" | "paused" | null>(null);

  // Sync state when agent changes
  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setRole(agent.title || agent.role);
      setAdapterType(agent.adapter_type || "claude-code");
      setWebhookUrl(agent.webhook_url || "");
      setReportsTo(agent.reports_to || "none");
      setModelTier(normalizeModelTier(agent.model_tier || "sonnet-4-6"));
      // Priority: (1) system_prompt if non-null and non-empty, (2) instructions (legacy) if non-null and non-empty, (3) empty (blueprint will be fetched)
      // Use trimmed value to strip stale whitespace from persisted prompts
      const initialPrompt = (agent.system_prompt && agent.system_prompt.trim())
        ? agent.system_prompt.trim()
        : (agent.instructions && agent.instructions.trim())
          ? agent.instructions.trim()
          : "";
      setSystemPrompt(initialPrompt);
      setBlueprintPrompt(null);
      setError(null);
      setSaveSuccess(false);
      setOptimisticStatus(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally keyed on agent?.id to avoid resetting form on every SWR poll
  }, [agent?.id]);

  // Sync live status updates (e.g., agent goes working→free) without resetting the form.
  // This clears any optimistic override so the real server status shows through.
  useEffect(() => {
    if (agent) setOptimisticStatus(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Only react to status changes, not full agent object
  }, [agent?.status]);

  // Fetch blueprint prompt for agents without a custom system_prompt or legacy instructions
  useEffect(() => {
    if (!agent) return;
    // Only fetch blueprint if neither system_prompt nor instructions is set
    if (agent.system_prompt && agent.system_prompt.trim()) return;
    if (agent.instructions && agent.instructions.trim()) return;

    let cancelled = false;
    setLoadingBlueprint(true);

    (async () => {
      try {
        const token = await getToken();
        if (!token || cancelled) return;
        const prompt = await fetchBlueprintPrompt(agent.id, token);
        if (!cancelled) {
          setBlueprintPrompt(prompt);
          // Pre-populate the textarea with the blueprint prompt if no prompt is set
          if (!(agent.system_prompt && agent.system_prompt.trim()) && !(agent.instructions && agent.instructions.trim())) {
            setSystemPrompt(prompt || "");
          }
        }
      } catch {
        // Non-fatal — the textarea will just be empty
      } finally {
        if (!cancelled) setLoadingBlueprint(false);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally keyed on agent?.id to avoid re-fetching blueprint on every SWR poll
  }, [agent?.id, getToken]);

  // ─── Close on Escape ──────────────────────────────────────────
  useEffect(() => {
    if (!agent) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [agent, onClose]);

  // ─── Click outside handler ────────────────────────────────────
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // ─── Other agents for reports_to dropdown ─────────────────────
  const otherAgents = useMemo(
    () => agents.filter((a) => a.id !== agent?.id),
    [agents, agent],
  );

  // ─── Agent turns ──────────────────────────────────────────────
  const agentTurns = useMemo(
    () => (agent ? filterAgentTurns(recentTurns, agent.id) : []),
    [recentTurns, agent],
  );

  // ─── Is enabled (not paused) — uses optimistic status when set ──
  const effectiveStatus = optimisticStatus ?? agent?.status;
  const isEnabled = effectiveStatus !== "paused";

  // ─── Show webhook URL for non-claude agents ──────────────────
  const showWebhookUrl = adapterType !== "claude-code";

  // ─── Save handler ─────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!agent) return;
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");

      // Determine if the system prompt is different from the blueprint default.
      // If user hasn't changed it from the blueprint, save as null to keep using blueprint.
      const trimmedPrompt = systemPrompt.trim();
      const isBlueprint = blueprintPrompt && trimmedPrompt === blueprintPrompt.trim();
      const systemPromptValue = trimmedPrompt === "" || isBlueprint ? null : trimmedPrompt;

      await updateAgent(
        agent.id,
        {
          name: name.trim(),
          role: role.trim(),
          title: role.trim(),
          reports_to: reportsTo === "none" ? null : reportsTo,
          adapter_type: adapterType,
          webhook_url: showWebhookUrl ? webhookUrl.trim() || null : null,
          model_tier: modelTier,
          system_prompt: systemPromptValue,
          // Write to legacy instructions field too for backward compatibility during transition
          instructions: systemPromptValue ?? "",
        },
        token,
      );
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [agent, name, role, reportsTo, adapterType, webhookUrl, showWebhookUrl, modelTier, systemPrompt, blueprintPrompt, getToken, onSaved]);

  // ─── Toggle enable/disable (optimistic UI) ────────────────────
  const handleToggle = useCallback(async () => {
    if (!agent) return;
    setToggling(true);
    setError(null);

    // Determine target state and apply optimistic update immediately
    const targetStatus = isEnabled ? "paused" : "free";
    setOptimisticStatus(targetStatus as "free" | "paused");

    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      if (isEnabled) {
        await pauseAgent(agent.id, token);
      } else {
        await resumeAgent(agent.id, token);
      }
      // Success — await SWR revalidation before clearing optimistic override
      // This ensures the UI stays in the target state until fresh server data arrives
      await onSaved();
      setOptimisticStatus(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const action = isEnabled ? "disable" : "enable";

      // Revert optimistic state on failure
      setOptimisticStatus(null);

      // Show a user-friendly error; include supervisor context when relevant
      if (message.includes("supervisor") || message.includes("502") || message.includes("503")) {
        setError(`Failed to ${action} agent: the supervisor is currently unreachable. Please try again later.`);
      } else if (message.includes("not paused")) {
        setError(`Agent is not in a paused state. Refreshing status…`);
      } else {
        setError(`Failed to ${action} agent: ${message}`);
      }
      // Refresh agent state from server to reflect actual state
      onSaved();
    } finally {
      setToggling(false);
    }
  }, [agent, isEnabled, getToken, onSaved]);

  return (
    <AnimatePresence>
      {agent && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/40"
            onClick={handleBackdropClick}
          />

          {/* Panel */}
          <motion.div
            key="panel"
            ref={panelRef}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full flex-col overflow-y-auto border-l border-border bg-background shadow-2xl sm:w-[60%] lg:w-[50%]"
          >
            {/* ── Header ──────────────────────────────────────── */}
            <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/95 px-6 py-4 backdrop-blur-sm">
              {/* Avatar */}
              <div className="relative shrink-0">
                <div className="h-10 w-10 rounded-none bg-secondary flex items-center justify-center overflow-hidden ring-1 ring-border">
                  {agent.icon ? (
                    <img
                      src={resolveAvatarUrl(agent.icon)}
                      alt={agent.name}
                      className="h-10 w-10 rounded-none object-cover"
                    />
                  ) : (
                    <span className="text-sm font-semibold text-muted-foreground">
                      {agent.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                {/* Status dot — uses optimistic status for immediate feedback */}
                <div className="absolute -bottom-0.5 -right-0.5">
                  <div
                    className={`h-3 w-3 rounded-none border-2 border-background ${STATUS_DOT[effectiveStatus ?? agent.status] ?? "bg-gray-400"}`}
                    title={STATUS_LABEL[effectiveStatus ?? agent.status] ?? "Unknown"}
                  />
                </div>
              </div>

              {/* Name + status badge — uses optimistic status for immediate feedback */}
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold truncate">{agent.name}</h2>
                <Badge
                  variant="secondary"
                  className="text-[10px]"
                >
                  {STATUS_LABEL[effectiveStatus ?? agent.status] ?? "Unknown"}
                </Badge>
              </div>

              {/* Close button */}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label="Close panel"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* ── Body ────────────────────────────────────────── */}
            <div className="flex-1 space-y-6 p-6">
              {/* Error banner */}
              {error && (
                <div className="rounded-none border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                  {error}
                </div>
              )}

              {/* ── Editable Fields ───────────────────────────── */}
              <section className="space-y-4">
                <h3 className="section-label">
                  Agent Details
                </h3>

                {/* Name */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="agent-name"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Name
                  </label>
                  <Input
                    id="agent-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Agent name"
                  />
                </div>

                {/* Role / Title */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="agent-role"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Role / Title
                  </label>
                  <Input
                    id="agent-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="Role or title"
                  />
                </div>

                {/* Adapter Type */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="agent-adapter-type"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Adapter Type
                  </label>
                  <select
                    id="agent-adapter-type"
                    value={adapterType}
                    onChange={(e) => setAdapterType(e.target.value)}
                    className="h-9 w-full rounded-none border border-input bg-transparent px-3 py-1 text-sm shadow-none outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30"
                  >
                    {ADAPTER_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Webhook URL (only for non-claude agents) */}
                {showWebhookUrl && (
                  <div className="space-y-1.5">
                    <label
                      htmlFor="agent-webhook-url"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Webhook URL
                    </label>
                    <Input
                      id="agent-webhook-url"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="https://..."
                    />
                  </div>
                )}

                {/* Reports To */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="agent-reports-to"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Reports To
                  </label>
                  <select
                    id="agent-reports-to"
                    value={reportsTo}
                    onChange={(e) => setReportsTo(e.target.value)}
                    className="h-9 w-full rounded-none border border-input bg-transparent px-3 py-1 text-sm shadow-none outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30"
                  >
                    <option value="none">None</option>
                    {otherAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.title || a.role})
                      </option>
                    ))}
                  </select>
                </div>
              </section>

              {/* ── LLM Model Section ─────────────────────────── */}
              <section className="space-y-4">
                <h3 className="section-label">
                  <Brain className="h-3.5 w-3.5" />
                  LLM Model
                </h3>
                <div className="space-y-1.5">
                  <label
                    htmlFor="agent-model-tier"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Model
                  </label>
                  <select
                    id="agent-model-tier"
                    value={modelTier}
                    onChange={(e) => setModelTier(e.target.value)}
                    className="h-9 w-full rounded-none border border-input bg-transparent px-3 py-1 text-sm shadow-none outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30"
                  >
                    {LLM_MODEL_GROUPS.map((group) => (
                      <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label} — {opt.multiplier}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {/* Live multiplier display */}
                  <p className="text-[10px] text-muted-foreground">
                    Cost multiplier: <span className="font-semibold text-accent-orange">{MODEL_MULTIPLIER_MAP[modelTier] ?? "1.0x"}</span>
                  </p>
                </div>
              </section>

              {/* ── System Prompt Section ─────────────────────── */}
              <section className="space-y-4">
                <h3 className="section-label">
                  <FileText className="h-3.5 w-3.5" />
                  System Prompt
                </h3>
                <div className="space-y-1.5">
                  <Textarea
                    id="agent-system-prompt"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder={loadingBlueprint ? "Loading default prompt…" : "Enter the complete system prompt for this agent…"}
                    className="min-h-[160px] resize-y font-mono text-xs"
                    rows={8}
                    maxLength={MAX_SYSTEM_PROMPT_LENGTH}
                  />
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-muted-foreground">
                      This is the complete system prompt sent to the agent at runtime.
                      Edit to fully customize agent behavior. Clear to revert to the blueprint default.
                    </p>
                    <span
                      className={`text-[10px] tabular-nums shrink-0 ml-2 ${
                        systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH
                          ? "text-red-500 font-semibold"
                          : systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH * 0.9
                            ? "text-amber-500"
                            : "text-muted-foreground"
                      }`}
                    >
                      {systemPrompt.length.toLocaleString()}/{MAX_SYSTEM_PROMPT_LENGTH.toLocaleString()}
                    </span>
                  </div>
                </div>
              </section>

              {/* ── Enable / Disable ──────────────────────────── */}
              <section className="space-y-4">
                <h3 className="section-label">
                  Status
                </h3>

                {/* Enable / Disable Toggle */}
                <div className="flex items-center justify-between rounded-none border border-border px-4 py-3">
                  <div>
                    <div className="text-sm font-medium">
                      {isEnabled ? "Enabled" : "Disabled"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {isEnabled
                        ? "Agent is active and can receive tasks"
                        : "Agent is paused and will not execute"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggle}
                    disabled={toggling}
                    className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    aria-label={isEnabled ? "Disable agent" : "Enable agent"}
                  >
                    {toggling ? (
                      <Loader2 className="h-6 w-6 animate-spin" />
                    ) : isEnabled ? (
                      <ToggleRight className="h-6 w-6 text-green-500" />
                    ) : (
                      <ToggleLeft className="h-6 w-6" />
                    )}
                  </button>
                </div>
              </section>

              {/* ── Skills Section ────────────────────────────── */}
              {agent.skills && agent.skills.length > 0 && (
                <section className="space-y-3">
                  <h3 className="section-label">
                    Skills
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {agent.skills.map((skill) => (
                      <Badge
                        key={skill.slug}
                        variant="outline"
                        className="text-xs"
                      >
                        {skill.name}
                      </Badge>
                    ))}
                  </div>
                </section>
              )}

              {/* ── Per-Agent Expense ─────────────────────────── */}
              <section className="space-y-3">
                <h3 className="section-label">
                  Expense
                </h3>
                <div className="flex items-center gap-3 rounded-none border border-border px-4 py-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-none bg-accent-orange/10">
                    <Coins className="h-4 w-4 text-accent-orange" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">
                      {formatTokensConsumed(agent.total_credits_consumed)} tokens
                    </div>
                    <div className="text-xs text-muted-foreground">
                      total tokens consumed
                    </div>
                  </div>
                </div>
              </section>

              {/* ── Agent History ─────────────────────────────── */}
              <section className="space-y-3">
                <h3 className="section-label">
                  Recent Activity
                </h3>
                {agentTurns.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recent activity.</p>
                ) : (
                  <div className="space-y-2">
                    {agentTurns.map((turn) => (
                      <div
                        key={turn.id}
                        className="flex items-center gap-3 rounded-none border border-border px-3 py-2"
                      >
                        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-muted-foreground truncate">
                            {formatTimeAgo(turn.timestamp)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Zap className="h-3 w-3" />
                            {turn.toolCallCount}
                          </span>
                          <span className="text-[10px] font-medium text-accent-orange">
                            {formatTokensConsumed(turn.costCents)} tokens
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* ── Footer: Save button ─────────────────────────── */}
            <div className="sticky bottom-0 border-t border-border bg-background/95 px-6 py-4 backdrop-blur-sm">
              <Button
                onClick={handleSave}
                disabled={saving || !name.trim() || systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH}
                className={`w-full ${saveSuccess ? "bg-green-600 hover:bg-green-600/90" : "bg-accent-orange hover:bg-accent-orange/90"} text-white`}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : saveSuccess ? (
                  <>
                    <Check className="h-4 w-4" />
                    Saved!
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save Changes
                  </>
                )}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
