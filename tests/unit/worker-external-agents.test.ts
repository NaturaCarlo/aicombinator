import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  handleCreateExternalAgent,
  handleListExternalAgents,
} from "../../worker/src/routes/external-agents.ts";

// ─── Mock helpers ────────────────────────────────────────────

function makeMockEnv(overrides: {
  companyOwnerId?: string;
  insertSuccess?: boolean;
  agentResult?: Record<string, unknown> | null;
  listResults?: Record<string, unknown>[];
} = {}) {
  const {
    companyOwnerId = "user-1",
    insertSuccess = true,
    agentResult = { id: "agent-new", company_id: "comp-1", name: "TestBot", source: "external" },
    listResults = [],
  } = overrides;

  const runMock = vi.fn(async () => ({ success: insertSuccess }));
  const firstMock = vi.fn(async () => agentResult);

  return {
    DB: {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("SELECT user_id FROM companies")) {
          return {
            bind: vi.fn(() => ({
              first: vi.fn(async () => companyOwnerId ? { user_id: companyOwnerId } : null),
            })),
          };
        }
        if (sql.includes("INSERT INTO agents")) {
          return {
            bind: vi.fn(() => ({ run: runMock })),
          };
        }
        if (sql.includes("SELECT * FROM agents WHERE id")) {
          return {
            bind: vi.fn(() => ({ first: firstMock })),
          };
        }
        if (sql.includes("SELECT *") && sql.includes("source = 'external'")) {
          return {
            bind: vi.fn(() => ({
              all: vi.fn(async () => ({ results: listResults })),
            })),
          };
        }
        if (sql.includes("INSERT INTO activity_log")) {
          return {
            bind: vi.fn(() => ({ run: vi.fn(async () => ({})) })),
          };
        }
        // Default fallback
        return {
          bind: vi.fn(() => ({
            run: vi.fn(async () => ({})),
            first: vi.fn(async () => null),
            all: vi.fn(async () => ({ results: [] })),
          })),
        };
      }),
    },
    FRONTEND_URL: "https://aicombinator.live",
    ENVIRONMENT: "test",
  } as unknown as Parameters<typeof handleCreateExternalAgent>[1];
}

function makeRequest(body: unknown, method = "POST"): Request {
  return new Request("https://api.aicombinator.live/api/companies/comp-1/agents/external", {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-token",
    },
    body: method !== "GET" ? JSON.stringify(body) : undefined,
  });
}

function makeGetRequest(): Request {
  return new Request("https://api.aicombinator.live/api/companies/comp-1/agents/external", {
    method: "GET",
    headers: {
      Authorization: "Bearer valid-token",
    },
  });
}

// Mock auth modules
vi.mock("../../worker/src/middleware/auth.ts", () => ({
  extractToken: vi.fn(() => "valid-token"),
  verifyClerkJwt: vi.fn(async () => "user-1"),
}));

vi.mock("../../worker/src/provisioning/config-builder.ts", () => ({
  generateId: vi.fn(() => "generated-id"),
}));

vi.mock("../../worker/src/utils/activity.ts", () => ({
  logActivity: vi.fn(async () => undefined),
}));

// ─── Tests ───────────────────────────────────────────────────

describe("POST /api/companies/:companyId/agents/external", () => {
  it("returns 201 with agent on valid input", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "My Webhook Bot",
      role: "worker",
      webhookUrl: "https://example.com/webhook",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(201);

    const data = await res.json() as { agent: Record<string, unknown> };
    expect(data.agent).toBeDefined();
  });

  it("returns 400 for missing name", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      webhookUrl: "https://example.com/webhook",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/name/i);
  });

  it("returns 400 for empty name", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "",
      webhookUrl: "https://example.com/webhook",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/name/i);
  });

  it("returns 400 for empty webhook URL", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "TestBot",
      webhookUrl: "",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/webhook/i);
  });

  it("returns 400 for missing webhook URL", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "TestBot",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/webhook/i);
  });

  it("returns 400 for ftp:// webhook URL (VAL-JOIN-006)", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "TestBot",
      webhookUrl: "ftp://files.example.com/agent",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/http/i);
  });

  it("returns 400 for invalid URL string (VAL-JOIN-006)", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "TestBot",
      webhookUrl: "not-a-url",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/webhook/i);
  });

  it("returns 400 for invalid adapter type", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "TestBot",
      webhookUrl: "https://example.com/webhook",
      adapterType: "invalid-type",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/adapter type/i);
  });

  it("defaults adapter type to http-webhook when not provided", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "TestBot",
      webhookUrl: "https://example.com/webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(201);
  });

  it("accepts https:// URL", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "TestBot",
      webhookUrl: "https://secure.example.com/webhook",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(201);
  });

  it("accepts http:// URL", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "TestBot",
      webhookUrl: "http://local.example.com/webhook",
      adapterType: "http-webhook",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(201);
  });

  it("accepts bash adapter type", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "BashBot",
      webhookUrl: "https://example.com/bash-exec",
      adapterType: "bash",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(201);
  });

  it("accepts codex adapter type", async () => {
    const env = makeMockEnv();
    const req = makeRequest({
      name: "CodexBot",
      webhookUrl: "https://example.com/codex",
      adapterType: "codex",
    });

    const res = await handleCreateExternalAgent(req, env, "comp-1");
    expect(res.status).toBe(201);
  });
});

describe("GET /api/companies/:companyId/agents/external", () => {
  it("returns list of external agents", async () => {
    const env = makeMockEnv({
      listResults: [
        { id: "ext-1", name: "Bot1", source: "external" },
        { id: "ext-2", name: "Bot2", source: "external" },
      ],
    });
    const req = makeGetRequest();

    const res = await handleListExternalAgents(req, env, "comp-1");
    expect(res.status).toBe(200);

    const data = await res.json() as { agents: unknown[] };
    expect(data.agents).toHaveLength(2);
  });

  it("returns empty array when no external agents", async () => {
    const env = makeMockEnv({ listResults: [] });
    const req = makeGetRequest();

    const res = await handleListExternalAgents(req, env, "comp-1");
    expect(res.status).toBe(200);

    const data = await res.json() as { agents: unknown[] };
    expect(data.agents).toHaveLength(0);
  });
});
