import type { Env } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/**
 * GET /api/applications — Get the current user's application (draft or submitted).
 * Returns the single application or null.
 */
export async function handleGetApplication(
  request: Request,
  env: Env,
): Promise<Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const row = await env.DB.prepare(
    `SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first();

  return Response.json(
    { application: row || null },
    { headers: corsHeaders(env) },
  );
}

/**
 * PUT /api/applications — Save draft (auto-save) or submit.
 * Body: { ...formFields, submit?: boolean }
 * If submit=true, validates all required fields and marks as submitted.
 * Otherwise just saves the draft.
 */
export async function handleSaveApplication(
  request: Request,
  env: Env,
): Promise<Response> {
  const token = extractToken(request);
  console.log("PUT /api/applications - has token:", !!token);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  console.log("PUT /api/applications - userId:", userId);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  // Check if user already has a submitted application
  const existing = await env.DB.prepare(
    `SELECT id, status FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: string; status: string }>();

  if (existing?.status === "submitted" || existing?.status === "accepted" || existing?.status === "rejected") {
    return Response.json(
      { error: "Application already submitted and cannot be modified" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const body = (await request.json()) as Record<string, unknown>;
  const submit = body.submit === true;

  const fields = {
    founder_name: String(body.founderName || ""),
    founder_bio: String(body.founderBio || ""),
    agent_experience: String(body.agentExperience || ""),
    prev_projects: String(body.prevProjects || ""),
    founder_linkedin: String(body.founderLinkedin || ""),
    founder_github: String(body.founderGithub || ""),
    founder_twitter: String(body.founderTwitter || ""),
    company_name: String(body.companyName || ""),
    tagline: String(body.tagline || ""),
    category: String(body.category || ""),
    problem_statement: String(body.problemStatement || ""),
    target_customer: String(body.targetCustomer || ""),
    agent_core_loop: String(body.agentCoreLoop || ""),
    first_twenty_four_hours: String(body.firstTwentyFourHours || ""),
  };

  // Validate required fields on submit
  if (submit) {
    const required = [
      "founder_name", "founder_bio", "agent_experience",
      "company_name", "tagline", "category",
      "problem_statement", "target_customer",
      "agent_core_loop", "first_twenty_four_hours",
    ] as const;

    const missing = required.filter((f) => !fields[f].trim());
    if (missing.length > 0) {
      return Response.json(
        { error: "Missing required fields", fields: missing },
        { status: 400, headers: corsHeaders(env) },
      );
    }
  }

  const status = submit ? "submitted" : "draft";
  const submittedAt = submit ? new Date().toISOString() : null;

  // Ensure user row exists
  await env.DB.prepare(
    `INSERT INTO users (id, email, name) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(userId, `${userId}@clerk`, null)
    .run();

  if (existing) {
    // Update existing draft
    await env.DB.prepare(
      `UPDATE applications SET
        founder_name = ?, founder_bio = ?, agent_experience = ?,
        prev_projects = ?, founder_linkedin = ?, founder_github = ?,
        founder_twitter = ?, company_name = ?, tagline = ?,
        category = ?, problem_statement = ?, target_customer = ?,
        agent_core_loop = ?, first_twenty_four_hours = ?,
        status = ?, submitted_at = COALESCE(?, submitted_at),
        updated_at = datetime('now')
      WHERE id = ?`,
    )
      .bind(
        fields.founder_name, fields.founder_bio, fields.agent_experience,
        fields.prev_projects, fields.founder_linkedin, fields.founder_github,
        fields.founder_twitter, fields.company_name, fields.tagline,
        fields.category, fields.problem_statement, fields.target_customer,
        fields.agent_core_loop, fields.first_twenty_four_hours,
        status, submittedAt,
        existing.id,
      )
      .run();

    const updated = await env.DB.prepare(`SELECT * FROM applications WHERE id = ?`)
      .bind(existing.id)
      .first();

    return Response.json(
      { application: updated },
      { headers: corsHeaders(env) },
    );
  } else {
    // Create new application
    const id = generateId();
    await env.DB.prepare(
      `INSERT INTO applications (
        id, user_id, status,
        founder_name, founder_bio, agent_experience,
        prev_projects, founder_linkedin, founder_github,
        founder_twitter, company_name, tagline,
        category, problem_statement, target_customer,
        agent_core_loop, first_twenty_four_hours,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, userId, status,
        fields.founder_name, fields.founder_bio, fields.agent_experience,
        fields.prev_projects, fields.founder_linkedin, fields.founder_github,
        fields.founder_twitter, fields.company_name, fields.tagline,
        fields.category, fields.problem_statement, fields.target_customer,
        fields.agent_core_loop, fields.first_twenty_four_hours,
        submittedAt,
      )
      .run();

    const created = await env.DB.prepare(`SELECT * FROM applications WHERE id = ?`)
      .bind(id)
      .first();

    return Response.json(
      { application: created },
      { status: 201, headers: corsHeaders(env) },
    );
  }
}

/**
 * DELETE /api/applications — Delete the current user's application.
 * Only drafts and submitted (not yet accepted) can be deleted by the user.
 */
export async function handleDeleteApplication(
  request: Request,
  env: Env,
): Promise<Response> {
  const token = extractToken(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return Response.json(
      { error: "Invalid token" },
      { status: 401, headers: corsHeaders(env) },
    );
  }

  const existing = await env.DB.prepare(
    `SELECT id, status FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: string; status: string }>();

  if (!existing) {
    return Response.json(
      { error: "No application found" },
      { status: 404, headers: corsHeaders(env) },
    );
  }

  if (existing.status === "accepted") {
    return Response.json(
      { error: "Cannot delete an accepted application" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  await env.DB.prepare(`DELETE FROM applications WHERE id = ?`)
    .bind(existing.id)
    .run();

  return Response.json(
    { deleted: true },
    { headers: corsHeaders(env) },
  );
}
