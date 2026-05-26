import type {
  CompanyEmailAliasRow,
  CompanyRow,
  DomainBundleOrderRow,
  DomainBundleOrderStatus,
  DomainBundleQuoteRow,
  Env,
} from "../types.js";
import { extractToken, verifyClerkJwt } from "../middleware/auth.js";
import { corsHeaders } from "../middleware/cors.js";
import { generateId } from "../provisioning/config-builder.js";
import { getBalance, deductCredits } from "../utils/credits.js";
import { logActivity } from "../utils/activity.js";
import {
  createAgentmailPodInbox,
  ensureAgentmailDomain,
  ensureAgentmailPod,
  getAgentmailDomain,
  rememberAgentmailInboxOwner,
  type AgentMailDnsRecord,
} from "../integrations/agentmail.js";
import {
  ensureCloudflareDnsRecord,
  ensureCloudflareWorkerRoute,
  ensureCloudflareZone,
} from "../integrations/cloudflare.js";
import {
  getPorkbunDomainQuote,
  purchasePorkbunDomain,
  updatePorkbunNameservers,
} from "../integrations/porkbun.js";

const DOMAIN_QUOTE_TTL_MS = 5 * 60_000;
const DOMAIN_SYNC_THROTTLE_MS = 60_000;
/** Conversion rate: 1M standard tokens = $1 */
const TOKENS_PER_DOLLAR = 1_000_000;
const EMAIL_BUNDLE_CREDITS = 5_000_000;
const WEBSITE_TARGET = "aicombinator.live";

type AuthenticatedCompany = Pick<
  CompanyRow,
  | "id"
  | "user_id"
  | "name"
  | "hosted_domain"
  | "email_domain"
  | "custom_domain"
  | "custom_domain_candidate"
  | "custom_domain_status"
>;

type DomainBundleSummary = {
  status: DomainBundleOrderStatus;
  domain: string;
  totalCredits: number;
  registrationCostUsd: number;
  renewalCostUsd: number | null;
  message: string;
  error: string | null;
  purchasedAt: string | null;
  completedAt: string | null;
};

type DomainBundleMetadata = {
  creditsDeducted?: boolean;
  nameserversUpdated?: boolean;
};

function jsonResponse(data: unknown, env: Env, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(env) });
}

function errorResponse(message: string, env: Env, status = 400): Response {
  return Response.json({ error: message }, { status, headers: corsHeaders(env) });
}

function domainBundleConfigError(env: Env): string | null {
  if (!env.PORKBUN_API_KEY || !env.PORKBUN_SECRET_API_KEY) {
    return "Porkbun domain purchasing is not configured yet.";
  }
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return "Cloudflare DNS automation is not configured yet.";
  }
  if (!env.AGENTMAIL_API_KEY) {
    return "AgentMail inbox provisioning is not configured yet.";
  }
  return null;
}

function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function isValidPurchaseDomain(domain: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain);
}

function computeDomainCredits(registrationCostUsd: number): number {
  return Math.max(TOKENS_PER_DOLLAR, Math.ceil(registrationCostUsd) * TOKENS_PER_DOLLAR);
}

function parseOrderMetadata(order: Pick<DomainBundleOrderRow, "metadata">): DomainBundleMetadata {
  if (!order.metadata) {
    return {};
  }

  try {
    return JSON.parse(order.metadata) as DomainBundleMetadata;
  } catch {
    return {};
  }
}

function isAgentmailDomainReady(status: string | null | undefined): boolean {
  const normalized = (status || "").trim().toLowerCase();
  return normalized === "active"
    || normalized === "ready"
    || normalized === "verified";
}

function buildOrderMessage(status: DomainBundleOrderStatus, domain: string): string {
  switch (status) {
    case "pending_purchase":
      return `Purchasing ${domain} and reserving the mail setup.`;
    case "pending_dns":
      return `${domain} has been purchased. DNS and website routing are still being configured.`;
    case "pending_mail":
      return `${domain} is purchased and DNS is configured. Waiting for branded mail verification before the inboxes go live.`;
    case "active":
      return `${domain} and its branded inboxes are live.`;
    case "failed":
      return `We could not finish the ${domain} bundle setup.`;
    default:
      return `Bundle status for ${domain} is being updated.`;
  }
}

function summarizeOrder(order: DomainBundleOrderRow): DomainBundleSummary {
  return {
    status: order.status,
    domain: order.domain_name,
    totalCredits: order.total_credits,
    registrationCostUsd: order.registration_cost_cents / 100,
    renewalCostUsd: order.renewal_cost_cents !== null ? order.renewal_cost_cents / 100 : null,
    message: buildOrderMessage(order.status, order.domain_name),
    error: order.error,
    purchasedAt: order.created_at,
    completedAt: order.completed_at,
  };
}

async function authenticateCompanyOwner(
  request: Request,
  env: Env,
  companyId: string,
): Promise<{ userId: string; company: AuthenticatedCompany } | null> {
  const token = extractToken(request);
  if (!token) {
    return null;
  }

  const userId = await verifyClerkJwt(token, env);
  if (!userId) {
    return null;
  }

  const company = await env.DB.prepare(
    `SELECT id, user_id, name, hosted_domain, email_domain, custom_domain, custom_domain_candidate, custom_domain_status
     FROM companies
     WHERE id = ?
       AND user_id = ?`,
  )
    .bind(companyId, userId)
    .first<AuthenticatedCompany>();

  if (!company) {
    return null;
  }

  return { userId, company };
}

async function getLatestQuote(
  env: Env,
  companyId: string,
): Promise<DomainBundleQuoteRow | null> {
  return env.DB.prepare(
    `SELECT *
     FROM domain_bundle_quotes
     WHERE company_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(companyId).first<DomainBundleQuoteRow>();
}

async function getLatestOrder(
  env: Env,
  companyId: string,
): Promise<DomainBundleOrderRow | null> {
  return env.DB.prepare(
    `SELECT *
     FROM domain_bundle_orders
     WHERE company_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(companyId).first<DomainBundleOrderRow>();
}

async function getFoundingOwners(
  env: Env,
  companyId: string,
): Promise<{
  ceo: { id: string; name: string; email_address: string | null } | null;
  cmo: { id: string; name: string; email_address: string | null } | null;
}> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, email_address, blueprint_id
     FROM agents
     WHERE company_id = ?
       AND blueprint_id IN ('ceo', 'cmo')
     ORDER BY created_at ASC`,
  ).bind(companyId).all<{
    id: string;
    name: string;
    email_address: string | null;
    blueprint_id: string | null;
  }>();

  const ceo = (results ?? []).find((agent) => agent.blueprint_id === "ceo") ?? null;
  const cmo = (results ?? []).find((agent) => agent.blueprint_id === "cmo") ?? null;

  return { ceo, cmo };
}

function deriveFirstNameAlias(name: string): string {
  return name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "ceo";
}

function normalizeAliasRecordName(record: AgentMailDnsRecord, domain: string): string | null {
  const raw = (record.host || record.name || "").trim();
  if (!raw || raw === "@") {
    return domain;
  }
  if (raw === domain || raw.endsWith(`.${domain}`)) {
    return raw;
  }
  return `${raw}.${domain}`;
}

function normalizeAliasRecordContent(record: AgentMailDnsRecord): string | null {
  const value = (record.value || record.content || "").trim();
  return value || null;
}

async function ensureEmailAliasRow(
  env: Env,
  input: {
    companyId: string;
    ownerAgentId: string | null;
    aliasType: "ceo" | "sales" | "support";
    emailAddress: string;
    inboxId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT id
     FROM company_email_aliases
     WHERE company_id = ?
       AND alias_type = ?
     LIMIT 1`,
  )
    .bind(input.companyId, input.aliasType)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE company_email_aliases
       SET owner_agent_id = ?, email_address = ?, inbox_id = ?, status = 'active', metadata = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(
        input.ownerAgentId,
        input.emailAddress,
        input.inboxId,
        input.metadata ? JSON.stringify(input.metadata) : null,
        existing.id,
      )
      .run();
    return;
  }

  await env.DB.prepare(
    `INSERT INTO company_email_aliases (
       id, company_id, owner_agent_id, alias_type, email_address, provider, inbox_id, status, metadata
     )
     VALUES (?, ?, ?, ?, ?, 'agentmail', ?, 'active', ?)`,
  )
    .bind(
      generateId(),
      input.companyId,
      input.ownerAgentId,
      input.aliasType,
      input.emailAddress,
      input.inboxId,
      input.metadata ? JSON.stringify(input.metadata) : null,
    )
    .run();
}

async function finalizeAgentmailInboxes(
  env: Env,
  company: AuthenticatedCompany,
  order: DomainBundleOrderRow,
): Promise<void> {
  if (!order.agentmail_pod_id) {
    throw new Error("AgentMail pod is missing from the domain bundle order");
  }

  const owners = await getFoundingOwners(env, company.id);
  if (!owners.ceo) {
    throw new Error("CEO agent is not available for branded mail provisioning");
  }

  const ceoAlias = `${deriveFirstNameAlias(owners.ceo.name)}@${order.domain_name}`;
  const salesOwner = owners.cmo ?? owners.ceo;
  const salesAlias = `sales@${order.domain_name}`;
  const supportAlias = `support@${order.domain_name}`;

  const ceoInbox = await createAgentmailPodInbox(env, {
    podId: order.agentmail_pod_id,
    username: ceoAlias.split("@")[0],
    domain: order.domain_name,
    displayName: owners.ceo.name,
    clientId: `company:${company.id}:ceo-mailbox`,
  });
  await rememberAgentmailInboxOwner(env, ceoInbox.inbox_id, {
    companyId: company.id,
    agentId: owners.ceo.id,
    aliasEmail: ceoAlias,
  });

  const salesInbox = await createAgentmailPodInbox(env, {
    podId: order.agentmail_pod_id,
    username: "sales",
    domain: order.domain_name,
    displayName: `${company.name} Sales`,
    clientId: `company:${company.id}:sales-mailbox`,
  });
  await rememberAgentmailInboxOwner(env, salesInbox.inbox_id, {
    companyId: company.id,
    agentId: salesOwner.id,
    aliasEmail: salesAlias,
  });

  const supportInbox = await createAgentmailPodInbox(env, {
    podId: order.agentmail_pod_id,
    username: "support",
    domain: order.domain_name,
    displayName: `${company.name} Support`,
    clientId: `company:${company.id}:support-mailbox`,
  });
  await rememberAgentmailInboxOwner(env, supportInbox.inbox_id, {
    companyId: company.id,
    agentId: owners.ceo.id,
    aliasEmail: supportAlias,
  });

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE agents
       SET email_address = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(ceoAlias, owners.ceo.id),
    env.DB.prepare(
      `UPDATE companies
       SET custom_domain = ?, email_domain = ?, custom_domain_candidate = ?, custom_domain_status = 'live', updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(order.domain_name, order.domain_name, order.domain_name, company.id),
    env.DB.prepare(
      `UPDATE domain_bundle_orders
       SET status = 'active', completed_at = datetime('now'), error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(order.id),
  ]);

  await Promise.all([
    ensureEmailAliasRow(env, {
      companyId: company.id,
      ownerAgentId: owners.ceo.id,
      aliasType: "ceo",
      emailAddress: ceoAlias,
      inboxId: ceoInbox.inbox_id,
    }),
    ensureEmailAliasRow(env, {
      companyId: company.id,
      ownerAgentId: salesOwner.id,
      aliasType: "sales",
      emailAddress: salesAlias,
      inboxId: salesInbox.inbox_id,
    }),
    ensureEmailAliasRow(env, {
      companyId: company.id,
      ownerAgentId: owners.ceo.id,
      aliasType: "support",
      emailAddress: supportAlias,
      inboxId: supportInbox.inbox_id,
    }),
  ]);

  await logActivity(env, {
    companyId: company.id,
    actorType: "system",
    actorId: "domain-bundle",
    action: "custom_domain.active",
    entityType: "domain",
    entityId: order.id,
    summary: `Custom domain ${order.domain_name} and branded inboxes are live`,
    details: {
      ceo: ceoAlias,
      sales: salesAlias,
      support: supportAlias,
    },
  });
}

async function persistAgentmailDnsToCloudflare(
  env: Env,
  order: DomainBundleOrderRow,
  zoneId: string,
  domain: string,
): Promise<void> {
  if (!order.agentmail_pod_id || !order.agentmail_domain_id) {
    throw new Error("AgentMail domain is not initialized yet");
  }

  const agentmailDomain = await getAgentmailDomain(env, order.agentmail_pod_id, order.agentmail_domain_id);
  const records = [
    ...(agentmailDomain.dns_records ?? []),
    ...(agentmailDomain.verification_records ?? []),
  ];

  for (const record of records) {
    const name = normalizeAliasRecordName(record, domain);
    const content = normalizeAliasRecordContent(record);
    const type = record.type?.trim().toUpperCase();

    if (!name || !content || !type) {
      continue;
    }

    if (!["TXT", "MX", "CNAME"].includes(type)) {
      continue;
    }

    await ensureCloudflareDnsRecord(env, zoneId, {
      type: type as "TXT" | "MX" | "CNAME",
      name,
      content,
      proxied: false,
      priority: record.priority ?? undefined,
      ttl: record.ttl ?? 1,
    });
  }
}

async function syncDomainBundleOrder(
  env: Env,
  order: DomainBundleOrderRow,
): Promise<DomainBundleOrderRow> {
  if (order.status === "active" || order.status === "failed") {
    return order;
  }

  const lastAttemptAt = order.last_sync_attempt_at ? new Date(order.last_sync_attempt_at).getTime() : 0;
  if (lastAttemptAt > 0 && Date.now() - lastAttemptAt < DOMAIN_SYNC_THROTTLE_MS) {
    return order;
  }

  const company = await env.DB.prepare(
    `SELECT id, user_id, name, hosted_domain, email_domain, custom_domain, custom_domain_candidate, custom_domain_status
     FROM companies
     WHERE id = ?`,
  )
    .bind(order.company_id)
    .first<AuthenticatedCompany>();

  if (!company) {
    throw new Error("Company not found for domain bundle order");
  }

  await env.DB.prepare(
    `UPDATE domain_bundle_orders
     SET last_sync_attempt_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(order.id).run();

  let currentOrder = await getLatestOrder(env, company.id);
  if (!currentOrder || currentOrder.id !== order.id) {
    throw new Error("Domain bundle order changed during sync");
  }

  const metadata = parseOrderMetadata(currentOrder);

  try {
    if (!currentOrder.registrar_order_id) {
      const purchased = await purchasePorkbunDomain(env, currentOrder.domain_name);

      if (!metadata.creditsDeducted) {
        await deductCredits(
          env,
          currentOrder.user_id,
          currentOrder.total_credits,
          `Purchased ${currentOrder.domain_name} + branded inbox bundle`,
          currentOrder.company_id,
        );
      }

      await env.DB.batch([
        env.DB.prepare(
          `UPDATE domain_bundle_orders
           SET registrar_order_id = ?, status = 'pending_dns', metadata = ?, error = NULL, updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(
          purchased.orderId,
          JSON.stringify({ ...metadata, creditsDeducted: true }),
          currentOrder.id,
        ),
        env.DB.prepare(
          `UPDATE companies
           SET custom_domain = ?, custom_domain_candidate = ?, custom_domain_status = 'pending_purchase', updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(currentOrder.domain_name, currentOrder.domain_name, company.id),
      ]);

      await logActivity(env, {
        companyId: company.id,
        actorType: "system",
        actorId: "domain-bundle",
        action: "custom_domain.purchased",
        entityType: "domain",
        entityId: currentOrder.id,
        summary: `Purchased ${currentOrder.domain_name}`,
        details: purchased.raw,
      });

      currentOrder = (await getLatestOrder(env, company.id)) || currentOrder;
    }

    if (!currentOrder.cloudflare_zone_id) {
      const zone = await ensureCloudflareZone(env, currentOrder.domain_name);
      await env.DB.prepare(
        `UPDATE domain_bundle_orders
         SET cloudflare_zone_id = ?, cloudflare_nameservers = ?, status = 'pending_dns', updated_at = datetime('now')
         WHERE id = ?`,
      )
        .bind(
          zone.id,
          zone.name_servers ? JSON.stringify(zone.name_servers) : null,
          currentOrder.id,
        )
        .run();
      currentOrder = (await getLatestOrder(env, company.id)) || currentOrder;
    }

    if (!currentOrder.agentmail_pod_id) {
      const pod = await ensureAgentmailPod(
        env,
        `company:${company.id}`,
        `${company.name} Mail`,
      );
      await env.DB.prepare(
        `UPDATE domain_bundle_orders
         SET agentmail_pod_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(pod.pod_id, currentOrder.id).run();
      currentOrder = (await getLatestOrder(env, company.id)) || currentOrder;
    }

    if (!currentOrder.agentmail_domain_id) {
      const domain = await ensureAgentmailDomain(env, currentOrder.agentmail_pod_id!, currentOrder.domain_name);
      await env.DB.prepare(
        `UPDATE domain_bundle_orders
         SET agentmail_domain_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(domain.id, currentOrder.id).run();
      currentOrder = (await getLatestOrder(env, company.id)) || currentOrder;
    }

    if (!metadata.nameserversUpdated) {
      const nameservers = currentOrder.cloudflare_nameservers
        ? JSON.parse(currentOrder.cloudflare_nameservers) as string[]
        : [];
      if (nameservers.length > 0) {
        await updatePorkbunNameservers(env, currentOrder.domain_name, nameservers);
      }

      await env.DB.prepare(
        `UPDATE domain_bundle_orders
         SET metadata = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(
        JSON.stringify({ ...metadata, nameserversUpdated: true, creditsDeducted: true }),
        currentOrder.id,
      ).run();
      currentOrder = (await getLatestOrder(env, company.id)) || currentOrder;
    }

    await persistAgentmailDnsToCloudflare(env, currentOrder, currentOrder.cloudflare_zone_id!, currentOrder.domain_name);
    await ensureCloudflareDnsRecord(env, currentOrder.cloudflare_zone_id!, {
      type: "CNAME",
      name: currentOrder.domain_name,
      content: WEBSITE_TARGET,
      proxied: true,
    });
    await ensureCloudflareDnsRecord(env, currentOrder.cloudflare_zone_id!, {
      type: "CNAME",
      name: `www.${currentOrder.domain_name}`,
      content: WEBSITE_TARGET,
      proxied: true,
    });

    const routeIds = await Promise.all([
      ensureCloudflareWorkerRoute(env, currentOrder.cloudflare_zone_id!, `${currentOrder.domain_name}/*`),
      ensureCloudflareWorkerRoute(env, currentOrder.cloudflare_zone_id!, `www.${currentOrder.domain_name}/*`),
    ]);

    await env.DB.prepare(
      `UPDATE domain_bundle_orders
       SET dashboard_route_ids = ?, status = 'pending_mail', updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(JSON.stringify(routeIds), currentOrder.id).run();
    currentOrder = (await getLatestOrder(env, company.id)) || currentOrder;

    const agentmailDomain = await getAgentmailDomain(env, currentOrder.agentmail_pod_id!, currentOrder.agentmail_domain_id!);
    if (!isAgentmailDomainReady(agentmailDomain.status)) {
      return currentOrder;
    }

    await finalizeAgentmailInboxes(env, company, currentOrder);
    return (await getLatestOrder(env, company.id)) || currentOrder;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      `UPDATE domain_bundle_orders
       SET status = CASE
         WHEN registrar_order_id IS NULL THEN 'pending_purchase'
         WHEN cloudflare_zone_id IS NULL THEN 'pending_dns'
         ELSE 'pending_mail'
       END,
           error = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(message, currentOrder.id).run();

    return (await getLatestOrder(env, company.id)) || {
      ...currentOrder,
      error: message,
    };
  }
}

export async function maybeSyncCompanyDomainBundle(
  env: Env,
  companyId: string,
): Promise<DomainBundleSummary | null> {
  const latestOrder = await getLatestOrder(env, companyId);
  if (!latestOrder) {
    return null;
  }

  const synced = await syncDomainBundleOrder(env, latestOrder);
  return summarizeOrder(synced);
}

export async function handleQuoteDomainBundle(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await authenticateCompanyOwner(request, env, companyId);
  if (!auth) {
    return errorResponse("Unauthorized", env, 401);
  }
  const configError = domainBundleConfigError(env);
  if (configError) {
    return errorResponse(configError, env, 503);
  }

  const body = await request.json() as { domain?: string };
  const domain = normalizeDomain(body.domain || "");
  if (!isValidPurchaseDomain(domain)) {
    return errorResponse("Enter a valid domain like companyname.com", env, 400);
  }

  const existingOrder = await getLatestOrder(env, companyId);
  if (existingOrder && existingOrder.status !== "failed") {
    return errorResponse("This company already has a custom-domain bundle in progress or active.", env, 409);
  }

  const quote = await getPorkbunDomainQuote(env, domain);
  if (!quote.available) {
    return errorResponse("That domain is not available.", env, 409);
  }
  if (quote.premium) {
    return errorResponse("Premium domains are not supported yet.", env, 400);
  }

  const domainCredits = computeDomainCredits(quote.registrationCostUsd);
  const totalCredits = EMAIL_BUNDLE_CREDITS + domainCredits;
  const now = Date.now();
  const quoteId = generateId();

  await env.DB.prepare(
    `INSERT INTO domain_bundle_quotes (
       id, user_id, company_id, domain_name, registration_cost_cents, renewal_cost_cents,
       email_bundle_credits, domain_credits, total_credits, status, provider_payload, expires_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?, datetime('now'))`,
  )
    .bind(
      quoteId,
      auth.userId,
      companyId,
      domain,
      Math.round(quote.registrationCostUsd * 100),
      quote.renewalCostUsd !== null ? Math.round(quote.renewalCostUsd * 100) : null,
      EMAIL_BUNDLE_CREDITS,
      domainCredits,
      totalCredits,
      JSON.stringify(quote.raw),
      new Date(now + DOMAIN_QUOTE_TTL_MS).toISOString(),
    )
    .run();

  return jsonResponse(
    {
      quoteId,
      domain,
      emailBundleCredits: EMAIL_BUNDLE_CREDITS,
      domainCredits,
      totalCredits,
      registrationCostUsd: quote.registrationCostUsd,
      renewalCostUsd: quote.renewalCostUsd,
      expiresAt: new Date(now + DOMAIN_QUOTE_TTL_MS).toISOString(),
      inboxes: [
        `firstname@${domain}`,
        `sales@${domain}`,
        `support@${domain}`,
      ],
    },
    env,
  );
}

export async function handlePurchaseDomainBundle(
  request: Request,
  env: Env,
  companyId: string,
): Promise<Response> {
  const auth = await authenticateCompanyOwner(request, env, companyId);
  if (!auth) {
    return errorResponse("Unauthorized", env, 401);
  }
  const configError = domainBundleConfigError(env);
  if (configError) {
    return errorResponse(configError, env, 503);
  }

  const body = await request.json() as { quoteId?: string };
  if (!body.quoteId) {
    return errorResponse("quoteId is required", env, 400);
  }

  const quote = await env.DB.prepare(
    `SELECT *
     FROM domain_bundle_quotes
     WHERE id = ?
       AND company_id = ?
       AND user_id = ?`,
  )
    .bind(body.quoteId, companyId, auth.userId)
    .first<DomainBundleQuoteRow>();

  if (!quote) {
    return errorResponse("Quote not found", env, 404);
  }
  if (quote.status !== "quoted") {
    return errorResponse("That quote can no longer be used", env, 409);
  }
  if (new Date(quote.expires_at).getTime() < Date.now()) {
    await env.DB.prepare(
      `UPDATE domain_bundle_quotes
       SET status = 'expired', updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(quote.id).run();
    return errorResponse("That quote expired. Check availability again.", env, 409);
  }

  const existingOrder = await getLatestOrder(env, companyId);
  if (existingOrder && existingOrder.status !== "failed") {
    return errorResponse("This company already has a custom-domain bundle in progress or active.", env, 409);
  }

  const balance = await getBalance(env, auth.userId);
  if (balance < quote.total_credits) {
    return errorResponse(`You need ${quote.total_credits.toLocaleString()} credits to buy this bundle.`, env, 402);
  }

  const freshQuote = await getPorkbunDomainQuote(env, quote.domain_name);
  if (!freshQuote.available || freshQuote.premium) {
    await env.DB.prepare(
      `UPDATE domain_bundle_quotes
       SET status = 'invalid', updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(quote.id).run();
    return errorResponse("The domain is no longer available at the quoted price.", env, 409);
  }

  const orderId = generateId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO domain_bundle_orders (
         id, user_id, company_id, quote_id, domain_name, registration_cost_cents, renewal_cost_cents,
         email_bundle_credits, domain_credits, total_credits, status, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_purchase', datetime('now'))`,
    ).bind(
      orderId,
      auth.userId,
      companyId,
      quote.id,
      quote.domain_name,
      quote.registration_cost_cents,
      quote.renewal_cost_cents,
      quote.email_bundle_credits,
      quote.domain_credits,
      quote.total_credits,
    ),
    env.DB.prepare(
      `UPDATE domain_bundle_quotes
       SET status = 'used', updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(quote.id),
  ]);

  const synced = await syncDomainBundleOrder(env, {
    id: orderId,
    user_id: auth.userId,
    company_id: companyId,
    quote_id: quote.id,
    domain_name: quote.domain_name,
    registration_cost_cents: quote.registration_cost_cents,
    renewal_cost_cents: quote.renewal_cost_cents,
    email_bundle_credits: quote.email_bundle_credits,
    domain_credits: quote.domain_credits,
    total_credits: quote.total_credits,
    status: "pending_purchase",
    registrar_order_id: null,
    cloudflare_zone_id: null,
    cloudflare_nameservers: null,
    dashboard_route_ids: null,
    agentmail_pod_id: null,
    agentmail_domain_id: null,
    error: null,
    metadata: null,
    last_sync_attempt_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return jsonResponse(
    {
      orderId,
      bundle: summarizeOrder(synced),
      remainingCredits: await getBalance(env, auth.userId),
    },
    env,
    201,
  );
}

export async function listCompanyEmailAliases(
  env: Env,
  companyId: string,
): Promise<Array<{
  aliasType: string;
  emailAddress: string;
  status: string;
  ownerAgentId: string | null;
}>> {
  const { results } = await env.DB.prepare(
    `SELECT alias_type, email_address, status, owner_agent_id
     FROM company_email_aliases
     WHERE company_id = ?
     ORDER BY alias_type ASC`,
  ).bind(companyId).all<Pick<CompanyEmailAliasRow, "alias_type" | "email_address" | "status" | "owner_agent_id">>();

  return (results ?? []).map((row) => ({
    aliasType: row.alias_type,
    emailAddress: row.email_address,
    status: row.status,
    ownerAgentId: row.owner_agent_id,
  }));
}
