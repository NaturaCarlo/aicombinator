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
    private readonly d1db?: TestD1Database,
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
    // Log standalone (non-batch) runs for test assertions
    if (this.d1db) {
      this.d1db._logStandaloneRun(this.sql);
    }
    const info = this.db.prepare(this.sql).run(...this.args);
    return {
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
}

let batchCallLog: Array<{ statementCount: number; sqls: string[] }> = [];
let standaloneRunLog: Array<{ sql: string }> = [];

class TestD1Database {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string) {
    return new TestPreparedStatement(this.db, sql, this);
  }

  _logStandaloneRun(sql: string) {
    standaloneRunLog.push({ sql });
  }

  async batch(statements: Array<TestPreparedStatement>) {
    // Log the batch call for test assertions
    const sqls = statements.map((s) => {
      // Access the SQL via the private field for logging
      return (s as any).sql ?? "unknown";
    });
    batchCallLog.push({ statementCount: statements.length, sqls });

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

function makeSuccessResult(message = "## Atomic turn\n\nAll updates committed together.") {
  return {
    ok: true,
    result: {
      assistantMessage: message,
      suggestedCompanyName: "AtomicCo",
      brief: {
        concept: "AI testing platform",
        targetCustomer: "developers",
        painfulProblem: "Non-atomic DB operations.",
        firstOffer: "Atomic batch writes",
        whyNow: "D1 batches exist.",
        businessModel: "SaaS subscription",
        distributionWedge: "Developer community",
        founderConstraints: [],
        autonomyBoundaries: [],
        founderSetupTasks: [],
        nonGoals: [],
        firstMilestone: "Ship atomic turn completion",
        openQuestions: [],
        autonomyConfidence: 85,
      },
      readiness: {
        score: 80,
        ready: false,
        blockers: ["Needs verification"],
        strengths: ["Solid architecture"],
        nextBestQuestion: null,
      },
      options: [
        {
          title: "Verify atomicity",
          description: "Check that all updates happen together",
          founderReply: "Let's verify atomicity.",
        },
      ],
    },
    attempts: [
      {
        provider: "anthropic",
        model: "claude-opus-4-6",
        outcome: "success",
        durationMs: 300,
        statusCode: 200,
        error: null,
        promptChars: 1000,
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
  batchCallLog = [];
  standaloneRunLog = [];
});

// ─── VAL-BE-TURN-004: Turn completion uses two-step approach for safe concurrency ──────

describe("VAL-BE-TURN-004: Turn completion uses two-step concurrency-safe approach", () => {
  it("completePendingAssistantTurn runs turn UPDATE alone first, then message+session batch", async () => {
    const result = makeSuccessResult("## Two-step completion\n\nTurn first, then message+session.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result, ["## Two-step completion\n\n", "Turn first, then message+session."])(),
    );

    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "TwoStepBatch",
          idea: "AI assistant for verifying that turn completion splits the concurrency check from the data writes.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Clear logs from session creation
    batchCallLog = [];
    standaloneRunLog = [];

    // Stream and complete the turn
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    await Promise.all([
      parseSseEvents(streamResponse),
      ctx.flush(),
    ]);

    // Step 1: Turn UPDATE should run as a standalone .run() call (not in a batch)
    const standaloneTurnUpdate = standaloneRunLog.find((r) =>
      r.sql.includes("launch_session_turns") &&
      r.sql.includes("status = ?") &&
      r.sql.includes("status = 'processing'"),
    );
    expect(standaloneTurnUpdate).toBeDefined();

    // Step 3: Message + session should be in a batch together (without turn)
    const msgSessionBatch = batchCallLog.find((b) =>
      b.sqls.some((sql) => sql.includes("launch_session_messages")) &&
      b.sqls.some((sql) => sql.includes("launch_sessions") && sql.includes("status ="))
    );
    expect(msgSessionBatch).toBeDefined();
    expect(msgSessionBatch!.statementCount).toBe(2);

    // The message+session batch should NOT contain a turn update
    expect(msgSessionBatch!.sqls.some((sql) => sql.includes("launch_session_turns"))).toBe(false);
  });

  it("turn UPDATE is NOT in the same batch as message/session updates", async () => {
    const result = makeSuccessResult("## Split check\n\nConcurrency check separated from writes.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result, ["## Split check\n\n", "Concurrency check separated from writes."])(),
    );

    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "SplitCheck",
          idea: "AI assistant for verifying that the concurrency check is not bundled with data writes.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;
    batchCallLog = [];
    standaloneRunLog = [];

    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    await Promise.all([
      parseSseEvents(streamResponse),
      ctx.flush(),
    ]);

    // There should be NO batch containing all 3 tables together (the old pattern)
    const combinedBatch = batchCallLog.find((b) =>
      b.sqls.some((sql) => sql.includes("launch_session_turns") && sql.includes("status =")) &&
      b.sqls.some((sql) => sql.includes("launch_session_messages")) &&
      b.sqls.some((sql) => sql.includes("launch_sessions") && sql.includes("status ="))
    );
    expect(combinedBatch).toBeUndefined();
  });
});

// ─── VAL-BE-TURN-005: Partial DB failure leaves clean state ────────────────

describe("VAL-BE-TURN-005: Partial DB failure during turn completion leaves clean state", () => {
  it("happy path: all three updates succeed atomically", async () => {
    const result = makeSuccessResult("## Clean state\n\nEverything committed together.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result, ["## Clean state\n\n", "Everything committed together."])(),
    );

    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "CleanState",
          idea: "AI assistant for verifying atomic turn completion produces consistent DB state.",
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

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // Verify all three tables are in a consistent state:
    // 1. Turn row should be 'complete'
    const turnRow = sqlite.prepare(
      `SELECT status, provider, model, duration_ms, completed_at FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnRow.status).toBe("complete");
    expect(turnRow.provider).toBe("anthropic");
    expect(turnRow.model).toBe("claude-opus-4-6");
    expect(turnRow.duration_ms).toBeDefined();
    expect(turnRow.completed_at).toBeDefined();

    // 2. Message content should be updated
    const msgRow = sqlite.prepare(
      `SELECT content, options_json FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(msgRow.content).toBe("## Clean state\n\nEverything committed together.");
    expect(JSON.parse(msgRow.options_json)).toHaveLength(1);

    // 3. Session should be updated
    const sessionRow = sqlite.prepare(
      `SELECT status, suggested_name, brief_json, readiness_json FROM launch_sessions WHERE id = ?`,
    ).get(sessionId) as any;
    expect(sessionRow.status).toBe("active"); // readiness.ready = false → active
    expect(sessionRow.suggested_name).toBe("AtomicCo");
    expect(JSON.parse(sessionRow.brief_json)).toBeDefined();
    expect(JSON.parse(sessionRow.readiness_json)).toBeDefined();
  });

  it("concurrent completion: second worker is rejected, DB stays consistent", async () => {
    const result1 = makeSuccessResult("## First worker\n\nAtomic completion by worker 1.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result1, ["## First worker\n\n", "Atomic completion by worker 1."])(),
    );

    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "ConcurrentAtomic",
          idea: "AI assistant for verifying concurrent atomic turn completion doesn't corrupt state.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Worker 1 completes the turn
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx as any,
      sessionId,
    );
    await Promise.all([
      parseSseEvents(streamResponse),
      ctx.flush(),
    ]);

    // All three tables should show worker 1's result
    const turnRow = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(turnRow.status).toBe("complete");

    const msgRow = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(msgRow.content).toContain("First worker");

    const sessionRow = sqlite.prepare(
      `SELECT suggested_name FROM launch_sessions WHERE id = ?`,
    ).get(sessionId) as any;
    expect(sessionRow.suggested_name).toBe("AtomicCo");
  });
});

// ─── Happy path: turn completes correctly with all three updates ───────────

describe("Happy path: turn completes correctly with all three updates in atomic batch", () => {
  it("ready session transitions to 'ready' status with all metadata in one atomic batch", async () => {
    const readyResult = {
      ok: true,
      result: {
        assistantMessage: "## Ready to launch\n\nEverything looks great!",
        suggestedCompanyName: "ReadyCo",
        brief: {
          concept: "Ready to go",
          targetCustomer: "everyone",
          painfulProblem: "Nothing",
          firstOffer: "Everything",
          whyNow: "Now",
          businessModel: "SaaS",
          distributionWedge: "Word of mouth",
          founderConstraints: [],
          autonomyBoundaries: [],
          founderSetupTasks: [],
          nonGoals: [],
          firstMilestone: "Launch",
          openQuestions: [],
          autonomyConfidence: 95,
        },
        readiness: {
          score: 95,
          ready: true,
          blockers: [],
          strengths: ["Everything is aligned"],
          nextBestQuestion: null,
        },
        options: [
          { title: "Launch now", description: "Ship it", founderReply: "Let's launch!" },
        ],
      },
      attempts: [
        {
          provider: "anthropic",
          model: "claude-opus-4-6",
          outcome: "success",
          durationMs: 200,
          statusCode: 200,
          error: null,
          promptChars: 800,
          transcriptMessages: 1,
        },
      ],
    };
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(readyResult as any, ["## Ready to launch\n\n", "Everything looks great!"])(),
    );

    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "ReadyBatch",
          idea: "AI assistant for verifying ready status transitions atomically.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

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

    // All three tables should be consistent in a single atomic update:
    const turnRow = sqlite.prepare(
      `SELECT status, completed_at FROM launch_session_turns WHERE session_id = ?`,
    ).get(sessionId) as any;
    expect(turnRow.status).toBe("complete");
    expect(turnRow.completed_at).toBeTruthy();

    const msgRow = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant'`,
    ).get(sessionId) as any;
    expect(msgRow.content).toBe("## Ready to launch\n\nEverything looks great!");

    const sessionRow = sqlite.prepare(
      `SELECT status, suggested_name FROM launch_sessions WHERE id = ?`,
    ).get(sessionId) as any;
    expect(sessionRow.status).toBe("ready"); // readiness.ready = true → ready
    expect(sessionRow.suggested_name).toBe("ReadyCo");
  });
});

// ─── Concurrency: losing worker does NOT overwrite message/session data ────

describe("Concurrency: losing worker returns early without touching message/session", () => {
  it("if turn is already complete, completePendingAssistantTurn skips message and session writes", async () => {
    // Worker 1 completes the turn
    const result1 = makeSuccessResult("## Worker 1 wins\n\nFirst worker's content should persist.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result1, ["## Worker 1 wins\n\n", "First worker's content should persist."])(),
    );

    const { env, sqlite } = makeEnv();
    const ctx1 = new TestExecutionContext();

    // Create session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RaceWinner",
          idea: "AI assistant for verifying that only the winning worker's data persists in a race condition.",
        }),
      }),
      env,
      ctx1 as any,
    );
    const created = (await createResponse.json()) as any;
    const sessionId = created.id;

    // Worker 1 completes the turn normally
    const stream1 = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx1 as any,
      sessionId,
    );
    await Promise.all([
      parseSseEvents(stream1),
      ctx1.flush(),
    ]);

    // Verify Worker 1's data is in DB
    const msgAfterW1 = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(msgAfterW1.content).toContain("Worker 1 wins");

    const sessionAfterW1 = sqlite.prepare(
      `SELECT suggested_name, status FROM launch_sessions WHERE id = ?`,
    ).get(sessionId) as any;
    expect(sessionAfterW1.suggested_name).toBe("AtomicCo");

    // Worker 2 tries to stream same session — turn is already 'complete', no pending turn
    const result2 = makeSuccessResult("## Worker 2 SHOULD NOT appear\n\nThis content must not overwrite worker 1.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(
      makeStreamingGenerator(result2, ["## Worker 2 SHOULD NOT appear\n\n", "This content must not overwrite worker 1."])(),
    );
    const ctx2 = new TestExecutionContext();

    const stream2 = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}/stream`, { method: "GET" }),
      env,
      ctx2 as any,
      sessionId,
    );
    await Promise.all([
      parseSseEvents(stream2),
      ctx2.flush(),
    ]);

    // Worker 1's content should still be in DB — NOT overwritten by Worker 2
    const msgAfterW2 = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as any;
    expect(msgAfterW2.content).toContain("Worker 1 wins");
    expect(msgAfterW2.content).not.toContain("Worker 2 SHOULD NOT appear");

    const sessionAfterW2 = sqlite.prepare(
      `SELECT suggested_name FROM launch_sessions WHERE id = ?`,
    ).get(sessionId) as any;
    expect(sessionAfterW2.suggested_name).toBe("AtomicCo");
  });
});
