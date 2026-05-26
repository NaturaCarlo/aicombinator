"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Bot, Building2, Coins, Eye, Globe, PauseCircle, ShieldAlert, Trash2 } from "lucide-react";
import { useSWRConfig } from "swr";
import { useCompanyStatus } from "@/hooks/use-company";
import { useAgents } from "@/hooks/use-agents";

import { useBilling } from "@/hooks/use-billing";
import { CompanySidebar } from "@/components/company/company-sidebar";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteCompany, purchaseDomainBundle, quoteDomainBundle, updateCompany } from "@/lib/api";
import type { DomainBundleQuote, FounderVisibleAgent } from "@/lib/types";

function SettingCard({
  icon,
  title,
  description,
  children,
  danger = false,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className={danger ? "rounded-none border border-accent-red/20 bg-accent-red/[0.04] p-6" : "rounded-none border border-border bg-card p-6"}>
      <div className="flex items-start gap-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-none ${
          danger ? "bg-accent-red/10 text-accent-red" : "bg-accent-orange/10 text-accent-orange"
        }`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className={`text-base font-semibold ${danger ? "text-accent-red" : ""}`}>{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const { mutate: globalMutate } = useSWRConfig();
  const { data: status, mutate } = useCompanyStatus(id);
  const { data: agentsData, isLoading: agentsLoading } = useAgents(id);

  const { data: billing, error: billingError } = useBilling();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadingAction, setLoadingAction] = useState<null | "visibility" | "runtime" | "mode" | "delete" | "name">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  const [quote, setQuote] = useState<DomainBundleQuote | null>(null);
  const [domainAction, setDomainAction] = useState<null | "quote" | "purchase">(null);
  const [domainError, setDomainError] = useState<string | null>(null);

  const agents = agentsData?.agents || [];
  const founderAgents: FounderVisibleAgent[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    icon: agent.icon,
    status: status?.state === "paused" ? "paused" : agent.status === "paused" ? "paused" : agent.status === "working" ? "working" : "free",
    email_address: agent.email_address ?? null,
    lastActiveAt: agent.last_wake_at || agent.last_heartbeat_at || agent.updated_at,
    lastTurnAt: agent.last_sleep_at || agent.last_heartbeat_at || null,
    reports_to: agent.reports_to ?? null,
    adapter_type: null,
    webhook_url: null,
    source: "internal",
    total_credits_consumed: agent.total_credits_consumed ?? 0,
    model_tier: agent.model_tier ?? "sonnet",
    instructions: agent.instructions ?? "",
    system_prompt: agent.system_prompt ?? null,
  }));
  const isPaused = status?.state === "paused";
  const availableCredits = billing?.credits.balance;
  const resumeBlocked = isPaused && availableCredits !== undefined && availableCredits <= 0;
  const domainBundle = status?.domainBundle ?? null;
  const activeAliases = (status?.emailAliases || []).filter((alias) => alias.status === "active");
  const quoteExpired = quote ? new Date(quote.expiresAt).getTime() <= Date.now() : false;

  useEffect(() => {
    if (!status) return;
    if (quote) return;
    setDomainInput(status.customDomain || status.customDomainCandidate || "");
  }, [status, quote]);

  // Initialize company name from server data
  useEffect(() => {
    if (!status?.name) return;
    setCompanyName((prev) => (prev === "" ? status.name : prev));
  }, [status?.name]);

  const MAX_COMPANY_NAME_LENGTH = 200;

  function validateNameInput(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "Company name cannot be empty";
    if (trimmed.length > MAX_COMPANY_NAME_LENGTH) return `Company name must be ${MAX_COMPANY_NAME_LENGTH} characters or fewer`;
    return null;
  }

  const nameValidationError = validateNameInput(companyName);
  const nameHasChanged = status?.name !== undefined && companyName.trim() !== status.name;
  const canSaveName = nameHasChanged && !nameValidationError && loadingAction !== "name";

  async function handleSaveName() {
    const error = validateNameInput(companyName);
    if (error) {
      setNameError(error);
      return;
    }
    setLoadingAction("name");
    setNameError(null);
    setNameSaved(false);
    try {
      const token = await getToken();
      if (!token) return;
      await updateCompany(id, { name: companyName.trim() }, token);
      // Revalidate both the company status (sidebar/dashboard) and the companies list (portfolio)
      await Promise.all([
        mutate(),
        globalMutate("/api/companies"),
      ]);
      setNameSaved(true);
      // Clear the success message after 3 seconds
      setTimeout(() => setNameSaved(false), 3000);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Failed to update company name.");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleToggleVisibility() {
    setLoadingAction("visibility");
    setActionError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await updateCompany(id, { publicVisible: !status?.publicVisible }, token);
      await mutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update visibility.");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleToggleMode() {
    setLoadingAction("mode");
    setActionError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const newMode = (status?.mode ?? "autonomous") === "autonomous" ? "manual" : "autonomous";
      await updateCompany(id, { mode: newMode }, token);
      await mutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update mode.");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handlePauseResume() {
    setLoadingAction("runtime");
    setActionError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await updateCompany(id, { state: isPaused ? "running" : "paused" }, token);
      await mutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update runtime.");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleDelete() {
    setLoadingAction("delete");
    setActionError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await deleteCompany(id, token);
      router.push("/portfolio");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete company.");
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleDomainQuote() {
    setDomainAction("quote");
    setDomainError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const nextQuote = await quoteDomainBundle(id, domainInput, token);
      setQuote(nextQuote);
    } catch (err) {
      setQuote(null);
      setDomainError(err instanceof Error ? err.message : "Failed to quote domain bundle.");
    } finally {
      setDomainAction(null);
    }
  }

  async function handleDomainPurchase() {
    if (!quote) return;
    setDomainAction("purchase");
    setDomainError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await purchaseDomainBundle(id, quote.quoteId, token);
      setQuote(null);
      await mutate();
    } catch (err) {
      setDomainError(err instanceof Error ? err.message : "Failed to purchase domain bundle.");
    } finally {
      setDomainAction(null);
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <CompanySidebar
        companyId={id}
        agents={founderAgents}
        agentsLoading={agentsLoading}
      />

      <div className="flex-1 min-w-0 overflow-y-auto p-4 lg:p-6">
        <div className="mx-auto max-w-3xl space-y-5 fade-in-up">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage visibility, runtime, and destructive actions for this company.
            </p>
          </div>

          {actionError && (
            <div className="rounded-none border border-accent-red/20 bg-accent-red/[0.04] px-4 py-3 text-sm text-accent-red">
              {actionError}
            </div>
          )}

          {domainError && (
            <div className="rounded-none border border-accent-red/20 bg-accent-red/[0.04] px-4 py-3 text-sm text-accent-red">
              {domainError}
            </div>
          )}

          {availableCredits !== undefined && availableCredits <= 0 && (
            <div className="rounded-none border border-accent-orange/20 bg-accent-orange/[0.05] px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-accent-orange">
                    <Coins className="h-4 w-4" />
                    <span className="text-xs font-semibold uppercase tracking-wider">No tokens remaining</span>
                  </div>
                  <p className="mt-2 text-sm text-foreground">
                    Your companies can stay paused and visible, but they cannot resume work until you add more tokens.
                  </p>
                </div>
                <Link
                  href="/billing"
                  className="inline-flex items-center justify-center rounded-none bg-accent-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-orange/90"
                >
                  Add tokens
                </Link>
              </div>
            </div>
          )}

          <div className="rounded-none border border-border bg-card p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="section-label">
                  Company
                </p>
                <h2 className="mt-1 text-lg font-semibold">
                  {status?.name || "Loading company"}
                </h2>
              </div>
              {status && <StatusBadge state={status.state} />}
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-none border border-border px-4 py-3">
                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Public page</p>
                <p className="mt-1 text-sm font-medium">{status?.publicVisible ? "Visible" : "Private"}</p>
              </div>
              <div className="rounded-none border border-border px-4 py-3">
                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Model</p>
                <p className="mt-1 text-sm font-medium">
                  Default: Sonnet 4.6{" "}
                  <Link href={`/company/${id}/team`} className="text-accent-orange hover:underline">
                    (configurable per agent)
                  </Link>
                </p>
              </div>
              <div className="rounded-none border border-border px-4 py-3">
                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Hosted domain</p>
                <p className="mt-1 text-sm font-medium">{status?.hostedDomain || "Not reserved yet"}</p>
              </div>
            </div>
          </div>

          <SettingCard
            icon={<Building2 className="h-5 w-5" />}
            title="Company name"
            description="Edit the display name for this company. The name appears in the sidebar, dashboard, and portfolio."
          >
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  value={companyName}
                  onChange={(event) => {
                    setCompanyName(event.target.value);
                    setNameError(null);
                    setNameSaved(false);
                  }}
                  placeholder="Company name"
                  maxLength={MAX_COMPANY_NAME_LENGTH}
                  className="h-11 rounded-none border border-border bg-background px-3 text-sm outline-none transition focus:border-accent-orange"
                />
                <Button
                  variant="outline"
                  onClick={handleSaveName}
                  disabled={!canSaveName}
                  className="h-11 rounded-none"
                >
                  {loadingAction === "name" ? "Saving..." : "Save"}
                </Button>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {companyName.trim().length}/{MAX_COMPANY_NAME_LENGTH} characters
                </p>
                {nameError && (
                  <p className="text-xs text-accent-red">{nameError}</p>
                )}
                {nameSaved && (
                  <p className="text-xs text-green-600">Name saved successfully</p>
                )}
              </div>
            </div>
          </SettingCard>

          <SettingCard
            icon={<Globe className="h-5 w-5" />}
            title="Custom domain + inboxes"
            description="Buy one custom domain plus 3 branded inboxes for this company. The bundle includes the CEO inbox, sales inbox, and support inbox."
          >
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  value={domainInput}
                  onChange={(event) => setDomainInput(event.target.value)}
                  placeholder="companyname.com"
                  className="h-11 rounded-none border border-border bg-background px-3 text-sm outline-none transition focus:border-accent-orange"
                  disabled={!!domainBundle && domainBundle.status !== "failed"}
                />
                <Button
                  variant="outline"
                  onClick={handleDomainQuote}
                  disabled={domainAction !== null || !!domainBundle && domainBundle.status !== "failed" || !domainInput.trim()}
                  className="h-11 rounded-none"
                >
                  {domainAction === "quote" ? "Checking..." : "Check availability"}
                </Button>
              </div>

              <div className="rounded-none border border-border px-4 py-3 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Bundle contents</p>
                <p className="mt-1">3 branded inboxes for the first year: CEO, sales, and support.</p>
                <p className="mt-1">Pricing is one bundled token total, with the domain rounded up by registration cost and the inbox bundle fixed.</p>
              </div>

              {quote && !quoteExpired && (
                <div className="rounded-none border border-accent-orange/20 bg-accent-orange/[0.04] px-4 py-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{quote.domain}</p>
                      <p className="text-xs text-muted-foreground">
                        Expires {new Date(quote.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                    <p className="text-lg font-semibold text-foreground">{quote.totalCredits.toLocaleString()} tokens</p>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <p>Domain registration: ${quote.registrationCostUsd.toFixed(2)} → {quote.domainCredits.toLocaleString()} tokens</p>
                    <p>Inbox bundle: {quote.emailBundleCredits.toLocaleString()} tokens</p>
                  </div>
                  <div className="mt-3">
                    <p className="text-xs font-mono font-medium uppercase tracking-wider text-muted-foreground">Will provision</p>
                    <ul className="mt-2 space-y-1 text-sm text-foreground">
                      {quote.inboxes.map((address) => (
                        <li key={address}>{address}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-muted-foreground">
                      Account balance: {availableCredits !== undefined ? availableCredits.toLocaleString() : "—"} tokens
                    </p>
                    <Button
                      onClick={handleDomainPurchase}
                      disabled={domainAction !== null || availableCredits === undefined || availableCredits < quote.totalCredits}
                      className="rounded-none bg-accent-orange text-white hover:bg-accent-orange/90"
                    >
                      {domainAction === "purchase" ? "Purchasing..." : `Buy for ${quote.totalCredits.toLocaleString()} tokens`}
                    </Button>
                  </div>
                </div>
              )}

              {quote && quoteExpired && (
                <p className="text-xs text-muted-foreground">
                  That quote expired. Check availability again before purchasing.
                </p>
              )}

              {domainBundle && (
                <div className="rounded-none border border-border px-4 py-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{domainBundle.domain}</p>
                      <p className="text-xs text-muted-foreground">{domainBundle.message}</p>
                    </div>
                    <span className={`inline-flex rounded-none px-2 py-1 text-[11px] font-medium ${
                      domainBundle.status === "active"
                        ? "bg-green-100 text-green-700"
                        : domainBundle.status === "failed"
                          ? "bg-accent-red/[0.08] text-accent-red"
                          : "bg-secondary text-muted-foreground"
                    }`}>
                      {domainBundle.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <p>Purchase price: {domainBundle.totalCredits.toLocaleString()} tokens</p>
                    <p>Renewal estimate: {domainBundle.renewalCostUsd !== null ? `$${domainBundle.renewalCostUsd.toFixed(2)}` : "Pending registrar quote"}</p>
                  </div>
                  {domainBundle.error && (
                    <p className="mt-3 text-xs text-accent-red">{domainBundle.error}</p>
                  )}
                  {activeAliases.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs font-mono font-medium uppercase tracking-wider text-muted-foreground">Live inboxes</p>
                      <ul className="mt-2 space-y-1 text-sm text-foreground">
                        {activeAliases.map((alias) => (
                          <li key={alias.aliasType}>{alias.emailAddress}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </SettingCard>

          <SettingCard
            icon={<Eye className="h-5 w-5" />}
            title="Public profile"
            description="Control whether this company has a public-facing profile page."
          >
            <Button
              variant="outline"
              onClick={handleToggleVisibility}
              disabled={loadingAction !== null}
              className="rounded-none"
            >
              {loadingAction === "visibility"
                ? "Updating..."
                : status?.publicVisible
                  ? "Hide public profile"
                  : "Make public profile visible"}
            </Button>
          </SettingCard>

          <SettingCard
            icon={<PauseCircle className="h-5 w-5" />}
            title="Company runtime"
            description="Pause or resume autonomous work for this company without deleting it."
          >
            <Button
              variant="outline"
              onClick={handlePauseResume}
              disabled={loadingAction !== null || resumeBlocked}
              className="rounded-none"
            >
              {loadingAction === "runtime"
                ? "Updating..."
                : isPaused
                  ? resumeBlocked
                    ? "Add tokens to resume"
                    : "Resume company"
                  : "Pause company"}
            </Button>
            {resumeBlocked && (
              <p className="mt-2 text-xs text-muted-foreground">
                This company is paused because your account has no available tokens.
                Add tokens, then resume it.
              </p>
            )}
            {billingError && (
              <p className="mt-2 text-xs text-red-600">
                We couldn’t load your account balance right now.
              </p>
            )}
          </SettingCard>

          <SettingCard
            icon={<Bot className="h-5 w-5" />}
            title="Operating mode"
            description={
              (status?.mode ?? "autonomous") === "autonomous"
                ? "Autonomous — the company plans and executes continuously without waiting for your input."
                : "Manual — when milestones complete, you'll be asked to approve the next plan before work continues."
            }
          >
            <Button
              variant="outline"
              onClick={handleToggleMode}
              disabled={loadingAction !== null}
              className="rounded-none"
            >
              {loadingAction === "mode"
                ? "Updating..."
                : (status?.mode ?? "autonomous") === "autonomous"
                  ? "Switch to manual"
                  : "Switch to autonomous"}
            </Button>
          </SettingCard>

          <SettingCard
            icon={<ShieldAlert className="h-5 w-5" />}
            title="Founder controls"
            description="This page only exposes founder-level controls. Agent-level task work stays in the main company view."
          >
            <p className="text-sm text-muted-foreground">
              Use the company home to review tasks, documents, artifacts, and founder chat. Settings is limited to company-level controls only.
            </p>
          </SettingCard>

          <SettingCard
            icon={<Trash2 className="h-5 w-5" />}
            title="Delete company"
            description="Permanently destroy this company, its workspace, and its stored history. This cannot be undone."
            danger
          >
            <Button
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={loadingAction !== null}
              className="rounded-none"
            >
              Delete company
            </Button>
          </SettingCard>

          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete this company?</DialogTitle>
                <DialogDescription>
                  This permanently removes the company, shuts down the agents, and deletes the stored data.
                </DialogDescription>
              </DialogHeader>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setConfirmDelete(false)} className="rounded-none">
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={loadingAction === "delete"}
                  className="rounded-none"
                >
                  {loadingAction === "delete" ? "Deleting..." : "Delete forever"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
