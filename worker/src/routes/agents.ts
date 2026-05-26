import type { Env, AgentRow } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import {
  ensureAgentmailInbox,
  rememberAgentmailInboxOwner,
} from "../integrations/agentmail.js";
import { generateId } from "../provisioning/config-builder.js";
import { logActivity } from "../utils/activity.js";
import { hashApiKey, generateApiKey } from "../middleware/agent-auth.js";
import { reserveAgentEmailAddress } from "../utils/company-contract.js";
import {
  fetchLiveSupervisorRuntime,
  fetchLiveSupervisorAgents,
  normalizeFounderVisibleAgentStatus,
} from "../utils/live-runtime.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";
import {
  resolveFounderCountryContext,
  defaultFoundingTeamNamesForCountry,
  generateAgentAvatar,
  storeAvatar,
  hasStoredAvatar,
  avatarGenerationEnabled,
} from "../enrichment/agent-identity.js";

/** Maximum allowed length for system_prompt (in characters). D1 TEXT columns have no practical limit,
 *  but we cap prompts to prevent abuse and ensure reasonable payload sizes. */
const MAX_SYSTEM_PROMPT_LENGTH = 50_000;

type SupervisorRequestResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

export async function loadFounderVisibleAgents(
  env: Env,
  companyId: string,
): Promise<AgentRow[]> {
  const [agentsResult, refreshedRuntime] = await Promise.all([
    env.DB.prepare(
      `SELECT *
       FROM agents
       WHERE company_id = ?
       ORDER BY created_at ASC`,
    ).bind(companyId).all<AgentRow>(),
    fetchLiveSupervisorRuntime(env, companyId),
  ]);

  const dbAgents = agentsResult.results ?? [];
  const liveAgents = refreshedRuntime.companyState === "dead" || refreshedRuntime.companyState === "failed"
    ? null
    : await fetchLiveSupervisorAgents(env, companyId);
  let agents = liveAgents && (dbAgents.length === 0 || liveAgents.length >= dbAgents.length)
    ? liveAgents.map((agent) => mergeAgentIdentity(agent, dbAgents.find((candidate) => candidate.id === agent.id)))
    : dbAgents;

  if (liveAgents) {
    const seen = new Set(agents.map((agent) => agent.id));
    for (const agent of dbAgents) {
      if (!seen.has(agent.id)) {
        agents.push(agent);
      }
    }
  }

  return agents.map((agent) => normalizeFounderVisibleAgentStatus(agent, refreshedRuntime));
}

/**
 * Verify JWT and check company ownership. Returns userId or error Response.
 */
async function requireCompanyAccess(
  request: Request,
  env: Env,
  companyId: string,
): Promise<{ userId: string } | Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  }
  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  }
  const company = await env.DB.prepare(
    "SELECT user_id FROM companies WHERE id = ?",
  ).bind(companyId).first<{ user_id: string }>();
  if (!company || company.user_id !== userId) {
    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  }
  return { userId };
}

/**
 * Verify JWT and resolve agent + company ownership.
 */
async function requireAgentAccess(
  request: Request,
  env: Env,
  agentId: string,
): Promise<{ userId: string; agent: AgentRow } | Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  }
  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  }
  const agent = await env.DB.prepare(
    `SELECT a.* FROM agents a
     JOIN companies c ON a.company_id = c.id
     WHERE a.id = ? AND c.user_id = ?`,
  ).bind(agentId, userId).first<AgentRow>();
  if (!agent) {
    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  }
  return { userId, agent };
}

async function requestSupervisor(
  env: Env,
  companyId: string,
  path: string,
  init: RequestInit = {},
): Promise<SupervisorRequestResult | null> {
  try {
    const res = await fetchFromCompanySupervisor(env, companyId, path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        ...init.headers,
      },
    });

    if (!res) {
      return null;
    }

    if (res.ok) {
      return { ok: true };
    }

    return {
      ok: false,
      status: res.status,
      message: (await res.text()) || `Supervisor returned ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message : "Failed to reach supervisor",
    };
  }
}

function supervisorErrorResponse(
  env: Env,
  result: Exclude<SupervisorRequestResult, { ok: true }>,
): Response {
  return Response.json(
    {
      error:
        result.status === 502
          ? `Failed to reach supervisor: ${result.message}`
          : `Supervisor error: ${result.message}`,
    },
    { status: result.status, headers: corsHeaders(env) },
  );
}

function buildWakePrompt(body: {
  message?: string;
  reason?: string;
  issueId?: string;
}): string {
  const trimmedMessage = body.message?.trim();
  const trimmedReason = body.reason?.trim();
  const parts: string[] = [];

  if (trimmedMessage) {
    parts.push(trimmedMessage);
  } else {
    parts.push(
      "Manual wake requested by the company owner. Review current priorities and continue the highest-value work.",
    );
  }

  if (trimmedReason) {
    parts.push(`Reason: ${trimmedReason}`);
  }

  if (body.issueId) {
    parts.push(`Focus on issue ${body.issueId}.`);
  }

  return parts.join("\n");
}

function resolveModelTierForAgentRole(role: string | undefined): "sonnet" {
  return "sonnet";
}

function mergeAgentIdentity(liveAgent: AgentRow, dbAgent?: AgentRow): AgentRow {
  if (!dbAgent) {
    return liveAgent;
  }
  return {
    ...liveAgent,
    name: dbAgent.name || liveAgent.name,
    title: dbAgent.title || liveAgent.title,
    icon: dbAgent.icon || liveAgent.icon,
    email_address: dbAgent.email_address || liveAgent.email_address,
    metadata: dbAgent.metadata || liveAgent.metadata,
    blueprint_id: dbAgent.blueprint_id || liveAgent.blueprint_id,
    department: dbAgent.department || liveAgent.department,
  };
}

// ─── GET /api/companies/:companyId/agents ─────────────────────

export async function handleListAgents(
  request: Request,
  env: Env,
  companyId: string,
  _ctx?: ExecutionContext,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const agents = await loadFounderVisibleAgents(env, companyId);

  // Backfill names for agents that still have blueprint-style names
  if (_ctx && agents.some((a) => agentNeedsNameBackfill(a))) {
    _ctx.waitUntil(backfillAgentIdentities(companyId, env, agents));
  }

  return Response.json(
    { agents },
    { headers: corsHeaders(env) },
  );
}

// ─── POST /api/companies/:companyId/agents ────────────────────

export async function handleCreateAgent(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const body = (await request.json()) as {
    name: string;
    role?: string;
    title?: string;
    icon?: string;
    reports_to?: string;
    capabilities?: string[];
    adapter_config?: Record<string, unknown>;
    runtime_config?: Record<string, unknown>;
  };

  if (!body.name || body.name.trim().length < 1) {
    return Response.json(
      { error: "Agent name is required" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  if (body.role === "ceo") {
    return Response.json(
      { error: "The CEO is provisioned automatically and cannot be created manually." },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  // Validate reports_to exists in same company
  if (body.reports_to) {
    const parent = await env.DB.prepare(
      "SELECT id FROM agents WHERE id = ? AND company_id = ?",
    ).bind(body.reports_to, companyId).first();
    if (!parent) {
      return Response.json(
        { error: "reports_to agent not found in this company" },
        { status: 400, headers: corsHeaders(env) },
      );
    }
  }

  const id = generateId();

  // Check if board approval is required
  const company = await env.DB.prepare(
    "SELECT require_board_approval_for_new_agents, email_domain FROM companies WHERE id = ?",
  ).bind(companyId).first<{
    require_board_approval_for_new_agents: number;
    email_domain: string | null;
  }>();

  const needsApproval = company?.require_board_approval_for_new_agents === 1;
  const initialStatus = needsApproval ? "pending_approval" : "idle";
  const modelTier = resolveModelTierForAgentRole(body.role);
  const emailAddress = await reserveAgentEmailAddress(
    env,
    companyId,
    company?.email_domain ?? null,
    {
      role: body.role || "worker",
      title: body.title || null,
      name: body.name.trim(),
    },
  );

  await env.DB.prepare(
    `INSERT INTO agents (
       id, company_id, name, role, title, icon, status, reports_to,
       capabilities, adapter_config, runtime_config, model_tier, email_address
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    companyId,
    body.name.trim(),
    body.role || "worker",
    body.title || null,
    body.icon || null,
    initialStatus,
    body.reports_to || null,
    JSON.stringify(body.capabilities || []),
    JSON.stringify(body.adapter_config || {}),
    JSON.stringify(body.runtime_config || {}),
    modelTier,
    emailAddress,
  ).run();

  if (emailAddress) {
    try {
      const inbox = await ensureAgentmailInbox(env, {
        emailAddress,
        displayName: body.name.trim(),
      });
      if (!inbox.shared) {
        await rememberAgentmailInboxOwner(env, inbox.inbox_id, {
          companyId,
          agentId: id,
          aliasEmail: emailAddress,
        });
      }
    } catch (err) {
      console.error(
        `[agentmail] Failed to ensure inbox for ${body.name.trim()} (${emailAddress}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Create approval if needed
  if (needsApproval) {
    const approvalId = generateId();
    await env.DB.prepare(
      `INSERT INTO approvals (id, company_id, type, requested_by_user_id, status, payload)
       VALUES (?, ?, 'hire_agent', ?, 'pending', ?)`,
    ).bind(
      approvalId,
      companyId,
      auth.userId,
      JSON.stringify({ agentId: id, name: body.name, role: body.role || "worker" }),
    ).run();

    await logActivity(env, {
      companyId,
      actorType: "user",
      actorId: auth.userId,
      action: "approval.created",
      entityType: "approval",
      entityId: approvalId,
      summary: `Hire approval requested for agent "${body.name}"`,
      agentId: id,
    });
  }

  await logActivity(env, {
    companyId,
    actorType: "user",
    actorId: auth.userId,
    action: "agent.created",
    entityType: "agent",
    entityId: id,
    summary: `Agent "${body.name}" created${needsApproval ? " (pending approval)" : ""}`,
  });

  const agent = await env.DB.prepare("SELECT * FROM agents WHERE id = ?")
    .bind(id).first<AgentRow>();

  return Response.json({ agent }, { status: 201, headers: corsHeaders(env) });
}

// ─── GET /api/agents/:id ──────────────────────────────────────

export async function handleGetAgent(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const auth = await requireAgentAccess(request, env, agentId);
  if (auth instanceof Response) return auth;

  const runtime = await fetchLiveSupervisorRuntime(env, auth.agent.company_id);
  return Response.json(
    { agent: normalizeFounderVisibleAgentStatus(auth.agent, runtime) },
    { headers: corsHeaders(env) },
  );
}

// ─── PATCH /api/agents/:id ────────────────────────────────────

export async function handleUpdateAgent(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const auth = await requireAgentAccess(request, env, agentId);
  if (auth instanceof Response) return auth;

  const body = (await request.json()) as {
    name?: string;
    role?: string;
    title?: string;
    icon?: string;
    reports_to?: string | null;
    capabilities?: string[];
    runtime_config?: Record<string, unknown>;
    adapter_type?: string | null;
    webhook_url?: string | null;
    model_tier?: string;
    instructions?: string;
    system_prompt?: string | null;
  };

  // Validate system_prompt length before processing
  if (body.system_prompt !== undefined && body.system_prompt !== null) {
    if (typeof body.system_prompt === "string" && body.system_prompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
      return Response.json(
        { error: `System prompt exceeds maximum length of ${MAX_SYSTEM_PROMPT_LENGTH} characters (got ${body.system_prompt.length})` },
        { status: 400, headers: corsHeaders(env) },
      );
    }
  }

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
  if (body.role !== undefined) { updates.push("role = ?"); values.push(body.role); }
  if (body.title !== undefined) { updates.push("title = ?"); values.push(body.title); }
  if (body.icon !== undefined) { updates.push("icon = ?"); values.push(body.icon); }
  if (body.reports_to !== undefined) { updates.push("reports_to = ?"); values.push(body.reports_to); }
  if (body.capabilities !== undefined) { updates.push("capabilities = ?"); values.push(JSON.stringify(body.capabilities)); }
  if (body.runtime_config !== undefined) { updates.push("runtime_config = ?"); values.push(JSON.stringify(body.runtime_config)); }
  if (body.adapter_type !== undefined) { updates.push("adapter_type = ?"); values.push(body.adapter_type); }
  if (body.webhook_url !== undefined) { updates.push("webhook_url = ?"); values.push(body.webhook_url); }
  if (body.model_tier !== undefined) { updates.push("model_tier = ?"); values.push(body.model_tier); }
  if (body.instructions !== undefined) { updates.push("instructions = ?"); values.push(body.instructions); }
  if (body.system_prompt !== undefined) { updates.push("system_prompt = ?"); values.push(body.system_prompt); }

  if (updates.length === 0) {
    return Response.json({ error: "No fields to update" }, { status: 400, headers: corsHeaders(env) });
  }

  updates.push("updated_at = datetime('now')");
  values.push(agentId);

  await env.DB.prepare(
    `UPDATE agents SET ${updates.join(", ")} WHERE id = ?`,
  ).bind(...values).run();

  // Push editable field changes to supervisor so its local SQLite stays in sync
  const supervisorPatch: Record<string, unknown> = {};
  if (body.name !== undefined) supervisorPatch.name = body.name;
  if (body.role !== undefined) supervisorPatch.role = body.role;
  if (body.title !== undefined) supervisorPatch.title = body.title;
  if (body.instructions !== undefined) supervisorPatch.instructions = body.instructions;
  if (body.system_prompt !== undefined) supervisorPatch.system_prompt = body.system_prompt;
  if (body.model_tier !== undefined) supervisorPatch.model_tier = body.model_tier;
  if (body.adapter_type !== undefined) supervisorPatch.adapter_type = body.adapter_type;
  if (body.webhook_url !== undefined) supervisorPatch.webhook_url = body.webhook_url;
  if (body.reports_to !== undefined) supervisorPatch.reports_to = body.reports_to;

  if (Object.keys(supervisorPatch).length > 0) {
    // Non-fatal: if supervisor is unreachable, D1 is still updated
    await requestSupervisor(
      env,
      auth.agent.company_id,
      `/companies/${auth.agent.company_id}/agents/${agentId}`,
      {
        method: "PATCH",
        body: JSON.stringify(supervisorPatch),
      },
    ).catch((err) => {
      console.warn(
        `[agents] Failed to push field update to supervisor for ${agentId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  const agent = await env.DB.prepare("SELECT * FROM agents WHERE id = ?")
    .bind(agentId).first<AgentRow>();

  return Response.json({ agent }, { headers: corsHeaders(env) });
}

// ─── POST /api/agents/:id/pause ───────────────────────────────

export async function handlePauseAgent(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const auth = await requireAgentAccess(request, env, agentId);
  if (auth instanceof Response) return auth;

  if (auth.agent.status === "terminated") {
    return Response.json(
      { error: "Cannot pause a terminated agent" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const supervisorResult = await requestSupervisor(
    env,
    auth.agent.company_id,
    `/companies/${auth.agent.company_id}/agents/${agentId}/pause`,
    { method: "POST" },
  );
  if (supervisorResult && !supervisorResult.ok) {
    return supervisorErrorResponse(env, supervisorResult);
  }

  if (!supervisorResult) {
    return Response.json(
      { error: "Supervisor not configured" },
      { status: 503, headers: corsHeaders(env) },
    );
  }

  await logActivity(env, {
    companyId: auth.agent.company_id,
    actorType: "user",
    actorId: auth.userId,
    action: "agent.paused",
    entityType: "agent",
    entityId: agentId,
    summary: `Agent "${auth.agent.name}" paused`,
  });

  return Response.json({ success: true, status: "paused" }, { headers: corsHeaders(env) });
}

// ─── POST /api/agents/:id/resume ──────────────────────────────

export async function handleResumeAgent(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const auth = await requireAgentAccess(request, env, agentId);
  if (auth instanceof Response) return auth;

  if (auth.agent.status !== "paused") {
    return Response.json(
      { error: "Agent is not paused" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const supervisorResult = await requestSupervisor(
    env,
    auth.agent.company_id,
    `/companies/${auth.agent.company_id}/agents/${agentId}/resume`,
    { method: "POST" },
  );
  if (supervisorResult && !supervisorResult.ok) {
    return supervisorErrorResponse(env, supervisorResult);
  }

  if (!supervisorResult) {
    return Response.json(
      { error: "Supervisor not configured" },
      { status: 503, headers: corsHeaders(env) },
    );
  }

  await logActivity(env, {
    companyId: auth.agent.company_id,
    actorType: "user",
    actorId: auth.userId,
    action: "agent.resumed",
    entityType: "agent",
    entityId: agentId,
    summary: `Agent "${auth.agent.name}" resumed`,
  });

  return Response.json({ success: true, status: "idle" }, { headers: corsHeaders(env) });
}

// ─── POST /api/agents/:id/terminate ───────────────────────────

export async function handleTerminateAgent(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const auth = await requireAgentAccess(request, env, agentId);
  if (auth instanceof Response) return auth;

  const supervisorResult = await requestSupervisor(
    env,
    auth.agent.company_id,
    `/companies/${auth.agent.company_id}/agents/${agentId}/deactivate`,
    { method: "POST" },
  );
  if (supervisorResult && !supervisorResult.ok) {
    return supervisorErrorResponse(env, supervisorResult);
  }

  if (!supervisorResult) {
    return Response.json(
      { error: "Supervisor not configured" },
      { status: 503, headers: corsHeaders(env) },
    );
  }

  await logActivity(env, {
    companyId: auth.agent.company_id,
    actorType: "user",
    actorId: auth.userId,
    action: "agent.terminated",
    entityType: "agent",
    entityId: agentId,
    summary: `Agent "${auth.agent.name}" terminated`,
  });

  return Response.json({ success: true, status: "terminated" }, { headers: corsHeaders(env) });
}

// ─── POST /api/agents/:id/wake ────────────────────────────────

export async function handleWakeAgent(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const auth = await requireAgentAccess(request, env, agentId);
  if (auth instanceof Response) return auth;

  if (auth.agent.status === "terminated" || auth.agent.status === "pending_approval") {
    return Response.json(
      { error: `Cannot wake agent in ${auth.agent.status} state` },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    message?: string;
    reason?: string;
    issueId?: string;
  };

  // Create wakeup request in D1
  const wakeupId = generateId();
  await env.DB.prepare(
    `INSERT INTO agent_wakeup_requests
       (id, company_id, agent_id, source, trigger_detail, reason, payload, status, requested_by_actor_type, requested_by_actor_id)
     VALUES (?, ?, ?, 'on_demand', 'manual', ?, ?, 'queued', 'user', ?)`,
  ).bind(
    wakeupId,
    auth.agent.company_id,
    agentId,
    body.reason || "manual wake",
    body.issueId ? JSON.stringify({ issueId: body.issueId }) : null,
    auth.userId,
  ).run();

  const supervisorResult = await requestSupervisor(
    env,
    auth.agent.company_id,
    `/companies/${auth.agent.company_id}/agents/${agentId}/work`,
    {
      method: "POST",
      body: JSON.stringify({ prompt: buildWakePrompt(body) }),
    },
  );

  if (supervisorResult && !supervisorResult.ok) {
    await env.DB.prepare(
      `UPDATE agent_wakeup_requests
       SET status = 'failed', error = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(supervisorResult.message, wakeupId).run();
    return supervisorErrorResponse(env, supervisorResult);
  }

  if (supervisorResult) {
    await env.DB.prepare(
      `UPDATE agent_wakeup_requests
       SET status = 'dispatched', claimed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(wakeupId).run();
  } else {
    return Response.json(
      { error: "Supervisor not configured" },
      { status: 503, headers: corsHeaders(env) },
    );
  }

  await logActivity(env, {
    companyId: auth.agent.company_id,
    actorType: "user",
    actorId: auth.userId,
    action: "agent.wake_requested",
    entityType: "agent",
    entityId: agentId,
    summary: `Wake requested for agent "${auth.agent.name}"`,
    details: {
      reason: body.reason || null,
      message: body.message || null,
      issueId: body.issueId || null,
    },
    agentId,
  });

  return Response.json({ success: true, wakeupId }, { headers: corsHeaders(env) });
}

// ─── POST /api/agents/:id/keys ────────────────────────────────

export async function handleCreateAgentApiKey(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const auth = await requireAgentAccess(request, env, agentId);
  if (auth instanceof Response) return auth;

  const body = (await request.json().catch(() => ({}))) as { name?: string };

  const plainKey = generateApiKey();
  const keyHash = await hashApiKey(plainKey);
  const id = generateId();

  await env.DB.prepare(
    `INSERT INTO agent_api_keys (id, agent_id, company_id, name, key_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, agentId, auth.agent.company_id, body.name || "default", keyHash).run();

  await logActivity(env, {
    companyId: auth.agent.company_id,
    actorType: "user",
    actorId: auth.userId,
    action: "agent.api_key_created",
    entityType: "agent_api_key",
    entityId: id,
    summary: `API key created for agent "${auth.agent.name}"`,
    agentId,
  });

  // Return the plaintext key ONCE - it cannot be retrieved again
  return Response.json(
    { id, key: plainKey, name: body.name || "default" },
    { status: 201, headers: corsHeaders(env) },
  );
}

// ─── GET /api/agents/:id/blueprint-prompt ──────────────────────

export async function handleGetBlueprintPrompt(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const auth = await requireAgentAccess(request, env, agentId);
  if (auth instanceof Response) return auth;

  // Fetch the blueprint prompt from the supervisor
  const result = await requestSupervisor(
    env,
    auth.agent.company_id,
    `/companies/${auth.agent.company_id}/agents/${agentId}/blueprint-prompt`,
    { method: "GET" },
  );

  if (result && !result.ok) {
    // Supervisor returned an error — return a null prompt gracefully
    return Response.json({ prompt: null }, { headers: corsHeaders(env) });
  }

  if (!result) {
    // Supervisor not configured — return null prompt
    return Response.json({ prompt: null }, { headers: corsHeaders(env) });
  }

  // The requestSupervisor helper only returns ok/error status. We need to
  // actually fetch the full response. Refetch directly.
  try {
    const res = await fetchFromCompanySupervisor(env, auth.agent.company_id, `/companies/${auth.agent.company_id}/agents/${agentId}/blueprint-prompt`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
      },
    });
    if (!res || !res.ok) {
      return Response.json({ prompt: null }, { headers: corsHeaders(env) });
    }
    const data = await res.json() as { prompt: string | null };
    return Response.json({ prompt: data.prompt }, { headers: corsHeaders(env) });
  } catch {
    return Response.json({ prompt: null }, { headers: corsHeaders(env) });
  }
}

// ─── Agent Identity Backfill ────────────────────────────────────

const BLUEPRINT_STYLE_NAMES = new Set([
  "ceo", "cto", "cmo", "CEO", "CTO", "CMO",
  "Frontend Dev", "Backend Dev", "QA Tester", "API Agent",
  "frontend-dev", "backend-dev", "qa-tester", "api-keys-agent",
  "Agent",
]);

function agentNeedsNameBackfill(agent: AgentRow): boolean {
  const name = agent.name?.trim();
  if (!name) return true;
  // Name is just the role/blueprint — needs a real human name
  if (BLUEPRINT_STYLE_NAMES.has(name)) return true;
  if (agent.blueprint_id && name.toLowerCase() === agent.blueprint_id.toLowerCase()) return true;
  if (agent.role && name.toLowerCase() === agent.role.toLowerCase()) return true;
  return false;
}

const BACKFILL_LOCK = new Set<string>();

async function backfillAgentIdentities(
  companyId: string,
  env: Env,
  agents: AgentRow[],
): Promise<void> {
  if (BACKFILL_LOCK.has(companyId)) return;
  BACKFILL_LOCK.add(companyId);

  try {
    const company = await env.DB.prepare(
      `SELECT user_id FROM companies WHERE id = ?`,
    ).bind(companyId).first<{ user_id: string }>();
    if (!company) return;

    const { country, countryName } = await resolveFounderCountryContext(env, company.user_id);
    const names = defaultFoundingTeamNamesForCountry(country, countryName);

    const roleToName: Record<string, string> = {
      ceo: names.ceo,
      cto: names.cto,
      "frontend-dev": names.engineer1,
      "backend-dev": names.engineer2,
      "qa-tester": names.qa_lead,
      "api-keys-agent": names.api_key_agent,
      cmo: names.cmo,
    };

    const needsBackfill = agents.filter((a) => agentNeedsNameBackfill(a));
    if (needsBackfill.length === 0) return;

    const stmts = needsBackfill
      .map((agent) => {
        const newName = roleToName[agent.blueprint_id ?? ""] ?? roleToName[agent.role ?? ""];
        if (!newName) return null;
        return env.DB.prepare(
          `UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ? AND (name IS NULL OR name IN (?, ?, ?))`,
        ).bind(newName, agent.id, agent.blueprint_id ?? "", agent.role ?? "", "Agent");
      })
      .filter(Boolean) as D1PreparedStatement[];

    if (stmts.length > 0) {
      await env.DB.batch(stmts);
    }

    // Also backfill avatars for agents without stored avatars
    if (avatarGenerationEnabled(env)) {
      // Limit to 3 avatars per backfill to prevent runaway API costs
      const MAX_AVATAR_BACKFILL = 3;
      let generated = 0;
      for (const agent of needsBackfill) {
        if (generated >= MAX_AVATAR_BACKFILL) break;
        if (await hasStoredAvatar(agent.id, env)) continue;

        const realName = roleToName[agent.blueprint_id ?? ""] ?? roleToName[agent.role ?? ""] ?? agent.name;
        const avatarData = await generateAgentAvatar(
          realName,
          agent.title || agent.role || "Team member",
          countryName,
          env,
          {
            agentId: agent.id,
            mode: "automatic",
            countryCode: country,
          },
        );
        if (avatarData) {
          const icon = await storeAvatar(agent.id, avatarData, env);
          await env.DB.prepare(
            `UPDATE agents
             SET icon = ?,
                 metadata = json_set(COALESCE(metadata, '{}'), '$.avatar_generated', 1)
             WHERE id = ?`,
          ).bind(icon, agent.id).run();
          generated++;
        }
      }
    }
  } catch (err) {
    console.warn(
      `[agents] Identity backfill failed for ${companyId}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    BACKFILL_LOCK.delete(companyId);
  }
}
