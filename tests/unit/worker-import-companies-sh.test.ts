import { describe, expect, it, vi, beforeEach } from "vitest";

import { handleImportCompaniesSh } from "../../worker/src/routes/import-companies-sh.ts";

// ─── Mock auth modules ────────────────────────────────────────

vi.mock("../../worker/src/middleware/auth.ts", () => ({
  extractToken: vi.fn(() => "valid-token"),
  verifyClerkJwt: vi.fn(async () => "user-1"),
}));

// Mock supervisor routing to control proxy behavior
const mockFetchFromCompanySupervisor = vi.fn();
vi.mock("../../worker/src/utils/supervisor-routing.ts", () => ({
  fetchFromCompanySupervisor: (...args: unknown[]) => mockFetchFromCompanySupervisor(...args),
}));

// ─── Mock Env ─────────────────────────────────────────────────

function makeMockEnv(overrides: { companyOwnerId?: string | null } = {}) {
  const { companyOwnerId = "user-1" } = overrides;

  return {
    DB: {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("SELECT user_id FROM companies")) {
          return {
            bind: vi.fn(() => ({
              first: vi.fn(async () =>
                companyOwnerId ? { user_id: companyOwnerId } : null,
              ),
            })),
          };
        }
        return {
          bind: vi.fn(() => ({
            run: vi.fn(async () => ({})),
            first: vi.fn(async () => null),
            all: vi.fn(async () => ({ results: [] })),
          })),
        };
      }),
    },
    SUPERVISOR_API_KEY: "test-key",
    FRONTEND_URL: "https://aicombinator.live",
    ENVIRONMENT: "test",
    AUTOMATON_KV: {
      get: vi.fn(async () => null),
    },
    SUPERVISOR_URL: "http://localhost:8787",
    SHARED_SUPERVISOR_URL: "http://localhost:8787",
  } as unknown as Parameters<typeof handleImportCompaniesSh>[1];
}

function makeRequest(body: unknown): Request {
  return new Request(
    "https://api.aicombinator.live/api/companies/comp-1/import/companies-sh",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid-token",
      },
      body: JSON.stringify(body),
    },
  );
}

// ─── Tests ───────────────────────────────────────────────────

describe("POST /api/companies/:companyId/import/companies-sh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when packageRef is missing", async () => {
    const env = makeMockEnv();
    const req = makeRequest({});
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/packageRef/i);
  });

  it("returns 400 when packageRef is empty string", async () => {
    const env = makeMockEnv();
    const req = makeRequest({ packageRef: "   " });
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/packageRef/i);
  });

  it("returns 400 for malformed package reference (single word) (VAL-IMPORT-008)", async () => {
    const env = makeMockEnv();
    const req = makeRequest({ packageRef: "justoneword" });
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid|format/i);
  });

  it("returns 404 when company does not belong to user", async () => {
    const env = makeMockEnv({ companyOwnerId: "other-user" });
    const req = makeRequest({ packageRef: "owner/repo/package" });
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(404);
  });

  it("returns 404 when company not found", async () => {
    const env = makeMockEnv({ companyOwnerId: null });
    const req = makeRequest({ packageRef: "owner/repo/package" });
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(404);
  });

  it("returns 502 when supervisor is unreachable", async () => {
    const env = makeMockEnv();
    mockFetchFromCompanySupervisor.mockResolvedValue(null);
    const req = makeRequest({ packageRef: "owner/repo/package" });
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/supervisor/i);
  });

  it("forwards successful supervisor response with import result", async () => {
    const env = makeMockEnv();
    const successBody = {
      company: { name: "Test Co", description: "A test company", goals: [] },
      agents: [{ name: "CEO", role: "executive", title: "CEO", reportsTo: null, skills: [] }],
      skills: [],
      import: { created: ["CEO"], skipped: [], errors: [] },
    };
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify(successBody), { status: 200 }),
    );

    const req = makeRequest({ packageRef: "paperclipai/companies/gstack" });
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof successBody;
    expect(body.company.name).toBe("Test Co");
    expect(body.import.created).toEqual(["CEO"]);
  });

  it("forwards supervisor 400 error for invalid package", async () => {
    const env = makeMockEnv();
    const errorBody = {
      error: "Failed to parse package",
      details: ["COMPANY.md not found"],
    };
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify(errorBody), { status: 400 }),
    );

    const req = makeRequest({ packageRef: "owner/nonexistent" });
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as typeof errorBody;
    expect(body.error).toContain("parse");
  });

  it("accepts GitHub URL as packageRef", async () => {
    const env = makeMockEnv();
    const successBody = {
      company: { name: "URL Co", description: "", goals: [] },
      agents: [],
      skills: [],
      import: { created: [], skipped: [], errors: [] },
    };
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify(successBody), { status: 200 }),
    );

    const req = makeRequest({
      packageRef: "https://github.com/paperclipai/companies/tree/main/gstack",
    });
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(200);
  });

  it("proxies to correct supervisor path with companyId", async () => {
    const env = makeMockEnv();
    mockFetchFromCompanySupervisor.mockResolvedValue(
      new Response(JSON.stringify({ company: {}, import: { created: [], skipped: [], errors: [] } }), { status: 200 }),
    );

    const req = makeRequest({ packageRef: "owner/repo/pkg" });
    await handleImportCompaniesSh(req, env, "comp-1");

    expect(mockFetchFromCompanySupervisor).toHaveBeenCalledWith(
      env,
      "comp-1",
      "/import/companies-sh/comp-1",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("returns 400 for invalid JSON body", async () => {
    const env = makeMockEnv();
    const req = new Request(
      "https://api.aicombinator.live/api/companies/comp-1/import/companies-sh",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid-token",
        },
        body: "not-json",
      },
    );
    const res = await handleImportCompaniesSh(req, env, "comp-1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/json/i);
  });
});
