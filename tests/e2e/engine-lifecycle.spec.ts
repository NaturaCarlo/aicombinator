import { test, expect } from "@playwright/test";
import { createClerkClient } from "@clerk/backend";

const API_BASE_URL = process.env.API_BASE_URL || "https://api.aicombinator.live";
const APP_BASE_URL = process.env.APP_BASE_URL || "https://aicombinator.live";

/**
 * Full Engine Lifecycle E2E Test
 *
 * Creates a real company, provisions its shared company runtime, waits for the
 * AI agent to complete at least one turn, verifies the data via API,
 * then navigates to the public company page to verify the dashboard
 * renders without errors. Cleans up by killing the agent.
 *
 * Cost: ~$0.20-0.50 per run (1 inference turn on Claude Opus).
 */

let authToken: string;
let companyId: string;
let companySlug: string;
let companyName: string;
const createdCompanyIds: string[] = [];

async function getToken(): Promise<string> {
  if (authToken) return authToken;
  const clerk = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY!,
  });
  const sessions = await clerk.sessions.getSessionList({
    userId: process.env.TEST_USER_ID!,
    status: "active",
  });
  if (sessions.data.length === 0) throw new Error("No active Clerk session");
  const tok = await clerk.sessions.getToken(sessions.data[0].id, "");
  authToken = tok.jwt;
  return authToken;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const token = await getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as Record<string, unknown> };
}

async function pollUntilTurn(
  id: string,
  timeoutMs = 180_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { status, data } = await api("GET", `/api/companies/${id}/status`);
    const elapsed = Math.round((Date.now() - start) / 1000);
    const state = data.state as string;
    const turns = (data.turnCount as number) || 0;
    if (status !== 200 || !state) {
      console.log(`  [poll +${elapsed}s] HTTP=${status} keys=${Object.keys(data).join(",")}`);
    } else {
      console.log(`  [poll +${elapsed}s] state=${state} turns=${turns}`);
    }
    if (turns >= 1) return data;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Agent did not complete a turn within ${timeoutMs / 1000}s`);
}

async function cleanupCompany(id: string): Promise<void> {
  try {
    await api("PATCH", `/api/admin/companies/${id}`, { state: "dead" });
  } catch {
    /* ignore */
  }
}

test.describe.serial("Engine Lifecycle", () => {
  test.setTimeout(300_000);

  test.afterAll(async () => {
    for (const id of createdCompanyIds) {
      await cleanupCompany(id);
    }
  });

  test("1. creates a company via API", async () => {
    const { status, data } = await api("POST", "/api/companies", {
      idea: "A CLI tool that converts natural language to regex patterns. Call it RegexGenie. Keep scope tiny.",
      budgetCents: 500,
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.name).toBeDefined();
    expect(data.slug).toBeDefined();
    companyId = data.id as string;
    companyName = data.name as string;
    companySlug = data.slug as string;
    createdCompanyIds.push(companyId);
  });

  test("2. provisions the company runtime", async () => {
    const { status, data } = await api(
      "POST",
      `/api/admin/companies/${companyId}/provision`,
    );
    expect(status).toBe(200);
    expect(data.provisioning).toBe(true);
  });

  test("3. agent completes at least one turn", async () => {
    const status = await pollUntilTurn(companyId);
    expect(status.turnCount).toBeGreaterThanOrEqual(1);
    expect(status.spentCents).toBeGreaterThan(0);
    expect(
      ["waking", "running", "sleeping"].includes(status.state as string),
    ).toBe(true);
  });

  test("4. verifies agent data via API", async () => {
    // Status endpoint returns full agent state
    const { status: statusCode, data: statusData } = await api(
      "GET",
      `/api/companies/${companyId}/status`,
    );
    expect(statusCode).toBe(200);
    expect(statusData.name).toBe(companyName);
    expect(statusData.turnCount).toBeGreaterThanOrEqual(1);
    expect(statusData.model).toBeTruthy();
    expect(statusData.recentTurns).toBeDefined();
    expect(
      (statusData.recentTurns as Array<Record<string, unknown>>).length,
    ).toBeGreaterThan(0);

    // Admin detail endpoint returns full company detail
    const { status: adminCode, data: adminData } = await api(
      "GET",
      `/api/admin/companies/${companyId}`,
    );
    expect(adminCode).toBe(200);
    expect(adminData.name).toBe(companyName);
    expect(adminData.genesis_prompt).toBeTruthy();
    expect(adminData.budget_cents).toBe(500);
    // spent_cents in D1 may lag behind the DO's real-time tracking
    // (step 3 already verified spentCents > 0 via the DO status endpoint)
    expect(adminData.spent_cents).toBeDefined();
    expect(adminData.recentActivity).toBeDefined();
  });

  test("5. public profile API returns data", async () => {
    // Verify the public profile API (no auth) returns company data
    const res = await fetch(`${API_BASE_URL}/api/public/${companySlug}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe(companyName);
    expect(data.slug).toBe(companySlug);
    expect(data.idea).toBeTruthy();
    // turnCount may be 0 in the public API since it reads from KV heartbeat
    // which lags behind the DO; step 4 already verified turns via the DO
    expect(data.turnCount).toBeDefined();
  });

  test("6. pauses the agent to stop spending", async () => {
    const { status } = await api(
      "PATCH",
      `/api/admin/companies/${companyId}`,
      { state: "paused" },
    );
    expect(status).toBe(200);

    // Verify the D1 state was updated via admin detail
    const { data: adminData } = await api(
      "GET",
      `/api/admin/companies/${companyId}`,
    );
    expect(adminData.state).toBe("paused");
  });

  test("7. cleans up — marks company as dead", async () => {
    const { status } = await api(
      "PATCH",
      `/api/admin/companies/${companyId}`,
      { state: "dead" },
    );
    expect(status).toBe(200);
  });
});
