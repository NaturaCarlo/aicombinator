/**
 * Supervisor internal routes — /api/supervisor/*
 *
 * These routes are called by the supervisor process to access D1.
 * Authenticated via X-Supervisor-Key header (shared secret).
 *
 * NOT exposed to end users. These are internal machine-to-machine endpoints.
 */

import type { ApprovalRow, Env, CompanyRow } from "../types.js";
import { corsHeaders } from "../middleware/cors.js";
import { generateId } from "../provisioning/config-builder.js";
import {
  ensureAgentmailInbox,
  rememberAgentmailInboxOwner,
} from "../integrations/agentmail.js";
import { deductCredits, getBalance } from "../utils/credits.js";
import { recordCostEvent } from "../utils/budget.js";
import { reconcileRecentStripeCreditPurchases } from "../utils/stripe-credits.js";
import { reserveAgentEmailAddress } from "../utils/company-contract.js";
import {
  listUserDedicatedCompanies,
  migrateCompanyWorkspaceToDedicatedVm,
  resolveHetznerServerByName,
  setUserDedicatedVmState,
} from "../utils/dedicated-vm.js";
import {
  dedicatedSupervisorBaseUrl,
  registerSharedSupervisorBaseUrl,
} from "../utils/supervisor-routing.js";
import {
  loadCompanyTelemetryRows,
  normalizeTelemetryInput,
  upsertCompanyTelemetryRow,
} from "../utils/company-telemetry.js";
import {
  ensureAvatarPoolWarm,
  avatarGenerationEnabled,
  generateAgentAvatar,
  generateSpecialistAgentName,
  hasStoredAvatar,
  resolveFounderCountryContext,
  storeAvatar,
} from "../enrichment/agent-identity.js";
import { bootstrapProvisionedCompany, ensureAutonomousWakeSchedules } from "./companies.js";
import { isCompatibleInternalContractVersion } from "../utils/internal-contract.js";

const FOUNDING_BLUEPRINT_IDS = new Set([
  "ceo",
  "cto",
  "frontend-dev",
  "backend-dev",
  "qa-tester",
  "cmo",
]);

// ─── Auth ────────────────────────────────────────────────────

function verifySupervisorKey(request: Request, env: Env): boolean {
  const contractVersion = request.headers.get("X-AIC-Contract-Version");
  if (!isCompatibleInternalContractVersion(contractVersion)) {
    return false;
  }

  const headerKey = request.headers.get("X-Supervisor-Key");
  if (headerKey && headerKey === env.SUPERVISOR_API_KEY) {
    return true;
  }

  // Claude Code SDK sends the key as x-api-key (standard Anthropic header)
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey && xApiKey === env.SUPERVISOR_API_KEY) {
    return true;
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return false;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return !!match?.[1] && match[1] === env.SUPERVISOR_API_KEY;
}

function unauthorized(env: Env): Response {
  return Response.json(
    { error: "Unauthorized" },
    { status: 401, headers: corsHeaders(env) },
  );
}

/** GET /api/supervisor/llm-config — return the LLM provider key for supervisor-side proxying */
export async function handleSupervisorLlmConfig(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) {
    return unauthorized(env);
  }
  const provider = env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENROUTER_API_KEY ? "openrouter" : null;
  if (!provider) {
    return Response.json({ error: "No LLM provider configured" }, { status: 500, headers: corsHeaders(env) });
  }
  const key = provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENROUTER_API_KEY;
  return Response.json({ provider, key }, { status: 200, headers: corsHeaders(env) });
}

/** POST /api/supervisor/shared-origin/register — publish the active shared supervisor tunnel URL */
export async function handleSupervisorRegisterSharedOrigin(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) {
    return unauthorized(env);
  }

  const body = await readOptionalJsonBody<{ url?: string }>(request);
  if (!body.url) {
    return Response.json(
      { error: "url is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  try {
    const url = await registerSharedSupervisorBaseUrl(env, body.url);
    return Response.json({ ok: true, url }, { headers: corsHeaders(env) });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not register shared supervisor origin",
      },
      { status: 400, headers: corsHeaders(env) },
    );
  }
}

/** Proxy Anthropic-compatible SDK traffic through the Worker's funded provider secret. */
export async function handleSupervisorAnthropicProxy(
  request: Request,
  env: Env,
  upstreamPath: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) {
    return unauthorized(env);
  }

  const useAnthropic = Boolean(env.ANTHROPIC_API_KEY);
  const useOpenRouter = !useAnthropic && Boolean(env.OPENROUTER_API_KEY);
  if (!useAnthropic && !useOpenRouter) {
    return Response.json(
      { error: "No funded LLM provider configured" },
      { status: 500, headers: corsHeaders(env) },
    );
  }

  // For Anthropic direct: proxy as-is to api.anthropic.com
  if (useAnthropic) {
    return proxyToAnthropic(request, env, upstreamPath);
  }

  // For OpenRouter: CF Workers can't reliably reach OpenRouter's /api/v1/messages
  // (Cloudflare-to-Cloudflare routing returns HTML). Transform to chat completions format.
  if (upstreamPath === "/v1/messages" && request.method === "POST") {
    return proxyToOpenRouterViaTransform(request, env);
  }

  // For non-messages endpoints (e.g. /v1/models), proxy directly
  return proxyToOpenRouterRaw(request, env, upstreamPath);
}

/** Direct proxy to Anthropic API — no transformation needed. */
async function proxyToAnthropic(request: Request, env: Env, upstreamPath: string): Promise<Response> {
  const target = new URL(`https://api.anthropic.com${upstreamPath}`);
  target.search = new URL(request.url).search;

  const headers = buildCleanHeaders(request);
  headers.set("x-api-key", env.ANTHROPIC_API_KEY);

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });

  return wrapUpstreamResponse(upstream, "anthropic");
}

/** Raw proxy to OpenRouter — for non-messages endpoints. */
async function proxyToOpenRouterRaw(request: Request, env: Env, upstreamPath: string): Promise<Response> {
  const target = new URL(`https://openrouter.ai/api${upstreamPath}`);
  target.search = new URL(request.url).search;

  const headers = buildCleanHeaders(request);
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${env.OPENROUTER_API_KEY}`);
  headers.set("http-referer", env.FRONTEND_URL);
  headers.set("x-title", "AI Combinator Supervisor");

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });

  return wrapUpstreamResponse(upstream, "openrouter");
}

/**
 * Transform Anthropic Messages API → OpenAI Chat Completions and proxy to OpenRouter.
 * Converts both request and response formats so Claude Code SDK works transparently.
 */
async function proxyToOpenRouterViaTransform(request: Request, env: Env): Promise<Response> {
  const anthropicReq = await request.json() as AnthropicMessagesRequest;

  // Build OpenAI-format request
  const openaiMessages: OpenAIMessage[] = [];
  if (anthropicReq.system) {
    const systemText = typeof anthropicReq.system === "string"
      ? anthropicReq.system
      : anthropicReq.system.map((b: { text: string }) => b.text).join("\n");
    openaiMessages.push({ role: "system", content: systemText });
  }
  for (const msg of anthropicReq.messages) {
    if (typeof msg.content === "string") {
      openaiMessages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Flatten content blocks to text
      const text = msg.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("\n");
      if (text) {
        openaiMessages.push({ role: msg.role, content: text });
      }
    }
  }

  const model = anthropicReq.model.includes("/")
    ? anthropicReq.model
    : `anthropic/${anthropicReq.model}`;

  const openaiReq: Record<string, unknown> = {
    model,
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens,
    stream: false,
  };
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;

  const headers = new Headers({
    "content-type": "application/json",
    "accept": "application/json",
    "authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
    "http-referer": env.FRONTEND_URL,
    "x-title": "AI Combinator Supervisor",
  });

  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(openaiReq),
  });

  // Detect if OpenRouter returned HTML instead of JSON (CF-to-CF routing issue)
  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    return Response.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: `OpenRouter returned HTML (status=${upstream.status}). CF-to-CF routing issue. Content-Type: ${contentType}`,
        },
      },
      { status: 502, headers: { "Cache-Control": "no-store", "X-AIC-Proxy": "openrouter-transform-debug" } },
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return Response.json(
      { type: "error", error: { type: "api_error", message: `OpenRouter (${upstream.status}): ${errText}` } },
      { status: upstream.status, headers: { "Cache-Control": "no-store", "X-AIC-Proxy": "openrouter-transform" } },
    );
  }

  // Transform OpenAI response → Anthropic Messages format
  const openaiRes = await upstream.json() as OpenAIChatResponse;
  const choice = openaiRes.choices?.[0];
  const anthropicRes: AnthropicMessagesResponse = {
    id: openaiRes.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: choice?.message?.content || "" }],
    model: anthropicReq.model,
    stop_reason: choice?.finish_reason === "stop" ? "end_turn"
      : choice?.finish_reason === "length" ? "max_tokens"
      : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: openaiRes.usage?.prompt_tokens || 0,
      output_tokens: openaiRes.usage?.completion_tokens || 0,
    },
  };

  return Response.json(anthropicRes, {
    status: 200,
    headers: { "Cache-Control": "no-store", "X-AIC-Proxy": "openrouter-transform" },
  });
}

function buildCleanHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === "authorization"
      || lower === "x-supervisor-key"
      || lower === "host"
      || lower === "content-length"
      || lower.startsWith("cf-")
      || lower.startsWith("x-forwarded-")
    ) {
      continue;
    }
    headers.set(key, value);
  }
  headers.delete("authorization");
  headers.delete("x-supervisor-key");
  headers.set("accept", "application/json");
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

function wrapUpstreamResponse(upstream: Response, provider: string): Response {
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-AIC-Proxy", provider);
  responseHeaders.delete("set-cookie");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

// ── Type helpers for request/response transformation ──

interface AnthropicMessagesRequest {
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>;
  system?: string | Array<{ text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

interface OpenAIMessage {
  role: string;
  content: string;
}

interface OpenAIChatResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  stop_reason: string;
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

async function readOptionalJsonBody<T extends Record<string, unknown>>(
  request: Request,
): Promise<T> {
  const raw = await request.text();
  if (!raw.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(
      `readOptionalJsonBody: failed to parse JSON body: ${raw.slice(0, 200)}`,
    );
    return {} as T;
  }
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function normalizeSupervisorDeductionBody(raw: Record<string, unknown>): {
  companyId: string | null;
  agentId: string | null;
  modelTier: string | null;
  description: string | null;
  amount: number;
  tokenUsage: { inputTokens: number; outputTokens: number };
} {
  const tokenUsageRaw =
    raw.tokenUsage && typeof raw.tokenUsage === "object"
      ? raw.tokenUsage as Record<string, unknown>
      : raw.token_usage && typeof raw.token_usage === "object"
        ? raw.token_usage as Record<string, unknown>
        : {};

  return {
    companyId: pickString(raw.companyId, raw.company_id, raw.company),
    agentId: pickString(raw.agentId, raw.agent_id, raw.agent),
    modelTier: pickString(raw.modelTier, raw.model_tier, raw.model),
    description: pickString(raw.description),
    amount: Math.max(1, pickNumber(raw.amount, raw.creditsUsed, raw.credits_used) ?? 0),
    tokenUsage: {
      inputTokens: Math.max(
        0,
        pickNumber(
          tokenUsageRaw.inputTokens,
          tokenUsageRaw.input_tokens,
          tokenUsageRaw.promptTokens,
          tokenUsageRaw.prompt_tokens,
        ) ?? 0,
      ),
      outputTokens: Math.max(
        0,
        pickNumber(
          tokenUsageRaw.outputTokens,
          tokenUsageRaw.output_tokens,
          tokenUsageRaw.completionTokens,
          tokenUsageRaw.completion_tokens,
        ) ?? 0,
      ),
    },
  };
}

function parseAgentMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mergeAgentMetadata(
  currentRaw: string | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): string {
  const next = parseAgentMetadata(currentRaw);

  if (patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        continue;
      }

      if (value === null) {
        delete next[key];
        continue;
      }

      next[key] = value;
    }
  }

  return JSON.stringify(next);
}

function parseApprovalPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizedApprovalText(value: unknown, max = 280): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase().slice(0, max)
    : "";
}

function firstApprovalText(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const normalized = normalizedApprovalText(payload[key]);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function buildApprovalFingerprint(
  type: string,
  requestedByAgentId: string,
  payload: Record<string, unknown>,
): string {
  const path = firstApprovalText(payload, ["path", "documentPath", "docPath"]);
  const title = firstApprovalText(payload, ["title", "subject", "name"]);
  const summary = firstApprovalText(payload, ["summary", "body"]);
  const taskId = normalizedApprovalText(
    payload.metadata && typeof payload.metadata === "object"
      ? (payload.metadata as Record<string, unknown>).taskId
      : null,
    80,
  );

  const parts = [
    type,
    requestedByAgentId,
    path,
    title,
    summary,
    taskId,
  ].filter(Boolean);

  if (parts.length <= 2) {
    parts.push("generic");
  }

  return parts.join("|");
}

function isFounderManagedProcurementPayload(
  payload: Record<string, unknown>,
): boolean {
  const text = [
    typeof payload.title === "string" ? payload.title : null,
    typeof payload.subject === "string" ? payload.subject : null,
    typeof payload.summary === "string" ? payload.summary : null,
    typeof payload.body === "string" ? payload.body : null,
    typeof payload.domain === "string" ? payload.domain : null,
    typeof payload.estimatedCost === "string" ? payload.estimatedCost : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (!text) {
    return false;
  }

  const procurementKeywords = [
    "domain registration",
    "custom domain",
    "branded inbox",
    "google workspace",
    "workspace business",
    "notion",
    "calendly",
    "docusign",
    "support inbox",
    "sales inbox",
    "email setup",
    "paid tool",
    "purchase domain",
    "register domain",
    "pipeline tools",
  ];

  return procurementKeywords.some((keyword) => text.includes(keyword));
}

async function updateAgentLifecycleState(
  env: Env,
  agentId: string,
  fields: {
    status?: string;
    lastWakeAt?: string | null;
    lastSleepAt?: string | null;
  },
  metadataPatch?: Record<string, unknown> | null,
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT metadata
     FROM agents
     WHERE id = ?
     LIMIT 1`,
  ).bind(agentId).first<{ metadata: string | null }>();

  const updates: string[] = ["updated_at = datetime('now')"];
  const bindings: Array<string | null> = [];

  if (fields.status !== undefined) {
    updates.push("status = ?");
    bindings.push(fields.status);
  }

  if (fields.lastWakeAt !== undefined) {
    updates.push("last_wake_at = ?");
    bindings.push(fields.lastWakeAt);
  }

  if (fields.lastSleepAt !== undefined) {
    updates.push("last_sleep_at = ?");
    bindings.push(fields.lastSleepAt);
  }

  if (metadataPatch) {
    updates.push("metadata = ?");
    bindings.push(mergeAgentMetadata(existing?.metadata, metadataPatch));
  }

  bindings.push(agentId);

  await env.DB.prepare(
    `UPDATE agents
     SET ${updates.join(", ")}
     WHERE id = ?`,
  ).bind(...bindings).run();
}

async function ensureSingleRunningTaskForAgent(
  env: Env,
  companyId: string,
  ownerAgentId: string,
  keepTaskId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks
     SET status = 'todo',
         blocked_on = NULL,
         updated_at = datetime('now')
     WHERE company_id = ?
       AND owner_agent_id = ?
       AND id <> ?
       AND status = 'in_progress'`,
  ).bind(companyId, ownerAgentId, keepTaskId).run();
}

function resolveBlueprintModelTier(body: {
  blueprintId?: string;
  role?: string;
  modelTier?: string;
}): "sonnet" {
  return "sonnet";
}

export async function resolveSupervisorReportsTo(
  env: Env,
  companyId: string,
  reportsTo: string | null | undefined,
): Promise<string | null> {
  if (!reportsTo) {
    return null;
  }

  const directMatch = await env.DB.prepare(
    `SELECT id
     FROM agents
     WHERE company_id = ?
       AND id = ?
     LIMIT 1`,
  )
    .bind(companyId, reportsTo)
    .first<{ id: string }>();

  if (directMatch?.id) {
    return directMatch.id;
  }

  const hierarchyMatch = await env.DB.prepare(
    `SELECT id
     FROM agents
     WHERE company_id = ?
       AND (role = ? OR blueprint_id = ?)
     ORDER BY CASE WHEN role = ? THEN 0 ELSE 1 END, created_at ASC
     LIMIT 1`,
  )
    .bind(companyId, reportsTo, reportsTo, reportsTo)
    .first<{ id: string }>();

  if (hierarchyMatch?.id) {
    return hierarchyMatch.id;
  }

  return null;
}

// ─── Companies ───────────────────────────────────────────────

/** GET /api/supervisor/companies — list active companies */
export async function handleSupervisorListCompanies(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const userId = new URL(request.url).searchParams.get("userId");

  const result = userId
    ? await env.DB.prepare(
      `SELECT id, user_id, name, state, container_id, goal, genesis_prompt, mode
       FROM companies
       WHERE state NOT IN ('dead', 'failed')
         AND user_id = ?`,
    ).bind(userId).all()
    : await env.DB.prepare(
      `SELECT id, user_id, name, state, container_id, goal, genesis_prompt, mode
       FROM companies WHERE state NOT IN ('dead', 'failed')`,
    ).all();

  return Response.json(
    { companies: result.results },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/dedicated-vm/register — mark a dedicated VM ready and cut traffic over */
export async function handleSupervisorRegisterDedicatedVm(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = await readOptionalJsonBody<{
    userId?: string;
    serverId?: string;
    serverName?: string;
    serverIp?: string;
  }>(request);

  const userId = pickString(body.userId);
  const reportedServerIp = pickString(body.serverIp);
  const reportedServerId = pickString(body.serverId);
  const reportedServerName = pickString(body.serverName);

  if (!userId || !reportedServerIp) {
    return Response.json(
      { error: "userId and serverIp are required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const resolvedServer = reportedServerId
    ? { serverId: reportedServerId, serverIp: reportedServerIp }
    : reportedServerName
      ? await resolveHetznerServerByName(env, reportedServerName)
      : { serverId: null, serverIp: reportedServerIp };

  const serverId = resolvedServer.serverId ?? reportedServerId ?? reportedServerName ?? null;
  const serverIp = resolvedServer.serverIp ?? reportedServerIp;
  const dedicatedBaseUrl = dedicatedSupervisorBaseUrl(serverIp);
  const companies = await listUserDedicatedCompanies(env, userId);

  if (companies.length === 0) {
    return Response.json(
      { error: "No dedicated-tier companies found for user" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  await setUserDedicatedVmState(env, userId, {
    status: "provisioning",
    serverId,
    serverIp,
  });

  try {
    for (const company of companies) {
      const agentCountRow = await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM agents
         WHERE company_id = ?`,
      )
        .bind(company.id)
        .first<{ count: number }>();
      const agentCount = agentCountRow?.count ?? 0;

      if (agentCount === 0) {
        const provisionResponse = await fetch(
          `${dedicatedBaseUrl}/companies/${company.id}/provision`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
            },
            body: JSON.stringify({ companyName: company.name }),
          },
        );

        if (!provisionResponse.ok) {
          throw new Error(
            `Dedicated provision failed for ${company.id}: ${await provisionResponse.text()}`,
          );
        }

        const provisionedCompany = await env.DB.prepare(
          `SELECT *
           FROM companies
           WHERE id = ?
           LIMIT 1`,
        ).bind(company.id).first<CompanyRow>();

        if (provisionedCompany) {
          await bootstrapProvisionedCompany(provisionedCompany, env, ctx);
        }
        continue;
      }

      await migrateCompanyWorkspaceToDedicatedVm(env, company, serverIp);

      const lifecycleAction = company.state === "paused"
        ? "pause"
        : company.state === "running"
          ? "resume"
          : null;
      if (lifecycleAction) {
        await fetch(`${dedicatedBaseUrl}/companies/${company.id}/${lifecycleAction}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
          },
        }).catch(() => {});
      }
    }

    await setUserDedicatedVmState(env, userId, {
      status: "active",
      serverId,
      serverIp,
    });

    return Response.json(
      {
        registered: true,
        userId,
        serverId,
        serverIp,
        companies: companies.map((company) => company.id),
      },
      { headers: corsHeaders(env) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setUserDedicatedVmState(env, userId, {
      status: "failed",
      serverId,
      serverIp,
    });

    await Promise.allSettled(
      companies.map((company) =>
        env.DB.prepare(
          `INSERT INTO activity_log (id, company_id, type, summary, details)
           VALUES (?, ?, 'error', ?, ?)`,
        )
          .bind(
            generateId(),
            company.id,
            "Dedicated VM registration failed",
            JSON.stringify({ error: message, serverIp, serverId }),
          )
          .run()),
    );

    return Response.json(
      { error: message },
      { status: 500, headers: corsHeaders(env) },
    );
  }
}

/** PATCH /api/supervisor/companies/:id — update company state */
export async function handleSupervisorUpdateCompany(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as { state?: string };

  if (body.state) {
    await env.DB.prepare(
      `UPDATE companies SET state = ?, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(body.state, companyId)
      .run();
  }

  return Response.json({ updated: true }, { headers: corsHeaders(env) });
}

/** POST /api/supervisor/companies/:id/bootstrap — rerun launch bootstrap */
export async function handleSupervisorBootstrapCompany(
  request: Request,
  env: Env,
  companyId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const company = await env.DB.prepare(
    `SELECT *
     FROM companies
     WHERE id = ?
     LIMIT 1`,
  ).bind(companyId).first<CompanyRow>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  try {
    await bootstrapProvisionedCompany(company, env, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        bootstrapped: false,
        companyId,
        error: message,
      },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  return Response.json(
    { bootstrapped: true, companyId },
    { headers: corsHeaders(env) },
  );
}

// ─── Agents ──────────────────────────────────────────────────

/** GET /api/supervisor/companies/:id/agents — list company agents */
export async function handleSupervisorListAgents(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const result = await env.DB.prepare(
    `SELECT id, company_id, name, role, title, status, reports_to,
            blueprint_id, model_tier, total_credits_consumed,
            last_wake_at, last_sleep_at, department, metadata,
            webhook_url, adapter_type, source, instructions
     FROM agents WHERE company_id = ?`,
  )
    .bind(companyId)
    .all();

  return Response.json(
    { agents: result.results },
    { headers: corsHeaders(env) },
  );
}

/** PATCH /api/supervisor/agents/:id — update agent status */
export async function handleSupervisorUpdateAgent(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    status?: string;
    metadataPatch?: Record<string, unknown> | null;
    lastWakeAt?: string | null;
    lastSleepAt?: string | null;
    reportsTo?: string | null;
  };

  // Verify agent exists in D1 — return 404 if not, so the supervisor's sync
  // manager falls back to POST (create) instead of silently succeeding.
  const exists = await env.DB.prepare(
    `SELECT id FROM agents WHERE id = ? LIMIT 1`,
  ).bind(agentId).first<{ id: string }>();
  if (!exists) {
    return Response.json(
      { error: "Agent not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  if (body.status || body.metadataPatch || body.lastWakeAt !== undefined || body.lastSleepAt !== undefined) {
    await updateAgentLifecycleState(
      env,
      agentId,
      { status: body.status, lastWakeAt: body.lastWakeAt, lastSleepAt: body.lastSleepAt },
      body.metadataPatch,
    );
  }

  // Update reports_to hierarchy when synced from supervisor backfill
  if (body.reportsTo !== undefined) {
    await env.DB.prepare(
      `UPDATE agents SET reports_to = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(body.reportsTo, agentId).run();
  }

  return Response.json({ updated: true }, { headers: corsHeaders(env) });
}

/** POST /api/supervisor/agents/:id/wake — record agent wake */
export async function handleSupervisorAgentWake(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = await readOptionalJsonBody<{
    metadataPatch?: Record<string, unknown> | null;
  }>(request);

  await updateAgentLifecycleState(
    env,
    agentId,
    {
      lastWakeAt: new Date().toISOString(),
      status: "running",
    },
    body.metadataPatch,
  );

  return Response.json({ recorded: true }, { headers: corsHeaders(env) });
}

/** POST /api/supervisor/agents/:id/sleep — record agent sleep */
export async function handleSupervisorAgentSleep(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = await readOptionalJsonBody<{
    metadataPatch?: Record<string, unknown> | null;
    status?: string;
  }>(request);
  const nextStatus =
    body.status === "paused" || body.status === "idle" || body.status === "free"
      ? body.status
      : "idle";

  await updateAgentLifecycleState(
    env,
    agentId,
    {
      lastSleepAt: new Date().toISOString(),
      status: nextStatus,
    },
    body.metadataPatch,
  );

  return Response.json({ recorded: true }, { headers: corsHeaders(env) });
}

/** POST /api/supervisor/agents/:id/avatar — generate/store a missing avatar */
export async function handleSupervisorGenerateAgentAvatar(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const agent = await env.DB.prepare(
    `SELECT a.id, a.name, a.title, a.icon, c.user_id
     FROM agents a
     JOIN companies c ON c.id = a.company_id
     WHERE a.id = ?
     LIMIT 1`,
  ).bind(agentId).first<{
    id: string;
    name: string;
    title: string | null;
    icon: string | null;
    user_id: string;
  }>();

  if (!agent) {
    return Response.json(
      { error: "Agent not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const storedAvatarExists = await hasStoredAvatar(agent.id, env);
  if (storedAvatarExists) {
    return Response.json(
      { generated: false, avatarUrl: `/api/avatars/${agent.id}` },
      { headers: corsHeaders(env) },
    );
  }

  if (agent.icon && !agent.icon.startsWith("/api/avatars/")) {
    return Response.json(
      { generated: false, avatarUrl: agent.icon },
      { headers: corsHeaders(env) },
    );
  }

  if (!avatarGenerationEnabled(env)) {
    return Response.json(
      { error: "No avatar generation provider configured" },
      { status: 500, headers: corsHeaders(env) },
    );
  }

  const { country, countryName } = await resolveFounderCountryContext(env, agent.user_id);

  const avatarBase64 = await generateAgentAvatar(
    agent.name,
    agent.title || "Agent",
    countryName,
    env,
    {
      agentId: agent.id,
      mode: "manual",
      countryCode: country,
    },
  );

  if (!avatarBase64) {
    return Response.json(
      { error: "Avatar generation returned no image" },
      { status: 502, headers: corsHeaders(env) },
    );
  }

  const avatarUrl = await storeAvatar(agent.id, avatarBase64, env);
  await env.DB.prepare(
    `UPDATE agents
     SET icon = ?,
         metadata = json_set(COALESCE(metadata, '{}'), '$.avatar_generated', 1),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(avatarUrl, agent.id).run();

  return Response.json(
    { generated: true, avatarUrl },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/avatar-pool/warm — refill the pooled launch avatars */
export async function handleSupervisorWarmAvatarPool(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) {
    return unauthorized(env);
  }

  const body = await readOptionalJsonBody<{
    minimumReady?: number;
    maxGenerate?: number;
  }>(request);

  const result = await ensureAvatarPoolWarm(env, {
    minimumReady: typeof body.minimumReady === "number" ? body.minimumReady : undefined,
    maxGenerate: typeof body.maxGenerate === "number" ? body.maxGenerate : undefined,
  });

  return Response.json(result, { headers: corsHeaders(env) });
}

/** POST /api/supervisor/companies/:id/agents — create agent from blueprint */
export async function handleSupervisorCreateAgent(
  request: Request,
  env: Env,
  companyId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  try {
    const body = (await request.json()) as {
      id?: string;
      blueprintId: string;
      name: string;
      role: string;
      title: string;
      department: string;
      reportsTo: string | null;
      modelTier: string;
    };

    const company = await env.DB.prepare(
      `SELECT user_id, name, email_domain, goal, genesis_prompt, idea, runtime_tier,
              hosted_domain, custom_domain_candidate, custom_domain_status
       FROM companies
       WHERE id = ?
       LIMIT 1`,
    ).bind(companyId).first<{
      user_id: string;
      name: string;
      email_domain: string | null;
      goal: string | null;
      genesis_prompt: string | null;
      idea: string | null;
      runtime_tier: string | null;
      hosted_domain: string | null;
      custom_domain_candidate: string | null;
      custom_domain_status: string | null;
    }>();

    if (!company) {
      return Response.json(
        { error: "Company not found" },
        { status: 404, headers: corsHeaders(env) },
      );
    }

    const providedId = body.id?.trim() || null;
    if (providedId) {
      const existing = await env.DB.prepare(
        `SELECT id, company_id, name, role, title, status, reports_to,
                blueprint_id, model_tier, icon, total_credits_consumed,
                last_wake_at, last_sleep_at, department
         FROM agents
         WHERE id = ?
         LIMIT 1`,
      ).bind(providedId).first();

      if (existing) {
        return Response.json(
          { agent: existing },
          { headers: corsHeaders(env) },
        );
      }
    }

    const agentId = providedId || generateId();
    const modelTier = resolveBlueprintModelTier(body);
    const reportsToAgentId = await resolveSupervisorReportsTo(
      env,
      companyId,
      body.reportsTo,
    );

    const isFoundingAgent = FOUNDING_BLUEPRINT_IDS.has(body.blueprintId);
    const existingNamesResult = await env.DB.prepare(
      `SELECT name
       FROM agents
       WHERE company_id = ?`,
    ).bind(companyId).all<{ name: string }>();
    const existingNames = (existingNamesResult.results ?? [])
      .map((row) => row.name.trim())
      .filter(Boolean);

    const founderCountry = await resolveFounderCountryContext(env, company.user_id);
    const country = founderCountry.country;
    const countryName = founderCountry.countryName;
    const personalizedName = !isFoundingAgent
      ? await generateSpecialistAgentName(
        country,
        countryName,
        company.name || "the company",
        body.blueprintId,
        body.title,
        existingNames,
        env,
      )
      : body.name;

    const emailAddress = await reserveAgentEmailAddress(
      env,
      companyId,
      company.email_domain ?? null,
      {
        blueprintId: body.blueprintId,
        role: body.role,
        title: body.title,
        name: personalizedName,
      },
    );

    try {
      await env.DB.prepare(
        `INSERT INTO agents (
           id, company_id, name, role, title, icon, status, reports_to,
           blueprint_id, model_tier, department, email_address
         )
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)`,
      )
        .bind(
          agentId,
          companyId,
          personalizedName,
          body.role,
          body.title,
          `/api/avatars/${agentId}`,
          reportsToAgentId,
          body.blueprintId,
          modelTier,
          body.department,
          emailAddress,
        )
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("UNIQUE constraint failed: agents.id")) {
        throw error;
      }

      const existing = await env.DB.prepare(
        `SELECT id, company_id, name, role, title, status, reports_to,
                blueprint_id, model_tier, icon, total_credits_consumed,
                last_wake_at, last_sleep_at, department
         FROM agents
         WHERE id = ?
         LIMIT 1`,
      ).bind(agentId).first();

      if (existing) {
        return Response.json(
          { agent: existing },
          { headers: corsHeaders(env) },
        );
      }

      throw error;
    }

    const backgroundProvisioning = async () => {
      try {
        await ensureAutonomousWakeSchedules(
          {
            id: companyId,
            name: company.name,
            goal: company.goal,
            genesis_prompt: company.genesis_prompt,
            idea: company.idea,
            status: "provisioning",
            spentCents: 0,
            budgetCents: 0,
            user_id: company.user_id,
            publicVisible: true,
            hostedDomain: company.hosted_domain ?? null,
            emailDomain: company.email_domain ?? null,
            customDomain: null,
            customDomainCandidate: company.custom_domain_candidate ?? null,
            customDomainStatus: company.custom_domain_status ?? null,
            conwaySandboxId: null,
            runtime_tier: company.runtime_tier ?? "shared",
            dedicated_vm_status: "shared",
            dedicated_vm_id: null,
            dedicated_vm_ip: null,
            egress_tier: "standard",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as unknown as CompanyRow,
          env,
          [{
            id: agentId,
            name: personalizedName,
            title: body.title,
            role: body.role,
            blueprint_id: body.blueprintId,
            icon: `/api/avatars/${agentId}`,
            metadata: JSON.stringify({
              founding_identity_ready: false,
              avatar_generated: false,
            }),
            email_address: emailAddress,
            last_wake_at: null,
          }],
        );
      } catch (err) {
        console.error(
          `[cron] Failed to ensure autonomous schedule for ${personalizedName} (${agentId}):`,
          err instanceof Error ? err.message : err,
        );
      }

      if (emailAddress) {
        try {
          const inbox = await ensureAgentmailInbox(env, {
            emailAddress,
            displayName: personalizedName,
          });
          if (!inbox.shared) {
            await rememberAgentmailInboxOwner(env, inbox.inbox_id, {
              companyId,
              agentId,
              aliasEmail: emailAddress,
            });
          }
        } catch (err) {
          console.error(
            `[agentmail] Failed to ensure inbox for ${personalizedName} (${emailAddress}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      if (!isFoundingAgent && avatarGenerationEnabled(env)) {
        try {
          if (!(await hasStoredAvatar(agentId, env))) {
            const avatarBase64 = await generateAgentAvatar(
              personalizedName,
              body.title || "Agent",
              countryName,
              env,
              {
                agentId,
                mode: "automatic",
                countryCode: country,
              },
            );

            if (avatarBase64) {
              const avatarUrl = await storeAvatar(agentId, avatarBase64, env);
              await env.DB.prepare(
                `UPDATE agents
                 SET icon = ?,
                     metadata = json_set(COALESCE(metadata, '{}'), '$.avatar_generated', 1),
                     updated_at = datetime('now')
                 WHERE id = ?`,
              ).bind(avatarUrl, agentId).run();
            }
          }
        } catch (err) {
          console.error(
            `[avatar] Failed to generate avatar for ${personalizedName} (${agentId}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    };

    if (ctx) {
      ctx.waitUntil(backgroundProvisioning());
    } else {
      void backgroundProvisioning();
    }

    const agent = await env.DB.prepare(
      `SELECT id, company_id, name, role, title, status, reports_to,
              blueprint_id, model_tier, icon, total_credits_consumed,
              last_wake_at, last_sleep_at, department
       FROM agents WHERE id = ?`,
    )
      .bind(agentId)
      .first();

    return Response.json(
      { agent },
      { status: 201, headers: corsHeaders(env) },
    );
  } catch (error) {
    console.error(
      `[supervisor] create-agent mirror failed for ${companyId}:`,
      error instanceof Error ? error.stack || error.message : error,
    );
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create agent" },
      { status: 500, headers: corsHeaders(env) },
    );
  }
}

/** GET /api/supervisor/companies/:id/info — get company details */
export async function handleSupervisorGetCompany(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const company = await env.DB.prepare(
    `SELECT id, user_id, name, state, container_id, goal, idea, genesis_prompt, mode
     FROM companies WHERE id = ?`,
  )
    .bind(companyId)
    .first();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  return Response.json(
    { company },
    { headers: corsHeaders(env) },
  );
}

/** GET /api/supervisor/companies/:id/founder-chats — recent founder chat history */
export async function handleSupervisorListFounderChats(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") || "6", 10) || 6, 1),
    12,
  );

  let entries: Array<{
    id: string;
    founderMessage: string;
    ceoReply: string | null;
    status: string;
    error: string | null;
    createdAt: string;
  }> = [];

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, founder_message, ceo_reply, status, error, created_at
       FROM founder_conversations
       WHERE company_id = ?
         AND kind = 'founder_chat'
       ORDER BY created_at DESC
       LIMIT ?`,
    ).bind(companyId, limit).all<{
      id: string;
      founder_message: string | null;
      ceo_reply: string | null;
      status: string | null;
      error: string | null;
      created_at: string;
    }>();

    entries = (results ?? [])
      .map((row) => ({
        id: row.id,
        founderMessage: row.founder_message || "",
        ceoReply: row.ceo_reply || null,
        status: row.status || "complete",
        error: row.error || null,
        createdAt: row.created_at,
      }))
      .filter((entry) => entry.founderMessage)
      .reverse();
  } catch {
    const { results } = await env.DB.prepare(
      `SELECT id, details, created_at
       FROM activity_log
       WHERE company_id = ?
         AND type = 'founder_chat'
       ORDER BY created_at DESC
       LIMIT ?`,
    ).bind(companyId, limit).all<{ id: string; details: string | null; created_at: string }>();

    entries = (results ?? [])
      .map((row) => {
        const details = row.details
          ? JSON.parse(row.details) as {
              message?: string;
              reply?: string | null;
              status?: "pending" | "complete" | "error";
              error?: string | null;
            }
          : {};

        return {
          id: row.id,
          founderMessage: details.message || "",
          ceoReply: details.reply || null,
          status: details.status || "complete",
          error: details.error || null,
          createdAt: row.created_at,
        };
      })
      .filter((entry) => entry.founderMessage)
      .reverse();
  }

  return Response.json(
    { entries },
    { headers: corsHeaders(env) },
  );
}

/** GET /api/supervisor/companies/:id/chat-messages — durable CEO-originated founder-visible notices */
export async function handleSupervisorListChatMessages(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  let messages: Array<{
    id: string;
    role: "ceo";
    content: string;
    createdAt: string;
    agentId: string | null;
  }> = [];

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, ceo_reply, agent_id, created_at
       FROM founder_conversations
       WHERE company_id = ?
         AND kind = 'ceo_notice'
       ORDER BY created_at ASC
       LIMIT 100`,
    ).bind(companyId).all<{
      id: string;
      ceo_reply: string | null;
      agent_id: string | null;
      created_at: string;
    }>();

    messages = (results ?? [])
      .map((row) => {
        if (!row.ceo_reply?.trim()) {
          return null;
        }
        return {
          id: row.id,
          role: "ceo" as const,
          content: row.ceo_reply.trim(),
          createdAt: row.created_at,
          agentId: row.agent_id ?? null,
        };
      })
      .filter((entry): entry is {
        id: string;
        role: "ceo";
        content: string;
        createdAt: string;
        agentId: string | null;
      } => Boolean(entry));
  } catch {
    const { results } = await env.DB.prepare(
      `SELECT id, details, created_at
       FROM activity_log
       WHERE company_id = ?
         AND type = 'ceo_message'
       ORDER BY created_at ASC
       LIMIT 100`,
    ).bind(companyId).all<{ id: string; details: string | null; created_at: string }>();

    messages = (results ?? [])
      .map((row) => {
        const details = row.details
          ? JSON.parse(row.details) as { content?: string; agent_id?: string | null }
          : {};
        if (!details.content?.trim()) {
          return null;
        }
        return {
          id: row.id,
          role: "ceo" as const,
          content: details.content.trim(),
          createdAt: row.created_at,
          agentId: details.agent_id ?? null,
        };
      })
      .filter((entry): entry is {
        id: string;
        role: "ceo";
        content: string;
        createdAt: string;
        agentId: string | null;
      } => Boolean(entry));
  }

  return Response.json({ messages }, { headers: corsHeaders(env) });
}

/** POST /api/supervisor/companies/:id/chat-messages — mirror CEO-originated founder-visible notices */
export async function handleSupervisorCreateChatMessage(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    id?: string;
    role?: string;
    content?: string;
    created_at?: string;
    agent_id?: string | null;
    agentId?: string | null;
  };

  if (body.role !== "ceo" || !body.content?.trim()) {
    return Response.json(
      { error: "role=ceo and content are required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const id = body.id?.trim() || generateId();
  const agentId = body.agent_id ?? body.agentId ?? null;
  const createdAt = body.created_at?.trim() || new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO founder_conversations (id, company_id, kind, founder_message, ceo_reply, status, grounded, agent_id, created_at, updated_at)
     VALUES (?, ?, 'ceo_notice', NULL, ?, 'complete', 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       ceo_reply = excluded.ceo_reply,
       agent_id = excluded.agent_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  ).bind(
    id,
    companyId,
    body.content.trim(),
    agentId,
    createdAt,
    createdAt,
  ).run();

  return Response.json({ ok: true, id }, { headers: corsHeaders(env) });
}

/** GET /api/supervisor/companies/:id/tasks — normalized live task snapshot */
export async function handleSupervisorListMilestones(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const { results } = await env.DB.prepare(
    `SELECT *
     FROM milestones
     WHERE company_id = ?
     ORDER BY sort_order ASC, created_at ASC`,
  ).bind(companyId).all<Record<string, unknown>>();

  const milestones = (results ?? []).map((row) => ({
    id: String(row.id ?? ""),
    company_id: String(row.company_id ?? ""),
    title: String(row.title ?? ""),
    description: typeof row.description === "string" ? row.description : null,
    sort_order: Number(row.sort_order ?? 0),
    status: String(row.status ?? "pending"),
    created_by: String(row.created_by ?? "system"),
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
  }));

  return Response.json(
    { milestones },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/companies/:id/milestones — create milestone state */
export async function handleSupervisorCreateMilestone(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    id?: string;
    title?: string;
    description?: string | null;
    sort_order?: number;
    status?: string;
    created_by?: string;
    created_at?: string;
    completed_at?: string | null;
  };

  if (!body.title?.trim()) {
    return Response.json(
      { error: "title is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const id = body.id?.trim() || generateId();
  await env.DB.prepare(
    `INSERT INTO milestones (
       id, company_id, title, description, sort_order, status, created_by, created_at, completed_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       company_id = excluded.company_id,
       title = excluded.title,
       description = excluded.description,
       sort_order = excluded.sort_order,
       status = excluded.status,
       created_by = excluded.created_by,
       created_at = excluded.created_at,
       completed_at = excluded.completed_at`,
  ).bind(
    id,
    companyId,
    body.title.trim(),
    body.description || null,
    Number.isFinite(body.sort_order) ? body.sort_order : 0,
    body.status || "pending",
    body.created_by || "system",
    body.created_at || new Date().toISOString(),
    body.completed_at || null,
  ).run();

  return Response.json(
    { id },
    { status: 201, headers: corsHeaders(env) },
  );
}

/** PATCH /api/supervisor/milestones/:id — update milestone workflow state */
export async function handleSupervisorUpdateMilestone(
  request: Request,
  env: Env,
  milestoneId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    title?: string;
    description?: string | null;
    sort_order?: number;
    status?: string;
    completed_at?: string | null;
  };

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(body.title.trim());
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    values.push(body.description || null);
  }
  if (body.sort_order !== undefined) {
    updates.push("sort_order = ?");
    values.push(body.sort_order);
  }
  if (body.status !== undefined) {
    updates.push("status = ?");
    values.push(body.status);
  }
  if (body.completed_at !== undefined) {
    updates.push("completed_at = ?");
    values.push(body.completed_at || null);
  }

  if (updates.length === 0) {
    return Response.json(
      { error: "No valid fields to update" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Verify milestone exists — return 404 so supervisor sync falls back to POST (create)
  const exists = await env.DB.prepare(
    `SELECT id FROM milestones WHERE id = ? LIMIT 1`,
  ).bind(milestoneId).first<{ id: string }>();
  if (!exists) {
    return Response.json(
      { error: "Milestone not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  values.push(milestoneId);
  await env.DB.prepare(
    `UPDATE milestones SET ${updates.join(", ")} WHERE id = ?`,
  ).bind(...values).run();

  return Response.json({ updated: true }, { headers: corsHeaders(env) });
}

/** GET /api/supervisor/companies/:id/tasks — normalized live task snapshot */
export async function handleSupervisorListTasks(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1),
    200,
  );

  const { results } = await env.DB.prepare(
    `SELECT *
     FROM tasks
     WHERE company_id = ?
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(companyId, limit).all<Record<string, unknown>>();

  const tasks = (results ?? []).map((row) => ({
    id: String(row.id ?? ""),
    company_id: companyId,
    milestone_id: typeof row.milestone_id === "string" ? row.milestone_id : null,
    title: String(row.title ?? ""),
    description:
      typeof row.description === "string" ? row.description : null,
    acceptance_criteria:
      typeof row.acceptance_criteria === "string"
        ? row.acceptance_criteria
        : "Produce the requested artifact or a concrete blocking reason.",
    depends_on:
      typeof row.depends_on === "string" && row.depends_on.trim().length > 0
        ? row.depends_on
        : "[]",
    status: String(row.status ?? "pending"),
    owner_agent_id:
      typeof row.owner_agent_id === "string" ? row.owner_agent_id : null,
    blocked_reason:
      typeof row.blocked_reason === "string"
        ? row.blocked_reason
        : typeof row.blocked_on === "string"
          ? row.blocked_on
          : null,
    artifact:
      typeof row.artifact === "string" ? row.artifact : null,
    credits_spent: Number(row.credits_spent ?? 0),
    turns_spent: Number(row.turns_spent ?? 0),
    created_by:
      typeof row.created_by === "string"
        ? row.created_by
        : typeof row.owner_agent_id === "string"
          ? row.owner_agent_id
          : "system",
    created_at:
      typeof row.created_at === "string"
        ? row.created_at
        : typeof row.updated_at === "string"
          ? row.updated_at
          : new Date().toISOString(),
    started_at: typeof row.started_at === "string" ? row.started_at : null,
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
    updated_at:
      typeof row.updated_at === "string" ? row.updated_at : "",
  }));

  return Response.json(
    { tasks },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/companies/:id/tasks — create a live task */
export async function handleSupervisorCreateTask(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    id?: string;
    milestone_id?: string | null;
    title?: string;
    description?: string | null;
    acceptance_criteria?: string | null;
    depends_on?: string | null;
    owner_agent_id?: string | null;
    parent_task_id?: string | null;
    status?: string;
    blocked_reason?: string | null;
    artifact?: string | null;
    created_by?: string | null;
    priority?: string;
    credits_spent?: number;
    turns_spent?: number;
    created_at?: string;
    started_at?: string | null;
    completed_at?: string | null;
  };

  if (!body.title?.trim()) {
    return Response.json(
      { error: "title is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const id = body.id?.trim() || generateId();
  const requestedMilestoneId = body.milestone_id?.trim() || null;
  const milestoneId = requestedMilestoneId
    ? (await env.DB.prepare(
      `SELECT id
       FROM milestones
       WHERE id = ?
       LIMIT 1`,
    ).bind(requestedMilestoneId).first<{ id: string }>())?.id ?? requestedMilestoneId
    : null;
  const requestedOwnerAgentId = body.owner_agent_id?.trim() || null;
  const ownerAgentId = requestedOwnerAgentId
    ? (await env.DB.prepare(
      `SELECT id
       FROM agents
       WHERE id = ?
       LIMIT 1`,
    ).bind(requestedOwnerAgentId).first<{ id: string }>())?.id ?? requestedOwnerAgentId
    : null;
  const requestedParentTaskId = body.parent_task_id?.trim() || null;
  const parentTaskId = requestedParentTaskId
    ? (await env.DB.prepare(
      `SELECT id
       FROM tasks
       WHERE id = ?
       LIMIT 1`,
    ).bind(requestedParentTaskId).first<{ id: string }>())?.id ?? requestedParentTaskId
    : null;

  await env.DB.prepare(
    `INSERT INTO tasks (
       id, company_id, milestone_id, title, description, acceptance_criteria,
       depends_on, owner_agent_id, status, blocked_on, artifact, parent_task_id,
       created_by, priority, credits_spent, turns_spent, created_at, started_at, completed_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       company_id = excluded.company_id,
       milestone_id = excluded.milestone_id,
       title = excluded.title,
       description = excluded.description,
       acceptance_criteria = excluded.acceptance_criteria,
       depends_on = excluded.depends_on,
       owner_agent_id = excluded.owner_agent_id,
       status = excluded.status,
       blocked_on = excluded.blocked_on,
       artifact = excluded.artifact,
       parent_task_id = excluded.parent_task_id,
       created_by = excluded.created_by,
       priority = excluded.priority,
       credits_spent = excluded.credits_spent,
       turns_spent = excluded.turns_spent,
       created_at = excluded.created_at,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       updated_at = datetime('now')`,
  ).bind(
    id,
    companyId,
    milestoneId,
    body.title.trim(),
    body.description || null,
    body.acceptance_criteria?.trim() || "Produce the requested artifact or a concrete blocking reason.",
    body.depends_on?.trim() || "[]",
    ownerAgentId,
    body.status || "pending",
    body.blocked_reason || null,
    body.artifact || null,
    parentTaskId,
    body.created_by || ownerAgentId || "system",
    body.priority || "medium",
    Number.isFinite(body.credits_spent) ? body.credits_spent : 0,
    Number.isFinite(body.turns_spent) ? body.turns_spent : 0,
    body.created_at || new Date().toISOString(),
    body.started_at || null,
    body.completed_at || null,
  ).run();

  if (body.status === "in_progress" && ownerAgentId) {
    await ensureSingleRunningTaskForAgent(
      env,
      companyId,
      ownerAgentId,
      id,
    );
  }

  return Response.json(
    { id },
    { status: 201, headers: corsHeaders(env) },
  );
}

/** GET /api/supervisor/companies/:id/messages — structured agent inbox */
export async function handleSupervisorListMessages(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId");
  if (!agentId) {
    return Response.json(
      { error: "agentId is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1),
    100,
  );
  const status = url.searchParams.get("status");

  let query = `SELECT m.*,
      fa.name AS from_name, fa.role AS from_role,
      ta.name AS to_name, ta.role AS to_role
    FROM agent_messages m
    LEFT JOIN agents fa ON fa.id = m.from_agent_id
    LEFT JOIN agents ta ON ta.id = m.to_agent_id
    WHERE m.company_id = ?
      AND m.to_agent_id = ?`;
  const bindings: unknown[] = [companyId, agentId];

  if (status) {
    query += " AND m.status = ?";
    bindings.push(status);
  }

  query += " ORDER BY m.created_at ASC LIMIT ?";
  bindings.push(limit);

  const { results } = await env.DB.prepare(query).bind(...bindings).all<Record<string, unknown>>();

  const messages = (results ?? []).map((row) => ({
    id: String(row.id ?? ""),
    company_id: String(row.company_id ?? ""),
    from_agent_id: String(row.from_agent_id ?? ""),
    to_agent_id: String(row.to_agent_id ?? ""),
    from_name: typeof row.from_name === "string" ? row.from_name : null,
    from_role: typeof row.from_role === "string" ? row.from_role : null,
    to_name: typeof row.to_name === "string" ? row.to_name : null,
    to_role: typeof row.to_role === "string" ? row.to_role : null,
    type: String(row.type ?? "message"),
    subject: typeof row.subject === "string" ? row.subject : null,
    body: String(row.body ?? ""),
    priority: String(row.priority ?? "normal"),
    status: String(row.status ?? "unread"),
    parent_message_id:
      typeof row.parent_message_id === "string" ? row.parent_message_id : null,
    metadata: typeof row.metadata === "string" && row.metadata
      ? JSON.parse(row.metadata)
      : null,
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    read_at: typeof row.read_at === "string" ? row.read_at : null,
  }));

  return Response.json(
    { messages },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/companies/:id/messages — create structured agent message */
export async function handleSupervisorCreateMessage(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    id?: string;
    fromAgentId?: string;
    toAgentId?: string;
    type?: string;
    subject?: string | null;
    body?: string;
    priority?: string;
    parentMessageId?: string | null;
    metadata?: Record<string, unknown> | null;
  };

  if (!body.fromAgentId || !body.toAgentId || !body.body?.trim()) {
    return Response.json(
      { error: "fromAgentId, toAgentId, and body are required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const id = body.id?.trim() || generateId();
  if (body.id?.trim()) {
    const existing = await env.DB.prepare(
      `SELECT id
       FROM agent_messages
       WHERE id = ?
       LIMIT 1`,
    ).bind(id).first<{ id: string }>();

    if (existing?.id) {
      return Response.json(
        { id },
        { headers: corsHeaders(env) },
      );
    }
  }

  await env.DB.prepare(
    `INSERT INTO agent_messages (
       id, company_id, from_agent_id, to_agent_id, type,
       subject, body, priority, status, parent_message_id, metadata
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)`,
  ).bind(
    id,
    companyId,
    body.fromAgentId,
    body.toAgentId,
    body.type || "message",
    body.subject || null,
    body.body.trim(),
    body.priority || "normal",
    body.parentMessageId || null,
    body.metadata ? JSON.stringify(body.metadata) : null,
  ).run();

  return Response.json(
    { id },
    { status: 201, headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/messages/:id/ack — mark agent message as acknowledged */
export async function handleSupervisorAcknowledgeMessage(
  request: Request,
  env: Env,
  messageId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  await env.DB.prepare(
    `UPDATE agent_messages
     SET status = 'acknowledged',
         read_at = COALESCE(read_at, datetime('now'))
     WHERE id = ?`,
  ).bind(messageId).run();

  return Response.json({ updated: true }, { headers: corsHeaders(env) });
}

/** PATCH /api/supervisor/tasks/:id — update live task workflow state */
export async function handleSupervisorUpdateTask(
  request: Request,
  env: Env,
  taskId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    milestone_id?: string | null;
    status?: string;
    owner_agent_id?: string | null;
    blocked_reason?: string | null;
    artifact?: string | null;
    priority?: string;
    acceptance_criteria?: string | null;
    depends_on?: string | null;
    credits_spent?: number;
    turns_spent?: number;
    created_by?: string | null;
    created_at?: string;
    started_at?: string | null;
    completed_at?: string | null;
  };

  const existingTask = await env.DB.prepare(
    `SELECT id, company_id, owner_agent_id, status, milestone_id
     FROM tasks
     WHERE id = ?
     LIMIT 1`,
  ).bind(taskId).first<{
    id: string;
    company_id: string;
    owner_agent_id: string | null;
    status: string;
    milestone_id: string | null;
  }>();

  if (!existingTask) {
    return Response.json(
      { error: "Task not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.milestone_id !== undefined) {
    updates.push("milestone_id = ?");
    values.push(body.milestone_id);
  }
  if (body.status !== undefined) {
    updates.push("status = ?");
    values.push(body.status);
  }
  if (body.owner_agent_id !== undefined) {
    updates.push("owner_agent_id = ?");
    values.push(body.owner_agent_id);
  }
  if (body.blocked_reason !== undefined) {
    updates.push("blocked_on = ?");
    values.push(body.blocked_reason);
  }
  if (body.artifact !== undefined) {
    updates.push("artifact = ?");
    values.push(body.artifact);
  }
  if (body.priority !== undefined) {
    updates.push("priority = ?");
    values.push(body.priority);
  }
  if (body.acceptance_criteria !== undefined) {
    updates.push("acceptance_criteria = ?");
    values.push(body.acceptance_criteria || null);
  }
  if (body.depends_on !== undefined) {
    updates.push("depends_on = ?");
    values.push(body.depends_on || "[]");
  }
  if (body.credits_spent !== undefined) {
    updates.push("credits_spent = ?");
    values.push(body.credits_spent);
  }
  if (body.turns_spent !== undefined) {
    updates.push("turns_spent = ?");
    values.push(body.turns_spent);
  }
  if (body.created_by !== undefined) {
    updates.push("created_by = ?");
    values.push(body.created_by || null);
  }
  if (body.created_at !== undefined) {
    updates.push("created_at = ?");
    values.push(body.created_at);
  }
  if (body.started_at !== undefined) {
    updates.push("started_at = ?");
    values.push(body.started_at || null);
  }
  if (body.completed_at !== undefined) {
    updates.push("completed_at = ?");
    values.push(body.completed_at || null);
  }

  if (updates.length === 0) {
    return Response.json(
      { error: "No valid fields to update" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  updates.push("updated_at = datetime('now')");
  values.push(taskId);

  await env.DB.prepare(
    `UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`,
  ).bind(...values).run();

  const finalOwnerAgentId = body.owner_agent_id !== undefined
    ? body.owner_agent_id
    : existingTask.owner_agent_id;
  const finalStatus = body.status !== undefined
    ? body.status
    : existingTask.status;

  if (finalStatus === "in_progress" && finalOwnerAgentId) {
    await ensureSingleRunningTaskForAgent(
      env,
      existingTask.company_id,
      finalOwnerAgentId,
      taskId,
    );
  }

  return Response.json({ updated: true }, { headers: corsHeaders(env) });
}

/** GET /api/supervisor/companies/:id/telemetry — structured company telemetry */
export async function handleSupervisorListTelemetry(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const url = new URL(request.url);
  const verifiedOnly = url.searchParams.get("verifiedOnly") === "1";
  const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500));
  const records = await loadCompanyTelemetryRows(env, companyId, {
    verifiedOnly,
    limit,
  });

  return Response.json(
    {
      records: records.map((record) => ({
        ...record,
        metadata: typeof record.metadata === "string" && record.metadata
          ? JSON.parse(record.metadata)
          : null,
      })),
    },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/companies/:id/telemetry — upsert structured telemetry */
export async function handleSupervisorUpsertTelemetry(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const rawBody = await request.json() as Record<string, unknown>;
  const body = normalizeTelemetryInput(rawBody);
  if (!body) {
    return Response.json(
      { error: "kind and status are required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const companyExists = await env.DB.prepare(
    `SELECT id
     FROM companies
     WHERE id = ?
     LIMIT 1`,
  ).bind(companyId).first<{ id: string }>();
  if (!companyExists?.id) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const id = body.id?.trim() || generateId();
  const agentId = body.agent_id
    ? (await env.DB.prepare(
      `SELECT id
       FROM agents
       WHERE id = ?
         AND company_id = ?
       LIMIT 1`,
    ).bind(body.agent_id, companyId).first<{ id: string }>())?.id ?? null
    : null;
  const taskId = body.task_id
    ? (await env.DB.prepare(
      `SELECT id
       FROM tasks
       WHERE id = ?
         AND company_id = ?
       LIMIT 1`,
    ).bind(body.task_id, companyId).first<{ id: string }>())?.id ?? null
    : null;

  try {
    await upsertCompanyTelemetryRow(env, companyId, {
      ...body,
      id,
      agent_id: agentId,
      task_id: taskId,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  return Response.json(
    { id },
    { status: 201, headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/companies/:id/approvals — create founder approval from an agent */
export async function handleSupervisorListApprovals(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const { results } = await env.DB.prepare(
    `SELECT id, company_id, type, status, payload, decided_at, created_at
     FROM approvals
     WHERE company_id = ?
     ORDER BY created_at ASC`,
  ).bind(companyId).all<ApprovalRow>();

  const approvals = (results ?? []).map((row) => {
    const payload = parseApprovalPayload(row.payload);
    return {
      id: row.id,
      company_id: row.company_id,
      type: row.type,
      description:
        typeof payload.description === "string" && payload.description.trim()
          ? payload.description.trim()
          : typeof payload.summary === "string" && payload.summary.trim()
            ? payload.summary.trim()
            : typeof payload.title === "string" && payload.title.trim()
              ? payload.title.trim()
              : row.type,
      related_task_id:
        typeof payload.relatedTaskId === "string" && payload.relatedTaskId.trim()
          ? payload.relatedTaskId.trim()
          : typeof payload.related_task_id === "string" && payload.related_task_id.trim()
            ? payload.related_task_id.trim()
            : null,
      status: row.status,
      resolved_at: row.decided_at ?? null,
      created_at: row.created_at,
    };
  });

  return Response.json({ approvals }, { headers: corsHeaders(env) });
}

export async function handleSupervisorCreateApproval(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    id?: string;
    type?: "hire_agent" | "strategy" | "budget_override";
    requestedByAgentId?: string;
    payload?: Record<string, unknown>;
    description?: string;
    related_task_id?: string | null;
    status?: "pending" | "approved" | "rejected" | "revision_requested";
    resolved_at?: string | null;
    created_at?: string;
  };

  if (!body.requestedByAgentId && typeof body.description === "string" && body.type) {
    const approvalId = body.id?.trim() || generateId();
    const mirrorPayload = {
      description: body.description,
      relatedTaskId: body.related_task_id ?? null,
    };
    await env.DB.prepare(
      `INSERT INTO approvals (
         id, company_id, type, requested_by_user_id, requested_by_agent_id,
         status, payload, decided_at, created_at, updated_at
       )
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         status = excluded.status,
         payload = excluded.payload,
         decided_at = excluded.decided_at,
         updated_at = datetime('now')`,
    ).bind(
      approvalId,
      companyId,
      body.type,
      body.status || "pending",
      JSON.stringify(mirrorPayload),
      body.resolved_at || null,
      body.created_at || new Date().toISOString(),
    ).run();

    return Response.json({ approvalId, mirrored: true }, { headers: corsHeaders(env) });
  }

  if (!body.type || !body.requestedByAgentId || !body.payload) {
    return Response.json(
      { error: "type, requestedByAgentId, and payload are required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const requestingAgent = await env.DB.prepare(
    `SELECT id, role
     FROM agents
     WHERE id = ?
       AND company_id = ?
     LIMIT 1`,
  ).bind(body.requestedByAgentId, companyId).first<{ id: string; role: string | null }>();

  const requesterRole = requestingAgent?.role || null;
  if (body.type !== "hire_agent" && requesterRole !== "ceo") {
    return Response.json(
      {
        suppressed: true,
        reroutedTo: "ceo",
        reason: "Only the CEO should bring strategy or budget approvals to the founder.",
      },
      { headers: corsHeaders(env) },
    );
  }

  if (isFounderManagedProcurementPayload(body.payload)) {
    return Response.json(
      {
        suppressed: true,
        reroutedTo: "ceo",
        reason:
          "Custom domains, branded inboxes, Google Workspace, and paid tools are founder-managed upgrades and should not surface during milestone zero.",
      },
      { headers: corsHeaders(env) },
    );
  }

  const fingerprint = buildApprovalFingerprint(
    body.type,
    body.requestedByAgentId,
    body.payload,
  );

  const { results: pendingApprovals } = await env.DB.prepare(
    `SELECT id, payload
     FROM approvals
     WHERE company_id = ?
       AND type = ?
       AND requested_by_agent_id = ?
       AND status = 'pending'
     ORDER BY created_at DESC`,
  ).bind(companyId, body.type, body.requestedByAgentId).all<{
    id: string;
    payload: string;
  }>();

  if (body.type === "strategy" && (pendingApprovals || []).length > 0) {
    const [latest] = pendingApprovals || [];
    await env.DB.prepare(
      `UPDATE approvals
       SET payload = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(JSON.stringify(body.payload), latest.id).run();

    return Response.json(
      { approvalId: latest.id, deduped: true, replacedPending: true },
      { headers: corsHeaders(env) },
    );
  }

  const existing = (pendingApprovals || []).find((approval) =>
    buildApprovalFingerprint(
      body.type!,
      body.requestedByAgentId!,
      parseApprovalPayload(approval.payload),
    ) === fingerprint,
  );

  if (existing) {
    await env.DB.prepare(
      `UPDATE approvals
       SET payload = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(JSON.stringify(body.payload), existing.id).run();

    return Response.json(
      { approvalId: existing.id, deduped: true },
      { headers: corsHeaders(env) },
    );
  }

  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO approvals (
       id, company_id, type, requested_by_user_id, requested_by_agent_id, payload
     )
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).bind(
    id,
    companyId,
    body.type,
    body.requestedByAgentId,
    JSON.stringify(body.payload),
  ).run();

  await env.DB.prepare(
    `INSERT INTO activity_log (id, company_id, type, summary, details)
     VALUES (?, ?, 'approval', ?, ?)`,
  ).bind(
    generateId(),
    companyId,
    `${body.type} approval requested by agent ${body.requestedByAgentId}`,
    JSON.stringify({
      approvalId: id,
      type: body.type,
      requestedByAgentId: body.requestedByAgentId,
    }),
  ).run();

  return Response.json(
    { approvalId: id },
    { status: 201, headers: corsHeaders(env) },
  );
}

// ─── Credits ─────────────────────────────────────────────────

/** GET /api/supervisor/credits — all credit balances */
export async function handleSupervisorListCredits(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const userId = new URL(request.url).searchParams.get("userId");

  const result = userId
    ? await env.DB.prepare(
      `SELECT user_id, balance
       FROM credit_balances
       WHERE user_id = ?`,
    ).bind(userId).all()
    : await env.DB.prepare(
      `SELECT user_id, balance FROM credit_balances`,
    ).all();

  return Response.json(
    { balances: result.results },
    { headers: corsHeaders(env) },
  );
}

/** GET /api/supervisor/credits/:userId — single user balance */
export async function handleSupervisorGetBalance(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const row = await env.DB.prepare(
    `SELECT balance FROM credit_balances WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ balance: number }>();

  return Response.json(
    { balance: row?.balance ?? 0 },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/credits/:userId/balance — legacy balance sync, now increase-only */
export async function handleSupervisorSetBalance(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = await request.json() as { balance?: number };
  if (!Number.isFinite(body.balance)) {
    return Response.json(
      { error: "balance is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const nextBalance = Math.max(0, Math.floor(body.balance ?? 0));
  const currentBalance = await getBalance(env, userId);

  await env.DB.prepare(
    `INSERT INTO credit_balances (user_id, balance, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       balance = CASE
         WHEN credit_balances.balance < excluded.balance THEN excluded.balance
         ELSE credit_balances.balance
       END,
       updated_at = datetime('now')`,
  )
    .bind(userId, nextBalance)
    .run();

  return Response.json(
    { balance: Math.max(currentBalance, nextBalance) },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/credits/:userId/reconcile-stripe — recover missed Stripe credit purchases */
export async function handleSupervisorReconcileStripeCredits(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const sub = await env.DB.prepare(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ stripe_customer_id: string | null }>();

  const reconciliation = await reconcileRecentStripeCreditPurchases(
    env,
    userId,
    sub?.stripe_customer_id ?? null,
  );
  const balance = await getBalance(env, userId);

  return Response.json(
    {
      balance,
      ...reconciliation,
    },
    { headers: corsHeaders(env) },
  );
}

/** POST /api/supervisor/credits/:userId/deduct — deduct credits after turn */
export async function handleSupervisorDeductCredits(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const rawBody = await request.json() as Record<string, unknown>;
  const body = normalizeSupervisorDeductionBody(rawBody);

  let resolvedAgent:
    | { id: string; company_id: string; model_tier: string | null }
    | null = null;
  if (body.agentId) {
    resolvedAgent = await env.DB.prepare(
      `SELECT id, company_id, model_tier
       FROM agents
       WHERE id = ?
       LIMIT 1`,
    )
      .bind(body.agentId)
      .first<{ id: string; company_id: string; model_tier: string | null }>();
  }

  const companyId = body.companyId ?? resolvedAgent?.company_id ?? null;
  const agentId = body.agentId ?? resolvedAgent?.id ?? null;
  let mirroredCompanyId: string | null = companyId;
  let mirroredAgentId: string | null = agentId;
  let companyState: string | null = null;

  if (mirroredCompanyId) {
    const companyExists = await env.DB.prepare(
      `SELECT id, state
       FROM companies
       WHERE id = ?
       LIMIT 1`,
    )
      .bind(mirroredCompanyId)
      .first<{ id: string; state: string }>();

    if (!companyExists?.id) {
      mirroredCompanyId = null;
      mirroredAgentId = null;
    } else {
      companyState = companyExists.state;
    }
  }

  if (mirroredAgentId) {
    const agentExists = await env.DB.prepare(
      `SELECT id
       FROM agents
       WHERE id = ?
       LIMIT 1`,
    )
      .bind(mirroredAgentId)
      .first<{ id: string }>();

    if (!agentExists?.id) {
      mirroredAgentId = null;
    }
  }

  try {
    if (mirroredCompanyId && companyState && companyState !== "running" && mirroredAgentId) {
      await updateAgentLifecycleState(
        env,
        mirroredAgentId,
        {
          status: "paused",
          lastSleepAt: new Date().toISOString(),
        },
      );
    }

    const result = await deductCredits(
      env,
      userId,
      body.amount,
      body.description ?? `Agent turn: ${body.tokenUsage.inputTokens + body.tokenUsage.outputTokens} tokens`,
      mirroredCompanyId ?? undefined,
      mirroredAgentId ?? undefined,
    );

    // Update agent's total credits consumed
    if (mirroredAgentId && result.deducted > 0) {
      await env.DB.prepare(
        `UPDATE agents SET total_credits_consumed = total_credits_consumed + ?, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(result.deducted, mirroredAgentId)
        .run();
    }

    if (mirroredCompanyId && result.deducted > 0) {
      await env.DB.prepare(
        `UPDATE companies SET spent_cents = spent_cents + ?, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(result.deducted, mirroredCompanyId)
        .run();
    }

    if (mirroredCompanyId && result.deducted > 0) {
      await recordCostEvent(env, {
        companyId: mirroredCompanyId,
        agentId: mirroredAgentId ?? body.agentId ?? undefined,
        provider: "anthropic",
        model: body.modelTier ?? resolvedAgent?.model_tier ?? "unknown",
        inputTokens: body.tokenUsage.inputTokens,
        outputTokens: body.tokenUsage.outputTokens,
        costCents: result.deducted,
      });
    }

    return Response.json(
      {
        balance: result.balance,
        ...(companyState && companyState !== "running" ? { companyState } : {}),
      },
      { headers: corsHeaders(env) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Deduction failed";
    return Response.json(
      { error: message, balance: 0 },
      { status: 400, headers: corsHeaders(env) },
    );
  }
}

// ─── Cron Tasks ──────────────────────────────────────────────

/** GET /api/supervisor/cron-tasks — list enabled cron tasks */
export async function handleSupervisorListCronTasks(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const userId = new URL(request.url).searchParams.get("userId");
  const companyId = new URL(request.url).searchParams.get("companyId");

  const result = companyId
    ? await env.DB.prepare(
      `SELECT id, company_id, agent_id, title, description, schedule, prompt, enabled, last_run_at, next_run_at, created_by, created_at
       FROM cron_tasks
       WHERE enabled = 1
         AND company_id = ?`,
    ).bind(companyId).all()
    : userId
    ? await env.DB.prepare(
      `SELECT cron_tasks.id, cron_tasks.company_id, cron_tasks.agent_id, cron_tasks.title,
              cron_tasks.description, cron_tasks.schedule,
              cron_tasks.prompt, cron_tasks.enabled, cron_tasks.last_run_at, cron_tasks.next_run_at,
              cron_tasks.created_by, cron_tasks.created_at
       FROM cron_tasks
       JOIN companies ON companies.id = cron_tasks.company_id
       WHERE cron_tasks.enabled = 1
         AND companies.user_id = ?`,
    ).bind(userId).all()
    : await env.DB.prepare(
      `SELECT id, company_id, agent_id, title, description, schedule, prompt, enabled, last_run_at, next_run_at, created_by, created_at
       FROM cron_tasks WHERE enabled = 1`,
    ).all();

  return Response.json(
    { tasks: result.results },
    { headers: corsHeaders(env) },
  );
}

/** PATCH /api/supervisor/cron-tasks/:id — update last run time */
export async function handleSupervisorUpdateCronTask(
  request: Request,
  env: Env,
  taskId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    last_run_at: string;
    next_run_at: string;
  };

  await env.DB.prepare(
    `UPDATE cron_tasks SET last_run_at = ?, next_run_at = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(body.last_run_at, body.next_run_at, taskId)
    .run();

  return Response.json({ updated: true }, { headers: corsHeaders(env) });
}

/** POST /api/supervisor/cron-tasks — create a cron task */
export async function handleSupervisorCreateCronTask(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    id?: string;
    companyId?: string;
    company_id?: string;
    agentId?: string;
    agent_id?: string;
    title?: string;
    description?: string;
    schedule: string;
    prompt: string;
    nextRunAt?: string;
    next_run_at?: string;
    createdBy?: string;
    created_by?: string;
    enabled?: number;
    last_run_at?: string | null;
  };

  const companyId = body.companyId ?? body.company_id ?? "";
  const agentId = body.agentId ?? body.agent_id ?? "";
  const createdBy = body.createdBy ?? body.created_by ?? "";
  const nextRunAt = body.nextRunAt ?? body.next_run_at ?? null;
  const title = body.title?.trim() ?? null;
  const description = body.description?.trim() ?? null;
  const lastRunAt = body.last_run_at ?? null;

  const id = body.id?.trim() || generateId();
  if (body.id?.trim()) {
    const existing = await env.DB.prepare(
      `SELECT id
       FROM cron_tasks
       WHERE id = ?
       LIMIT 1`,
    ).bind(id).first<{ id: string }>();

    if (existing?.id) {
      // Update existing record with any new data (e.g., title, description, last_run_at)
      await env.DB.prepare(
        `UPDATE cron_tasks
         SET title = COALESCE(?, title),
             description = COALESCE(?, description),
             schedule = COALESCE(?, schedule),
             prompt = COALESCE(?, prompt),
             enabled = COALESCE(?, enabled),
             last_run_at = COALESCE(?, last_run_at),
             updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(
        title,
        description,
        body.schedule || null,
        body.prompt || null,
        body.enabled ?? null,
        lastRunAt,
        id,
      ).run();
      return Response.json({ created: true, id }, { headers: corsHeaders(env) });
    }
  }

  await env.DB.prepare(
    `INSERT INTO cron_tasks (
       id, company_id, agent_id, title, description, schedule, prompt, enabled,
       last_run_at, next_run_at, created_by
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(
      id,
      companyId,
      agentId,
      title,
      description,
      body.schedule,
      body.prompt,
      lastRunAt,
      nextRunAt,
      createdBy,
    )
    .run();

  return Response.json({ created: true }, { status: 201, headers: corsHeaders(env) });
}

// ─── Activity Logging ────────────────────────────────────────

/** POST /api/supervisor/companies/:id/activity — log activity */
export async function handleSupervisorLogActivity(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    id?: string;
    type: string;
    summary: string;
    details?: Record<string, unknown>;
  };

  const companyExists = await env.DB.prepare(
    `SELECT id
     FROM companies
     WHERE id = ?
     LIMIT 1`,
  ).bind(companyId).first<{ id: string }>();

  if (!companyExists?.id) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const id = body.id?.trim() || generateId();
  if (body.id?.trim()) {
    const existing = await env.DB.prepare(
      `SELECT id
       FROM activity_log
       WHERE id = ?
       LIMIT 1`,
    ).bind(id).first<{ id: string }>();

    if (existing?.id) {
      return Response.json({ logged: true, id }, { headers: corsHeaders(env) });
    }
  }

  await env.DB.prepare(
    `INSERT INTO activity_log (id, company_id, type, summary, details) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      companyId,
      body.type,
      body.summary,
      body.details ? JSON.stringify(body.details) : null,
    )
    .run();

  return Response.json({ logged: true }, { headers: corsHeaders(env) });
}

// ─── Agent Skills ──────────────────────────────────────────────

/** POST /api/supervisor/agents/:id/skills — sync agent skills from supervisor */
export async function handleSupervisorSyncAgentSkills(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  if (!verifySupervisorKey(request, env)) return unauthorized(env);

  const body = (await request.json()) as {
    skills: Array<{
      skill_slug: string;
      name: string;
      description?: string;
    }>;
  };

  if (!Array.isArray(body.skills)) {
    return Response.json({ error: "skills array required" }, { status: 400, headers: corsHeaders(env) });
  }

  // Replace all skills for this agent
  const stmts = [
    env.DB.prepare(`DELETE FROM agent_skills WHERE agent_id = ?`).bind(agentId),
    ...body.skills.map((skill) =>
      env.DB.prepare(
        `INSERT INTO agent_skills (agent_id, skill_slug, name, description) VALUES (?, ?, ?, ?)`,
      ).bind(agentId, skill.skill_slug, skill.name, skill.description ?? ""),
    ),
  ];

  try {
    await env.DB.batch(stmts);
  } catch {
    // Table may not exist yet — create it and retry
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS agent_skills (
          agent_id TEXT NOT NULL, skill_slug TEXT NOT NULL, name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (agent_id, skill_slug))`,
      ).run();
      await env.DB.batch(stmts);
    } catch (retryErr) {
      return Response.json(
        { error: "Failed to sync agent skills", detail: String(retryErr) },
        { status: 500, headers: corsHeaders(env) },
      );
    }
  }

  return Response.json({ synced: body.skills.length }, { headers: corsHeaders(env) });
}
