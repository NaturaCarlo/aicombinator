import type {
  Company,
  CompanyStatus,
  ActivityEntry,
  FounderChatMessage,
  PublicProfile,
  Application,
  AdminApplication,
  AdminCompany,
  AdminCompanyDetail,
  AdminPurchaseRequest,
  AdminHealthAgent,
  AdminHealthStats,
  Agent,
  CostSummary,
  CostByAgent,
  AgentMessage,
  CompanyDocument,
  CompanyArtifact,
  BillingStatus,
  CreditPurchaseConfirmation,
  DomainBundleQuote,
  DomainBundlePurchaseResult,
  Task,
  BurnRateMetrics,
  CompanyLaunchStatus,
  FounderState,
  LaunchSession,
  LaunchSessionMode,
} from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live";
const API_GET_TIMEOUT_MS = 15000;
const API_WRITE_TIMEOUT_MS = 60000;

/**
 * Resolve an avatar path (e.g. "/api/avatars/abc") to a full URL on the API domain.
 */
export function resolveAvatarUrl(path: string | null): string {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `${API_URL}${path}`;
}

export function resolveApiUrl(path: string | null): string {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `${API_URL}${path}`;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const controller = new AbortController();
  const timeoutMs = method === "GET" ? API_GET_TIMEOUT_MS : API_WRITE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      cache: method === "GET" ? "no-store" : options.cache,
      signal: options.signal ?? controller.signal,
      headers: {
        ...(method !== "GET" && { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(extractApiErrorMessage(body, res.status));
  }

  return res.json();
}

function extractApiErrorMessage(body: string, status: number): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `API error: ${status}`;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed.detail === "string" && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
  } catch {
    // Fall back to plain text below.
  }

  return trimmed || `API error: ${status}`;
}

export async function createCompany(
  params: { idea: string; name?: string; budgetCents?: number },
  token: string,
): Promise<{
  id: string;
  name: string;
  slug: string;
  state: string;
  budgetCents: number;
  hostedDomain?: string | null;
  emailDomain?: string | null;
  customDomainCandidate?: string | null;
  customDomainStatus?: string | null;
  runtimeTier?: string | null;
}> {
  return apiFetch("/api/companies", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
}

export async function generateLuckyCompanyIdea(
  token: string,
): Promise<{ name: string; idea: string }> {
  return apiFetch("/api/companies/lucky-idea", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function createLaunchSession(
  params: { idea: string; companyName?: string; mode: LaunchSessionMode },
  token: string,
): Promise<LaunchSession> {
  return apiFetch("/api/launch-sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
}

export async function getLaunchSession(
  id: string,
  token: string,
): Promise<LaunchSession> {
  return apiFetch(`/api/launch-sessions/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function sendLaunchSessionMessage(
  id: string,
  message: string,
  token: string,
  signal?: AbortSignal,
): Promise<LaunchSession> {
  return apiFetch(`/api/launch-sessions/${id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
    signal,
  });
}

export async function retryLaunchSessionTurn(
  id: string,
  token: string,
): Promise<LaunchSession> {
  return apiFetch(`/api/launch-sessions/${id}/retry-last-turn`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function launchCompanyFromSession(
  id: string,
  token: string,
): Promise<{
  id: string;
  name: string;
  slug: string;
  state: string;
  budgetCents: number;
  hostedDomain?: string | null;
  emailDomain?: string | null;
  customDomainCandidate?: string | null;
  customDomainStatus?: string | null;
  runtimeTier?: string | null;
}> {
  return apiFetch(`/api/launch-sessions/${id}/launch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

const LAUNCH_STREAM_TIMEOUT_MS = 120_000;

export async function streamLaunchSession(
  id: string,
  token: string,
  handlers: {
    onToken?: (content: string) => void;
    onProcessing?: (session: LaunchSession) => void;
    onDone?: (session: LaunchSession) => void;
    onError?: (error: string) => void;
  },
  signal?: AbortSignal,
): Promise<{ complete: boolean }> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), LAUNCH_STREAM_TIMEOUT_MS);

  const onExternalAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/launch-sessions/${id}/stream`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: timeoutController.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    if ((error as Error).name === "AbortError") return { complete: false };
    throw error;
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    const body = await res.text().catch(() => "");
    throw new Error(body || `API error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parsed = extractSsePayloads(buffer);
      buffer = parsed.rest;

      for (const payload of parsed.payloads) {
        if (payload.type === "token" && typeof payload.content === "string") {
          handlers.onToken?.(payload.content);
          continue;
        }

        if (payload.type === "processing" && payload.session) {
          handlers.onProcessing?.(payload.session as unknown as LaunchSession);
          continue;
        }

        if (payload.type === "done" && payload.session) {
          handlers.onDone?.(payload.session as unknown as LaunchSession);
          return { complete: true };
        }

        if (payload.type === "error" && typeof payload.error === "string") {
          handlers.onError?.(payload.error);
          return { complete: false };
        }
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    reader.releaseLock();
  }

  // Stream ended without a done event — incomplete termination
  return { complete: false };
}

export async function listCompanies(token: string): Promise<Company[]> {
  const data = await apiFetch<{ companies: Company[] }>("/api/companies", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data.companies;
}

export async function getCompany(
  id: string,
  token: string,
): Promise<Company> {
  return apiFetch(`/api/companies/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCompanyStatus(
  id: string,
  token: string,
): Promise<CompanyStatus> {
  return apiFetch(`/api/companies/${id}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getFounderState(
  id: string,
  token: string,
): Promise<FounderState> {
  return apiFetch(`/api/companies/${id}/founder-state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCompanyLaunchStatus(
  id: string,
  token: string,
): Promise<CompanyLaunchStatus> {
  return apiFetch(`/api/companies/${id}/launch-status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCompanyActivity(
  id: string,
  token: string,
  cursor?: string,
): Promise<{ entries: ActivityEntry[]; nextCursor?: string }> {
  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  return apiFetch(`/api/companies/${id}/activity?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function chatWithCeo(
  id: string,
  message: string,
  token: string,
): Promise<string> {
  const data = await apiFetch<{ reply: string }>(`/api/companies/${id}/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
  return data.reply;
}

const STREAM_CHAT_TIMEOUT_MS = 360_000;

export async function streamChatWithCeo(
  id: string,
  message: string,
  token: string,
  handlers: {
    onMeta?: (payload: { chatId: string; createdAt: string }) => void;
    onDelta?: (text: string) => void;
    onDone?: (reply: string) => void;
    onError?: (error: string) => void;
    onToolStart?: (payload: { toolName: string; description: string }) => void;
    onToolEnd?: (payload: { toolName?: string; toolId?: string }) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort("CEO response timed out after 6 minutes"), STREAM_CHAT_TIMEOUT_MS);

  // If an external signal is provided, abort the timeout controller when it fires
  const onExternalAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/companies/${id}/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message }),
      signal: timeoutController.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    if ((error as Error).name === "AbortError") {
      throw new Error("Response timed out. Try again.");
    }
    throw error;
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    const body = await res.text().catch(() => "");
    throw new Error(body || `API error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parsed = extractSsePayloads(buffer);
      buffer = parsed.rest;

      for (const payload of parsed.payloads) {
        if (payload.type === "meta" && typeof payload.chatId === "string" && typeof payload.createdAt === "string") {
          handlers.onMeta?.({ chatId: payload.chatId, createdAt: payload.createdAt });
          continue;
        }

        if (payload.type === "delta" && typeof payload.text === "string") {
          handlers.onDelta?.(payload.text);
          continue;
        }

        if (payload.type === "tool_start" && typeof payload.toolName === "string") {
          handlers.onToolStart?.({
            toolName: payload.toolName as string,
            description: (payload.description as string) ?? "Working...",
          });
          continue;
        }

        if (payload.type === "tool_end") {
          handlers.onToolEnd?.({
            toolName: payload.toolName as string | undefined,
            toolId: payload.toolId as string | undefined,
          });
          continue;
        }

        if (payload.type === "done" && typeof payload.reply === "string") {
          handlers.onDone?.(payload.reply);
          return;
        }

        if (payload.type === "error" && typeof payload.error === "string") {
          handlers.onError?.(payload.error);
          throw new Error(payload.error);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    reader.releaseLock();
  }
}

export async function getCeoChatHistory(
  id: string,
  token: string,
): Promise<FounderChatMessage[]> {
  const data = await apiFetch<{ entries: FounderChatMessage[] }>(`/api/companies/${id}/chat`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data.entries;
}

function extractSsePayloads(buffer: string): {
  payloads: Array<Record<string, unknown>>;
  rest: string;
} {
  const payloads: Array<Record<string, unknown>> = [];
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";

  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n");

    if (!data) continue;

    try {
      payloads.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      console.warn("[SSE] Malformed chunk dropped:", data.slice(0, 200));
    }
  }

  return { payloads, rest };
}

export async function updateCompany(
  id: string,
  updates: { publicVisible?: boolean; state?: "running" | "paused" | "failed"; paused?: boolean; mode?: "autonomous" | "manual"; name?: string },
  token: string,
): Promise<Company> {
  return apiFetch(`/api/companies/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(updates),
  });
}

export async function deleteCompany(
  id: string,
  token: string,
): Promise<void> {
  await apiFetch(`/api/companies/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function quoteDomainBundle(
  companyId: string,
  domain: string,
  token: string,
): Promise<DomainBundleQuote> {
  return apiFetch(`/api/companies/${companyId}/domain-bundle/quote`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ domain }),
  });
}

export async function purchaseDomainBundle(
  companyId: string,
  quoteId: string,
  token: string,
): Promise<DomainBundlePurchaseResult> {
  return apiFetch(`/api/companies/${companyId}/domain-bundle/purchase`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ quoteId }),
  });
}

export async function getPublicProfile(slug: string): Promise<PublicProfile> {
  return apiFetch(`/api/public/${slug}`);
}

// ─── Applications ─────────────────────────────────────────────

export async function getApplication(
  token: string,
): Promise<Application | null> {
  const data = await apiFetch<{ application: Application | null }>("/api/applications", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data.application;
}

export async function saveApplication(
  formData: Record<string, string>,
  token: string,
  submit = false,
): Promise<Application> {
  const data = await apiFetch<{ application: Application }>("/api/applications", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...formData, submit }),
  });
  return data.application;
}

// SWR fetcher that injects the auth token
export function createAuthFetcher(token: string | null) {
  return async (url: string) => {
    if (!token) throw new Error("Not authenticated");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_GET_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${API_URL}${url}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if ((error as Error).name === "AbortError") {
        throw new Error(`Request timed out after ${Math.round(API_GET_TIMEOUT_MS / 1000)}s`);
      }
      throw error;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(extractApiErrorMessage(body, res.status));
    }
    return res.json();
  };
}

// ─── Admin API ────────────────────────────────────────────────

export async function adminListApplications(
  token: string,
  status?: string,
): Promise<AdminApplication[]> {
  const params = status ? `?status=${status}` : "";
  const data = await apiFetch<{ applications: AdminApplication[] }>(
    `/api/admin/applications${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.applications;
}

export async function adminUpdateApplication(
  id: string,
  update: { status: "accepted" | "rejected"; admin_notes?: string },
  token: string,
): Promise<{ status: string; companyId?: string; message: string }> {
  return apiFetch(`/api/admin/applications/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(update),
  });
}

export async function adminDeleteApplication(
  id: string,
  token: string,
): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/admin/applications/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function adminListCompanies(
  token: string,
  state?: string,
): Promise<AdminCompany[]> {
  const params = state ? `?state=${state}` : "";
  const data = await apiFetch<{ companies: AdminCompany[] }>(
    `/api/admin/companies${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.companies;
}

export async function adminGetCompany(
  id: string,
  token: string,
): Promise<AdminCompanyDetail> {
  return apiFetch(`/api/admin/companies/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function adminUpdateCompany(
  id: string,
  update: { budget_cents?: number; state?: string; inference_model?: string },
  token: string,
): Promise<{ updated: boolean }> {
  return apiFetch(`/api/admin/companies/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(update),
  });
}

export async function adminListPurchases(
  token: string,
  status?: string,
): Promise<AdminPurchaseRequest[]> {
  const params = status ? `?status=${status}` : "";
  const data = await apiFetch<{ requests: AdminPurchaseRequest[] }>(
    `/api/admin/purchases${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.requests;
}

export async function adminUpdatePurchase(
  id: string,
  update: { status: "approved" | "rejected"; admin_notes?: string },
  token: string,
): Promise<{ status: string; message: string }> {
  return apiFetch(`/api/admin/purchases/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(update),
  });
}

export async function adminProvisionCompany(
  id: string,
  token: string,
): Promise<{ provisioning: boolean; message: string }> {
  return apiFetch(`/api/admin/companies/${id}/provision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function adminGetHealth(
  token: string,
): Promise<{ agents: AdminHealthAgent[]; stats: AdminHealthStats }> {
  return apiFetch(`/api/admin/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Multi-Agent Orchestration API ───────────────────────────

// Agents
export async function listAgents(companyId: string, token: string): Promise<Agent[]> {
  const data = await apiFetch<{ agents: Agent[] }>(`/api/companies/${companyId}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data.agents;
}

export async function createAgent(
  companyId: string,
  agent: { name: string; role?: string; title?: string; reports_to?: string; capabilities?: string[] },
  token: string,
): Promise<Agent> {
  const data = await apiFetch<{ agent: Agent }>(`/api/companies/${companyId}/agents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(agent),
  });
  return data.agent;
}

export async function getAgent(agentId: string, token: string): Promise<Agent> {
  const data = await apiFetch<{ agent: Agent }>(`/api/agents/${agentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data.agent;
}

export async function updateAgent(
  agentId: string,
  updates: Partial<Pick<Agent, "name" | "role" | "title" | "icon" | "reports_to" | "adapter_type" | "webhook_url" | "instructions">> & { model_tier?: string; system_prompt?: string | null },
  token: string,
): Promise<Agent> {
  const data = await apiFetch<{ agent: Agent }>(`/api/agents/${agentId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(updates),
  });
  return data.agent;
}

export async function fetchBlueprintPrompt(
  agentId: string,
  token: string,
): Promise<string | null> {
  const data = await apiFetch<{ prompt: string | null }>(`/api/agents/${agentId}/blueprint-prompt`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data.prompt;
}

export async function pauseAgent(agentId: string, token: string): Promise<void> {
  await apiFetch(`/api/agents/${agentId}/pause`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function resumeAgent(agentId: string, token: string): Promise<void> {
  await apiFetch(`/api/agents/${agentId}/resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function terminateAgent(agentId: string, token: string): Promise<void> {
  await apiFetch(`/api/agents/${agentId}/terminate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function wakeAgent(agentId: string, token: string, message?: string): Promise<void> {
  await apiFetch(`/api/agents/${agentId}/wake`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
}

export async function createAgentApiKey(agentId: string, token: string, name?: string): Promise<{ id: string; key: string; name: string }> {
  return apiFetch(`/api/agents/${agentId}/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
}

// Approvals
export async function approveApproval(approvalId: string, token: string, note?: string): Promise<void> {
  await apiFetch(`/api/approvals/${approvalId}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ note }),
  });
}

export async function rejectApproval(approvalId: string, token: string, note?: string): Promise<void> {
  await apiFetch(`/api/approvals/${approvalId}/reject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ note }),
  });
}

// Costs
export async function getCostSummary(companyId: string, token: string): Promise<CostSummary> {
  return apiFetch(`/api/companies/${companyId}/costs/summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function getCostByAgent(companyId: string, token: string): Promise<CostByAgent[]> {
  const data = await apiFetch<{ agents: CostByAgent[] }>(`/api/companies/${companyId}/costs/by-agent`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data.agents;
}

// ─── Agent Messages ──────────────────────────────────────────

export async function listMessages(
  companyId: string,
  token: string,
  params?: { limit?: number; before?: string; agent_id?: string },
): Promise<AgentMessage[]> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.before) qs.set("before", params.before);
  if (params?.agent_id) qs.set("agent_id", params.agent_id);
  const q = qs.toString();
  const data = await apiFetch<{ messages: AgentMessage[] }>(
    `/api/companies/${companyId}/messages${q ? `?${q}` : ""}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.messages;
}

// ─── Company Documents ───────────────────────────────────────

export async function getDocuments(
  companyId: string,
  token: string,
): Promise<{ documents: CompanyDocument[]; artifacts: CompanyArtifact[] }> {
  return apiFetch<{ documents: CompanyDocument[]; artifacts: CompanyArtifact[] }>(
    `/api/companies/${companyId}/documents`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

// ─── Billing ─────────────────────────────────────────────────

export async function getBillingStatus(token: string): Promise<BillingStatus> {
  return apiFetch(`/api/billing/status?_=${Date.now()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function createCheckoutSession(token: string): Promise<{ url: string }> {
  return apiFetch("/api/billing/checkout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function createPortalSession(token: string): Promise<{ url: string }> {
  return apiFetch("/api/billing/portal", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function updateAutoRefill(
  config: { enabled?: boolean; threshold?: number; amount?: number },
  token: string,
): Promise<{ updated: boolean }> {
  return apiFetch("/api/billing/auto-refill", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(config),
  });
}

export async function buyCredits(
  amount: number,
  token: string,
): Promise<{ url: string }> {
  return apiFetch("/api/billing/buy-credits", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ amount }),
  });
}

export async function confirmCreditPurchase(
  sessionId: string,
  token: string,
): Promise<CreditPurchaseConfirmation> {
  return apiFetch("/api/billing/credits/confirm", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId }),
  });
}

// ─── Tasks ──────────────────────────────────────────────────

export async function listTasks(
  companyId: string,
  token: string,
  params?: { status?: string; agent_id?: string },
): Promise<Task[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.agent_id) qs.set("agent_id", params.agent_id);
  const q = qs.toString();
  const data = await apiFetch<{ tasks: Task[] }>(
    `/api/companies/${companyId}/tasks${q ? `?${q}` : ""}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.tasks;
}

export async function createTask(
  companyId: string,
  task: { title: string; description?: string; owner_agent_id?: string; parent_task_id?: string },
  token: string,
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(
    `/api/companies/${companyId}/tasks`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(task),
    },
  );
  return data.task;
}

export async function updateTask(
  taskId: string,
  updates: Partial<Pick<Task, "title" | "description" | "status" | "owner_agent_id" | "blocked_reason">>,
  token: string,
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(
    `/api/tasks/${taskId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(updates),
    },
  );
  return data.task;
}

// ─── Burn Rate ──────────────────────────────────────────────

export async function getBurnRate(
  companyId: string,
  token: string,
): Promise<BurnRateMetrics> {
  return apiFetch(`/api/companies/${companyId}/burn-rate`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Real-time Status (SSE) ─────────────────────────────────

/**
 * Connect to the Server-Sent Events stream for real-time company updates.
 * Returns an EventSource that emits agent_wake, agent_sleep, credit_deduct, etc.
 */
export function connectStatusStream(
  companyId: string,
  token: string,
): EventSource {
  const url = `${API_URL}/api/companies/${companyId}/status/stream?token=${encodeURIComponent(token)}`;
  return new EventSource(url);
}

// ─── Agent KV ────────────────────────────────────────────────

export async function getAgentKv(
  companyId: string,
  agentId: string,
  key: string,
  token: string,
): Promise<string | null> {
  const data = await apiFetch<{ value: string | null }>(
    `/api/companies/${companyId}/agent-kv/${agentId}/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.value;
}
