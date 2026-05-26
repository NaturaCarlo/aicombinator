import fs from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyClerkJwtMock,
  generateLaunchSessionTurnStreamingMock,
} = vi.hoisted(() => ({
  verifyClerkJwtMock: vi.fn(async () => "user-1"),
  generateLaunchSessionTurnStreamingMock: vi.fn(),
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

import {
  handleCreateLaunchSession,
  handleGetLaunchSession,
  handleStreamLaunchSession,
} from "../../worker/src/routes/launch-sessions.ts";

// ─── Test infrastructure ───────────────────────────────────────────────────

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
  readonly tasks: Promise<unknown>[] = [];

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

function makeSuccessResult(message = "## Great idea\n\nLet's build this.") {
  return {
    ok: true,
    result: {
      assistantMessage: message,
      suggestedCompanyName: "TestCo",
      brief: {
        concept: "AI testing platform",
        targetCustomer: "developers",
        painfulProblem: "Manual testing is slow.",
        firstOffer: "Automated test generation",
        whyNow: "AI models are good enough now.",
        businessModel: "SaaS subscription",
        distributionWedge: "Developer community outreach",
        founderConstraints: [],
        autonomyBoundaries: [],
        founderSetupTasks: [],
        nonGoals: [],
        firstMilestone: "Launch MVP and get first 10 users",
        openQuestions: [],
        autonomyConfidence: 80,
      },
      readiness: {
        score: 82,
        ready: false,
        blockers: ["Need pricing validation"],
        strengths: ["Clear market"],
        nextBestQuestion: null,
      },
      options: [
        {
          title: "Focus on pricing",
          description: "Define pricing tiers",
          founderReply: "Let's focus on pricing.",
        },
      ],
    },
    attempts: [
      {
        provider: "anthropic",
        model: "claude-opus-4-6",
        outcome: "success",
        durationMs: 500,
        statusCode: 200,
        error: null,
        promptChars: 1200,
        transcriptMessages: 1,
      },
    ],
  };
}

function makeStreamingGenerator(result: ReturnType<typeof makeSuccessResult>, tokenChunks?: string[]) {
  const chunks = tokenChunks ??
    (result.ok && result.result
      ? [result.result.assistantMessage]
      : []);
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
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice("data: ".length).trim();
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
});

// ─── VAL-BE-TURN-010: Pending turns not prematurely marked as error ────────

describe("VAL-BE-TURN-010: Pending turns not prematurely marked as error", () => {
  it("a pending turn older than ABANDONED_PROCESSING_MS remains pending after repair", async () => {
    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session (which creates a pending turn)
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "PendingRepairTest",
          idea: "AI assistant to verify pending turns are not erroneously marked as error by repair logic.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Set the pending turn's updated_at to well beyond ABANDONED_PROCESSING_MS (e.g. 5 min ago)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    sqlite.prepare(
      `UPDATE launch_session_turns SET updated_at = ? WHERE session_id = ?`,
    ).run(fiveMinAgo, sessionId);

    // Verify turn is pending before repair
    const turnBefore = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnBefore.status).toBe("pending");

    // Trigger repair by calling GET endpoint (loadSessionConversation runs repairAbandonedProcessingTurns)
    const getResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    expect(getResponse.status).toBe(200);
    await ctx.flush();

    // Verify the turn is still 'pending' — NOT 'error'
    const turnAfter = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnAfter.status).toBe("pending");
  });

  it("a pending turn older than ABANDONED_PROCESSING_MS can still be picked up by SSE", async () => {
    const result = makeSuccessResult("## Picked up after delay\n\nThis pending turn was processed.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result, ["## Picked up after delay\n\n", "This pending turn was processed."])(),
    );

    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "OldPendingPickup",
          idea: "AI assistant to verify that old pending turns can still be picked up by SSE endpoint.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Set the pending turn's updated_at to well beyond ABANDONED_PROCESSING_MS
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    sqlite.prepare(
      `UPDATE launch_session_turns SET updated_at = ? WHERE session_id = ?`,
    ).run(fiveMinAgo, sessionId);

    // SSE endpoint should still pick up the pending turn and process it
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    const events = await parseSseEvents(streamResponse);
    await ctx.flush();

    // Should have token events (turn was claimed and processed)
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);

    // Should have a done event
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // Turn should now be complete
    const turnAfter = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnAfter.status).toBe("complete");
  });
});

// ─── VAL-BE-TURN-011: Stale processing turns correctly marked as error ─────

describe("VAL-BE-TURN-011: Stale processing turns correctly marked as error", () => {
  it("a processing turn older than ABANDONED_PROCESSING_MS is repaired (re-queued to pending)", async () => {
    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "StaleProcessingRepair",
          idea: "AI assistant to verify stale processing turns are correctly repaired.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Set the turn to 'processing' with updated_at well beyond ABANDONED_PROCESSING_MS
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    sqlite.prepare(
      `UPDATE launch_session_turns SET status = 'processing', started_at = ?, updated_at = ? WHERE session_id = ?`,
    ).run(fiveMinAgo, fiveMinAgo, sessionId);

    // Verify turn is processing before repair
    const turnBefore = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnBefore.status).toBe("processing");

    // Trigger repair by calling GET endpoint
    const getResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    expect(getResponse.status).toBe(200);
    await ctx.flush();

    // Verify the turn was repaired — re-queued to 'pending' (not marked as error)
    const turnAfter = sqlite.prepare(
      `SELECT status, last_error FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnAfter.status).toBe("pending");
    expect(turnAfter.last_error).toContain("stalled");
  });

  it("a recently-processing turn is NOT repaired (within ABANDONED_PROCESSING_MS)", async () => {
    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RecentProcessing",
          idea: "AI assistant to verify recently-processing turns are left alone by repair.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Set the turn to 'processing' with updated_at = 30s ago (well within ABANDONED_PROCESSING_MS)
    const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
    sqlite.prepare(
      `UPDATE launch_session_turns SET status = 'processing', started_at = ?, updated_at = ? WHERE session_id = ?`,
    ).run(thirtySecsAgo, thirtySecsAgo, sessionId);

    // Trigger repair by calling GET endpoint
    const getResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    expect(getResponse.status).toBe(200);
    await ctx.flush();

    // Turn should still be 'processing' (not repaired — it's recent)
    const turnAfter = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnAfter.status).toBe("processing");
  });
});

// ─── Source code verification: no 'pending' → 'error' transition in repair ─

describe("Source code: repairAbandonedProcessingTurns does not mark pending as error", () => {
  it("function does not filter for pending turns to mark as error", () => {
    const source = fs.readFileSync(
      "/Users/CEF/Projects/automaton/worker/src/routes/launch-sessions.ts",
      "utf8",
    );

    // Extract the function body
    const funcStart = source.indexOf("async function repairAbandonedProcessingTurns(");
    expect(funcStart).toBeGreaterThan(-1);

    // Find the end of the function (next async function or export)
    const funcBody = source.slice(funcStart, funcStart + 2000);

    // Should NOT contain logic that marks pending turns as error
    expect(funcBody).not.toMatch(/status\s*!==\s*['"]pending['"]/);
    expect(funcBody).not.toMatch(/abandonedPending/);

    // Should still handle processing turns
    expect(funcBody).toMatch(/status\s*!==\s*['"]processing['"]/);
  });
});
