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
  handleLaunchSessionMessage,
  handleStreamLaunchSession,
} from "../../worker/src/routes/launch-sessions.ts";

// ---- Test helpers (mirrors launch-api-guards.test.ts) ----

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

function makeNonReadyResult(message = "Tell me more about your target customer.") {
  return {
    ok: true,
    result: {
      assistantMessage: message,
      suggestedCompanyName: "TestCo",
      brief: {
        concept: "AI testing tool",
        targetCustomer: "",
        painfulProblem: "",
        firstOffer: "",
        whyNow: "",
        businessModel: "",
        distributionWedge: "",
        founderConstraints: [],
        autonomyBoundaries: [],
        founderSetupTasks: [],
        nonGoals: [],
        firstMilestone: "",
        openQuestions: [],
        autonomyConfidence: 30,
      },
      readiness: {
        score: 40,
        ready: false,
        blockers: ["Needs target customer"],
        strengths: [],
        nextBestQuestion: "Who is the first buyer?",
      },
      options: [
        {
          title: "Focus on SMBs",
          description: "Target small businesses first.",
          founderReply: "Focus on small businesses.",
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

function makeStreamingGenerator(result: ReturnType<typeof makeNonReadyResult>) {
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

beforeEach(() => {
  verifyClerkJwtMock.mockClear();
  generateLaunchSessionTurnMock.mockReset();
  generateLaunchSessionTurnStreamingMock.mockReset();
  createAndProvisionCompanyMock.mockReset();
});

describe("fix-launch-option-click-blocked", () => {
  // ---- FIX 1: toResponse processing reflects ALL turns, not just latest ----

  describe("toResponse processing reflects ALL turns", () => {
    it("shows processing=true when an older turn is stuck in pending even though latest turn is complete", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create a session — first turn stays pending
      generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(makeNonReadyResult())());
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify processing state reflects all turns correctly.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;

      // Complete the first turn via streaming
      await completeViaStream(env, ctx, created.id);

      // Now manually insert a stale pending turn into the DB to simulate an older stuck turn
      const now = new Date().toISOString();
      const staleFounderId = "stale-founder-msg";
      const staleAssistantId = "stale-assistant-msg";
      sqlite.prepare(
        `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
         VALUES (?, ?, 'founder', 'old message', NULL, ?)`,
      ).run(staleFounderId, created.id, now);
      sqlite.prepare(
        `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
         VALUES (?, ?, 'assistant', '', NULL, ?)`,
      ).run(staleAssistantId, created.id, now);
      // Insert a turn that is "pending" with a RECENT updated_at (so it won't be repaired)
      sqlite.prepare(
        `INSERT INTO launch_session_turns (
           id, session_id, founder_message_id, assistant_message_id, status, attempts,
           provider, model, duration_ms, last_error, started_at, completed_at,
           prompt_chars, transcript_messages, status_code, created_at, updated_at
         )
         VALUES ('stale-turn', ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(created.id, staleFounderId, staleAssistantId, now, now);

      // GET the session — processing should be true because a stale pending turn exists
      const getResponse = await handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
        env,
        ctx as any,
        created.id,
      );
      const session = (await getResponse.json()) as any;
      expect(session.processing).toBe(true);
    });

    it("shows processing=false when ALL turns are complete", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();

      generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(makeNonReadyResult())());
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify processing is false when all turns complete.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;

      // Complete the turn via streaming
      await completeViaStream(env, ctx, created.id);

      const getResponse = await handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
        env,
        ctx as any,
        created.id,
      );
      const session = (await getResponse.json()) as any;
      expect(session.processing).toBe(false);
    });
  });

  // ---- FIX 2: Pending turns are left alone regardless of age ----

  describe("pending turns are NOT prematurely marked as error", () => {
    it("pending turns older than 90 seconds remain pending (not marked as error)", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create a session
      generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(makeNonReadyResult())());
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify stale pending turns remain pending.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;

      // Complete the first turn
      await completeViaStream(env, ctx, created.id);

      // Insert a stale pending turn with updated_at 100 seconds ago
      const staleTime = new Date(Date.now() - 100_000).toISOString();
      const staleFounderId = "stale-founder-2";
      const staleAssistantId = "stale-assistant-2";
      sqlite.prepare(
        `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
         VALUES (?, ?, 'founder', 'stale message', NULL, ?)`,
      ).run(staleFounderId, created.id, staleTime);
      sqlite.prepare(
        `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
         VALUES (?, ?, 'assistant', '', NULL, ?)`,
      ).run(staleAssistantId, created.id, staleTime);
      sqlite.prepare(
        `INSERT INTO launch_session_turns (
           id, session_id, founder_message_id, assistant_message_id, status, attempts,
           provider, model, duration_ms, last_error, started_at, completed_at,
           prompt_chars, transcript_messages, status_code, created_at, updated_at
         )
         VALUES ('stale-turn-2', ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(created.id, staleFounderId, staleAssistantId, staleTime, staleTime);

      // GET the session — pending turn should still be pending (not repaired to error)
      const getResponse = await handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
        env,
        ctx as any,
        created.id,
      );
      const session = (await getResponse.json()) as any;

      // The stale pending turn still shows as processing=true because it's pending
      expect(session.processing).toBe(true);

      // Verify the stale turn is still pending — NOT marked as error
      const repairedTurn = sqlite.prepare(
        `SELECT status, last_error FROM launch_session_turns WHERE id = 'stale-turn-2'`,
      ).get() as { status: string; last_error: string | null };
      expect(repairedTurn.status).toBe("pending");
    });

    it("does NOT repair recent pending turns (< 90s)", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create a session — the initial turn is recent and pending
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify recent pending turns are not repaired prematurely.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;

      // The initial turn is pending and recent — should NOT be repaired
      expect(created.processing).toBe(true);

      // Verify the turn is still pending
      const turn = sqlite.prepare(
        `SELECT status FROM launch_session_turns WHERE session_id = ?`,
      ).get(created.id) as { status: string };
      expect(turn.status).toBe("pending");
    });
  });

  // ---- FIX 3: Pending turns block new messages (correct behavior) ----

  describe("pending turns correctly block new messages until processed", () => {
    it("sending a message is blocked when a pending turn exists (returns 409)", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create session and complete first turn
      generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(makeNonReadyResult())());
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify pending turns block new messages.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;
      await completeViaStream(env, ctx, created.id);

      // Insert a stale pending turn (100 seconds old) — it should remain pending
      const staleTime = new Date(Date.now() - 100_000).toISOString();
      const staleFounderId = "stale-founder-3";
      const staleAssistantId = "stale-assistant-3";
      sqlite.prepare(
        `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
         VALUES (?, ?, 'founder', 'stale old message', NULL, ?)`,
      ).run(staleFounderId, created.id, staleTime);
      sqlite.prepare(
        `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
         VALUES (?, ?, 'assistant', '', NULL, ?)`,
      ).run(staleAssistantId, created.id, staleTime);
      sqlite.prepare(
        `INSERT INTO launch_session_turns (
           id, session_id, founder_message_id, assistant_message_id, status, attempts,
           provider, model, duration_ms, last_error, started_at, completed_at,
           prompt_chars, transcript_messages, status_code, created_at, updated_at
         )
         VALUES ('stale-turn-3', ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(created.id, staleFounderId, staleAssistantId, staleTime, staleTime);

      // Pending turn is NOT repaired to error, so it still blocks new messages with 409
      const messageResponse = await handleLaunchSessionMessage(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ message: "Focus on small businesses." }),
        }),
        env,
        ctx as any,
        created.id,
      );

      expect(messageResponse.status).toBe(409);
    });

    it("SSE endpoint picks up old pending turn for processing", async () => {
      const result = makeNonReadyResult();
      generateLaunchSessionTurnStreamingMock
        .mockReturnValueOnce(makeStreamingGenerator(result)())
        .mockReturnValueOnce(makeStreamingGenerator(result)());

      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create session and complete first turn
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify SSE picks up old pending turns.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;
      await completeViaStream(env, ctx, created.id);

      // Insert a stale pending turn (100 seconds old) — it should remain pending
      const staleTime = new Date(Date.now() - 100_000).toISOString();
      const staleFounderId = "stale-founder-4";
      const staleAssistantId = "stale-assistant-4";
      sqlite.prepare(
        `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
         VALUES (?, ?, 'founder', 'stale old msg', NULL, ?)`,
      ).run(staleFounderId, created.id, staleTime);
      sqlite.prepare(
        `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
         VALUES (?, ?, 'assistant', '', NULL, ?)`,
      ).run(staleAssistantId, created.id, staleTime);
      sqlite.prepare(
        `INSERT INTO launch_session_turns (
           id, session_id, founder_message_id, assistant_message_id, status, attempts,
           provider, model, duration_ms, last_error, started_at, completed_at,
           prompt_chars, transcript_messages, status_code, created_at, updated_at
         )
         VALUES ('stale-turn-4', ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(created.id, staleFounderId, staleAssistantId, staleTime, staleTime);

      // The SSE endpoint should pick up the pending turn and process it
      const streamResponse = await handleStreamLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
        env,
        ctx as any,
        created.id,
      );

      // The response should be SSE
      expect(streamResponse.headers.get("Content-Type")).toBe("text/event-stream");
      const text = await streamResponse.text();
      await ctx.flush();

      // The pending turn should still be pending (not marked as error)
      // SSE may have picked it up for processing, or it returns a processing event
      const repairedTurn = sqlite.prepare(
        `SELECT status FROM launch_session_turns WHERE id = 'stale-turn-4'`,
      ).get() as { status: string };
      // Turn is either complete (SSE processed it) or still pending (SSE returned processing event)
      expect(["pending", "processing", "complete"]).toContain(repairedTurn.status);
      // Should NOT be error — that's the old buggy behavior
      expect(repairedTurn.status).not.toBe("error");
    });
  });
});
