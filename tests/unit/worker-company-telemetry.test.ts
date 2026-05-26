import { describe, expect, it, vi } from "vitest";

import {
  normalizeTelemetryInput,
  summarizeTelemetryRows,
  upsertCompanyTelemetryRow,
} from "../../worker/src/utils/company-telemetry.ts";

describe("company telemetry utilities", () => {
  it("normalizes flexible telemetry payloads into the canonical shape", () => {
    const normalized = normalizeTelemetryInput({
      kind: "Lead",
      status: "qualified",
      verificationLevel: "system_verified",
      subjectEmail: "prospect@example.com",
      companyName: "Example",
      externalRef: "msg_123",
      occurredAt: "2026-03-09T12:00:00.000Z",
    });

    expect(normalized).toEqual({
      id: null,
      agent_id: null,
      task_id: null,
      kind: "lead",
      status: "qualified",
      source: null,
      source_event_id: null,
      channel: null,
      verification_level: "system_verified",
      subject_name: null,
      subject_email: "prospect@example.com",
      subject_company: "Example",
      amount_cents: null,
      currency: null,
      external_ref: "msg_123",
      evidence_ref: null,
      notes: null,
      metadata: null,
      occurred_at: "2026-03-09T12:00:00.000Z",
    });
  });

  it("summarizes outreach, leads, meetings, and revenue correctly", () => {
    const summary = summarizeTelemetryRows(
      [
        {
          id: "t1",
          company_id: "company-1",
          agent_id: "agent-1",
          task_id: null,
          kind: "outreach",
          status: "sent",
          channel: "email",
          verification_level: "system_verified",
          subject_name: null,
          subject_email: "prospect@example.com",
          subject_company: "example.com",
          amount_cents: null,
          currency: null,
          external_ref: "msg_1",
          evidence_ref: null,
          notes: null,
          metadata: null,
          occurred_at: "2026-03-09T12:00:00.000Z",
          created_at: "2026-03-09T12:00:00.000Z",
          updated_at: "2026-03-09T12:00:00.000Z",
        },
        {
          id: "t2",
          company_id: "company-1",
          agent_id: "agent-1",
          task_id: null,
          kind: "lead",
          status: "new",
          channel: "email",
          verification_level: "system_verified",
          subject_name: null,
          subject_email: "prospect@example.com",
          subject_company: "example.com",
          amount_cents: null,
          currency: null,
          external_ref: "msg_2",
          evidence_ref: null,
          notes: null,
          metadata: null,
          occurred_at: "2026-03-09T12:05:00.000Z",
          created_at: "2026-03-09T12:05:00.000Z",
          updated_at: "2026-03-09T12:05:00.000Z",
        },
        {
          id: "t3",
          company_id: "company-1",
          agent_id: "agent-2",
          task_id: null,
          kind: "meeting",
          status: "scheduled",
          channel: "calendar",
          verification_level: "evidence_attached",
          subject_name: "Alex Prospect",
          subject_email: "prospect@example.com",
          subject_company: "example.com",
          amount_cents: null,
          currency: null,
          external_ref: null,
          evidence_ref: "/workspace/docs/meetings/alex.md",
          notes: null,
          metadata: null,
          occurred_at: "2026-03-09T12:10:00.000Z",
          created_at: "2026-03-09T12:10:00.000Z",
          updated_at: "2026-03-09T12:10:00.000Z",
        },
        {
          id: "t4",
          company_id: "company-1",
          agent_id: "agent-2",
          task_id: null,
          kind: "revenue",
          status: "paid",
          channel: "stripe",
          verification_level: "system_verified",
          subject_name: "Alex Prospect",
          subject_email: "prospect@example.com",
          subject_company: "example.com",
          amount_cents: 250000,
          currency: "usd",
          external_ref: "pi_123",
          evidence_ref: null,
          notes: null,
          metadata: null,
          occurred_at: "2026-03-09T12:15:00.000Z",
          created_at: "2026-03-09T12:15:00.000Z",
          updated_at: "2026-03-09T12:15:00.000Z",
        },
      ],
      "verified",
    );

    expect(summary.outreach.sent).toBe(1);
    expect(summary.outreach.byChannel.email).toBe(1);
    expect(summary.leads.new).toBe(1);
    expect(summary.meetings.scheduled).toBe(1);
    expect(summary.revenue.paidCount).toBe(1);
    expect(summary.revenue.paidCents).toBe(250000);
    expect(summary.revenue.currency).toBe("usd");
  });

  it("rejects system verified telemetry with no external or evidence reference", async () => {
    const env = {
      DB: {
        prepare: vi.fn(),
      },
    } as any;

    await expect(
      upsertCompanyTelemetryRow(env, "company-1", {
        kind: "lead",
        status: "new",
        verification_level: "system_verified",
      }),
    ).rejects.toThrow("lead telemetry must come from a trusted system source with source_event_id");
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
});
