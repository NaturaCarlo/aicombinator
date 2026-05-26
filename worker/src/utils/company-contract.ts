import type { Env, SubscriptionPlan } from "../types.js";
import { isPaidPlan } from "../types.js";

export type RuntimeTier = "shared" | "dedicated";
export type DedicatedVmStatus = "shared" | "pending" | "provisioning" | "active" | "failed";
export type EgressTier = "standard" | "residential";
export type CustomDomainStatus =
  | "unchecked"
  | "available"
  | "unavailable"
  | "pending_purchase"
  | "live"
  | "error";

export interface CompanyProvisioningContract {
  hostedDomain: string;
  emailDomain: string;
  customDomainCandidate: string | null;
  customDomainStatus: CustomDomainStatus;
  runtimeTier: RuntimeTier;
  dedicatedVmStatus: DedicatedVmStatus;
  egressTier: EgressTier;
}

const PLATFORM_DOMAIN = "aicombinator.live";

const BLUEPRINT_EMAIL_ALIASES: Record<string, string> = {
  ceo: "ceo",
  cto: "cto",
  cmo: "cmo",
  "frontend-dev": "frontend",
  "backend-dev": "backend",
  "fullstack-dev": "product",
  devops: "infra",
  "qa-tester": "qa",
  "api-keys-agent": "ops",
  "reddit-marketer": "reddit",
  "twitter-marketer": "social",
  "cold-emailer": "outbound",
  "seo-writer": "seo",
  "ad-buyer": "ads",
  "content-writer": "content",
  "lead-researcher": "research",
  "outbound-caller": "sales",
  "account-buyer": "accounts",
  bookkeeper: "finance",
  designer: "design",
};

export function resolveRuntimeTier(plan: SubscriptionPlan): RuntimeTier {
  return isPaidPlan(plan) ? "dedicated" : "shared";
}

export function resolveDedicatedVmStatus(plan: SubscriptionPlan): DedicatedVmStatus {
  return isPaidPlan(plan) ? "pending" : "shared";
}

export function resolveEgressTier(plan: SubscriptionPlan): EgressTier {
  return isPaidPlan(plan) ? "residential" : "standard";
}

function sanitizeLabel(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (normalized.length === 0) {
    return "company";
  }

  return normalized.slice(0, 48);
}

async function hostedDomainExists(env: Env, domain: string): Promise<boolean> {
  const existing = await env.DB.prepare(
    `SELECT 1
     FROM companies
     WHERE hosted_domain = ?
        OR custom_domain = ?
        OR custom_domain_candidate = ?
     LIMIT 1`,
  )
    .bind(domain, domain, domain)
    .first();

  return !!existing;
}

export async function reserveHostedDomain(
  env: Env,
  companyName: string,
): Promise<string> {
  const base = sanitizeLabel(companyName);

  for (let suffix = 0; suffix < 100; suffix++) {
    const label = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const domain = `${label}.${PLATFORM_DOMAIN}`;
    if (!(await hostedDomainExists(env, domain))) {
      return domain;
    }
  }

  return `${base}-${Date.now().toString(36)}.${PLATFORM_DOMAIN}`;
}

export function buildCustomDomainCandidate(companyName: string): string | null {
  const label = sanitizeLabel(companyName);
  return label ? `${label}.com` : null;
}

async function checkRdap(domain: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://rdap.verisign.com/com/v1/domain/${domain}`, {
      headers: { Accept: "application/rdap+json, application/json" },
    });

    if (res.status === 404) {
      return false;
    }
    if (res.ok) {
      return true;
    }
  } catch {
    // Ignore and fall back to DNS heuristics below.
  }

  return null;
}

async function checkDns(domain: string): Promise<boolean | null> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`,
      {
        headers: { Accept: "application/dns-json" },
      },
    );

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      Status?: number;
      Answer?: Array<{ data?: string }>;
    };

    if (Array.isArray(data.Answer) && data.Answer.length > 0) {
      return true;
    }

    if (data.Status === 3) {
      return false;
    }
  } catch {
    // Ignore
  }

  return null;
}

export async function checkCustomDomainCandidate(
  domain: string | null,
): Promise<CustomDomainStatus> {
  if (!domain) {
    return "unchecked";
  }

  const rdapTaken = await checkRdap(domain);
  if (rdapTaken === true) {
    return "unavailable";
  }
  if (rdapTaken === false) {
    return "available";
  }

  const dnsTaken = await checkDns(domain);
  if (dnsTaken === true) {
    return "unavailable";
  }
  if (dnsTaken === false) {
    return "available";
  }

  return "error";
}

export async function buildCompanyProvisioningContract(
  env: Env,
  companyName: string,
  plan: SubscriptionPlan,
  options?: {
    checkCustomDomainAvailability?: boolean;
  },
): Promise<CompanyProvisioningContract> {
  const hostedDomain = await reserveHostedDomain(env, companyName);
  const customDomainCandidate = buildCustomDomainCandidate(companyName);
  const customDomainStatus = options?.checkCustomDomainAvailability === false
    ? "unchecked"
    : await checkCustomDomainCandidate(customDomainCandidate);

  return {
    hostedDomain,
    emailDomain: hostedDomain,
    customDomainCandidate,
    customDomainStatus,
    runtimeTier: resolveRuntimeTier(plan),
    dedicatedVmStatus: resolveDedicatedVmStatus(plan),
    egressTier: resolveEgressTier(plan),
  };
}

function uniqueAliases(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];

  for (const value of values) {
    const normalized = sanitizeLabel(value || "").replace(/-/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    aliases.push(normalized.slice(0, 32));
  }

  return aliases;
}

function buildAgentAliasCandidates(input: {
  blueprintId?: string | null;
  role?: string | null;
  title?: string | null;
  name?: string | null;
}): string[] {
  const blueprintAlias = input.blueprintId
    ? BLUEPRINT_EMAIL_ALIASES[input.blueprintId]
    : null;
  const firstName = input.name?.trim().split(/\s+/)[0] ?? null;

  return uniqueAliases([
    firstName,
    input.name,
    blueprintAlias,
    input.role,
    input.title,
    "agent",
  ]);
}

export async function reserveAgentEmailAddress(
  env: Env,
  companyId: string,
  emailDomain: string | null,
  input: {
    blueprintId?: string | null;
    role?: string | null;
    title?: string | null;
    name?: string | null;
  },
): Promise<string | null> {
  if (!emailDomain) {
    return null;
  }

  const aliases = buildAgentAliasCandidates(input);

  for (const alias of aliases) {
    const address = `${alias}@${emailDomain}`;
    const existing = await env.DB.prepare(
      `SELECT 1 FROM agents WHERE company_id = ? AND email_address = ? LIMIT 1`,
    )
      .bind(companyId, address)
      .first();

    if (!existing) {
      return address;
    }
  }

  const fallback = aliases[0] || "agent";
  for (let suffix = 2; suffix < 100; suffix++) {
    const address = `${fallback}${suffix}@${emailDomain}`;
    const existing = await env.DB.prepare(
      `SELECT 1 FROM agents WHERE company_id = ? AND email_address = ? LIMIT 1`,
    )
      .bind(companyId, address)
      .first();

    if (!existing) {
      return address;
    }
  }

  return `${fallback}-${Date.now().toString(36)}@${emailDomain}`;
}

export async function applyPaidPlanCompanyEntitlements(
  env: Env,
  userId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE companies
     SET runtime_tier = 'dedicated',
         dedicated_vm_status = CASE
           WHEN dedicated_vm_status = 'active' THEN 'active'
           ELSE 'pending'
         END,
         custom_domain_status = CASE
           WHEN custom_domain_status = 'available' THEN 'pending_purchase'
           WHEN custom_domain_status = 'live' THEN 'live'
           ELSE custom_domain_status
         END,
         egress_tier = 'residential',
         updated_at = datetime('now')
     WHERE user_id = ?`,
  )
    .bind(userId)
    .run();
}
