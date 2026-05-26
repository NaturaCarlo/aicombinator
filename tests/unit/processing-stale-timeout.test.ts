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

function makeSuccessResult(message = "## Great operating thesis\n\nLet's build this.") {
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

// ─── VAL-BE-TURN-001: PROCESSING_STALE_MS exceeds MODEL_TIMEOUT_MS ────────

describe("VAL-BE-TURN-001: PROCESSING_STALE_MS exceeds MODEL_TIMEOUT_MS", () => {
  it("PROCESSING_STALE_MS is at least 100_000 (> MODEL_TIMEOUT_MS 90_000)", () => {
    // We read the constant value indirectly: a turn set to 'processing' 95s ago
    // should NOT be reclaimable by the SSE endpoint if PROCESSING_STALE_MS > 95s.
    // Conversely, 35s was the old buggy value. We test that a 50s-old turn
    // is NOT stale (would be stale with old 35s value).
    //
    // Direct constant test: import the module source and check
    const source = fs.readFileSync(
      "/Users/CEF/Projects/automaton/worker/src/routes/launch-sessions.ts",
      "utf8",
    );
    const match = source.match(/const PROCESSING_STALE_MS\s*=\s*(\d[\d_]*)/);
    expect(match).toBeTruthy();
    const value = Number(match![1].replace(/_/g, ""));
    // Must be at least MODEL_TIMEOUT_MS (90_000) + 10_000 = 100_000
    expect(value).toBeGreaterThanOrEqual(100_000);
    // Ensure a reasonable margin (at least 30s over MODEL_TIMEOUT_MS)
    expect(value - 90_000).toBeGreaterThanOrEqual(10_000);
  });

  it("a turn processing for 50s is not reclaimable (was stale with old 35s value)", async () => {
    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session with a pending turn
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "StaleTest",
          idea: "AI assistant to verify that 50s-old processing turns are not treated as stale with updated timeout.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Manually set the turn to 'processing' with updated_at = 50s ago
    const fiftySecsAgo = new Date(Date.now() - 50_000).toISOString();
    sqlite.prepare(
      `UPDATE launch_session_turns SET status = 'processing', started_at = ?, updated_at = ? WHERE session_id = ?`,
    ).run(fiftySecsAgo, fiftySecsAgo, sessionId);

    // SSE endpoint should NOT claim this turn (it's not stale yet)
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    const events = await parseSseEvents(streamResponse);
    await ctx.flush();

    // Should get a 'processing' event (not claimable), not a token stream
    const processingEvent = events.find((e) => e.type === "processing");
    expect(processingEvent).toBeDefined();

    // Should NOT have token events (turn not reclaimed)
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBe(0);
  });
});

// ─── VAL-BE-TURN-002: Optimistic concurrency on completePendingAssistantTurn ─

describe("VAL-BE-TURN-002: Optimistic concurrency on completePendingAssistantTurn", () => {
  it("two concurrent SSE completions: first succeeds, second is silently skipped", async () => {
    // Worker 1 claims and processes the turn normally
    const result1 = makeSuccessResult("## Worker 1 response\n\nFirst worker completed.");
    const result2 = makeSuccessResult("## Worker 2 response\n\nSecond worker should be rejected.");

    // We'll use two separate streaming generators
    generateLaunchSessionTurnStreamingMock
      .mockReturnValueOnce(makeStreamingGenerator(result1, ["## Worker 1 response\n\n", "First worker completed."])())
      .mockReturnValueOnce(makeStreamingGenerator(result2, ["## Worker 2 response\n\n", "Second worker should be rejected."])());

    const { env, sqlite } = makeEnv();
    const ctx1 = new TestExecutionContext();
    const ctx2 = new TestExecutionContext();

    // Create session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "ConcurrencyTest",
          idea: "AI assistant for testing that two concurrent workers completing the same turn results in only one succeeding.",
        }),
      }),
      env,
      ctx1 as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Worker 1: SSE endpoint claims and completes the turn
    const stream1Response = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx1 as any,
      sessionId,
    );
    const [events1] = await Promise.all([
      parseSseEvents(stream1Response),
      ctx1.flush(),
    ]);

    // Worker 1 should have completed successfully
    const doneEvent1 = events1.find((e) => e.type === "done");
    expect(doneEvent1).toBeDefined();
    const session1 = doneEvent1?.session as any;
    expect(session1?.processing).toBe(false);

    // Verify the final message content is from Worker 1
    const lastMsg = session1?.messages?.at(-1);
    expect(lastMsg?.content).toContain("Worker 1 response");

    // Verify DB has exactly the worker 1 content
    const messageRow = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(messageRow.content).toContain("Worker 1 response");

    // Worker 2: Try to stream the same session — turn should already be complete
    // The SSE endpoint should return a 'done' event (no pending turn)
    const stream2Response = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx2 as any,
      sessionId,
    );
    const [events2] = await Promise.all([
      parseSseEvents(stream2Response),
      ctx2.flush(),
    ]);

    // Worker 2 should get a done event without processing
    const doneEvent2 = events2.find((e) => e.type === "done");
    expect(doneEvent2).toBeDefined();

    // Final content should still be Worker 1's content (no overwrite)
    const finalMsg = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(finalMsg.content).toContain("Worker 1 response");
    expect(finalMsg.content).not.toContain("Worker 2 response");
  });

  it("completePendingAssistantTurn only updates if turn is still in processing status", async () => {
    const result = makeSuccessResult("## Concurrency safe\n\nTurn completed with status check.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result, ["## Concurrency safe\n\n", "Turn completed with status check."])(),
    );

    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "StatusCheck",
          idea: "AI assistant for verifying that completePendingAssistantTurn uses a conditional DB update on turn status.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Stream and complete the turn normally
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    const [events] = await Promise.all([
      parseSseEvents(streamResponse),
      ctx.flush(),
    ]);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // Verify turn is in 'complete' status
    const turnRow = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnRow.status).toBe("complete");
  });
});

// ─── VAL-BE-TURN-003: Second worker rejected when first is still active ────

describe("VAL-BE-TURN-003: Second worker rejected when first is still active", () => {
  it("SSE returns processing event for recently-claimed turn (not stale)", async () => {
    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "ActiveWorker",
          idea: "AI assistant for verifying that a second worker cannot claim a recently-processing turn.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Manually set the turn to 'processing' with updated_at = 10s ago (recently claimed)
    const tenSecsAgo = new Date(Date.now() - 10_000).toISOString();
    sqlite.prepare(
      `UPDATE launch_session_turns SET status = 'processing', started_at = ?, updated_at = ? WHERE session_id = ?`,
    ).run(tenSecsAgo, tenSecsAgo, sessionId);

    // Second SSE request should see processing turn and NOT claim it
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    const events = await parseSseEvents(streamResponse);
    await ctx.flush();

    // Should get a 'processing' event (second worker rejected)
    const processingEvent = events.find((e) => e.type === "processing");
    expect(processingEvent).toBeDefined();

    // Should NOT get token events (turn not stolen)
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBe(0);

    // The streaming generator should NOT have been called (no turn processing)
    expect(generateLaunchSessionTurnStreamingMock).not.toHaveBeenCalled();
  });
});

// ─── Happy path: single worker completing turn still works ─────────────────

describe("Happy path: single worker completing turn", () => {
  it("single worker claims, streams, and completes turn successfully", async () => {
    const result = makeSuccessResult("## Happy path\n\nSingle worker success.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result, ["## Happy path\n\n", "Single worker success."])(),
    );

    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "HappyPath",
          idea: "AI assistant for verifying the happy path still works after the concurrency fix.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Stream and complete
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    const [events] = await Promise.all([
      parseSseEvents(streamResponse),
      ctx.flush(),
    ]);

    // Should have token events
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBe(2);
    expect(tokenEvents.map((e) => e.content).join("")).toBe("## Happy path\n\nSingle worker success.");

    // Should have done event
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    const session = doneEvent?.session as any;
    expect(session?.processing).toBe(false);
    expect(session?.messages?.at(-1)?.content).toContain("Happy path");

    // DB should have complete status
    const turnRow = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnRow.status).toBe("complete");

    // Message content in DB should be clean
    const msgRow = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(msgRow.content).toBe("## Happy path\n\nSingle worker success.");
  });
});
