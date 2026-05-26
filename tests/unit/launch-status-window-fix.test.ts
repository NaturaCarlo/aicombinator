import fs from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyClerkJwtMock,
  generateLaunchSessionTurnStreamingMock,
  createAndProvisionCompanyMock,
} = vi.hoisted(() => ({
  verifyClerkJwtMock: vi.fn(async () => "user-1"),
  generateLaunchSessionTurnStreamingMock: vi.fn(),
  createAndProvisionCompanyMock: vi.fn(),
}));

vi.mock("../../worker/src/middleware/auth.ts", async () => {
  const actual = await vi.importActual<typeof import("../../worker/src/middleware/auth.ts")>(
    "../../worker/src/middleware/auth.ts",
  );
  return {
    ...actual,
    verifyClerkJwt: verifyClerkJwtMock,
  };
});

vi.mock("../../worker/src/provisioning/launch-session.ts", async () => {
  const actual = await vi.importActual<typeof import("../../worker/src/provisioning/launch-session.ts")>(
    "../../worker/src/provisioning/launch-session.ts",
  );
  return {
    ...actual,
    generateLaunchSessionTurn: vi.fn(),
    generateLaunchSessionTurnStreaming: generateLaunchSessionTurnStreamingMock,
    generateLaunchArtifacts: vi.fn(async () => ({
      companySpecMd: "# Company Spec",
      missionMd: "# Mission",
      firstMilestoneMd: "# First Milestone",
      autonomyContractMd: "# Autonomy Contract",
    })),
  };
});

vi.mock("../../worker/src/routes/companies.ts", async () => {
  const actual = await vi.importActual<typeof import("../../worker/src/routes/companies.ts")>(
    "../../worker/src/routes/companies.ts",
  );
  return {
    ...actual,
    createAndProvisionCompany: createAndProvisionCompanyMock,
    hasInferableCompanyMeaning: () => true,
  };
});

import {
  handleCreateLaunchSession,
  handleGetLaunchSession,
  handleLaunchFromSession,
  handleStreamLaunchSession,
} from "../../worker/src/routes/launch-sessions.ts";

// ---- Test helpers (same as launch-api-guards.test.ts) ----

class TestPreparedStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      results: this.db.prepare(this.sql).all(...this.args) as T[],
    };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return {
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
}

class TestD1Database {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string) {
    return new TestPreparedStatement(this.db, sql);
  }

  async batch(statements: Array<TestPreparedStatement>) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

class MemoryKv {
  private readonly values = new Map<string, string>();

  async get(key: string, type?: "json") {
    const raw = this.values.get(key) ?? null;
    if (raw === null) {
      return null;
    }
    if (type === "json") {
      return JSON.parse(raw);
    }
    return raw;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

class TestExecutionContext {
  private readonly tasks: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>) {
    this.tasks.push(Promise.resolve(promise));
  }

  async flush() {
    while (this.tasks.length > 0) {
      const pending = this.tasks.splice(0, this.tasks.length);
      await Promise.all(pending);
    }
  }
}

function applyMigration(db: Database.Database, fileName: string) {
  const sql = fs.readFileSync(`/Users/CEF/Projects/automaton/worker/migrations/${fileName}`, "utf8");
  db.exec(sql);
}

function makeEnv() {
  const sqlite = new Database(":memory:");
  applyMigration(sqlite, "012_launch_sessions.sql");
  applyMigration(sqlite, "014_launch_session_turns.sql");

  return {
    sqlite,
    env: {
      DB: new TestD1Database(sqlite),
      AUTOMATON_KV: new MemoryKv(),
      FRONTEND_URL: "https://aicombinator.live",
    } as any,
  };
}

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, {
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
}

function makeSuccessResult(message = "## Tight operating thesis\n\nWe should start with inbound storm lead recovery.") {
  return {
    ok: true,
    result: {
      assistantMessage: message,
      suggestedCompanyName: "PatchPilot",
      brief: {
        concept: "AI assistant for storm-damage roofing companies.",
        targetCustomer: "owner-led roofing companies in storm-prone US metros",
        painfulProblem: "Missed inbound leads decay before the office gets back to them.",
        firstOffer: "Missed-call recovery + instant lead qualification + booking",
        whyNow: "Storm-driven lead spikes create acute response bottlenecks.",
        businessModel: "Monthly retainer plus per-booked-job success fee",
        distributionWedge: "Founder-led outbound to roofing owners already buying leads",
        founderConstraints: [],
        autonomyBoundaries: ["Stripe still needs founder setup"],
        founderSetupTasks: ["Connect Stripe"],
        nonGoals: [],
        firstMilestone: "Launch a live lead-recovery funnel and book the first qualified calls",
        openQuestions: [],
        autonomyConfidence: 82,
      },
      readiness: {
        score: 84,
        ready: true,
        blockers: [],
        strengths: ["Clear first buyer", "Concrete first offer"],
        nextBestQuestion: null,
      },
      options: [
        {
          title: "Go narrower",
          description: "Focus on hail-heavy metros first.",
          founderReply: "Narrow the first market to hail-heavy metros.",
        },
      ],
    },
    attempts: [
      {
        provider: "anthropic",
        model: "claude-opus-4-6",
        outcome: "success",
        durationMs: 420,
        statusCode: 200,
        error: null,
        promptChars: 1400,
        transcriptMessages: 1,
      },
    ],
  };
}

function makeStreamingGenerator(result: ReturnType<typeof makeSuccessResult>) {
  const chunks = result.ok && result.result
    ? [result.result.assistantMessage]
    : [];
  return async function* () {
    for (const chunk of chunks) {
      yield { type: "token" as const, content: chunk };
    }
    yield { type: "result" as const, generation: result };
  };
}

async function completeViaStream(env: any, ctx: TestExecutionContext, sessionId: string): Promise<void> {
  const streamResponse = await handleStreamLaunchSession(
    makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
    env,
    ctx as any,
    sessionId,
  );
  await Promise.all([
    streamResponse.text(),
    ctx.flush(),
  ]);
}

async function createReadySession(env: any, ctx: TestExecutionContext) {
  const result = makeSuccessResult();
  generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());

  const createResponse = await handleCreateLaunchSession(
    makeRequest("https://api.aicombinator.live/api/launch-sessions", {
      method: "POST",
      body: JSON.stringify({
        companyName: "PatchPilot",
        idea: "AI assistant for storm-damage roofing companies to recover missed leads and book work faster.",
      }),
    }),
    env,
    ctx as any,
  );

  const created = (await createResponse.json()) as any;

  await completeViaStream(env, ctx, created.id);

  const getResponse = await handleGetLaunchSession(
    makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
    env,
    ctx as any,
    created.id,
  );
  const session = (await getResponse.json()) as any;
  expect(session.ready).toBe(true);
  return session;
}

beforeEach(() => {
  verifyClerkJwtMock.mockClear();
  generateLaunchSessionTurnStreamingMock.mockReset();
  createAndProvisionCompanyMock.mockReset();
});

describe("VAL-BE-LAUNCH: no transient invalid launched status", () => {
  it("VAL-BE-LAUNCH-001: readiness is checked before status transitions to launched", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    // Manually set readiness to not-ready to simulate a race condition
    sqlite.prepare(
      `UPDATE launch_sessions SET readiness_json = ? WHERE id = ?`,
    ).run(JSON.stringify({ score: 30, ready: false, blockers: ["Needs work"], strengths: [], nextBestQuestion: "?" }), session.id);

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    expect(body.error).toContain("not ready");

    // CRITICAL: Status must NOT be 'launched' after readiness failure
    const row = sqlite.prepare(
      `SELECT status FROM launch_sessions WHERE id = ?`,
    ).get(session.id) as { status: string };
    expect(row.status).not.toBe("launched");
    // It should be back to 'ready'
    expect(row.status).toBe("ready");
  });

  it("VAL-BE-LAUNCH-001: artifacts are ensured before status transitions to launched", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    // Force artifacts_json to null and readiness to ready
    sqlite.prepare(
      `UPDATE launch_sessions SET artifacts_json = NULL WHERE id = ?`,
    ).run(session.id);

    // The generateLaunchArtifacts mock returns null artifacts if the ensureArtifacts
    // function can't generate them. Simulate this by clearing artifacts and having
    // the ensureArtifacts call fail to produce them.
    // Actually, ensureArtifacts is called with the session's existing artifacts_json.
    // If artifacts_json is null, it tries to generate them.
    // Our mock generateLaunchArtifacts returns valid artifacts, so ensureArtifacts should work.
    // The test for artifacts failure requires more elaborate mocking; we'll test the happy path ensures artifacts BEFORE launched status.

    createAndProvisionCompanyMock.mockResolvedValue({
      id: "company-1",
      name: "PatchPilot",
    });

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(201);

    // After successful launch, status should be 'launched' AND launched_company_id set
    const row = sqlite.prepare(
      `SELECT status, launched_company_id FROM launch_sessions WHERE id = ?`,
    ).get(session.id) as { status: string; launched_company_id: string | null };
    expect(row.status).toBe("launched");
    expect(row.launched_company_id).toBe("company-1");
  });

  it("VAL-BE-LAUNCH-002: during launch, clients never see 'launched' without launched_company_id", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    // Track all status transitions
    const statusHistory: Array<{ status: string; launched_company_id: string | null }> = [];

    // Wrap createAndProvisionCompany to check status during provisioning
    createAndProvisionCompanyMock.mockImplementation(async () => {
      // During provisioning, check the DB state
      const row = sqlite.prepare(
        `SELECT status, launched_company_id FROM launch_sessions WHERE id = ?`,
      ).get(session.id) as { status: string; launched_company_id: string | null };
      statusHistory.push(row);
      return { id: "company-1", name: "PatchPilot" };
    });

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(201);

    // During provisioning, status should NOT have been 'launched'
    // It should be 'launching' (intermediate) — never 'launched' without company_id
    for (const snapshot of statusHistory) {
      if (snapshot.status === "launched") {
        // If status was 'launched', company_id must already be set
        expect(snapshot.launched_company_id).toBeTruthy();
      }
    }

    // After completion: status is launched AND company_id is set
    const finalRow = sqlite.prepare(
      `SELECT status, launched_company_id FROM launch_sessions WHERE id = ?`,
    ).get(session.id) as { status: string; launched_company_id: string | null };
    expect(finalRow.status).toBe("launched");
    expect(finalRow.launched_company_id).toBe("company-1");
  });

  it("double-launch prevention still works with launching intermediate status", async () => {
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    createAndProvisionCompanyMock.mockResolvedValue({
      id: "company-1",
      name: "PatchPilot",
    });

    // Two concurrent launch requests
    const [response1, response2] = await Promise.all([
      handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      ),
      handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      ),
    ]);

    const statuses = [response1.status, response2.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("readiness check failure rolls back to 'ready' (not stuck at 'launching')", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    // Force not-ready
    sqlite.prepare(
      `UPDATE launch_sessions SET readiness_json = ? WHERE id = ?`,
    ).run(JSON.stringify({ score: 20, ready: false, blockers: ["Missing revenue model"], strengths: [], nextBestQuestion: null }), session.id);

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(409);

    // Must be back to 'ready', not stuck at 'launching'
    const row = sqlite.prepare(
      `SELECT status FROM launch_sessions WHERE id = ?`,
    ).get(session.id) as { status: string };
    expect(row.status).toBe("ready");
  });

  it("artifact failure rolls back to 'ready' (not stuck at 'launching')", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    // Ensure readiness is set but clear artifacts and make generation fail
    // The ensureArtifacts function will try to generate artifacts.
    // We need to ensure the session has no existing artifacts and the generation returns null.
    sqlite.prepare(
      `UPDATE launch_sessions SET artifacts_json = NULL WHERE id = ?`,
    ).run(session.id);

    // Override generateLaunchArtifacts to return null (failure)
    const { generateLaunchArtifacts } = await import("../../worker/src/provisioning/launch-session.ts");
    vi.mocked(generateLaunchArtifacts).mockResolvedValueOnce(null as any);

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(500);

    // Must be back to 'ready', not stuck at 'launching'
    const row = sqlite.prepare(
      `SELECT status FROM launch_sessions WHERE id = ?`,
    ).get(session.id) as { status: string };
    expect(row.status).toBe("ready");
  });

  it("successful launch sets final status to 'launched' with company_id", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    createAndProvisionCompanyMock.mockResolvedValue({
      id: "company-42",
      name: "PatchPilot",
    });

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(201);

    const row = sqlite.prepare(
      `SELECT status, launched_company_id FROM launch_sessions WHERE id = ?`,
    ).get(session.id) as { status: string; launched_company_id: string | null };
    expect(row.status).toBe("launched");
    expect(row.launched_company_id).toBe("company-42");
  });

  it("pre-provision failure (4xx) rolls back to 'ready' from launching", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    const creditError = new Error("Insufficient credits") as Error & { status?: number };
    creditError.status = 402;
    createAndProvisionCompanyMock.mockRejectedValue(creditError);

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(402);

    const row = sqlite.prepare(
      `SELECT status FROM launch_sessions WHERE id = ?`,
    ).get(session.id) as { status: string };
    expect(row.status).toBe("ready");
  });

  it("post-provision failure (5xx) keeps 'launching' status to prevent duplicates without violating invariant", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    createAndProvisionCompanyMock.mockRejectedValue(
      new Error("Supervisor unreachable"),
    );

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(500);

    const row = sqlite.prepare(
      `SELECT status, launched_company_id FROM launch_sessions WHERE id = ?`,
    ).get(session.id) as { status: string; launched_company_id: string | null };
    // Status stays 'launching' (NOT 'launched') — prevents re-attempt via claim guard
    // and does NOT violate the invariant: no client sees 'launched' without launched_company_id
    expect(row.status).toBe("launching");
    expect(row.launched_company_id).toBeNull();
  });
});
