import fs from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyClerkJwtMock,
  generateLaunchSessionTurnStreamingMock,
  generateLaunchArtifactsMock,
  createAndProvisionCompanyMock,
} = vi.hoisted(() => ({
  verifyClerkJwtMock: vi.fn(async () => "user-1"),
  generateLaunchSessionTurnStreamingMock: vi.fn(),
  generateLaunchArtifactsMock: vi.fn(async () => ({
    companySpecMd: "# Company Spec",
    missionMd: "# Mission",
    firstMilestoneMd: "# First Milestone",
    autonomyContractMd: "# Autonomy Contract",
  })),
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
    generateLaunchArtifacts: generateLaunchArtifactsMock,
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

function makeSuccessResult(message = "## Your company is ready!\n\nLet's launch.") {
  return {
    ok: true,
    result: {
      assistantMessage: message,
      suggestedCompanyName: "ArtifactGuardCo",
      brief: {
        concept: "AI testing tool for artifact claim guard.",
        targetCustomer: "developers building AI apps",
        painfulProblem: "Duplicate artifact generation from concurrent paths.",
        firstOffer: "Guarded artifact generation for launch sessions",
        whyNow: "Concurrent requests cause duplicate work.",
        businessModel: "SaaS subscription",
        distributionWedge: "Developer community adoption",
        founderConstraints: [],
        autonomyBoundaries: [],
        founderSetupTasks: [],
        nonGoals: [],
        firstMilestone: "Ship the claim guard fix",
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
        companyName: "ArtifactGuardCo",
        idea: "AI testing tool for artifact claim guard in launch path.",
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
  generateLaunchArtifactsMock.mockClear();
  createAndProvisionCompanyMock.mockReset();
});

describe("Artifact claim guard in handleLaunchFromSession", () => {
  it("handleLaunchFromSession uses tryClaimArtifactGeneration before ensureArtifacts", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    // Clear artifacts so ensureArtifacts will be called
    sqlite.prepare(
      `UPDATE launch_sessions SET artifacts_json = NULL WHERE id = ?`,
    ).run(session.id);

    createAndProvisionCompanyMock.mockResolvedValue({
      id: "company-1",
      name: "ArtifactGuardCo",
    });

    // Track artifact generation calls
    let artifactCallCount = 0;
    generateLaunchArtifactsMock.mockImplementation(async () => {
      artifactCallCount++;
      return {
        companySpecMd: "# Company Spec",
        missionMd: "# Mission",
        firstMilestoneMd: "# First Milestone",
        autonomyContractMd: "# Autonomy Contract",
      };
    });

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(201);
    // Artifacts should still be generated (claim succeeds when no existing claim)
    expect(artifactCallCount).toBe(1);
  });

  it("if claim fails (deferred generation running), waits for real artifacts instead of duplicating", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    // Clear the mock call count from session creation (streaming generates artifacts)
    generateLaunchArtifactsMock.mockClear();

    // Simulate a claim already in progress by setting the sentinel
    sqlite.prepare(
      `UPDATE launch_sessions SET artifacts_json = ? WHERE id = ?`,
    ).run('{"_claim":true}', session.id);

    createAndProvisionCompanyMock.mockResolvedValue({
      id: "company-1",
      name: "ArtifactGuardCo",
    });

    // Simulate the other generator finishing after a short delay
    // by updating the DB directly after a small delay
    const realArtifacts = JSON.stringify({
      companySpecMd: "# Company Spec",
      missionMd: "# Mission",
      firstMilestoneMd: "# First Milestone",
      autonomyContractMd: "# Autonomy Contract",
    });

    setTimeout(() => {
      sqlite.prepare(
        `UPDATE launch_sessions SET artifacts_json = ? WHERE id = ?`,
      ).run(realArtifacts, session.id);
    }, 200);

    const response = await handleLaunchFromSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
      env,
      ctx as any,
      session.id,
    );

    expect(response.status).toBe(201);
    // ensureArtifacts / generateLaunchArtifacts should NOT have been called since claim failed
    // and real artifacts appeared from the other generator
    expect(generateLaunchArtifactsMock).not.toHaveBeenCalled();
  });

  it("no duplicate artifact generation from concurrent launch + deferred stream paths", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();
    const session = await createReadySession(env, ctx);

    // Clear artifacts to force generation
    sqlite.prepare(
      `UPDATE launch_sessions SET artifacts_json = NULL WHERE id = ?`,
    ).run(session.id);

    let artifactCallCount = 0;
    generateLaunchArtifactsMock.mockImplementation(async () => {
      artifactCallCount++;
      // Simulate some work time
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        companySpecMd: "# Company Spec",
        missionMd: "# Mission",
        firstMilestoneMd: "# First Milestone",
        autonomyContractMd: "# Autonomy Contract",
      };
    });

    createAndProvisionCompanyMock.mockResolvedValue({
      id: "company-1",
      name: "ArtifactGuardCo",
    });

    // Simulate concurrent: GET request triggers deferred generation + launch request
    const ctx2 = new TestExecutionContext();
    const [getResponse, launchResponse] = await Promise.all([
      handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}`, { method: "GET" }),
        env,
        ctx2 as any,
        session.id,
      ),
      // Small delay to let GET start deferred generation first
      new Promise<Response>((resolve) =>
        setTimeout(async () => {
          const res = await handleLaunchFromSession(
            makeRequest(`https://api.aicombinator.live/api/launch-sessions/${session.id}/launch`, { method: "POST" }),
            env,
            ctx as any,
            session.id,
          );
          resolve(res);
        }, 10),
      ),
    ]);

    // Flush deferred generation
    await ctx2.flush();

    expect(getResponse.status).toBe(200);
    // Launch should succeed (either by generating artifacts itself or waiting for deferred)
    expect(launchResponse.status).toBe(201);

    // CRITICAL: artifacts should have been generated at most once
    // (either by the GET's deferred path or by the launch path, not both)
    expect(artifactCallCount).toBe(1);
  });

  it("all ensureArtifacts call sites are guarded", async () => {
    // This is a static analysis test — verify via source inspection
    // that every call to ensureArtifacts is preceded by tryClaimArtifactGeneration
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      "/Users/CEF/Projects/automaton/worker/src/routes/launch-sessions.ts",
      "utf8",
    );

    // Find all ensureArtifacts call sites (not the function definition)
    const lines = source.split("\n");
    const callSites: number[] = [];
    const definitionPattern = /^async function ensureArtifacts/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes("ensureArtifacts(") && !definitionPattern.test(line)) {
        callSites.push(i + 1); // 1-indexed line number
      }
    }

    // Every call site should be within a block that checks tryClaimArtifactGeneration
    // or has hasRealArtifacts check nearby (within 20 lines above)
    for (const lineNum of callSites) {
      const contextStart = Math.max(0, lineNum - 21);
      const contextLines = lines.slice(contextStart, lineNum);
      const context = contextLines.join("\n");
      const hasClaim = context.includes("tryClaimArtifactGeneration");
      // The ensureArtifacts function definition itself checks hasRealArtifacts,
      // but external call sites should have claim guards
      expect(hasClaim).toBe(true);
    }
  });
});
