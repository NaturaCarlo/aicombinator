import type { Env } from "../types.js";

const PORKBUN_API_BASE = "https://api.porkbun.com/api/json/v3";

export interface PorkbunDomainQuote {
  domain: string;
  available: boolean;
  premium: boolean;
  registrationCostUsd: number;
  renewalCostUsd: number | null;
  raw: Record<string, unknown>;
}

function assertPorkbunConfigured(env: Env): void {
  if (!env.PORKBUN_API_KEY || !env.PORKBUN_SECRET_API_KEY) {
    throw new Error("Porkbun API credentials are not configured");
  }
}

function normalizeDollarString(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(normalized)) {
      return normalized;
    }
  }
  return 0;
}

async function porkbunRequest<T>(
  env: Env,
  path: string,
  extraBody?: Record<string, unknown>,
): Promise<T> {
  assertPorkbunConfigured(env);

  const response = await fetch(`${PORKBUN_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apikey: env.PORKBUN_API_KEY,
      secretapikey: env.PORKBUN_SECRET_API_KEY,
      ...(extraBody ?? {}),
    }),
  });

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(`Porkbun ${path} failed: ${response.status} ${text}`);
  }

  if (payload.status && payload.status !== "SUCCESS") {
    const message = typeof payload.message === "string" ? payload.message : text;
    throw new Error(`Porkbun ${path} failed: ${message}`);
  }

  return payload as T;
}

export async function getPorkbunDomainQuote(
  env: Env,
  domain: string,
): Promise<PorkbunDomainQuote> {
  const normalized = domain.trim().toLowerCase();
  const payload = await porkbunRequest<Record<string, unknown>>(
    env,
    `/domain/checkDomain/${encodeURIComponent(normalized)}`,
  );

  const resp = (payload.response ?? payload) as Record<string, unknown>;
  const available = String(resp.avail ?? resp.available ?? "")
    .toLowerCase() === "yes";
  const premium = String(resp.premium ?? "").toLowerCase() === "yes";
  const registrationCostUsd = normalizeDollarString(
    resp.price ?? resp.registrationPrice ?? resp.purchase_price,
  );
  const additional = (resp.additional ?? {}) as Record<string, unknown>;
  const renewalObj = (additional.renewal ?? {}) as Record<string, unknown>;
  const renewalCostUsd = normalizeDollarString(
    renewalObj.price ?? resp.regularPrice ?? resp.renewalPrice ?? resp.renewal_price,
  );

  return {
    domain: normalized,
    available,
    premium,
    registrationCostUsd,
    renewalCostUsd: renewalCostUsd > 0 ? renewalCostUsd : null,
    raw: payload,
  };
}

export async function purchasePorkbunDomain(
  env: Env,
  domain: string,
  years = 1,
): Promise<{ orderId: string | null; raw: Record<string, unknown> }> {
  const normalized = domain.trim().toLowerCase();
  const payload = await porkbunRequest<Record<string, unknown>>(
    env,
    `/domain/create/${encodeURIComponent(normalized)}`,
    { years },
  );

  return {
    orderId:
      typeof payload.orderId === "string"
        ? payload.orderId
        : typeof payload.order_id === "string"
          ? payload.order_id
          : null,
    raw: payload,
  };
}

export async function updatePorkbunNameservers(
  env: Env,
  domain: string,
  nameservers: string[],
): Promise<void> {
  const normalized = domain.trim().toLowerCase();
  await porkbunRequest(
    env,
    `/domain/updateNs/${encodeURIComponent(normalized)}`,
    { ns: nameservers },
  );
}
