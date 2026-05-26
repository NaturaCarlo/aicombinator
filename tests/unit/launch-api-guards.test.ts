import fs from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyClerkJwtMock,
  generateLaunchSessionTurnMock,
  generateLaunchSessionTurnStreamingMock,
  createAndProvisionCompanyMock,
} = vi.hoisted(() => ({
  verifyClerkJwtMock: vi.fn(async () => "user-1"),
  generateLaunchSessionTurnMock: vi.fn(),
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
    generateLaunchSessionTurn: generateLaunchSessionTurnMock,
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
  handleLaunchSessionMessage,
  handleStreamLaunchSession,
} from "../../worker/src/routes/launch-sessions.ts";

// ---- Test helpers (mirrors worker-launch-session-routes.test.ts) ----

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

/** Create a session and run its first Opus turn to completion via SSE, returning the ready session. */
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

  // Complete the turn via SSE streaming (the sole processor of turns)
  await completeViaStream(env, ctx, created.id);

  // GET returns the now-ready session
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
  generateLaunchSessionTurnMock.mockReset();
  generateLaunchSessionTurnStreamingMock.mockReset();
  createAndProvisionCompanyMock.mockReset();
});

describe("launch API guards", () => {
  // ---- 1. DOUBLE-LAUNCH PREVENTION ----

  describe("double-launch prevention (VAL-LAUNCH-010)", () => {
    it("first launch succeeds, second concurrent launch returns 409", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      createAndProvisionCompanyMock.mockResolvedValue({
        id: "company-1",
        name: "PatchPilot",
      });

      // Send two concurrent launch requests
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

      // The 409 response should have a clear error message
      const conflictResponse = response1.status === 409 ? response1 : response2;
      const conflictBody = (await conflictResponse.json()) as any;
      expect(conflictBody.error).toContain("already launched");
    });

    it("launching an already-launched session returns 409", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      createAndProvisionCompanyMock.mockResolvedValue({
        id: "company-1",
        name: "PatchPilot",
      });

      // First launch succeeds
      const first = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );
      expect(first.status).toBe(201);

      // Second launch returns 409
      const second = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );
      expect(second.status).toBe(409);
      const body = (await second.json()) as any;
      expect(body.error).toContain("already launched");
      expect(body.companyId).toBe("company-1");
    });
  });

  // ---- 2. MESSAGE DURING PROCESSING ----

  describe("message during processing guard (VAL-LAUNCH-015)", () => {
    it("returns 409 when sending a message while Opus turn is pending", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create a session — turn stays pending (no kickoff happens)
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing purposes to verify processing guard behavior.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;
      expect(created.processing).toBe(true);

      // Try to send a message while Opus turn is pending
      const messageResponse = await handleLaunchSessionMessage(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ message: "Let's go!" }),
        }),
        env,
        ctx as any,
        created.id,
      );

      expect(messageResponse.status).toBe(409);
      const body = (await messageResponse.json()) as any;
      expect(body.error).toContain("still responding");
    });

    it("allows sending a message after Opus turn completes", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();

      // First turn resolves with a non-ready result so the session stays active
      const nonReadyResult = {
        ...makeSuccessResult(),
        result: {
          ...makeSuccessResult().result,
          readiness: {
            score: 50,
            ready: false,
            blockers: ["Needs more detail"],
            strengths: [],
            nextBestQuestion: "What is the first buyer?",
          },
        },
      };
      generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(nonReadyResult)());

      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing purposes to verify message sending after turn completes.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;

      // Complete the first turn via SSE streaming
      await completeViaStream(env, ctx, created.id);

      // Now send a message — should succeed (200)
      const messageResponse = await handleLaunchSessionMessage(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ message: "Focus on hail-heavy metros first." }),
        }),
        env,
        ctx as any,
        created.id,
      );

      expect(messageResponse.status).toBe(200);
    });

    it("returns 409 when sending a message to an already-launched session", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      createAndProvisionCompanyMock.mockResolvedValue({
        id: "company-1",
        name: "PatchPilot",
      });

      // Launch the session
      await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );

      // Try to send a message after launch
      const messageResponse = await handleLaunchSessionMessage(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ message: "Can we add more features?" }),
        }),
        env,
        ctx as any,
        session.id,
      );

      expect(messageResponse.status).toBe(409);
      const body = (await messageResponse.json()) as any;
      expect(body.error).toContain("already been used");
    });
  });

  // ---- 3. FAILED LAUNCH RECOVERY ----

  describe("failed launch recovery", () => {
    it("keeps session as launching when createAndProvisionCompany throws a 500 error (post-provision)", async () => {
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
      const body = (await response.json()) as any;
      expect(body.error).toContain("Supervisor unreachable");

      // Session should stay 'launching' to prevent duplicate provisioning
      // without violating the invariant (no 'launched' without launched_company_id)
      const row = sqlite.prepare(
        `SELECT status, launched_company_id FROM launch_sessions WHERE id = ?`,
      ).get(session.id) as { status: string; launched_company_id: string | null };
      expect(row.status).toBe("launching");
      expect(row.launched_company_id).toBeNull();
    });

    it("rolls back session status when createAndProvisionCompany throws insufficient credits (402)", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      const creditError = new Error("You need at least 100 credits to launch a company.") as Error & {
        status?: number;
        requiredCredits?: number;
        balance?: number;
      };
      creditError.status = 402;
      creditError.requiredCredits = 100;
      creditError.balance = 5;
      createAndProvisionCompanyMock.mockRejectedValue(creditError);

      const response = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );

      expect(response.status).toBe(402);
      const body = (await response.json()) as any;
      expect(body.error).toContain("credits");
      expect(body.requiredCredits).toBe(100);
      expect(body.balance).toBe(5);

      // Session should be rolled back to 'ready' for retry
      const row = sqlite.prepare(
        `SELECT status FROM launch_sessions WHERE id = ?`,
      ).get(session.id) as { status: string };
      expect(row.status).toBe("ready");
    });

    it("allows retrying launch after a 402 credit-check failure", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      // First attempt fails with insufficient credits (pre-provision)
      const creditError = new Error("You need at least 100 credits to launch a company.") as Error & {
        status?: number;
        requiredCredits?: number;
        balance?: number;
      };
      creditError.status = 402;
      creditError.requiredCredits = 100;
      creditError.balance = 5;
      createAndProvisionCompanyMock.mockRejectedValueOnce(creditError);

      const failedResponse = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );
      expect(failedResponse.status).toBe(402);

      // Second attempt succeeds (user added credits)
      createAndProvisionCompanyMock.mockResolvedValueOnce({
        id: "company-1",
        name: "PatchPilot",
      });

      const retryResponse = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );
      expect(retryResponse.status).toBe(201);
      const body = (await retryResponse.json()) as any;
      expect(body.id).toBe("company-1");
    });

    it("does NOT allow retrying after a 500 provisioning error (prevents duplicate)", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      // First attempt fails with 500 (post-provision, company may exist)
      createAndProvisionCompanyMock.mockRejectedValueOnce(
        new Error("Supervisor temporarily unavailable"),
      );

      const failedResponse = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );
      expect(failedResponse.status).toBe(500);

      // Second attempt should return 409 since status stayed 'launching'
      // (claim guard: WHERE status NOT IN ('launching', 'launched'))
      const retryResponse = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );
      expect(retryResponse.status).toBe(409);
    });

    it("rolls back session status on 400 validation error (pre-provision)", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      const validationError = new Error("Company name contains prohibited characters.") as Error & {
        status?: number;
      };
      validationError.status = 400;
      createAndProvisionCompanyMock.mockRejectedValue(validationError);

      const response = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error).toContain("prohibited characters");

      // Session should be rolled back to 'ready' — 400 is pre-provision
      const row = sqlite.prepare(
        `SELECT status FROM launch_sessions WHERE id = ?`,
      ).get(session.id) as { status: string };
      expect(row.status).toBe("ready");
    });

    it("allows retrying launch after a 400 validation failure", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      // First attempt fails with 400 (pre-provision)
      const validationError = new Error("Invalid company name") as Error & { status?: number };
      validationError.status = 400;
      createAndProvisionCompanyMock.mockRejectedValueOnce(validationError);

      const failedResponse = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );
      expect(failedResponse.status).toBe(400);

      // Second attempt succeeds
      createAndProvisionCompanyMock.mockResolvedValueOnce({
        id: "company-1",
        name: "PatchPilot",
      });

      const retryResponse = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );
      expect(retryResponse.status).toBe(201);
      const body = (await retryResponse.json()) as any;
      expect(body.id).toBe("company-1");
    });

    it("rolls back session status on 403 forbidden error (pre-provision)", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      const forbiddenError = new Error("User account suspended") as Error & { status?: number };
      forbiddenError.status = 403;
      createAndProvisionCompanyMock.mockRejectedValue(forbiddenError);

      const response = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );

      expect(response.status).toBe(403);

      // Session should be rolled back to 'ready' — 403 is pre-provision
      const row = sqlite.prepare(
        `SELECT status FROM launch_sessions WHERE id = ?`,
      ).get(session.id) as { status: string };
      expect(row.status).toBe("ready");
    });

    it("rolls back session status on 422 unprocessable entity (pre-provision)", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      const unprocessableError = new Error("Brief data is incomplete") as Error & { status?: number };
      unprocessableError.status = 422;
      createAndProvisionCompanyMock.mockRejectedValue(unprocessableError);

      const response = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );

      expect(response.status).toBe(422);

      // Session should be rolled back to 'ready' — 422 is pre-provision
      const row = sqlite.prepare(
        `SELECT status FROM launch_sessions WHERE id = ?`,
      ).get(session.id) as { status: string };
      expect(row.status).toBe("ready");
    });

    it("returns human-readable error message on launch failure", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      createAndProvisionCompanyMock.mockRejectedValue(
        new Error("Connection reset by peer"),
      );

      const response = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );

      expect(response.status).toBe(500);
      const body = (await response.json()) as any;
      // Error message should be present and human-readable
      expect(body.error).toBeTruthy();
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(5);
    });

    it("returns human-readable error when non-Error object is thrown", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();
      const session = await createReadySession(env, ctx);

      createAndProvisionCompanyMock.mockRejectedValue("string error");

      const response = await handleLaunchFromSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
        env,
        ctx as any,
        session.id,
      );

      expect(response.status).toBe(500);
      const body = (await response.json()) as any;
      expect(body.error).toBe("Could not launch company. Please try again.");

      // Session stays 'launching' for post-provision errors to prevent duplicates
      // without violating the invariant (no 'launched' without launched_company_id)
      const row = sqlite.prepare(
        `SELECT status FROM launch_sessions WHERE id = ?`,
      ).get(session.id) as { status: string };
      expect(row.status).toBe("launching");
    });
  });
});
