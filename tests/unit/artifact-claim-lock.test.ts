import fs from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyClerkJwtMock,
  generateLaunchSessionTurnStreamingMock,
  generateLaunchArtifactsMock,
} = vi.hoisted(() => ({
  verifyClerkJwtMock: vi.fn(async () => "user-1"),
  generateLaunchSessionTurnStreamingMock: vi.fn(),
  generateLaunchArtifactsMock: vi.fn(async () => ({
    companySpecMd: "# Company Spec",
    missionMd: "# Mission",
    firstMilestoneMd: "# First Milestone",
    autonomyContractMd: "# Autonomy Contract",
  })),
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
    generateLaunchArtifacts: generateLaunchArtifactsMock,
  };
});

import {
  handleCreateLaunchSession,
  handleGetLaunchSession,
  handleStreamLaunchSession,
} from "../../worker/src/routes/launch-sessions.ts";

// ---- Test helpers ----

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
    if (raw === null) return null;
    if (type === "json") return JSON.parse(raw);
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

function makeReadyResult(message = "## Your company is ready!\n\nLet's launch.") {
  return {
    ok: true as const,
    result: {
      assistantMessage: message,
      suggestedCompanyName: "ClaimTestCo",
      brief: {
        concept: "AI testing tool for artifact claim lock.",
        targetCustomer: "developers building AI apps",
        painfulProblem: "Duplicate artifact generation from race conditions.",
        firstOffer: "Atomic claim lock for artifact generation",
        whyNow: "Concurrent requests cause duplicate work.",
        businessModel: "SaaS subscription",
        distributionWedge: "Developer community adoption",
        founderConstraints: [],
        autonomyBoundaries: [],
        founderSetupTasks: [],
        nonGoals: [],
        firstMilestone: "Ship the claim lock fix",
        openQuestions: [],
        autonomyConfidence: 90,
      },
      readiness: {
        score: 92,
        ready: true,
        blockers: [],
        strengths: ["Clear problem", "Strong demand"],
        nextBestQuestion: null,
      },
      options: [
        {
          title: "Launch now",
          description: "Start immediately.",
          founderReply: "Let's go!",
        },
      ],
    },
    attempts: [
      {
        provider: "anthropic" as const,
        model: "claude-opus-4-6",
        outcome: "success" as const,
        durationMs: 300,
        statusCode: 200,
        error: null,
        promptChars: 1000,
        transcriptMessages: 1,
      },
    ],
  };
}

function makeStreamingGenerator(result: ReturnType<typeof makeReadyResult>) {
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

async function parseSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const events: Array<Record<string, unknown>> = [];
  const chunks = text.split("\n\n");
  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // skip non-json
    }
  }
  return events;
}

beforeEach(() => {
  verifyClerkJwtMock.mockClear();
  generateLaunchSessionTurnStreamingMock.mockReset();
  generateLaunchArtifactsMock.mockClear();
});

describe("Artifact claim lock (VAL-BE-TURN-008, VAL-BE-TURN-009)", () => {
  /**
   * Create a ready session by directly inserting into D1.
   * This avoids the streaming handler's own ensureArtifacts call,
   * so we can test the claim lock in isolation.
   */
  function createReadySessionDirect(sqlite: Database.Database, env: any): string {
    const sessionId = `test-session-${Date.now()}`;
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO launch_sessions (id, user_id, status, mode, input_name, input_idea, suggested_name, brief_json, readiness_json, artifacts_json, created_at, updated_at)
       VALUES (?, ?, 'ready', 'standard', ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      sessionId,
      "user-1",
      "ClaimTestCo",
      "AI testing tool for artifact claim lock.",
      "ClaimTestCo",
      JSON.stringify({
        concept: "AI testing tool for artifact claim lock.",
        targetCustomer: "developers",
        painfulProblem: "Duplicate artifacts",
        firstOffer: "Atomic claim lock",
        whyNow: "Race conditions",
        businessModel: "SaaS",
        distributionWedge: "Community",
        founderConstraints: [],
        autonomyBoundaries: [],
        founderSetupTasks: [],
        nonGoals: [],
        firstMilestone: "Ship fix",
        openQuestions: [],
        autonomyConfidence: 90,
      }),
      JSON.stringify({
        score: 92,
        ready: true,
        blockers: [],
        strengths: ["Clear problem"],
        nextBestQuestion: null,
      }),
      now,
      now,
    );
    return sessionId;
  }

  it("two concurrent artifact claim attempts: exactly one succeeds (VAL-BE-TURN-008)", async () => {
    const { env, sqlite } = makeEnv();
    const sessionId = createReadySessionDirect(sqlite, env);

    // Track how many times generateLaunchArtifacts is called
    let artifactCallCount = 0;
    generateLaunchArtifactsMock.mockImplementation(async () => {
      artifactCallCount++;
      // Small delay to simulate real work
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        companySpecMd: "# Company Spec",
        missionMd: "# Mission",
        firstMilestoneMd: "# First Milestone",
        autonomyContractMd: "# Autonomy Contract",
      };
    });

    // Fire two concurrent GET requests — both will trigger kickoffArtifactGenerationIfNeeded
    const ctx1 = new TestExecutionContext();
    const ctx2 = new TestExecutionContext();

    const [res1, res2] = await Promise.all([
      handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
        env,
        ctx1 as any,
        sessionId,
      ),
      handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
        env,
        ctx2 as any,
        sessionId,
      ),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Flush both contexts to complete deferred artifact generation
    await ctx1.flush();
    await ctx2.flush();

    // Only ONE artifact generation should have occurred — the other should be blocked by the claim lock
    expect(artifactCallCount).toBe(1);
  });

  it("no duplicate artifact generation from concurrent requests (VAL-BE-TURN-009)", async () => {
    const { env, sqlite } = makeEnv();
    const sessionId = createReadySessionDirect(sqlite, env);

    generateLaunchArtifactsMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        companySpecMd: "# Company Spec",
        missionMd: "# Mission",
        firstMilestoneMd: "# First Milestone",
        autonomyContractMd: "# Autonomy Contract",
      };
    });

    // Fire three concurrent GET requests
    const ctx1 = new TestExecutionContext();
    const ctx2 = new TestExecutionContext();
    const ctx3 = new TestExecutionContext();

    await Promise.all([
      handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
        env,
        ctx1 as any,
        sessionId,
      ),
      handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
        env,
        ctx2 as any,
        sessionId,
      ),
      handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
        env,
        ctx3 as any,
        sessionId,
      ),
    ]);

    // Flush all
    await ctx1.flush();
    await ctx2.flush();
    await ctx3.flush();

    // Only one call to generateLaunchArtifacts
    expect(generateLaunchArtifactsMock).toHaveBeenCalledTimes(1);

    // Verify exactly one artifacts_json value in DB (not duplicated)
    const row = sqlite.prepare("SELECT artifacts_json FROM launch_sessions WHERE id = ?").get(sessionId) as any;
    expect(row.artifacts_json).toBeTruthy();
    const parsed = JSON.parse(row.artifacts_json);
    expect(parsed.companySpecMd).toBe("# Company Spec");
    // No _claim sentinel should remain
    expect(parsed._claim).toBeUndefined();
  });

  it("single artifact claim still works normally", async () => {
    const { env, sqlite } = makeEnv();
    const sessionId = createReadySessionDirect(sqlite, env);

    // Single GET request — should trigger artifact generation normally
    const ctx1 = new TestExecutionContext();
    await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
      env,
      ctx1 as any,
      sessionId,
    );

    await ctx1.flush();

    // Artifacts should be generated
    expect(generateLaunchArtifactsMock).toHaveBeenCalledTimes(1);

    const row = sqlite.prepare("SELECT artifacts_json FROM launch_sessions WHERE id = ?").get(sessionId) as any;
    expect(row.artifacts_json).toBeTruthy();
    const parsed = JSON.parse(row.artifacts_json);
    expect(parsed.companySpecMd).toBe("# Company Spec");
  });

  it("artifact claim is released on generation failure, allowing retry", async () => {
    const { env, sqlite } = makeEnv();
    const sessionId = createReadySessionDirect(sqlite, env);

    // First attempt: fail
    generateLaunchArtifactsMock.mockRejectedValueOnce(new Error("API timeout"));

    const ctx1 = new TestExecutionContext();
    await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
      env,
      ctx1 as any,
      sessionId,
    );

    // Flush — the waitUntil promise will reject, but we catch it since the error
    // is expected (artifact generation failed, but the claim should be cleared)
    await ctx1.flush().catch(() => {});

    // After failure, the claim should be released so artifacts_json is NULL (KV cleared),
    // allowing a retry. With D1-based claim, artifacts_json should be NULL.
    const rowAfterFail = sqlite.prepare("SELECT artifacts_json FROM launch_sessions WHERE id = ?").get(sessionId) as any;
    expect(rowAfterFail.artifacts_json).toBeNull();

    // Second attempt: succeed
    generateLaunchArtifactsMock.mockImplementation(async () => ({
      companySpecMd: "# Company Spec",
      missionMd: "# Mission",
      firstMilestoneMd: "# First Milestone",
      autonomyContractMd: "# Autonomy Contract",
    }));

    const ctx2 = new TestExecutionContext();
    await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
      env,
      ctx2 as any,
      sessionId,
    );

    await ctx2.flush();

    // Artifacts should be generated on retry
    const rowAfterRetry = sqlite.prepare("SELECT artifacts_json FROM launch_sessions WHERE id = ?").get(sessionId) as any;
    expect(rowAfterRetry.artifacts_json).toBeTruthy();
    const parsed = JSON.parse(rowAfterRetry.artifacts_json);
    expect(parsed.companySpecMd).toBe("# Company Spec");
  });
});
