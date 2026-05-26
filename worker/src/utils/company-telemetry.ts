import type {
  CompanyTelemetryKind,
  CompanyTelemetryInput,
  CompanyTelemetryRow,
  CompanyTelemetrySource,
  CompanyTelemetrySummary,
  CompanyTelemetryVerificationLevel,
  Env,
} from "../types.js";

const TRUSTED_TELEMETRY_SOURCES: CompanyTelemetrySource[] = [
  "agentmail_inbound",
  "agentmail_outbound",
  "calendar_booking",
  "payment_provider",
  "crm_import",
];

export function normalizeTelemetryKind(value: unknown): CompanyTelemetryKind | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "outreach"
    || normalized === "lead"
    || normalized === "meeting"
    || normalized === "revenue"
    ? normalized
    : null;
}

export function normalizeTelemetryVerificationLevel(
  value: unknown,
): CompanyTelemetryVerificationLevel {
  if (typeof value !== "string") {
    return "self_reported";
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "evidence_attached" || normalized === "system_verified"
    ? normalized
    : "self_reported";
}

export function normalizeTelemetrySource(value: unknown): CompanyTelemetrySource | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return TRUSTED_TELEMETRY_SOURCES.includes(normalized as CompanyTelemetrySource)
    ? normalized as CompanyTelemetrySource
    : null;
}

function deriveGroundedVerificationLevel(
  source: CompanyTelemetrySource | null | undefined,
  sourceEventId: string | null | undefined,
  externalRef: string | null | undefined,
  evidenceRef: string | null | undefined,
): CompanyTelemetryVerificationLevel | null {
  if (!source || !sourceEventId) {
    return null;
  }

  if (externalRef) {
    return "system_verified";
  }
  if (evidenceRef) {
    return "evidence_attached";
  }
  return null;
}

function validateGroundedCommercialTelemetry(input: CompanyTelemetryInput): {
  verificationLevel: CompanyTelemetryVerificationLevel;
  source: CompanyTelemetrySource;
  sourceEventId: string;
} {
  const source = normalizeTelemetrySource(input.source);
  const sourceEventId = input.source_event_id?.trim() || null;
  const verificationLevel = deriveGroundedVerificationLevel(
    source,
    sourceEventId,
    input.external_ref,
    input.evidence_ref,
  );

  if (!source || !sourceEventId) {
    throw new Error(
      `${input.kind} telemetry must come from a trusted system source with source_event_id`,
    );
  }

  if (!verificationLevel) {
    throw new Error(
      `${input.kind} telemetry requires external_ref or evidence_ref and cannot be self-reported`,
    );
  }

  if (input.kind === "revenue") {
    if (input.amount_cents === null || input.amount_cents === undefined || input.amount_cents <= 0) {
      throw new Error("revenue telemetry requires a positive amount_cents");
    }
    if (!input.currency?.trim()) {
      throw new Error("revenue telemetry requires currency");
    }
  }

  return { verificationLevel, source, sourceEventId };
}

export function normalizeTelemetryInput(
  raw: Record<string, unknown>,
): CompanyTelemetryInput | null {
  const kind = normalizeTelemetryKind(raw.kind);
  const status = pickString(raw.status);

  if (!kind || !status) {
    return null;
  }

  return {
    id: pickString(raw.id),
    agent_id: pickString(raw.agent_id, raw.agentId),
    task_id: pickString(raw.task_id, raw.taskId),
    kind,
    status,
    source: normalizeTelemetrySource(raw.source),
    source_event_id: pickString(raw.source_event_id, raw.sourceEventId, raw.eventId),
    channel: pickString(raw.channel),
    verification_level: normalizeTelemetryVerificationLevel(
      raw.verification_level ?? raw.verificationLevel,
    ),
    subject_name: pickString(raw.subject_name, raw.subjectName, raw.contactName),
    subject_email: pickString(raw.subject_email, raw.subjectEmail, raw.contactEmail),
    subject_company: pickString(raw.subject_company, raw.subjectCompany, raw.companyName),
    amount_cents: pickNumber(raw.amount_cents, raw.amountCents, raw.value_cents, raw.valueCents),
    currency: pickString(raw.currency),
    external_ref: pickString(raw.external_ref, raw.externalRef, raw.providerMessageId),
    evidence_ref: pickString(raw.evidence_ref, raw.evidenceRef, raw.artifact, raw.path),
    notes: pickString(raw.notes, raw.note, raw.body, raw.summary),
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? raw.metadata as Record<string, unknown>
        : null,
    occurred_at: pickIsoString(raw.occurred_at, raw.occurredAt, raw.happenedAt, raw.scheduledFor),
  };
}

export async function upsertCompanyTelemetryRow(
  env: Env,
  companyId: string,
  input: CompanyTelemetryInput,
): Promise<{ id: string }> {
  const id = input.id?.trim() || crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const { verificationLevel, source, sourceEventId } = validateGroundedCommercialTelemetry(input);

  await env.DB.prepare(
    `INSERT INTO telemetry_records (
       id, company_id, agent_id, task_id, kind, status, source, source_event_id, channel,
       verification_level, subject_name, subject_email, subject_company,
       amount_cents, currency, external_ref, evidence_ref, notes, metadata,
       occurred_at, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       company_id = excluded.company_id,
       agent_id = excluded.agent_id,
       task_id = excluded.task_id,
       kind = excluded.kind,
       status = excluded.status,
       source = excluded.source,
       source_event_id = excluded.source_event_id,
       channel = excluded.channel,
       verification_level = excluded.verification_level,
       subject_name = excluded.subject_name,
       subject_email = excluded.subject_email,
       subject_company = excluded.subject_company,
       amount_cents = excluded.amount_cents,
       currency = excluded.currency,
       external_ref = excluded.external_ref,
       evidence_ref = excluded.evidence_ref,
       notes = excluded.notes,
       metadata = excluded.metadata,
       occurred_at = excluded.occurred_at,
       updated_at = datetime('now')`,
  ).bind(
    id,
    companyId,
    input.agent_id || null,
    input.task_id || null,
    input.kind,
    input.status.trim(),
    source,
    sourceEventId,
    input.channel || null,
    verificationLevel,
    input.subject_name || null,
    input.subject_email || null,
    input.subject_company || null,
    input.amount_cents ?? null,
    input.currency || null,
    input.external_ref || null,
    input.evidence_ref || null,
    input.notes || null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.occurred_at || new Date().toISOString(),
  ).run();

  return { id };
}

export async function loadCompanyTelemetryRows(
  env: Env,
  companyId: string,
  options?: {
    verifiedOnly?: boolean;
    limit?: number;
  },
): Promise<CompanyTelemetryRow[]> {
  const clauses = ["company_id = ?"];
  const bindings: unknown[] = [companyId];

  if (options?.verifiedOnly) {
    clauses.push(`verification_level IN ('evidence_attached', 'system_verified')`);
  }

  bindings.push(Math.max(1, Math.min(options?.limit ?? 250, 500)));

  const { results } = await env.DB.prepare(
    `SELECT id, company_id, agent_id, task_id, kind, status, source, source_event_id, channel,
            verification_level, subject_name, subject_email, subject_company,
            amount_cents, currency, external_ref, evidence_ref, notes, metadata,
            occurred_at, created_at, updated_at
     FROM telemetry_records
     WHERE ${clauses.join(" AND ")}
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT ?`,
  ).bind(...bindings).all<CompanyTelemetryRow>();

  return (results ?? []).map((row) => ({
    ...row,
    metadata: row.metadata,
  })) as CompanyTelemetryRow[];
}

export function summarizeTelemetryRows(
  rows: CompanyTelemetryRow[],
  scope: CompanyTelemetrySummary["scope"],
): CompanyTelemetrySummary {
  const summary: CompanyTelemetrySummary = {
    scope,
    asOf: new Date().toISOString(),
    outreach: {
      total: 0,
      sent: 0,
      replied: 0,
      failed: 0,
      lastOccurredAt: null,
      byChannel: {},
    },
    leads: {
      total: 0,
      new: 0,
      qualified: 0,
      won: 0,
      lost: 0,
      lastOccurredAt: null,
    },
    meetings: {
      total: 0,
      scheduled: 0,
      completed: 0,
      cancelled: 0,
      noShow: 0,
      lastOccurredAt: null,
    },
    revenue: {
      events: 0,
      pendingCount: 0,
      paidCount: 0,
      refundedCount: 0,
      pendingCents: 0,
      paidCents: 0,
      refundedCents: 0,
      currency: null,
      lastOccurredAt: null,
    },
  };

  for (const row of rows) {
    const status = row.status.trim().toLowerCase();

    switch (row.kind) {
      case "outreach": {
        summary.outreach.total += 1;
        const channel = row.channel?.trim().toLowerCase() || "unknown";
        summary.outreach.byChannel[channel] = (summary.outreach.byChannel[channel] ?? 0) + 1;
        if (["attempted", "sent", "delivered"].includes(status)) {
          summary.outreach.sent += 1;
        }
        if (["replied", "responded", "positive_reply"].includes(status)) {
          summary.outreach.replied += 1;
        }
        if (["failed", "bounced"].includes(status)) {
          summary.outreach.failed += 1;
        }
        summary.outreach.lastOccurredAt = latestIso(summary.outreach.lastOccurredAt, row.occurred_at);
        break;
      }
      case "lead": {
        summary.leads.total += 1;
        if (status === "new") summary.leads.new += 1;
        if (["qualified", "active", "responded"].includes(status)) summary.leads.qualified += 1;
        if (["won", "customer"].includes(status)) summary.leads.won += 1;
        if (["lost", "disqualified"].includes(status)) summary.leads.lost += 1;
        summary.leads.lastOccurredAt = latestIso(summary.leads.lastOccurredAt, row.occurred_at);
        break;
      }
      case "meeting": {
        summary.meetings.total += 1;
        if (status === "scheduled") summary.meetings.scheduled += 1;
        if (["completed", "held"].includes(status)) summary.meetings.completed += 1;
        if (status === "cancelled") summary.meetings.cancelled += 1;
        if (["no_show", "no-show"].includes(status)) summary.meetings.noShow += 1;
        summary.meetings.lastOccurredAt = latestIso(summary.meetings.lastOccurredAt, row.occurred_at);
        break;
      }
      case "revenue": {
        summary.revenue.events += 1;
        if (summary.revenue.currency === null && row.currency) {
          summary.revenue.currency = row.currency;
        }
        if (status === "pending") {
          summary.revenue.pendingCount += 1;
          summary.revenue.pendingCents += row.amount_cents ?? 0;
        }
        if (["paid", "collected"].includes(status)) {
          summary.revenue.paidCount += 1;
          summary.revenue.paidCents += row.amount_cents ?? 0;
        }
        if (status === "refunded") {
          summary.revenue.refundedCount += 1;
          summary.revenue.refundedCents += row.amount_cents ?? 0;
        }
        summary.revenue.lastOccurredAt = latestIso(summary.revenue.lastOccurredAt, row.occurred_at);
        break;
      }
      default:
        break;
    }
  }

  return summary;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function pickIsoString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      const timestamp = new Date(value).getTime();
      if (Number.isFinite(timestamp)) {
        return new Date(timestamp).toISOString();
      }
    }
  }
  return null;
}

function latestIso(current: string | null, candidate: string | null | undefined): string | null {
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  return new Date(candidate).getTime() >= new Date(current).getTime()
    ? candidate
    : current;
}
