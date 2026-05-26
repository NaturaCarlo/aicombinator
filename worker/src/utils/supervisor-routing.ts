import type { CompanyRow, Env } from "../types.js";
import { buildInternalContractHeaders } from "./internal-contract.js";

const SHARED_SUPERVISOR_URL_KV_KEY = "supervisor:shared_origin_url";

type SupervisorRouteCompany = Pick<
  CompanyRow,
  "id" | "runtime_tier" | "dedicated_vm_status" | "dedicated_vm_ip"
>;

export function dedicatedSupervisorBaseUrl(ip: string): string {
  return `http://${ip}:8787`;
}

function normalizeSupervisorUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function sharedSupervisorFallbackUrl(env: Env): string | null {
  return normalizeSupervisorUrl(env.SHARED_SUPERVISOR_URL || env.SUPERVISOR_URL || null);
}

export async function sharedSupervisorBaseUrl(env: Env): Promise<string | null> {
  const registered = normalizeSupervisorUrl(
    await env.AUTOMATON_KV.get(SHARED_SUPERVISOR_URL_KV_KEY),
  );
  return registered || sharedSupervisorFallbackUrl(env);
}

export async function registerSharedSupervisorBaseUrl(
  env: Env,
  url: string,
): Promise<string> {
  const normalized = normalizeSupervisorUrl(url);
  if (!normalized) {
    throw new Error("Invalid shared supervisor URL");
  }

  await env.AUTOMATON_KV.put(SHARED_SUPERVISOR_URL_KV_KEY, normalized);
  return normalized;
}

export async function resolveSupervisorBaseUrlForCompany(
  env: Env,
  company: SupervisorRouteCompany | null | undefined,
): Promise<string | null> {
  if (
    company
    && company.runtime_tier === "dedicated"
    && company.dedicated_vm_status === "active"
    && company.dedicated_vm_ip
  ) {
    return dedicatedSupervisorBaseUrl(company.dedicated_vm_ip);
  }

  return sharedSupervisorBaseUrl(env);
}

export async function getCompanySupervisorRecord(
  env: Env,
  companyId: string,
): Promise<SupervisorRouteCompany | null> {
  const record = await env.DB.prepare(
    `SELECT id, runtime_tier, dedicated_vm_status, dedicated_vm_ip
     FROM companies
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(companyId)
    .first<SupervisorRouteCompany>();

  return record ?? null;
}

export async function resolveSupervisorBaseUrlByCompanyId(
  env: Env,
  companyId: string,
): Promise<string | null> {
  const company = await getCompanySupervisorRecord(env, companyId);
  return await resolveSupervisorBaseUrlForCompany(env, company);
}

export async function fetchFromCompanySupervisor(
  env: Env,
  companyId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const baseUrl = await resolveSupervisorBaseUrlByCompanyId(env, companyId);
  if (!baseUrl) {
    return null;
  }

  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: buildInternalContractHeaders({
        "Content-Type": "application/json",
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        ...init.headers,
      }),
    });
  } catch (err) {
    console.error(
      `[supervisor-routing] fetch failed for ${baseUrl}${path}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
