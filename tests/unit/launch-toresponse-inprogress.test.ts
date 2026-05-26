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

vi.mock("../../worker/src/routes/companies.ts", async () => {
  const actual = await vi.importActual<typeof import("../../worker/src/routes/companies.ts")>(
    "../../worker/src/routes/companies.ts",
  );
  return {
    ...actual,
    createAndProvisionCompany: vi.fn(),
    hasInferableCompanyMeaning: () => true,
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
  generateLaunchSessionTurnStreamingMock.mockReset();
});

describe("toResponse() includes in-progress assistant messages (VAL-BE-SSE-001, VAL-BE-SSE-002)", () => {
  describe("in-progress messages are included in REST API response", () => {
    it("GET /launch-sessions/:id returns pending assistant messages with empty content", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create a session — initial turn stays pending (no streaming mock set up for completion)
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify in-progress messages appear in REST response.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;
      const sessionId = created.id;

      // GET the session — the pending assistant message should be included
      const getResponse = await handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
        env,
        ctx as any,
        sessionId,
      );
      const session = (await getResponse.json()) as any;

      // Find assistant messages
      const assistantMessages = session.messages.filter((m: any) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      // The pending assistant message should be present with streaming: true
      const pendingMsg = assistantMessages.find((m: any) => m.streaming === true);
      expect(pendingMsg).toBeDefined();
      expect(pendingMsg.role).toBe("assistant");
      expect(pendingMsg.streaming).toBe(true);
    });

    it("GET /launch-sessions/:id returns processing assistant messages with their current content", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create session
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify processing messages include their content.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;
      const sessionId = created.id;

      // Manually set the turn to "processing" with some partial content
      const assistantMsg = sqlite.prepare(
        `SELECT id FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' LIMIT 1`,
      ).get(sessionId) as { id: string };

      sqlite.prepare(
        `UPDATE launch_session_messages SET content = ? WHERE id = ?`,
      ).run("Here is some partial response content that was", assistantMsg.id);

      sqlite.prepare(
        `UPDATE launch_session_turns SET status = 'processing', started_at = ? WHERE assistant_message_id = ?`,
      ).run(new Date().toISOString(), assistantMsg.id);

      // GET the session
      const getResponse = await handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
        env,
        ctx as any,
        sessionId,
      );
      const session = (await getResponse.json()) as any;

      // The processing assistant message should be included with its content
      const assistantMessages = session.messages.filter((m: any) => m.role === "assistant");
      const streamingMsg = assistantMessages.find((m: any) => m.streaming === true);
      expect(streamingMsg).toBeDefined();
      expect(streamingMsg.content).toBe("Here is some partial response content that was");
      expect(streamingMsg.streaming).toBe(true);
    });
  });

  describe("streaming flag on in-progress vs completed messages", () => {
    it("in-progress messages include streaming: true", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create session (turn stays pending)
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify streaming flag is true on in-progress messages.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;

      // The initial response should include the pending assistant message with streaming: true
      const assistantMessages = created.messages.filter((m: any) => m.role === "assistant");
      const pendingMsg = assistantMessages.find((m: any) => m.streaming === true);
      expect(pendingMsg).toBeDefined();
      expect(pendingMsg.streaming).toBe(true);
    });

    it("completed messages do NOT have streaming: true", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create and complete session
      generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(makeNonReadyResult())());
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify completed messages have no streaming flag.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;
      await completeViaStream(env, ctx, created.id);

      // GET the session
      const getResponse = await handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
        env,
        ctx as any,
        created.id,
      );
      const session = (await getResponse.json()) as any;

      // All completed assistant messages should NOT have streaming: true
      const assistantMessages = session.messages.filter((m: any) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThan(0);
      for (const msg of assistantMessages) {
        expect(msg.streaming).not.toBe(true);
      }
    });
  });

  describe("toResponse still correctly reports processing flag", () => {
    it("processing: true when a turn is active (pending)", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();

      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing processing flag remains true when turn is pending.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;

      expect(created.processing).toBe(true);
    });

    it("processing: false when all turns are complete", async () => {
      const { env } = makeEnv();
      const ctx = new TestExecutionContext();

      generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(makeNonReadyResult())());
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing processing is false when turns complete.",
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
      expect(session.processing).toBe(false);
    });
  });

  describe("error messages behavior", () => {
    it("error assistant messages are included and do NOT have streaming: true", async () => {
      const { sqlite, env } = makeEnv();
      const ctx = new TestExecutionContext();

      // Create session
      const createResponse = await handleCreateLaunchSession(
        makeRequest("https://api.aicombinator.live/api/launch-sessions", {
          method: "POST",
          body: JSON.stringify({
            companyName: "TestCo",
            idea: "AI assistant for testing to verify error messages are included without streaming flag.",
          }),
        }),
        env,
        ctx as any,
      );
      const created = (await createResponse.json()) as any;
      const sessionId = created.id;

      // Set the turn to error status
      const assistantMsg = sqlite.prepare(
        `SELECT id FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' LIMIT 1`,
      ).get(sessionId) as { id: string };

      sqlite.prepare(
        `UPDATE launch_session_turns SET status = 'error', last_error = 'Model timeout' WHERE assistant_message_id = ?`,
      ).run(assistantMsg.id);

      // GET the session
      const getResponse = await handleGetLaunchSession(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${sessionId}`, { method: "GET" }),
        env,
        ctx as any,
        sessionId,
      );
      const session = (await getResponse.json()) as any;

      // Error messages should be included (not filtered out)
      const assistantMessages = session.messages.filter((m: any) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThan(0);

      // Error messages should NOT have streaming: true
      const errorMsg = assistantMessages.find((m: any) => m.error === true);
      expect(errorMsg).toBeDefined();
      expect(errorMsg.streaming).not.toBe(true);
    });
  });
});
