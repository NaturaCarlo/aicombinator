/**
 * Admin Routes — AI Combinator platform management.
 *
 * All routes require Clerk JWT + ADMIN_USER_IDS membership.
 * These endpoints are used by the admin dashboard to manage
 * applications, agents, purchase requests, and monitor health.
 */

import type { Env, CompanyRow } from "../types.js";
import { requireAdmin } from "../middleware/admin.js";
import { corsHeaders } from "../middleware/cors.js";
import { generateId, buildSlug, generateCompanyName, generateGenesisPrompt } from "../provisioning/config-builder.js";
import { provisionInBackground } from "./companies.js";
import { avatarGenerationEnabled, generateAgentAvatar, storeAvatar } from "../enrichment/agent-identity.js";
import { buildCompanyProvisioningContract } from "../utils/company-contract.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";

async function requestSupervisor(
  env: Env,
  companyId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  return fetchFromCompanySupervisor(env, companyId, path, init);
}

// ─── Applications ─────────────────────────────────────────────

/**
 * GET /api/admin/applications
 * Query params: ?status=submitted (optional filter)
 */
export async function handleAdminListApplications(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");

  let query: string;
  let params: unknown[];

  if (statusFilter) {
    query = `SELECT a.*, u.email, u.name as user_name, u.image_url
             FROM applications a
             LEFT JOIN users u ON u.id = a.user_id
             WHERE a.status = ?
             ORDER BY a.submitted_at DESC NULLS LAST, a.created_at DESC
             LIMIT 100`;
    params = [statusFilter];
  } else {
    query = `SELECT a.*, u.email, u.name as user_name, u.image_url
             FROM applications a
             LEFT JOIN users u ON u.id = a.user_id
             ORDER BY a.submitted_at DESC NULLS LAST, a.created_at DESC
             LIMIT 100`;
    params = [];
  }

  const results = await env.DB.prepare(query).bind(...params).all();

  return Response.json(
    { applications: results.results },
    { headers: corsHeaders(env) },
  );
}

/**
 * DELETE /api/admin/applications/:id
 * Hard-deletes any application (any status).
 */
export async function handleAdminDeleteApplication(
  request: Request,
  env: Env,
  applicationId: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const app = await env.DB.prepare(
    `SELECT id FROM applications WHERE id = ?`,
  )
    .bind(applicationId)
    .first();

  if (!app) {
    return Response.json(
      { error: "Application not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  await env.DB.prepare(`DELETE FROM applications WHERE id = ?`)
    .bind(applicationId)
    .run();

  return Response.json(
    { deleted: true },
    { headers: corsHeaders(env) },
  );
}

/**
 * PATCH /api/admin/applications/:id
 * Body: { status: "accepted" | "rejected", admin_notes?: string }
 *
 * When accepted, creates a company and provisions the agent.
 */
export async function handleAdminUpdateApplication(
  request: Request,
  env: Env,
  applicationId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const body = (await request.json()) as {
    status: "accepted" | "rejected";
    admin_notes?: string;
  };

  if (!body.status || !["accepted", "rejected"].includes(body.status)) {
    return Response.json(
      { error: "status must be 'accepted' or 'rejected'" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const app = await env.DB.prepare(
    `SELECT * FROM applications WHERE id = ?`,
  )
    .bind(applicationId)
    .first<Record<string, unknown>>();

  if (!app) {
    return Response.json(
      { error: "Application not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // Update application status
  await env.DB.prepare(
    `UPDATE applications SET status = ?, admin_notes = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(body.status, body.admin_notes || null, applicationId)
    .run();

  // If accepted, create company + provision agent
  if (body.status === "accepted") {
    const userId = app.user_id as string;
    const idea = (app.problem_statement as string) || (app.tagline as string) || "Autonomous agent";
    const companyName = (app.company_name as string) || await generateCompanyName(idea, env);
    const genesisPrompt = await generateGenesisPrompt(idea, companyName, env);
    const contract = await buildCompanyProvisioningContract(env, companyName, "paid");

    const companyId = generateId();
    const slug = buildSlug(companyName);
    const budgetCents = 5000; // $50 default for accepted applications
    const companyGoal = genesisPrompt || idea;

    // Ensure user row exists
    await env.DB.prepare(
      `INSERT INTO users (id, email, name) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(userId, `${userId}@clerk`, null)
      .run();

    // Insert company
    await env.DB.prepare(
      `INSERT INTO companies (
         id, user_id, name, slug, idea, genesis_prompt, goal, state, inference_model,
         budget_cents, wallet_address, private_key_encrypted, hosted_domain, email_domain,
         custom_domain_candidate, custom_domain_status, runtime_tier, dedicated_vm_status, egress_tier
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', 'anthropic/claude-sonnet-4-6', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        companyId,
        userId,
        companyName,
        slug,
        idea,
        genesisPrompt,
        companyGoal,
        budgetCents,
        null,
        null,
        contract.hostedDomain,
        contract.emailDomain,
        contract.customDomainCandidate,
        contract.customDomainStatus,
        contract.runtimeTier,
        contract.dedicatedVmStatus,
        contract.egressTier,
      )
      .run();

    // Log creation
    await env.DB.prepare(
      `INSERT INTO activity_log (id, company_id, type, summary) VALUES (?, ?, 'milestone', ?)`,
    )
      .bind(generateId(), companyId, `Company "${companyName}" created via Genesis Batch acceptance`)
      .run();

    // Provision in background
    const companyRow = {
      id: companyId,
      user_id: userId,
      name: companyName,
      slug,
      idea,
      genesis_prompt: genesisPrompt,
      goal: companyGoal,
      state: "provisioning",
      inference_model: "anthropic/claude-sonnet-4-6",
      budget_cents: budgetCents,
      spent_cents: 0,
      wallet_address: null,
      private_key_encrypted: null,
      public_visible: 1,
      custom_domain: null,
      custom_domain_candidate: contract.customDomainCandidate,
      custom_domain_status: contract.customDomainStatus,
      hosted_domain: contract.hostedDomain,
      email_domain: contract.emailDomain,
      runtime_tier: contract.runtimeTier,
      dedicated_vm_status: contract.dedicatedVmStatus,
      dedicated_vm_id: null,
      dedicated_vm_ip: null,
      egress_tier: contract.egressTier,
      container_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as CompanyRow;

    ctx.waitUntil(provisionInBackground(companyRow, env, ctx));

    return Response.json(
      {
        status: "accepted",
        companyId,
        companyName,
        slug,
        message: "Application accepted. Agent is being provisioned.",
      },
      { headers: corsHeaders(env) },
    );
  }

  return Response.json(
    { status: body.status, message: `Application ${body.status}` },
    { headers: corsHeaders(env) },
  );
}

// ─── Companies / Agents ───────────────────────────────────────

/**
 * GET /api/admin/companies
 * Query params: ?state=running (optional filter)
 */
export async function handleAdminListCompanies(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const stateFilter = url.searchParams.get("state");

  let query: string;
  let params: unknown[];

  if (stateFilter) {
    query = `SELECT c.id, c.name, c.slug, c.idea, c.state, c.inference_model,
                    c.budget_cents, c.spent_cents, c.public_visible,
                    c.created_at, c.updated_at,
                    u.email, u.name as owner_name, u.image_url as owner_image,
                    (SELECT COUNT(*) FROM virtual_cards vc WHERE vc.company_id = c.id AND vc.status = 'active') as has_card,
                    (SELECT COUNT(*) FROM purchase_requests pr WHERE pr.company_id = c.id AND pr.status = 'pending') as pending_purchases
             FROM companies c
             LEFT JOIN users u ON u.id = c.user_id
             WHERE c.state = ?
             ORDER BY c.created_at DESC
             LIMIT 200`;
    params = [stateFilter];
  } else {
    query = `SELECT c.id, c.name, c.slug, c.idea, c.state, c.inference_model,
                    c.budget_cents, c.spent_cents, c.public_visible,
                    c.created_at, c.updated_at,
                    u.email, u.name as owner_name, u.image_url as owner_image,
                    (SELECT COUNT(*) FROM virtual_cards vc WHERE vc.company_id = c.id AND vc.status = 'active') as has_card,
                    (SELECT COUNT(*) FROM purchase_requests pr WHERE pr.company_id = c.id AND pr.status = 'pending') as pending_purchases
             FROM companies c
             LEFT JOIN users u ON u.id = c.user_id
             ORDER BY c.created_at DESC
             LIMIT 200`;
    params = [];
  }

  const results = await env.DB.prepare(query).bind(...params).all();

  return Response.json(
    { companies: results.results },
    { headers: corsHeaders(env) },
  );
}

/**
 * GET /api/admin/companies/:id
 * Returns full company detail with card, purchases, activity, and agent state.
 */
export async function handleAdminGetCompany(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const company = await env.DB.prepare(
    `SELECT c.*, u.email, u.name as owner_name, u.image_url as owner_image
     FROM companies c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.id = ?`,
  )
    .bind(companyId)
    .first();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  // Fetch related data in parallel
  const [cardResult, purchasesResult, activityResult, agentsResult, messagesResult] =
    await Promise.all([
      env.DB.prepare(
        `SELECT id, last_four, card_brand, status, balance_cents, spending_limit_cents
         FROM virtual_cards WHERE company_id = ? AND status != 'cancelled'
         ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(companyId)
        .first(),
      env.DB.prepare(
        `SELECT id, description, amount_cents, url, status, admin_notes, created_at, resolved_at
         FROM purchase_requests WHERE company_id = ?
         ORDER BY created_at DESC LIMIT 10`,
      )
        .bind(companyId)
        .all(),
      env.DB.prepare(
        `SELECT id, type, summary, created_at
         FROM activity_log WHERE company_id = ?
         ORDER BY created_at DESC LIMIT 20`,
      )
        .bind(companyId)
        .all(),
      env.DB.prepare(
        `SELECT id, name, role, title, icon, status, reports_to, capabilities, last_heartbeat_at, created_at
         FROM agents WHERE company_id = ? ORDER BY created_at ASC`,
      )
        .bind(companyId)
        .all(),
      env.DB.prepare(
        `SELECT m.*, fa.name as from_name, fa.title as from_title, ta.name as to_name, ta.title as to_title
         FROM agent_messages m
         LEFT JOIN agents fa ON fa.id = m.from_agent_id
         LEFT JOIN agents ta ON ta.id = m.to_agent_id
         WHERE m.company_id = ?
         ORDER BY m.created_at DESC LIMIT 30`,
      )
        .bind(companyId)
        .all(),
    ]);

  // Remove sensitive fields
  const { private_key_encrypted, ...safeCompany } =
    company as Record<string, unknown>;

  return Response.json(
    {
      ...safeCompany,
      card: cardResult || null,
      recentPurchases: purchasesResult.results,
      recentActivity: activityResult.results,
      agents: (agentsResult.results || []).map((a: any) => ({
        ...a,
        capabilities: JSON.parse(a.capabilities || "[]"),
      })),
      messages: (messagesResult.results || []).map((m: any) => ({
        id: m.id,
        fromName: m.from_title || m.from_name || m.from_agent_id,
        toName: m.to_title || m.to_name || m.to_agent_id,
        type: m.type,
        subject: m.subject,
        body: m.body,
        priority: m.priority,
        status: m.status,
        createdAt: m.created_at,
      })),
    },
    { headers: corsHeaders(env) },
  );
}

/**
 * PATCH /api/admin/companies/:id
 * Body: { budget_cents?, state?, inference_model? }
 */
export async function handleAdminUpdateCompany(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const company = await env.DB.prepare(
    `SELECT id, name, state, budget_cents, spent_cents FROM companies WHERE id = ?`,
  )
    .bind(companyId)
    .first<{ id: string; name: string; state: string; budget_cents: number; spent_cents: number }>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  const body = (await request.json()) as {
    budget_cents?: number;
    state?: string;
    inference_model?: string;
  };

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.budget_cents !== undefined) {
    updates.push("budget_cents = ?");
    values.push(body.budget_cents);
  }

  // Pause/resume: delegate to supervisor (it pushes D1 synchronously).
  // Other states (failed, dead, etc.): admin override, write D1 directly.
  let stateHandled = false;
  if (body.state === "paused") {
    const supRes = await requestSupervisor(env, companyId, `/companies/${companyId}/pause`, {
      method: "POST",
    });
    if (!supRes) {
      return Response.json(
        { error: "Supervisor not configured" },
        { status: 503, headers: corsHeaders(env) },
      );
    }
    if (!supRes.ok) {
      return Response.json(
        { error: (await supRes.text()) || "Failed to pause company" },
        { status: supRes.status, headers: corsHeaders(env) },
      );
    }
    stateHandled = true;
  } else if (body.state === "running") {
    const supRes = await requestSupervisor(env, companyId, `/companies/${companyId}/resume`, {
      method: "POST",
    });
    if (!supRes) {
      return Response.json(
        { error: "Supervisor not configured" },
        { status: 503, headers: corsHeaders(env) },
      );
    }
    if (!supRes.ok) {
      return Response.json(
        { error: (await supRes.text()) || "Failed to resume company" },
        { status: supRes.status, headers: corsHeaders(env) },
      );
    }
    stateHandled = true;
  } else if (body.state) {
    const validStates = ["sleeping", "failed", "dead"];
    if (!validStates.includes(body.state)) {
      return Response.json(
        { error: `Invalid state. Must be one of: running, paused, ${validStates.join(", ")}` },
        { status: 400, headers: corsHeaders(env) },
      );
    }
    updates.push("state = ?");
    values.push(body.state);
  }

  if (body.inference_model) {
    if (body.inference_model !== "anthropic/claude-sonnet-4-6") {
      return Response.json(
        { error: "Company inference_model is fixed to anthropic/claude-sonnet-4-6." },
        { status: 400, headers: corsHeaders(env) },
      );
    }
    updates.push("inference_model = ?");
    values.push(body.inference_model);
  }

  // Auto-resurrect: if budget was increased on a dead company
  if (body.budget_cents !== undefined && !body.state && company.state === "dead") {
    if (body.budget_cents > company.spent_cents) {
      const supRes = await requestSupervisor(env, companyId, `/companies/${companyId}/resume`, {
        method: "POST",
      }).catch(() => null);
      if (supRes?.ok) {
        stateHandled = true;
      } else {
        // Fallback: write D1 directly if supervisor unavailable for resurrection
        updates.push("state = ?");
        values.push("running");
      }
    }
  }

  if (updates.length === 0 && !stateHandled) {
    return Response.json(
      { error: "No valid fields to update" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(companyId);
    await env.DB.prepare(
      `UPDATE companies SET ${updates.join(", ")} WHERE id = ?`,
    )
      .bind(...values)
      .run();
  }

  // Log the change
  const changeSummary = Object.entries(body)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  await env.DB.prepare(
    `INSERT INTO activity_log (id, company_id, type, summary) VALUES (?, ?, 'milestone', ?)`,
  )
    .bind(generateId(), companyId, `Admin updated: ${changeSummary}`)
    .run();

  return Response.json(
    { updated: true, changes: body },
    { headers: corsHeaders(env) },
  );
}

/**
 * POST /api/admin/companies/:id/provision
 * Manually trigger DO provisioning for a company (skips payment).
 */
export async function handleAdminProvisionCompany(
  request: Request,
  env: Env,
  companyId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const company = await env.DB.prepare(
    `SELECT * FROM companies WHERE id = ?`,
  )
    .bind(companyId)
    .first<CompanyRow>();

  if (!company) {
    return Response.json(
      { error: "Company not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  if (company.state === "running") {
    return Response.json(
      { error: "Company is already running" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const existingAgents = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM agents
     WHERE company_id = ?`,
  )
    .bind(companyId)
    .first<{ count: number }>();

  if ((existingAgents?.count ?? 0) > 0) {
    return Response.json(
      { error: "Company is already initialized. Use resume instead of provision." },
      { status: 409, headers: corsHeaders(env) },
    );
  }

  await env.DB.prepare(
    `UPDATE companies SET state = 'provisioning', updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(companyId)
    .run();

  const updatedCompany: CompanyRow = { ...company, state: "provisioning" };
  ctx.waitUntil(provisionInBackground(updatedCompany, env, ctx));

  return Response.json(
    { provisioning: true, companyId, name: company.name },
    { headers: corsHeaders(env) },
  );
}

/**
 * POST /api/admin/companies/:id/generate-avatars
 * Generate avatars for agents that don't have one.
 * Generates one avatar per request to stay within CPU limits.
 */
export async function handleAdminGenerateAvatars(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  // Find agents without avatars
  const agents = await env.DB.prepare(
    `SELECT a.id, a.name, a.title
     FROM agents a
     WHERE a.company_id = ? AND (a.icon IS NULL OR a.icon = '')
     LIMIT 1`,
  ).bind(companyId).all<{ id: string; name: string; title: string }>();

  if (!agents.results || agents.results.length === 0) {
    return Response.json(
      { done: true, message: "All agents have avatars" },
      { headers: corsHeaders(env) },
    );
  }

  const agent = agents.results[0];

  // Get country from user profile
  const profile = await env.DB.prepare(
    `SELECT up.country, up.country_name FROM user_profiles up
     JOIN companies c ON c.user_id = up.user_id
     WHERE c.id = ?`,
  ).bind(companyId).first<{ country: string | null; country_name: string | null }>();
  const countryName = profile?.country_name || "United States";

  if (!avatarGenerationEnabled(env)) {
    return Response.json(
      { error: "No avatar generation provider configured" },
      { status: 500, headers: corsHeaders(env) },
    );
  }

  const avatarBase64 = await generateAgentAvatar(
    agent.name,
    agent.title,
    countryName,
    env as any,
    {
      agentId: agent.id,
      mode: "manual",
      countryCode: profile?.country || undefined,
    },
  );

  if (!avatarBase64) {
    return Response.json(
      { error: `Avatar generation returned no image for ${agent.name}` },
      { status: 500, headers: corsHeaders(env) },
    );
  }

  const avatarUrl = await storeAvatar(agent.id, avatarBase64, env as any);
  await env.DB.prepare(
    `UPDATE agents
     SET icon = ?,
         metadata = json_set(COALESCE(metadata, '{}'), '$.avatar_generated', 1),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(avatarUrl, agent.id).run();

  // Count remaining
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM agents WHERE company_id = ? AND (icon IS NULL OR icon = '')`,
  ).bind(companyId).first<{ cnt: number }>();

  return Response.json(
    {
      done: false,
      generated: { id: agent.id, name: agent.name, avatarUrl },
      remaining: remaining?.cnt ?? 0,
    },
    { headers: corsHeaders(env) },
  );
}

// ─── Purchase Requests ────────────────────────────────────────

/**
 * GET /api/admin/purchases
 * Query params: ?status=pending (optional, defaults to all)
 */
export async function handleAdminListPurchases(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status");

  let query: string;
  let params: unknown[];

  if (statusFilter) {
    query = `SELECT pr.*, c.name as company_name, c.slug as company_slug
             FROM purchase_requests pr
             JOIN companies c ON c.id = pr.company_id
             WHERE pr.status = ?
             ORDER BY pr.created_at DESC
             LIMIT 100`;
    params = [statusFilter];
  } else {
    query = `SELECT pr.*, c.name as company_name, c.slug as company_slug
             FROM purchase_requests pr
             JOIN companies c ON c.id = pr.company_id
             ORDER BY pr.created_at DESC
             LIMIT 100`;
    params = [];
  }

  const results = await env.DB.prepare(query).bind(...params).all();

  return Response.json(
    { requests: results.results },
    { headers: corsHeaders(env) },
  );
}

/**
 * PATCH /api/admin/purchases/:id
 * Body: { status: "approved" | "rejected", admin_notes?: string }
 */
export async function handleAdminUpdatePurchase(
  request: Request,
  env: Env,
  purchaseId: string,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const body = (await request.json()) as {
    status: "approved" | "rejected";
    admin_notes?: string;
  };

  if (!body.status || !["approved", "rejected"].includes(body.status)) {
    return Response.json(
      { error: "status must be 'approved' or 'rejected'" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const purchase = await env.DB.prepare(
    `SELECT pr.*, c.name as company_name
     FROM purchase_requests pr
     JOIN companies c ON c.id = pr.company_id
     WHERE pr.id = ?`,
  )
    .bind(purchaseId)
    .first<{
      id: string;
      company_id: string;
      description: string;
      amount_cents: number | null;
      company_name: string;
    }>();

  if (!purchase) {
    return Response.json(
      { error: "Purchase request not found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE purchase_requests SET status = ?, admin_notes = ?, resolved_at = datetime('now') WHERE id = ?`,
    ).bind(body.status, body.admin_notes || null, purchaseId),
    env.DB.prepare(
      `INSERT INTO activity_log (id, company_id, type, summary) VALUES (?, ?, 'financial', ?)`,
    ).bind(
      generateId(),
      purchase.company_id,
      `Purchase request ${body.status}: ${purchase.description.slice(0, 80)}${
        purchase.amount_cents
          ? ` ($${(purchase.amount_cents / 100).toFixed(2)})`
          : ""
      }`,
    ),
  ]);

  return Response.json(
    {
      status: body.status,
      message: `Purchase request ${body.status}`,
    },
    { headers: corsHeaders(env) },
  );
}

// ─── Health Monitoring ────────────────────────────────────────

/**
 * GET /api/admin/health
 * Returns company runtime health from the supervisor-based execution path.
 */
export async function handleAdminHealth(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(
    `SELECT id, name, slug, state, budget_cents, spent_cents, inference_model, runtime_tier,
            dedicated_vm_status, updated_at,
            (SELECT COUNT(*) FROM credit_events ce WHERE ce.company_id = companies.id AND ce.type = 'deduct') as turn_count
     FROM companies
     ORDER BY updated_at DESC`,
  ).all<{
    id: string;
    name: string;
    slug: string;
    state: string;
    budget_cents: number;
    spent_cents: number;
    inference_model: string;
    runtime_tier: string;
    dedicated_vm_status: string;
    turn_count: number;
    updated_at: string;
  }>();

  if (!results || results.length === 0) {
    return Response.json(
      { agents: [], stats: { total: 0, running: 0, healthy: 0, totalSpentCents: 0 } },
      { headers: corsHeaders(env) },
    );
  }

  const agents = results.map((company) => ({
    companyId: company.id,
    name: company.name,
    slug: company.slug,
    state: company.state,
    budgetCents: company.budget_cents,
    spentCents: company.spent_cents,
    inferenceModel: company.inference_model,
    runtimeTier: company.runtime_tier,
    dedicatedVmStatus: company.dedicated_vm_status,
    lastHeartbeat: company.updated_at,
    turnCount: company.turn_count || 0,
    isHealthy: company.state !== "dead" && company.state !== "failed",
  }));

  const stats = {
    total: agents.length,
    running: agents.filter((a) => a.state === "running").length,
    healthy: agents.filter((a) => a.isHealthy).length,
    totalSpentCents: results.reduce((sum, c) => sum + c.spent_cents, 0),
  };

  return Response.json(
    { agents, stats },
    { headers: corsHeaders(env) },
  );
}
