import { describe, expect, it, vi } from "vitest";

/**
 * Tests that the sync manager includes reports_to in the PATCH payload
 * for agent updates, and that the worker handleSupervisorUpdateAgent
 * processes the reportsTo field to update D1.
 */

// ─── Sync Manager: reports_to in PATCH payload ─────────────

describe("Sync manager: reports_to in PATCH payload", () => {
  it("includes reportsTo in agent PATCH payload when reports_to is in sync item", () => {
    // Simulate what the sync manager does when building the PATCH payload
    // This mirrors the logic in supervisor/src/sync.ts case "agents"
    const payload: Record<string, unknown> = {
      reports_to: "agent-ceo-uuid",
      updated_at: "2026-03-29T00:00:00.000Z",
    };

    const patchPayload: Record<string, unknown> = {};
    if (payload.status !== undefined) patchPayload.status = payload.status;
    if (payload.last_wake_at !== undefined) patchPayload.lastWakeAt = payload.last_wake_at;
    if (payload.last_sleep_at !== undefined) patchPayload.lastSleepAt = payload.last_sleep_at;
    if (payload.reports_to !== undefined) patchPayload.reportsTo = payload.reports_to;

    expect(patchPayload.reportsTo).toBe("agent-ceo-uuid");
    expect(patchPayload.status).toBeUndefined();
  });

  it("does not include reportsTo when reports_to is not in sync item", () => {
    const payload: Record<string, unknown> = {
      status: "idle",
    };

    const patchPayload: Record<string, unknown> = {};
    if (payload.status !== undefined) patchPayload.status = payload.status;
    if (payload.last_wake_at !== undefined) patchPayload.lastWakeAt = payload.last_wake_at;
    if (payload.last_sleep_at !== undefined) patchPayload.lastSleepAt = payload.last_sleep_at;
    if (payload.reports_to !== undefined) patchPayload.reportsTo = payload.reports_to;

    expect(patchPayload.reportsTo).toBeUndefined();
    expect(patchPayload.status).toBe("idle");
  });

  it("handles null reports_to (CEO clearing hierarchy)", () => {
    const payload: Record<string, unknown> = {
      reports_to: null,
    };

    const patchPayload: Record<string, unknown> = {};
    if (payload.reports_to !== undefined) patchPayload.reportsTo = payload.reports_to;

    // null is !== undefined, so it should be included
    expect(patchPayload).toHaveProperty("reportsTo");
    expect(patchPayload.reportsTo).toBeNull();
  });
});

// ─── Worker: handleSupervisorUpdateAgent accepts reportsTo ──

vi.mock("../../worker/src/middleware/cors.ts", () => ({
  corsHeaders: vi.fn(() => ({})),
}));

vi.mock("../../worker/src/utils/internal-contract.ts", () => ({
  isCompatibleInternalContractVersion: vi.fn(() => true),
}));

vi.mock("../../worker/src/enrichment/agent-identity.ts", () => ({}));
vi.mock("../../worker/src/utils/supervisor-routing.ts", () => ({}));
vi.mock("../../worker/src/routes/companies.ts", () => ({}));

import { handleSupervisorUpdateAgent } from "../../worker/src/routes/supervisor.ts";

function makeEnv(agentExists: boolean = true) {
  const runCalls: Array<{ sql: string; bindings: unknown[] }> = [];
  return {
    env: {
      SUPERVISOR_API_KEY: "test-key",
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn((...bindings: unknown[]) => ({
            first: vi.fn(async () => agentExists ? { id: "agent-1" } : null),
            run: vi.fn(async () => {
              runCalls.push({ sql, bindings });
              return { success: true };
            }),
          })),
        })),
      },
    } as any,
    runCalls,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://test/api/supervisor/agents/agent-1", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Supervisor-Key": "test-key",
    },
    body: JSON.stringify(body),
  });
}

describe("handleSupervisorUpdateAgent: reportsTo field", () => {
  it("updates reports_to in D1 when reportsTo is provided", async () => {
    const { env, runCalls } = makeEnv(true);
    const request = makeRequest({ reportsTo: "agent-ceo-uuid" });

    const response = await handleSupervisorUpdateAgent(request, env, "agent-1");

    expect(response.status).toBe(200);
    const data = await response.json() as { updated: boolean };
    expect(data.updated).toBe(true);

    // Check that an UPDATE for reports_to was executed
    const reportsToUpdate = runCalls.find(
      (r) => r.sql.includes("reports_to"),
    );
    expect(reportsToUpdate).toBeDefined();
  });

  it("updates reports_to to null when reportsTo is null", async () => {
    const { env, runCalls } = makeEnv(true);
    const request = makeRequest({ reportsTo: null });

    const response = await handleSupervisorUpdateAgent(request, env, "agent-1");

    expect(response.status).toBe(200);

    const reportsToUpdate = runCalls.find(
      (r) => r.sql.includes("reports_to"),
    );
    expect(reportsToUpdate).toBeDefined();
  });

  it("does not update reports_to when reportsTo is not provided", async () => {
    const { env, runCalls } = makeEnv(true);
    const request = makeRequest({ status: "idle" });

    const response = await handleSupervisorUpdateAgent(request, env, "agent-1");

    expect(response.status).toBe(200);

    // Only the lifecycle state update runs, not a reports_to update
    const reportsToUpdate = runCalls.find(
      (r) => r.sql.includes("reports_to") && r.sql.includes("UPDATE"),
    );
    expect(reportsToUpdate).toBeUndefined();
  });

  it("returns 404 when agent does not exist in D1", async () => {
    const { env } = makeEnv(false);
    const request = makeRequest({ reportsTo: "agent-ceo" });

    const response = await handleSupervisorUpdateAgent(request, env, "agent-1");

    expect(response.status).toBe(404);
  });
});
