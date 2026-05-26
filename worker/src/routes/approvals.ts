import type { Env, ApprovalRow, ApprovalCommentRow } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import { generateId } from "../provisioning/config-builder.js";
import { logActivity } from "../utils/activity.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";

type SupervisorRequestResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

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
  requestedByAgentId: string | null,
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
    requestedByAgentId || "user",
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

async function resolveDuplicatePendingApprovals(
  env: Env,
  approval: ApprovalRow,
  decision: "approved" | "rejected",
  decidedByUserId: string,
  note: string | null,
): Promise<void> {
  const payload = parseApprovalPayload(approval.payload);
  const fingerprint = buildApprovalFingerprint(
    approval.type,
    approval.requested_by_agent_id,
    payload,
  );

  const { results } = await env.DB.prepare(
    `SELECT id, payload
     FROM approvals
     WHERE company_id = ?
       AND type = ?
       AND status = 'pending'
       AND id != ?
       AND COALESCE(requested_by_agent_id, '') = COALESCE(?, '')`,
  ).bind(
    approval.company_id,
    approval.type,
    approval.id,
    approval.requested_by_agent_id,
  ).all<{ id: string; payload: string }>();

  const duplicateIds = (results || [])
    .filter((row) =>
      buildApprovalFingerprint(
        approval.type,
        approval.requested_by_agent_id,
        parseApprovalPayload(row.payload),
      ) === fingerprint,
    )
    .map((row) => row.id);

  if (duplicateIds.length === 0) {
    return;
  }

  const placeholders = duplicateIds.map(() => "?").join(", ");
  await env.DB.prepare(
    `UPDATE approvals
     SET status = ?,
         decided_by_user_id = ?,
         decision_note = ?,
         decided_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id IN (${placeholders})`,
  ).bind(decision, decidedByUserId, note, ...duplicateIds).run();
}

async function requireCompanyAccess(
  request: Request, env: Env, companyId: string,
): Promise<{ userId: string } | Response> {
  const token = extractToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  const userId = await verifyClerkJwt(token, env);
  if (!userId) return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  const company = await env.DB.prepare("SELECT user_id FROM companies WHERE id = ?").bind(companyId).first<{ user_id: string }>();
  if (!company || company.user_id !== userId) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  return { userId };
}

async function requireApprovalAccess(
  request: Request, env: Env, approvalId: string,
): Promise<{ userId: string; approval: ApprovalRow } | Response> {
  const token = extractToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(env) });
  const userId = await verifyClerkJwt(token, env);
  if (!userId) return Response.json({ error: "Invalid token" }, { status: 401, headers: corsHeaders(env) });
  const approval = await env.DB.prepare(
    `SELECT a.* FROM approvals a JOIN companies c ON a.company_id = c.id WHERE a.id = ? AND c.user_id = ?`,
  ).bind(approvalId, userId).first<ApprovalRow>();
  if (!approval) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders(env) });
  return { userId, approval };
}

// ─── GET /api/companies/:companyId/approvals ──────────────────

export async function loadCompanyApprovals(
  env: Env,
  companyId: string,
  status?: string | null,
): Promise<Array<ApprovalRow & { related_task_id: string | null }>> {
  let query = "SELECT * FROM approvals WHERE company_id = ?";
  const params: unknown[] = [companyId];

  if (status) {
    query += " AND status = ?";
    params.push(status);
  }

  query += " ORDER BY created_at DESC";

  const { results } = await env.DB.prepare(query).bind(...params).all<ApprovalRow>();

  return (results || []).map((row) => {
    const payload = parseApprovalPayload(row.payload);
    const relatedTaskId =
      (typeof payload.relatedTaskId === "string" && payload.relatedTaskId.trim()) ||
      (typeof payload.related_task_id === "string" && payload.related_task_id.trim()) ||
      null;
    return { ...row, related_task_id: relatedTaskId };
  });
}

export async function handleListApprovals(
  request: Request, env: Env, companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const approvals = await loadCompanyApprovals(env, companyId, url.searchParams.get("status"));

  return Response.json({ approvals }, { headers: corsHeaders(env) });
}

// ─── POST /api/companies/:companyId/approvals ─────────────────

export async function handleCreateApproval(
  request: Request, env: Env, companyId: string,
): Promise<Response> {
  const auth = await requireCompanyAccess(request, env, companyId);
  if (auth instanceof Response) return auth;

  const body = (await request.json()) as {
    type: string;
    payload: Record<string, unknown>;
    requested_by_agent_id?: string;
  };

  if (!body.type || !body.payload) {
    return Response.json({ error: "type and payload are required" }, { status: 400, headers: corsHeaders(env) });
  }

  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO approvals (id, company_id, type, requested_by_user_id, requested_by_agent_id, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, companyId, body.type,
    body.requested_by_agent_id ? null : auth.userId,
    body.requested_by_agent_id || null,
    JSON.stringify(body.payload),
  ).run();

  await logActivity(env, {
    companyId, actorType: body.requested_by_agent_id ? "agent" : "user",
    actorId: body.requested_by_agent_id || auth.userId,
    action: "approval.created", entityType: "approval", entityId: id,
    summary: `${body.type} approval requested`,
    agentId: body.requested_by_agent_id,
  });

  const approval = await env.DB.prepare("SELECT * FROM approvals WHERE id = ?").bind(id).first<ApprovalRow>();
  return Response.json({ approval }, { status: 201, headers: corsHeaders(env) });
}

// ─── GET /api/approvals/:id ───────────────────────────────────

export async function handleGetApproval(
  request: Request, env: Env, approvalId: string,
): Promise<Response> {
  const auth = await requireApprovalAccess(request, env, approvalId);
  if (auth instanceof Response) return auth;

  const { results: comments } = await env.DB.prepare(
    "SELECT * FROM approval_comments WHERE approval_id = ? ORDER BY created_at ASC",
  ).bind(approvalId).all<ApprovalCommentRow>();

  return Response.json({ approval: auth.approval, comments }, { headers: corsHeaders(env) });
}

// ─── POST /api/approvals/:id/approve ──────────────────────────

export async function handleApproveApproval(
  request: Request, env: Env, approvalId: string,
): Promise<Response> {
  const auth = await requireApprovalAccess(request, env, approvalId);
  if (auth instanceof Response) return auth;

  if (auth.approval.status !== "pending") {
    return Response.json(
      { error: `Cannot approve: status is ${auth.approval.status}` },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { note?: string };

  if (auth.approval.type === "hire_agent") {
    const supervisorAvailable = await fetchFromCompanySupervisor(
      env,
      auth.approval.company_id,
      "/health",
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );
    if (!supervisorAvailable) {
      return Response.json(
        { error: "Supervisor not configured" },
        { status: 503, headers: corsHeaders(env) },
      );
    }
  }

  await env.DB.prepare(
    `UPDATE approvals
     SET status = 'approved', decided_by_user_id = ?, decision_note = ?, decided_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(auth.userId, body.note || null, approvalId).run();

  await resolveDuplicatePendingApprovals(
    env,
    auth.approval,
    "approved",
    auth.userId,
    body.note || null,
  );

  // Side effect: if hire_agent, provision the agent
  if (auth.approval.type === "hire_agent") {
    const payload = JSON.parse(auth.approval.payload);
    const agentId = payload.agentId;
    if (agentId) {
      const supervisorResult = await requestSupervisor(
        env,
        auth.approval.company_id,
        `/companies/${auth.approval.company_id}/agents/${agentId}/resume`,
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
    }
  }

  // Notify supervisor so CEO gets immediate approval_decided event
  await requestSupervisor(
    env,
    auth.approval.company_id,
    `/companies/${auth.approval.company_id}/approval/${approvalId}/resolve`,
    { method: "POST", body: JSON.stringify({ decision: "approved", note: body.note || null }) },
  );

  await logActivity(env, {
    companyId: auth.approval.company_id,
    actorType: "user", actorId: auth.userId,
    action: "approval.approved", entityType: "approval", entityId: approvalId,
    summary: `${auth.approval.type} approval approved`,
    details: { note: body.note },
  });

  return Response.json({ success: true, status: "approved" }, { headers: corsHeaders(env) });
}

// ─── POST /api/approvals/:id/reject ───────────────────────────

export async function handleRejectApproval(
  request: Request, env: Env, approvalId: string,
): Promise<Response> {
  const auth = await requireApprovalAccess(request, env, approvalId);
  if (auth instanceof Response) return auth;

  if (auth.approval.status !== "pending") {
    return Response.json(
      { error: `Cannot reject: status is ${auth.approval.status}` },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { note?: string };

  if (auth.approval.type === "hire_agent") {
    const supervisorAvailable = await fetchFromCompanySupervisor(
      env,
      auth.approval.company_id,
      "/health",
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );
    if (!supervisorAvailable) {
      return Response.json(
        { error: "Supervisor not configured" },
        { status: 503, headers: corsHeaders(env) },
      );
    }
  }

  await env.DB.prepare(
    `UPDATE approvals
     SET status = 'rejected', decided_by_user_id = ?, decision_note = ?, decided_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(auth.userId, body.note || null, approvalId).run();

  await resolveDuplicatePendingApprovals(
    env,
    auth.approval,
    "rejected",
    auth.userId,
    body.note || null,
  );

  // Side effect: if hire_agent, terminate the agent
  if (auth.approval.type === "hire_agent") {
    const payload = JSON.parse(auth.approval.payload);
    if (payload.agentId) {
      const supervisorResult = await requestSupervisor(
        env,
        auth.approval.company_id,
        `/companies/${auth.approval.company_id}/agents/${payload.agentId}/deactivate`,
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
    }
  }

  // Notify supervisor so CEO gets immediate approval_decided event
  await requestSupervisor(
    env,
    auth.approval.company_id,
    `/companies/${auth.approval.company_id}/approval/${approvalId}/resolve`,
    { method: "POST", body: JSON.stringify({ decision: "rejected", note: body.note || null }) },
  );

  await logActivity(env, {
    companyId: auth.approval.company_id,
    actorType: "user", actorId: auth.userId,
    action: "approval.rejected", entityType: "approval", entityId: approvalId,
    summary: `${auth.approval.type} approval rejected`,
    details: { note: body.note },
  });

  return Response.json({ success: true, status: "rejected" }, { headers: corsHeaders(env) });
}

// ─── POST /api/approvals/:id/comments ─────────────────────────

export async function handleCreateApprovalComment(
  request: Request, env: Env, approvalId: string,
): Promise<Response> {
  const auth = await requireApprovalAccess(request, env, approvalId);
  if (auth instanceof Response) return auth;

  const body = (await request.json()) as { body: string; agent_id?: string };

  if (!body.body || body.body.trim().length < 1) {
    return Response.json({ error: "Comment body is required" }, { status: 400, headers: corsHeaders(env) });
  }

  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO approval_comments (id, company_id, approval_id, author_user_id, author_agent_id, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, auth.approval.company_id, approvalId, body.agent_id ? null : auth.userId, body.agent_id || null, body.body.trim()).run();

  const comment = await env.DB.prepare("SELECT * FROM approval_comments WHERE id = ?").bind(id).first<ApprovalCommentRow>();
  return Response.json({ comment }, { status: 201, headers: corsHeaders(env) });
}
