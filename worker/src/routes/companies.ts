import type { Env, CompanyRow } from "../types.js";
import { isPaidPlan } from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import {
  fallbackGenesisPrompt,
  generateCompanyName,
  generateLuckyStartupIdea,
  generateGenesisPrompt,
  buildSlug,
  generateId,
} from "../provisioning/config-builder.js";
import {
  claimAvatarFromPool,
  avatarGenerationEnabled,
  defaultFoundingTeamNamesForCountry,
  ensureAvatarPoolWarm,
  generateAgentAvatar,
  generateFoundingTeamNames,
  hasStoredAvatar,
  resolveFounderCountryContext,
  storeAvatar,
} from "../enrichment/agent-identity.js";
import { getBalance, grantCredits } from "../utils/credits.js";
import {
  buildCompanyProvisioningContract,
  checkCustomDomainCandidate,
  reserveAgentEmailAddress,
} from "../utils/company-contract.js";
import { ensureDedicatedVmForUser, getUserDedicatedVmRecord } from "../utils/dedicated-vm.js";
import { fetchFromCompanySupervisor } from "../utils/supervisor-routing.js";
import { fetchLiveSupervisorAgents, maybeDispatchAssignedWork } from "../utils/live-runtime.js";

const FOUNDING_BLUEPRINT_IDS = [
  "ceo",
  "cto",
  "frontend-dev",
  "backend-dev",
  "qa-tester",
  "cmo",
] as const;

const QUICK_NAME_TIMEOUT_MS = 1500;
const FOUNDING_BLUEPRINT_ID_SET = new Set<string>(FOUNDING_BLUEPRINT_IDS);

type FoundingNames = Awaited<ReturnType<typeof generateFoundingTeamNames>>;

export interface ProvisionedAgentRecord {
  id: string;
  name: string;
  title: string | null;
  role: string;
  blueprint_id: string | null;
  icon: string | null;
  metadata: string | null;
  email_address?: string | null;
  last_wake_at: string | null;
}

interface AutonomousCronSpec {
  schedule: string;
  firstDelayMinutes: number;
}

interface AutonomousCronPlan {
  agentId: string;
  schedule: string;
  prompt: string;
  nextRunAt: string;
}

interface SupervisorBootstrapStatus {
  ready: boolean;
  delegatedTaskCount: number;
  foundingAgentCount?: number;
  identityReadyCount?: number;
  avatarReadyCount?: number;
  concreteDocs: {
    executionContract: boolean;
    plan: boolean;
    executiveBrief: boolean;
    founderDailyUpdate: boolean;
  };
}

const MAX_BOOTSTRAP_ATTEMPTS = 3;
const IDEA_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "build",
  "company",
  "create",
  "does",
  "for",
  "from",
  "help",
  "helps",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "platform",
  "product",
  "service",
  "startup",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with",
]);

async function requireAuthenticatedUser(request: Request, env: Env): Promise<string | Response> {
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

  return userId;
}

function defaultAgentAvatarUrl(agentId: string): string {
  return `/api/avatars/${agentId}`;
}

function countClassicVowels(token: string): number {
  return (token.match(/[aeiou]/gi) || []).length;
}

function longestConsonantRun(token: string): number {
  let longest = 0;
  let current = 0;
  for (const char of token.toLowerCase()) {
    if (!/[a-z]/.test(char)) continue;
    if (/[aeiou]/.test(char)) {
      current = 0;
      continue;
    }
    current += 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

function looksInferableBusinessToken(rawToken: string): boolean {
  const token = rawToken.trim();
  if (!token) return false;
  if (/^[A-Z]{2,6}$/.test(token)) {
    return true;
  }

  const normalized = token.toLowerCase();
  if (normalized.length <= 2) {
    return false;
  }
  if (!/[a-z]/i.test(normalized)) {
    return false;
  }
  if (/(.)\1{3,}/.test(normalized)) {
    return false;
  }

  const vowelCount = countClassicVowels(normalized);
  const consonantRun = longestConsonantRun(normalized);
  if (vowelCount === 0 && normalized.length >= 4) {
    return false;
  }
  if (consonantRun >= 6) {
    return false;
  }
  if (normalized.length >= 7 && vowelCount / normalized.length < 0.2) {
    return false;
  }

  return true;
}

export function hasInferableCompanyMeaning(idea: string): boolean {
  const rawTokens = idea
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const significantTokens = rawTokens.filter((token) => {
    const normalized = token.toLowerCase();
    return normalized.length >= 3 && !IDEA_STOPWORDS.has(normalized);
  });

  if (significantTokens.length === 0) {
    return false;
  }

  const inferableCount = significantTokens.filter(looksInferableBusinessToken).length;
  if (inferableCount >= 1) {
    return true;
  }

  return false;
}

export interface CreateProvisionedCompanyInput {
  userId: string;
  idea: string;
  requestedName?: string | null;
  budgetCents?: number;
  expandedBrief?: string | null;
  companyGoal?: string | null;
}

export interface CreateProvisionedCompanyResult {
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
}

export async function createAndProvisionCompany(
  input: CreateProvisionedCompanyInput,
  env: Env,
  ctx: ExecutionContext,
): Promise<CreateProvisionedCompanyResult> {
  const idea = input.idea.trim();
  const requestedName = input.requestedName?.trim();
  const inferenceModel = "anthropic/claude-sonnet-4-6";
  const validBudgets = [500, 1000, 2500, 5000];
  const budgetCents = validBudgets.includes(input.budgetCents || 0)
    ? input.budgetCents!
    : 500;

  ctx.waitUntil(ensureAvatarPoolWarm(env));

  await env.DB.prepare(
    `INSERT INTO users (id, email, name) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(input.userId, `${input.userId}@clerk`, null)
    .run();

  const existingCreditEvent = await env.DB.prepare(
    `SELECT 1 FROM credit_events WHERE user_id = ? LIMIT 1`,
  ).bind(input.userId).first();

  if (!existingCreditEvent) {
    await grantCredits(
      env,
      input.userId,
      1000,
      "grant",
      "Launch credits",
    );
  }

  const [resolvedName, fallbackMissionBrief] = await Promise.all([
    requestedName && requestedName.length > 0
      ? Promise.resolve(requestedName)
      : generateCompanyName(idea, env, QUICK_NAME_TIMEOUT_MS),
    input.expandedBrief?.trim()
      ? Promise.resolve(null)
      : generateMissionBrief(idea, env).catch((err) => {
        console.warn("[launch] Mission brief generation failed:", err instanceof Error ? err.message : err);
        return null;
      }),
  ]);

  const generatedGenesisPrompt = input.expandedBrief?.trim()
    ? null
    : await generateGenesisPrompt(idea, resolvedName, env).catch(() => fallbackGenesisPrompt(resolvedName, idea));

  const expandedBrief = input.expandedBrief?.trim()
    || fallbackMissionBrief
    || generatedGenesisPrompt
    || idea;
  const companyGoal = input.companyGoal?.trim() || idea;

  const user = await env.DB.prepare(
    `SELECT plan FROM users WHERE id = ?`,
  ).bind(input.userId).first<{ plan: string }>();
  const contract = await buildCompanyProvisioningContract(
    env,
    resolvedName,
    (user?.plan as import("../types.js").SubscriptionPlan) ?? "free",
    { checkCustomDomainAvailability: false },
  );
  const activeDedicatedVm = isPaidPlan(user?.plan)
    ? await getUserDedicatedVmRecord(env, input.userId)
    : null;
  const creditBalance = await getBalance(env, input.userId);
  const minCreditsToLaunch = 100;
  if (creditBalance < minCreditsToLaunch) {
    const error = new Error(`You need at least ${minCreditsToLaunch} credits to launch a company.`);
    (error as Error & { status?: number; requiredCredits?: number; balance?: number }).status = 402;
    (error as Error & { requiredCredits?: number }).requiredCredits = minCreditsToLaunch;
    (error as Error & { balance?: number }).balance = creditBalance;
    throw error;
  }

  const id = generateId();
  const slug = buildSlug(resolvedName);

  await env.DB.prepare(
    `INSERT INTO companies (
       id, user_id, name, slug, idea, genesis_prompt, goal, state,
       inference_model, budget_cents, wallet_address, private_key_encrypted, issue_prefix,
       hosted_domain, email_domain, custom_domain_candidate, custom_domain_status,
       runtime_tier, dedicated_vm_status, dedicated_vm_id, dedicated_vm_ip, egress_tier
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.userId,
      resolvedName,
      slug,
      idea,
      expandedBrief,
      companyGoal,
      inferenceModel,
      budgetCents,
      null,
      null,
      deriveIssuePrefix(resolvedName, slug, id),
      contract.hostedDomain,
      contract.emailDomain,
      contract.customDomainCandidate,
      contract.customDomainStatus,
      contract.runtimeTier,
      activeDedicatedVm?.status === "active" ? "active" : contract.dedicatedVmStatus,
      activeDedicatedVm?.serverId ?? null,
      activeDedicatedVm?.serverIp ?? null,
      contract.egressTier,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO activity_log (id, company_id, type, summary) VALUES (?, ?, 'milestone', ?)`,
  )
    .bind(generateId(), id, `Company "${resolvedName}" created — provisioning with ${creditBalance} credits`)
    .run();

  const companyRow: CompanyRow = {
    id,
    user_id: input.userId,
    name: resolvedName,
    slug,
    idea,
    genesis_prompt: expandedBrief,
    state: "provisioning",
    inference_model: inferenceModel,
    budget_cents: budgetCents,
    spent_cents: 0,
    wallet_address: null,
    private_key_encrypted: null,
    public_visible: 0,
    goal: companyGoal,
    custom_domain: null,
    custom_domain_candidate: contract.customDomainCandidate,
    custom_domain_status: contract.customDomainStatus,
    hosted_domain: contract.hostedDomain,
    email_domain: contract.emailDomain,
    runtime_tier: contract.runtimeTier,
    dedicated_vm_status: activeDedicatedVm?.status === "active" ? "active" : contract.dedicatedVmStatus,
    dedicated_vm_id: activeDedicatedVm?.serverId ?? null,
    dedicated_vm_ip: activeDedicatedVm?.serverIp ?? null,
    egress_tier: contract.egressTier,
    mode: "autonomous",
    container_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  ctx.waitUntil(provisionInBackground(companyRow, env, ctx));
  ctx.waitUntil(refreshLaunchMetadata({
    companyId: id,
    customDomainCandidate: contract.customDomainCandidate,
    env,
  }));

  return {
    id,
    name: resolvedName,
    slug,
    state: "provisioning",
    budgetCents,
    hostedDomain: contract.hostedDomain,
    emailDomain: contract.emailDomain,
    customDomainCandidate: contract.customDomainCandidate,
    customDomainStatus: contract.customDomainStatus,
    runtimeTier: contract.runtimeTier,
  };
}

type AgentMetadata = {
  founding_identity_ready?: boolean;
  avatar_generated?: boolean;
  [key: string]: unknown;
};

function parseAgentMetadata(raw: string | null | undefined): AgentMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as AgentMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyAgentMetadata(raw: AgentMetadata): string {
  return JSON.stringify(raw);
}

function withAgentMetadata(
  agent: ProvisionedAgentRecord,
  patch: AgentMetadata,
): ProvisionedAgentRecord {
  const current = parseAgentMetadata(agent.metadata);
  return {
    ...agent,
    metadata: stringifyAgentMetadata({ ...current, ...patch }),
  };
}

function foundingIdentityReady(agent: ProvisionedAgentRecord): boolean {
  return Boolean(parseAgentMetadata(agent.metadata).founding_identity_ready);
}

function avatarGenerated(agent: ProvisionedAgentRecord): boolean {
  return Boolean(parseAgentMetadata(agent.metadata).avatar_generated);
}

function isFoundingTeamAgent(agent: Pick<ProvisionedAgentRecord, "blueprint_id">): boolean {
  return Boolean(agent.blueprint_id && FOUNDING_BLUEPRINT_ID_SET.has(agent.blueprint_id));
}

async function markAvatarGenerated(
  agent: ProvisionedAgentRecord,
  env: Env,
): Promise<ProvisionedAgentRecord> {
  const metadata = stringifyAgentMetadata({
    ...parseAgentMetadata(agent.metadata),
    avatar_generated: true,
  });
  const icon = agent.icon || defaultAgentAvatarUrl(agent.id);
  await env.DB.prepare(
    `UPDATE agents
     SET icon = ?, metadata = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(icon, metadata, agent.id).run();
  return { ...agent, icon, metadata };
}

/**
 * POST /api/companies/lucky-idea — Generate a startup idea and suggested name.
 */
export async function handleGenerateLuckyIdea(
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await requireAuthenticatedUser(request, env);
  if (typeof userId !== "string") {
    return userId;
  }

  await env.DB.prepare(
    `INSERT INTO users (id, email, name) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(userId, `${userId}@clerk`, null)
    .run();

  const lucky = await generateLuckyStartupIdea(env);
  return Response.json(lucky, { headers: corsHeaders(env) });
}

/**
 * POST /api/companies — Launch a new company.
 * Body: { idea: string, model?: string, budgetCents?: number }
 */
export async function handleCreateCompany(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const userId = await requireAuthenticatedUser(request, env);
  if (typeof userId !== "string") {
    return userId;
  }

  const body = (await request.json()) as {
    idea?: string;
    name?: string;
    budgetCents?: number;
  };

  if (!body.idea || body.idea.trim().length < 5) {
    return Response.json(
      { error: "Please describe your business idea (at least 5 characters)" },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const idea = body.idea.trim();
  const requestedName = body.name?.trim();
  if (!hasInferableCompanyMeaning(idea)) {
    return Response.json(
      {
        error: "Please describe the company in plain language so we can infer what it actually does.",
        detail: "Try one simple sentence about the product and who it is for. Example: \"An AI assistant that helps dentists answer inbound leads faster.\"",
      },
      { status: 400, headers: corsHeaders(env) },
    );
  }

  try {
    const result = await createAndProvisionCompany(
      {
        userId,
        idea,
        requestedName,
        budgetCents: body.budgetCents,
      },
      env,
      ctx,
    );
    return Response.json(result, { status: 201, headers: corsHeaders(env) });
  } catch (error) {
    const status = typeof (error as { status?: number }).status === "number"
      ? (error as { status: number }).status
      : 500;
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not create company",
        requiredCredits: (error as { requiredCredits?: number }).requiredCredits,
        balance: (error as { balance?: number }).balance,
      },
      { status, headers: corsHeaders(env) },
    );
  }
}

async function refreshLaunchMetadata(input: {
  companyId: string;
  customDomainCandidate: string | null;
  env: Env;
}): Promise<void> {
  const { companyId, customDomainCandidate, env } = input;

  const customDomainStatus = await checkCustomDomainCandidate(customDomainCandidate)
    .catch(() => "error" as const);

  await env.DB.prepare(
    `UPDATE companies
     SET custom_domain_status = CASE
           WHEN custom_domain_status = 'unchecked' THEN ?
           ELSE custom_domain_status
         END,
         updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(customDomainStatus, companyId)
    .run();
}

export async function provisionInBackground(
  company: CompanyRow,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  const logProvisioningFailure = async (message: string): Promise<void> => {
    console.error(`Provisioning failed for ${company.id}: ${message}`);

    await env.DB.prepare(
      `UPDATE companies SET state = 'failed', updated_at = datetime('now') WHERE id = ?`,
    ).bind(company.id).run();

    await env.DB.prepare(
      `INSERT INTO activity_log (id, company_id, type, summary, details) VALUES (?, ?, 'error', ?, ?)`,
    ).bind(
      generateId(),
      company.id,
      "Provisioning failed",
      JSON.stringify({ error: message }),
    ).run();
  };

  try {
    if (company.runtime_tier === "dedicated") {
      const dedicatedVm = await ensureDedicatedVmForUser(env, company.user_id);
      if (dedicatedVm.status === "active") {
        await env.DB.prepare(
          `UPDATE companies
           SET dedicated_vm_status = 'active',
               dedicated_vm_id = ?,
               dedicated_vm_ip = ?,
               updated_at = datetime('now')
           WHERE id = ?`,
        )
          .bind(dedicatedVm.serverId, dedicatedVm.serverIp, company.id)
          .run();
      }
      if (dedicatedVm.status !== "active") {
        await env.DB.prepare(
          `INSERT INTO activity_log (id, company_id, type, summary, details)
           VALUES (?, ?, 'milestone', ?, ?)`,
        ).bind(
          generateId(),
          company.id,
          "Dedicated VM provisioning started",
          JSON.stringify({
            dedicatedVmStatus: dedicatedVm.status,
            dedicatedVmId: dedicatedVm.serverId,
            dedicatedVmIp: dedicatedVm.serverIp,
          }),
        ).run();
        return;
      }
    }

    const existingAgents = await getProvisionedAgents(company.id, env);
    if (existingAgents.length > 0) {
      if (company.state === "provisioning" || company.state === "failed") {
        await bootstrapProvisionedCompany(company, env, ctx);
      } else {
        console.warn(
          `[launch] Skipping reprovision for ${company.id}; company already has ${existingAgents.length} agents`,
        );
      }
      return;
    }

    const res = await fetchFromCompanySupervisor(
      env,
      company.id,
      `/companies/${company.id}/provision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
        body: JSON.stringify({
          companyName: company.name,
          user_id: company.user_id,
          goal: company.goal ?? company.idea,
          genesis_prompt: company.genesis_prompt,
          env: company.runtime_tier === "shared"
            ? { SKIP_DOCKER: "true" }
            : undefined,
        }),
      },
    );

    if (!res) {
      throw new Error("Supervisor is not configured");
    }

    const raw = await res.text();
    let parsed: { container?: { containerId?: string }; error?: string } | null = null;
    try {
      parsed = raw ? JSON.parse(raw) as { container?: { containerId?: string }; error?: string } : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      throw new Error(parsed?.error || raw || `Supervisor returned ${res.status}`);
    }

    if (parsed?.container?.containerId) {
      await env.DB.prepare(
        `UPDATE companies SET container_id = ?, updated_at = datetime('now') WHERE id = ?`,
      ).bind(parsed.container.containerId, company.id).run();
    }

    await bootstrapProvisionedCompany(company, env, ctx);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await logProvisioningFailure(message);
  }
}

export async function bootstrapProvisionedCompany(
  company: CompanyRow,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  let agents = await getProvisionedAgents(company.id, env);
  const hasCeo = () => agents.some((agent) => agent.blueprint_id === "ceo" || agent.role === "ceo");

  // Only CEO is required at bootstrap time — other agents are activated later
  // by the supervisor's ingest_plan() based on the plan's agents_needed list.
  if (!hasCeo()) {
    agents = await hydrateProvisionedAgentsFromSupervisor(company.id, env, agents);
  }

  if (!hasCeo()) {
    throw new Error(
      "Expected CEO to exist after provisioning, but no CEO agent was found",
    );
  }

  // Personalize whatever agents exist now (may be just CEO)
  let personalizedAgents = await applyFoundingTeamIdentity(company, env, agents);
  personalizedAgents = await assignFoundingTeamAvatarsFromPool(company, env, personalizedAgents);
  personalizedAgents = await ensureFoundingTeamAvatars(company, env, personalizedAgents);
  const preparedFoundingAgents = personalizedAgents.filter((agent) => isFoundingTeamAgent(agent));
  if (
    preparedFoundingAgents.some((agent) => !foundingIdentityReady(agent) || !avatarGenerated(agent))
  ) {
    throw new Error("Founding team identity was not fully prepared during provisioning");
  }
  await syncAgentIdentityToSupervisor(company.id, env, personalizedAgents);
  await ensureAutonomousWakeSchedules(company, env, personalizedAgents);
  ctx?.waitUntil(ensureAvatarPoolWarm(env));

  // The supervisor runs the CEO planning turn asynchronously during provision_company().
  // It will transition: planning → (CEO writes mission + plan) → ingest plan → create agents → running.
  // We only advance D1 from provisioning -> planning here. If the supervisor has already
  // moved the company further along (running/paused/completed/failed), do not clobber it
  // back to planning during bootstrap or re-bootstrap.
  await env.DB.prepare(
    `UPDATE companies
     SET state = 'planning', updated_at = datetime('now')
     WHERE id = ?
       AND state = 'provisioning'`,
  ).bind(company.id).run();

  await env.DB.prepare(
    `INSERT INTO activity_log (id, company_id, type, summary, details)
     VALUES (?, ?, 'milestone', ?, ?)`,
  ).bind(
    generateId(),
    company.id,
    "CEO planning started",
    JSON.stringify({
      agents: personalizedAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        blueprintId: agent.blueprint_id,
      })),
    }),
  ).run();

  void ctx;
}

/**
 * Personalize agents that were activated after initial bootstrap (e.g. by ingest_plan).
 * Called lazily during launch-status polling so the user sees agents appear with names/avatars.
 */
export async function personalizeUnreadyAgents(
  companyId: string,
  env: Env,
): Promise<void> {
  const companyRow = await env.DB.prepare(
    `SELECT * FROM companies WHERE id = ?`,
  ).bind(companyId).first<CompanyRow>();
  if (!companyRow) return;

  // First, hydrate any agents that exist in supervisor but not yet in D1
  // (e.g. agents activated by ingest_plan after initial bootstrap)
  let agents = await getProvisionedAgents(companyId, env);
  agents = await hydrateProvisionedAgentsFromSupervisor(companyId, env, agents);

  const unready = agents.filter(
    (agent) => isFoundingTeamAgent(agent) && !foundingIdentityReady(agent),
  );
  if (unready.length === 0) return;

  let personalized = await applyFoundingTeamIdentity(companyRow, env, unready);
  personalized = await assignFoundingTeamAvatarsFromPool(companyRow, env, personalized);
  personalized = await ensureFoundingTeamAvatars(companyRow, env, personalized);
  await syncAgentIdentityToSupervisor(companyId, env, personalized);
}

async function getProvisionedAgents(
  companyId: string,
  env: Env,
): Promise<ProvisionedAgentRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, title, role, blueprint_id, icon, metadata, last_wake_at
     FROM agents
     WHERE company_id = ?
     ORDER BY created_at ASC`,
  ).bind(companyId).all<ProvisionedAgentRecord>();

  return results ?? [];
}

async function hydrateProvisionedAgentsFromSupervisor(
  companyId: string,
  env: Env,
  currentAgents: ProvisionedAgentRecord[],
): Promise<ProvisionedAgentRecord[]> {
  const liveAgents = await fetchLiveSupervisorAgents(env, companyId);
  const currentFoundingCount = new Set(
    currentAgents.map((agent) => agent.blueprint_id).filter((id): id is string => Boolean(id)),
  ).size;
  const liveFoundingCount = new Set(
    (liveAgents ?? []).map((agent) => agent.blueprint_id).filter((id): id is string => Boolean(id)),
  ).size;
  if (!liveAgents || (liveAgents.length <= currentAgents.length && liveFoundingCount <= currentFoundingCount)) {
    return currentAgents;
  }

  await env.DB.batch(
    liveAgents.map((agent) =>
      env.DB.prepare(
        `INSERT INTO agents (
           id, company_id, name, role, title, icon, status, reports_to,
           capabilities, adapter_config, runtime_config, permissions, metadata,
           blueprint_id, model_tier, total_credits_consumed, last_wake_at, last_sleep_at,
           department, email_address, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', '{}', '{}', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           company_id = excluded.company_id,
           name = excluded.name,
           role = excluded.role,
           title = excluded.title,
           icon = excluded.icon,
           status = excluded.status,
           reports_to = excluded.reports_to,
           metadata = excluded.metadata,
           blueprint_id = excluded.blueprint_id,
           model_tier = excluded.model_tier,
           total_credits_consumed = excluded.total_credits_consumed,
           last_wake_at = excluded.last_wake_at,
           last_sleep_at = excluded.last_sleep_at,
           department = excluded.department,
           email_address = excluded.email_address,
           updated_at = excluded.updated_at`,
      ).bind(
        agent.id,
        agent.company_id,
        agent.name,
        agent.role,
        agent.title ?? null,
        agent.icon ?? defaultAgentAvatarUrl(agent.id),
        agent.status,
        agent.reports_to ?? null,
        agent.metadata ?? "{}",
        agent.blueprint_id ?? null,
        agent.model_tier ?? "sonnet",
        agent.total_credits_consumed ?? 0,
        agent.last_wake_at ?? null,
        agent.last_sleep_at ?? null,
        agent.department ?? null,
        agent.email_address ?? null,
      ),
    ),
  );

  return getProvisionedAgents(companyId, env);
}

async function applyFoundingTeamIdentity(
  company: CompanyRow,
  env: Env,
  agents: ProvisionedAgentRecord[],
): Promise<ProvisionedAgentRecord[]> {
  const { country, countryName } = await resolveFounderCountryContext(env, company.user_id);

  const names = await loadFoundingNames(country, countryName, company.name, env);
  const updatedAgents: ProvisionedAgentRecord[] = [];

  for (const agent of agents) {
    if (!isFoundingTeamAgent(agent)) {
      updatedAgents.push(agent);
      continue;
    }
    const blueprintId = agent.blueprint_id ?? "";
    const name = resolveFoundingName(names, blueprintId, agent.name);
    const title = resolveFoundingTitle(agent);
    const emailAddress = await reserveAgentEmailAddress(
      env,
      company.id,
      company.email_domain ?? null,
      {
        blueprintId,
        role: agent.role,
        title,
        name,
      },
    );
    const metadata = stringifyAgentMetadata({
      ...parseAgentMetadata(agent.metadata),
      founding_identity_ready: true,
    });

    await env.DB.prepare(
      `UPDATE agents
       SET name = ?, title = ?, email_address = ?, icon = COALESCE(NULLIF(icon, ''), ?), metadata = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(name, title, emailAddress, defaultAgentAvatarUrl(agent.id), metadata, agent.id).run();

    updatedAgents.push({
      ...agent,
      name,
      title,
      icon: agent.icon || defaultAgentAvatarUrl(agent.id),
      metadata,
      email_address: emailAddress,
    });
  }

  return updatedAgents;
}

async function ensureFoundingTeamAvatars(
  company: CompanyRow,
  env: Env,
  agents: ProvisionedAgentRecord[],
): Promise<ProvisionedAgentRecord[]> {
  if (!avatarGenerationEnabled(env)) {
    return agents;
  }

  const { country, countryName } = await resolveFounderCountryContext(env, company.user_id);
  const budget = { remaining: FOUNDING_BLUEPRINT_IDS.length * 2 };
  const foundingAgentIds = new Set(agents.filter((agent) => isFoundingTeamAgent(agent)).map((agent) => agent.id));
  let currentAgents = agents;

  for (let pass = 1; pass <= 2; pass += 1) {
    const avatarPresence = await Promise.all(
      currentAgents
        .filter((agent) => foundingAgentIds.has(agent.id))
      .map(async (agent) => ({
        agent,
        hasAvatar: await hasStoredAvatar(agent.id, env),
      })),
    );
    const storedAvatarUpdates = new Map<string, ProvisionedAgentRecord>();
    for (const presence of avatarPresence) {
      if (presence.hasAvatar && !avatarGenerated(presence.agent)) {
        storedAvatarUpdates.set(presence.agent.id, await markAvatarGenerated(presence.agent, env));
      }
    }
    if (storedAvatarUpdates.size > 0) {
      currentAgents = currentAgents.map((agent) => storedAvatarUpdates.get(agent.id) ?? agent);
    }
    const agentsNeedingAvatars = avatarPresence
      .filter(({ hasAvatar }) => !hasAvatar)
      .map(({ agent }) => agent);

    if (agentsNeedingAvatars.length === 0) {
      return currentAgents;
    }

    // Process avatars with concurrency limiter (3 at a time) to avoid rate limits
    const AVATAR_CONCURRENCY = 3;
    const allResults: PromiseSettledResult<ProvisionedAgentRecord>[] = [];
    for (let i = 0; i < agentsNeedingAvatars.length; i += AVATAR_CONCURRENCY) {
      const batch = agentsNeedingAvatars.slice(i, i + AVATAR_CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map((agent) => generateAndStoreAvatar(agent, country, countryName, env, budget)),
      );
      allResults.push(...batchResults);
    }

    const updatedById = new Map<string, ProvisionedAgentRecord>();
    for (const result of allResults) {
      if (result.status === "fulfilled") {
        updatedById.set(result.value.id, result.value);
      }
    }

    currentAgents = currentAgents.map((agent) => updatedById.get(agent.id) ?? agent);
  }

  const stillMissing = await Promise.all(
    currentAgents
      .filter((agent) => foundingAgentIds.has(agent.id))
      .map(async (agent) => ({
      agent,
      hasAvatar: await hasStoredAvatar(agent.id, env),
    })),
  );
  const missingNames = stillMissing
    .filter(({ hasAvatar }) => !hasAvatar)
    .map(({ agent }) => agent.name);
  if (missingNames.length > 0) {
    throw new Error(`Founding team avatar generation did not complete: ${missingNames.join(", ")}`);
  }

  return currentAgents;
}

async function assignFoundingTeamAvatarsFromPool(
  company: CompanyRow,
  env: Env,
  agents: ProvisionedAgentRecord[],
): Promise<ProvisionedAgentRecord[]> {
  const { country, countryName } = await resolveFounderCountryContext(env, company.user_id);
  const usedSlotIds = new Set<string>();
  const updatedById = new Map<string, ProvisionedAgentRecord>();

  for (const agent of agents) {
    if (!isFoundingTeamAgent(agent)) {
      continue;
    }
    if (await hasStoredAvatar(agent.id, env)) {
      if (!avatarGenerated(agent)) {
        updatedById.set(agent.id, await markAvatarGenerated(agent, env));
      }
      continue;
    }

    const claimed = await claimAvatarFromPool(
      agent.id,
      agent.title || agent.role || "Agent",
      env,
      usedSlotIds,
      {
        agentName: agent.name,
        country,
        countryName,
      },
    );
    if (!claimed) {
      continue;
    }

    updatedById.set(
      agent.id,
      await markAvatarGenerated(
        {
          ...agent,
          icon: claimed.avatarUrl,
        },
        env,
      ),
    );
  }

  return agents.map((agent) => updatedById.get(agent.id) ?? agent);
}

async function generateAndStoreAvatar(
  agent: ProvisionedAgentRecord,
  country: string,
  countryName: string,
  env: Env,
  budget: { remaining: number },
): Promise<ProvisionedAgentRecord> {
  if (await hasStoredAvatar(agent.id, env)) {
    return markAvatarGenerated(agent, env);
  }

  try {
    const avatarBase64 = await generateAgentAvatar(agent.name, agent.title || "Agent", countryName, env, {
      agentId: agent.id,
      budget,
      mode: "automatic",
      countryCode: country,
    });
    if (!avatarBase64) {
      return agent;
    }
    const icon = await storeAvatar(agent.id, avatarBase64, env);
    return markAvatarGenerated({ ...agent, icon }, env);
  } catch (err) {
    console.warn(
      `[launch] Failed to generate avatar for ${agent.name} (${agent.id}):`,
      err instanceof Error ? err.message : err,
    );
    return agent;
  }
}

async function syncAgentIdentityToSupervisor(
  companyId: string,
  env: Env,
  agents: Array<Pick<ProvisionedAgentRecord, "id" | "name" | "title" | "icon" | "email_address" | "metadata">>,
): Promise<void> {
  const results = await Promise.all(
    agents.map(async (agent) => {
      const res = await fetchFromCompanySupervisor(
        env,
        companyId,
        `/companies/${companyId}/agents/${agent.id}/identity`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
          },
          body: JSON.stringify({
            name: agent.name,
            title: agent.title,
            icon: agent.icon || defaultAgentAvatarUrl(agent.id),
            email_address: agent.email_address ?? null,
            metadata: parseAgentMetadata(agent.metadata),
          }),
        },
      );
      if (!res || !res.ok) {
        const message = res ? await res.text().catch(() => `HTTP ${res.status}`) : "Supervisor unavailable";
        throw new Error(`Failed syncing identity for ${agent.id}: ${message}`);
      }
    }),
  );
  void results;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function buildAutonomousCronSpec(
  agent: Pick<ProvisionedAgentRecord, "blueprint_id">,
): AutonomousCronSpec {
  switch (agent.blueprint_id) {
    case "ceo":
      return { schedule: "*/12 * * * *", firstDelayMinutes: 2 };
    case "cto":
      return { schedule: "1-59/12 * * * *", firstDelayMinutes: 3 };
    case "cmo":
      return { schedule: "2-59/12 * * * *", firstDelayMinutes: 4 };
    case "frontend-dev":
      return { schedule: "*/15 * * * *", firstDelayMinutes: 3 };
    case "backend-dev":
      return { schedule: "2-59/15 * * * *", firstDelayMinutes: 5 };
    case "qa-tester":
      return { schedule: "4-59/15 * * * *", firstDelayMinutes: 7 };
    case "api-keys-agent":
      return { schedule: "6-59/15 * * * *", firstDelayMinutes: 9 };
    default:
      return { schedule: "8-59/15 * * * *", firstDelayMinutes: 10 };
  }
}

export function buildAutonomousWakePrompt(
  companyName: string,
  mission: string,
  agent: ProvisionedAgentRecord,
): string {
  const sharedContext = [
    `You are continuing day-zero execution for ${companyName}.`,
    "Read /workspace/docs/goal.md, /workspace/docs/execution-contract.json, /workspace/docs/plan.md, /workspace/.agent/OPERATING_SYSTEM.md, and your role guide before acting.",
    "Advance one concrete deliverable for your role and leave a real artifact in /workspace.",
    "A turn with no file edits is a failed turn. Use tools and modify the workspace before you finish.",
    "Do not restart from scratch. Continue the strongest existing file or asset and move it measurably closer to finished.",
    "Use structured task/messages through your outbox first. Markdown handoffs are fallback only.",
    "Follow the execution contract and your assigned tracked task. Do not assume the landing page is the first priority unless the CEO chose it.",
    "Avoid fake progress. A finished landing page, app screen, backend module, market analysis, ad creative, or executive brief is better than another vague planning note.",
    "If you are blocked, write the blocker clearly in the relevant doc and leave the next best recommendation for the CEO.",
    "",
    "Mission:",
    mission,
  ].join("\n");

  switch (agent.blueprint_id) {
    case "ceo":
      return [
        sharedContext,
        "Review team output, refine /workspace/docs/execution-contract.json and /workspace/docs/plan.md, and keep the company aligned to the mission. Replace any placeholder text in those CEO docs with real content. Keep founder docs concise: plan 120-350 words. Do NOT write executive-brief.md or daily-update files proactively — those are generated automatically by the scheduler at end of day.",
      ].join("\n\n");
    case "cto":
      return [
        sharedContext,
        "Review architecture and engineering output, keep /workspace/docs/architecture.md current only as a compact implementation decision log, route engineer work through QA, and sequence delivery around the current priority defined by the CEO and the execution contract.",
      ].join("\n\n");
    case "frontend-dev":
      return [
        sharedContext,
        "Continue building the highest-priority frontend deliverable in /workspace/src/. If the current priority is a landing page, improve /workspace/src/index.html; otherwise work the correct frontend files for the assigned task. Do not end the turn without improving a real frontend file.",
      ].join("\n\n");
    case "backend-dev":
      return [
        sharedContext,
        "Continue the backend implementation in /workspace/src/. Ship real APIs, data models, or execution logic needed by the MVP in /workspace/src/api/, /workspace/src/backend/, or /workspace/src/services/. Do not end the turn without creating or updating backend code.",
      ].join("\n\n");
    case "qa-tester":
      return [
        sharedContext,
        "Expand the QA plan, test the current highest-priority deliverable, and loop concrete issues back quickly through tracked work.",
      ].join("\n\n");
    case "api-keys-agent":
      return [
        sharedContext,
        "Keep auditing required services, credentials, and operational blockers. Leave concrete setup guidance in /workspace/docs/ops/api-services.md.",
      ].join("\n\n");
    case "cmo":
      return [
        sharedContext,
        "Continue the go-to-market work. Prefer concrete copy/assets first. Keep marketing docs brief and only when they change a decision: marketing plan 100-280 words, market analysis 100-280 words. Create at least one real marketing asset in /workspace/assets/ads/ or /workspace/assets/creative/. If a channel specialist is warranted, request the hire in /workspace/.agent/hiring/cmo.json.",
      ].join("\n\n");
    case "reddit-marketer":
      return [
        sharedContext,
        "Advance the Reddit channel under the CMO strategy. Produce channel-ready copy, subreddit research, or response plans and report findings to /workspace/.agent/handoffs/to-cmo.md.",
      ].join("\n\n");
    case "twitter-marketer":
      return [
        sharedContext,
        "Advance the X/Twitter channel under the CMO strategy. Produce tweets, threads, or engagement plans and report findings to /workspace/.agent/handoffs/to-cmo.md.",
      ].join("\n\n");
    default:
      return sharedContext;
  }
}

export function buildAutonomousCronPlans(
  companyName: string,
  mission: string,
  agents: ProvisionedAgentRecord[],
  now: Date = new Date(),
): AutonomousCronPlan[] {
  return agents.map((agent) => {
    const spec = buildAutonomousCronSpec(agent);
    return {
      agentId: agent.id,
      schedule: spec.schedule,
      prompt: buildAutonomousWakePrompt(companyName, mission, agent),
      nextRunAt: addMinutes(now, spec.firstDelayMinutes).toISOString(),
    };
  });
}

export async function ensureAutonomousWakeSchedules(
  company: CompanyRow,
  env: Env,
  agents: ProvisionedAgentRecord[],
): Promise<void> {
  const existingCronTasks = await env.DB.prepare(
    `SELECT agent_id
     FROM cron_tasks
     WHERE company_id = ?
       AND enabled = 1`,
  ).bind(company.id).all<{ agent_id: string }>();

  const scheduledAgentIds = new Set(
    (existingCronTasks.results ?? []).map((task) => task.agent_id),
  );
  const mission = resolveCompanyMission(company);
  const plans = buildAutonomousCronPlans(company.name, mission, agents).filter(
    (plan) => !scheduledAgentIds.has(plan.agentId),
  );

  if (plans.length === 0) {
    return;
  }

  await env.DB.batch(
    plans.map((plan) =>
      env.DB.prepare(
        `INSERT INTO cron_tasks (
           id, company_id, agent_id, schedule, prompt, enabled,
           last_run_at, next_run_at, created_by
         )
         VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      ).bind(
        generateId(),
        company.id,
        plan.agentId,
        plan.schedule,
        plan.prompt,
        plan.nextRunAt,
        plan.agentId,
      )),
  );
}

async function loadFoundingNames(
  country: string,
  countryName: string,
  companyName: string,
  env: Env,
): Promise<FoundingNames> {
  if (!env.GEMINI_API_KEY) {
    return defaultFoundingNames(country, countryName);
  }

  try {
    return await Promise.race([
      generateFoundingTeamNames(country, countryName, companyName, env),
      new Promise<FoundingNames>((_, reject) => {
        setTimeout(() => reject(new Error("Founding name generation timed out")), 8_000);
      }),
    ]);
  } catch (err) {
    console.warn(
      `[launch] Falling back to default founding names for ${companyName}:`,
      err instanceof Error ? err.message : err,
    );
    return defaultFoundingNames(country, countryName);
  }
}

function defaultFoundingNames(
  country: string,
  countryName: string,
): FoundingNames {
  return defaultFoundingTeamNamesForCountry(country, countryName);
}

function resolveFoundingName(
  names: FoundingNames,
  blueprintId: string,
  fallbackName?: string,
): string {
  switch (blueprintId) {
    case "ceo":
      return names.ceo;
    case "cto":
      return names.cto;
    case "frontend-dev":
      return names.engineer1;
    case "backend-dev":
      return names.engineer2;
    case "qa-tester":
      return names.qa_lead;
    case "api-keys-agent":
      return names.api_key_agent;
    case "cmo":
      return names.cmo;
    default:
      return defaultSpecialistName(blueprintId, fallbackName);
  }
}

function defaultSpecialistName(
  blueprintId: string,
  fallbackName?: string,
): string {
  switch (blueprintId) {
    case "fullstack-dev":
      return "Adrian Cole";
    case "devops":
      return "Miles Everett";
    case "reddit-marketer":
      return "Nora Flynn";
    case "twitter-marketer":
      return "Ethan Vale";
    case "cold-emailer":
      return "Claire Sutton";
    case "seo-writer":
      return "Juliette Moss";
    case "ad-buyer":
      return "Darren Holt";
    case "content-writer":
      return "Naomi Pierce";
    case "lead-researcher":
      return "Theo Warren";
    case "outbound-caller":
      return "Sabrina Lowe";
    case "account-buyer":
      return "Gavin Mercer";
    case "bookkeeper":
      return "Priya Nair";
    case "designer":
      return "Elisa Romero";
    default:
      return fallbackName || "Agent";
  }
}

function deriveIssuePrefix(
  name: string,
  slug: string | null,
  companyId: string,
): string {
  const source = (slug || name || companyId)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const consonants = source.replace(/[AEIOU]/g, "");
  const head = (consonants || source || "CMP").slice(0, 3).padEnd(3, "X");
  const tail = companyId
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(-2)
    .padStart(2, "0");
  return `${head}${tail}`;
}

async function ensureCompanyIssuePrefix(
  env: Env,
  companyId: string,
): Promise<string> {
  const company = await env.DB.prepare(
    `SELECT name, slug, issue_prefix
     FROM companies
     WHERE id = ?`,
  ).bind(companyId).first<{ name: string; slug: string | null; issue_prefix: string | null }>();

  if (!company) {
    return deriveIssuePrefix("COMPANY", null, companyId);
  }

  if (company.issue_prefix && company.issue_prefix !== "AIC") {
    return company.issue_prefix;
  }

  const issuePrefix = deriveIssuePrefix(company.name, company.slug, companyId);
  await env.DB.prepare(
    `UPDATE companies
     SET issue_prefix = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(issuePrefix, companyId).run();

  return issuePrefix;
}

function resolveFoundingTitle(agent: ProvisionedAgentRecord): string {
  switch (agent.blueprint_id) {
    case "frontend-dev":
      return "Frontend Engineer";
    case "backend-dev":
      return "Backend Engineer";
    case "qa-tester":
      return "QA Lead";
    case "api-keys-agent":
      return "API Specialist";
    default:
      return agent.title || "Agent";
  }
}

async function dispatchInitialWakeups(
  company: CompanyRow,
  env: Env,
  agents: ProvisionedAgentRecord[],
): Promise<SupervisorBootstrapStatus | null> {
  const mission = resolveCompanyMission(company);
  const ceo = agents.find((agent) => agent.blueprint_id === "ceo" || agent.role === "ceo");
  if (!ceo) {
    console.warn(`[launch] Could not find CEO for initial kickoff in ${company.id}`);
    return null;
  }

  const res = await fetchFromCompanySupervisor(
    env,
    company.id,
    `/companies/${company.id}/agents/${ceo.id}/work`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
      },
      body: JSON.stringify({
        prompt: buildInitialWakePrompt(company.name, mission, ceo),
        sync: true,
      }),
    },
  );

  if (!res || !res.ok) {
    const errText = res ? await res.text().catch(() => "") : "";
    console.warn(
      `[launch] Failed to wake CEO ${ceo.id} for ${company.id}: ${errText || res?.status || "supervisor unavailable"}`,
    );
    return null;
  }

  return await fetchBootstrapStatusFromSupervisor(env, company.id);
}

function isBootstrapReady(
  status: SupervisorBootstrapStatus | null,
): boolean {
  return Boolean(status?.ready);
}

function missingBootstrapItems(
  status: SupervisorBootstrapStatus | null,
): string[] {
  if (!status) {
    return [
      "full founding team",
      "personalized team identity",
      "first delegated tracked task",
    ];
  }

  const missing: string[] = [];
  if ((status.foundingAgentCount ?? 0) < FOUNDING_BLUEPRINT_IDS.length) missing.push("full founding team");
  if ((status.identityReadyCount ?? 0) < FOUNDING_BLUEPRINT_IDS.length) missing.push("personalized team identity");
  if ((status.avatarReadyCount ?? 0) < FOUNDING_BLUEPRINT_IDS.length) missing.push("founding team profile photos");
  if (status.delegatedTaskCount < 1) missing.push("first delegated tracked task");
  return missing;
}

function buildBootstrapRecoveryPrompt(
  companyName: string,
  mission: string,
  ceo: ProvisionedAgentRecord,
  status: SupervisorBootstrapStatus | null,
): string {
  const missing = missingBootstrapItems(status);
  return [
    `You are resuming the CEO bootstrap for ${companyName}.`,
    "Your previous bootstrap turn was incomplete. Fix the missing items now and do nothing else.",
    "Do not rewrite files that are already complete unless they are obviously wrong.",
    `Missing items: ${missing.join("; ")}.`,
    `Write your outbox to /workspace/.agent/outbox/${ceo.id}.json using JSON like {"messages":[{"to":"frontend-dev","type":"task","subject":"Short task title","body":"Concrete instructions with a deliverable.","priority":"high"}]}.`,
    "Before ending this turn, make sure the full founding team exists, their identity is fully synced, and at least one non-CEO founding agent has a real delegated tracked task.",
    "Do not ask the founder for anything. Do not hire new specialists. Do not write a celebration note.",
    "Mission:",
    mission,
  ].join("\n");
}

async function dispatchBootstrapRecoveryWake(
  company: CompanyRow,
  env: Env,
  ceo: ProvisionedAgentRecord,
  status: SupervisorBootstrapStatus | null,
): Promise<SupervisorBootstrapStatus | null> {
  const res = await fetchFromCompanySupervisor(
    env,
    company.id,
    `/companies/${company.id}/agents/${ceo.id}/work`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
      },
      body: JSON.stringify({
        prompt: buildBootstrapRecoveryPrompt(
          company.name,
          resolveCompanyMission(company),
          ceo,
          status,
        ),
        sync: true,
      }),
    },
  );

  if (!res || !res.ok) {
    const errText = res ? await res.text().catch(() => "") : "";
    console.warn(
      `[launch] Failed to re-wake CEO ${ceo.id} for ${company.id}: ${errText || res?.status || "supervisor unavailable"}`,
    );
    return null;
  }

  return await fetchBootstrapStatusFromSupervisor(env, company.id);
}

async function runCeoBootstrap(
  company: CompanyRow,
  env: Env,
  agents: ProvisionedAgentRecord[],
): Promise<boolean> {
  const ceo = agents.find((agent) => agent.blueprint_id === "ceo" || agent.role === "ceo");
  if (!ceo) {
    return false;
  }

  let status = await dispatchInitialWakeups(company, env, agents);
  if (isBootstrapReady(status)) {
    return true;
  }

  for (let attempt = 2; attempt <= MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    console.warn(
      `[launch] CEO bootstrap incomplete for ${company.id}; retry ${attempt}/${MAX_BOOTSTRAP_ATTEMPTS} with missing items: ${missingBootstrapItems(status).join(", ")}`,
    );
    status = await dispatchBootstrapRecoveryWake(company, env, ceo, status);
    if (isBootstrapReady(status)) {
      return true;
    }
  }

  return false;
}

const SUPERVISOR_READY_POLL_MS = 2000;
const SUPERVISOR_READY_MAX_WAIT_MS = 120_000;

async function waitForSupervisorReady(
  env: Env,
  companyId: string,
): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    const res = await fetchFromCompanySupervisor(
      env,
      companyId,
      `/companies/${companyId}/status`,
      {
        headers: {
          "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        },
      },
    );

    if (res?.ok) {
      const data = await res.json() as { state?: string; tasks?: { total?: number } };
      if (data.state === "running") {
        return true;
      }
      if (data.state === "failed" || data.state === "dead") {
        return false;
      }
    }

    if (Date.now() - startedAt > SUPERVISOR_READY_MAX_WAIT_MS) {
      console.warn(`[launch] Supervisor did not reach running state for ${companyId} within ${SUPERVISOR_READY_MAX_WAIT_MS}ms`);
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, SUPERVISOR_READY_POLL_MS));
  }
}

async function fetchBootstrapStatusFromSupervisor(
  env: Env,
  companyId: string,
): Promise<SupervisorBootstrapStatus | null> {
  const res = await fetchFromCompanySupervisor(
    env,
    companyId,
    `/companies/${companyId}/bootstrap`,
    {
      headers: {
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
      },
    },
  );

  if (!res || !res.ok) {
    return null;
  }

  return await res.json() as SupervisorBootstrapStatus;
}

async function activateProvisionedCompany(
  companyId: string,
  env: Env,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE companies
     SET state = 'running',
         public_visible = 1,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(companyId).run();

  const res = await fetchFromCompanySupervisor(
    env,
    companyId,
    `/companies/${companyId}/resume`,
    {
      method: "POST",
      headers: {
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
      },
    },
  );

  if (!res || !res.ok) {
    const errText = res ? await res.text().catch(() => "") : "";
    throw new Error(`Failed to activate company after CEO bootstrap: ${errText || res?.status || "supervisor unavailable"}`);
  }
}

function buildInitialWakePrompt(
  companyName: string,
  mission: string,
  agent: ProvisionedAgentRecord,
): string {
  const sharedContext = [
    `You are part of the founding team for ${companyName}.`,
    "Day zero starts now. Read /workspace/docs/goal.md, /workspace/docs/execution-contract.json, /workspace/.agent/OPERATING_SYSTEM.md, and your role guide before you act.",
    "This is an execution turn. You must use tools and leave a file change in /workspace before you finish.",
    "Use structured task/messages through your outbox first. Markdown handoffs are fallback only.",
    "",
    "Mission:",
    mission,
    "",
    "Start immediately and leave clear artifacts in /workspace/docs/ or /workspace/src/.",
  ].join("\n");

  switch (agent.blueprint_id) {
    case "ceo":
      return [
        sharedContext,
        "This first turn is the CEO bootstrap turn. You decide what happens first. Do not assume the worker preassigned anything correctly.",
        `Write your outbox to /workspace/.agent/outbox/${agent.id}.json using JSON like {"messages":[{"to":"frontend-dev","type":"task","subject":"Short task title","body":"Clear task instructions with a concrete deliverable.","priority":"high"}]}.`,
        "Before ending this turn, you must do all of the following:",
        "1. Decide the first 3-5 workstreams yourself.",
        "2. Replace /workspace/docs/execution-contract.json with the canonical company direction, success criteria, and first owners.",
        "3. Replace /workspace/docs/plan.md with the first sequence of work.",
        "4. Write at least 3 structured tracked task messages to specific founding agents in your outbox so parallel work starts immediately after this turn.",
        "Do NOT write executive-brief.md or daily-update files — those are generated automatically by the scheduler at end of day.",
        "If any of those four requirements is missing, the bootstrap is failed.",
        "Keep the docs concise and operational. Do not spend this turn polishing secondary files, hiring extra specialists, or asking the founder for anything.",
      ].join("\n\n");
    default:
      return [
        sharedContext,
        "Wait for structured CEO or CTO delegation before taking on major implementation work. Use this turn to read the current contract, inspect the workspace, and be ready to execute the first tracked task that gets assigned to you.",
      ].join("\n\n");
  }
}

function resolveCompanyMission(company: CompanyRow): string {
  return company.goal?.trim()
    || company.genesis_prompt?.trim()
    || company.idea?.trim()
    || `Build a working company around ${company.name}.`;
}

const MISSION_BRIEF_TIMEOUT_MS = 4000;

async function generateMissionBrief(
  idea: string,
  env: Env,
): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY) return null;

  const prompt = `You are a startup strategist writing the founding mission brief for a new AI-powered company.

The founder's idea: "${idea}"

Write a concise, polished mission brief with exactly two sections:

**Mission** (2 paragraphs)
Articulate what this company does, who it serves, and why it matters. Make it compelling and specific — not generic startup fluff. Ground it in the real problem being solved.

**Vision & Strategy**
A short section (3-5 bullet points) covering:
- The long-term vision
- Core strategic approach
- Key differentiators
- High-level execution priorities

Write in third person ("The company..."). Be direct and concrete. No platitudes. No "revolutionize" or "leverage AI". Just clear, sharp strategy that a founder would be proud to show investors.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MISSION_BRIEF_TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API returned ${resp.status}`);
    }

    const result = await resp.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = result.content?.find((c) => c.type === "text")?.text?.trim();
    return text || null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET /api/companies — List all companies for the authenticated user.
 */
export async function handleListCompanies(
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

  const { results } = await env.DB.prepare(
    `SELECT id, name, slug, idea, state, inference_model, budget_cents, spent_cents, public_visible,
            hosted_domain, email_domain, custom_domain, custom_domain_candidate, custom_domain_status,
            runtime_tier, dedicated_vm_status, egress_tier, created_at, updated_at
     FROM companies
     WHERE user_id = ?
       AND state IN ('running', 'paused', 'failed')
     ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all();

  const companies = (results as Record<string, unknown>[]).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    idea: r.idea,
    state: r.state,
    inferenceModel: r.inference_model,
    budgetCents: r.budget_cents,
    spentCents: r.spent_cents,
    publicVisible: r.public_visible,
    hostedDomain: r.hosted_domain,
    emailDomain: r.email_domain,
    customDomain: r.custom_domain,
    customDomainCandidate: r.custom_domain_candidate,
    customDomainStatus: r.custom_domain_status,
    runtimeTier: r.runtime_tier,
    dedicatedVmStatus: r.dedicated_vm_status,
    egressTier: r.egress_tier,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return Response.json(
    { companies },
    { headers: corsHeaders(env) },
  );
}
