export const INTERNAL_RUNTIME_CONTRACT_VERSION = "2026-03-22.v1";

import type {
  FounderCompanyState,
  FounderStateSnapshot,
  ProvisionCompanyPayload,
  UserMessagePayload,
} from "./types.js";

export function isCompatibleInternalContractVersion(
  value: string | null | undefined,
): boolean {
  if (!value) {
    return true;
  }
  return value === INTERNAL_RUNTIME_CONTRACT_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFounderCompanyState(value: unknown): value is FounderCompanyState {
  return value === "running" || value === "paused" || value === "failed";
}

export function parseFounderStateSnapshot(value: unknown): FounderStateSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const companyId = asString(value.companyId);
  const name = asString(value.name);
  const state = value.state;
  const credits = isRecord(value.credits) ? value.credits : null;
  const agents = Array.isArray(value.agents) ? value.agents : null;
  const tasks = Array.isArray(value.tasks) ? value.tasks : null;
  const opsSummary = isRecord(value.opsSummary) ? value.opsSummary : null;

  if (!companyId || !name || !isFounderCompanyState(state) || !credits || !agents || !tasks || !opsSummary) {
    return null;
  }

  const balance = asNumber(credits.balance);
  const reserved = asNumber(credits.reserved);
  const available = asNumber(credits.available);
  const currentCompanyReserved = asNumber(credits.currentCompanyReserved);
  const otherCompanyReserved = asNumber(credits.otherCompanyReserved);
  const contentionReason = asNullableString(credits.contentionReason);
  const reservations = Array.isArray(credits.reservations) ? credits.reservations : [];

  if (
    balance === null
    || reserved === null
    || available === null
    || currentCompanyReserved === null
    || otherCompanyReserved === null
  ) {
    return null;
  }

  const headline = asString(opsSummary.headline);
  const detail = asString(opsSummary.detail);
  if (!headline || !detail) {
    return null;
  }

  return {
    companyId,
    name,
    state,
    credits: {
      balance,
      reserved,
      available,
      currentCompanyReserved,
      otherCompanyReserved,
      contentionReason,
      reservations: reservations
        .map((reservation) => {
          if (!isRecord(reservation)) {
            return null;
          }
          const reservationCompanyId = asString(reservation.companyId);
          const reservationCompanyName = asString(reservation.companyName);
          const reservationReserved = asNumber(reservation.reserved);
          const isCurrentCompany = reservation.isCurrentCompany === true;
          const reservationState = reservation.state == null
            ? null
            : isFounderCompanyState(reservation.state)
              ? reservation.state
              : null;
          if (!reservationCompanyId || !reservationCompanyName || reservationReserved === null) {
            return null;
          }
          return {
            companyId: reservationCompanyId,
            companyName: reservationCompanyName,
            state: reservationState,
            reserved: reservationReserved,
            isCurrentCompany,
          };
        })
        .filter((reservation): reservation is FounderStateSnapshot["credits"]["reservations"][number] => reservation !== null),
    },
    agents: agents as FounderStateSnapshot["agents"],
    tasks: tasks as FounderStateSnapshot["tasks"],
    opsSummary: {
      headline,
      detail,
    },
  };
}

export function parseUserMessagePayload(value: unknown): UserMessagePayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const text = asString(value.text)?.trim();
  if (!text) {
    return null;
  }

  const target_agent_id = asNullableString(value.target_agent_id)?.trim() || undefined;
  const founder_state = value.founder_state == null
    ? null
    : parseFounderStateSnapshot(value.founder_state);

  if (value.founder_state != null && !founder_state) {
    return null;
  }

  return {
    text,
    target_agent_id,
    founder_state,
  };
}

export function parseProvisionCompanyPayload(
  companyId: string,
  value: unknown,
): ProvisionCompanyPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const user_id = asString(value.user_id)?.trim()
    || asString(value.userId)?.trim()
    || null;
  const name = asString(value.name)?.trim()
    || asString(value.companyName)?.trim()
    || companyId;
  if (!user_id) {
    return null;
  }

  const env = isRecord(value.env)
    ? Object.fromEntries(
        Object.entries(value.env)
          .filter(([, envValue]) => typeof envValue === "string")
          .map(([key, envValue]) => [key, envValue as string]),
      )
    : undefined;

  return {
    id: companyId,
    user_id,
    name,
    goal: asNullableString(value.goal),
    genesis_prompt: asNullableString(value.genesis_prompt),
    state: (asNullableString(value.state) as ProvisionCompanyPayload["state"] | null) ?? undefined,
    workspace_dir: asNullableString(value.workspace_dir),
    container_id: asNullableString(value.container_id),
    env,
    created_at: asString(value.created_at) ?? new Date().toISOString(),
    updated_at: asString(value.updated_at) ?? new Date().toISOString(),
  };
}
