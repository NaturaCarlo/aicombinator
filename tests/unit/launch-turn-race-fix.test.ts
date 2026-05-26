import fs from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyClerkJwtMock,
  generateLaunchSessionTurnMock,
  generateLaunchSessionTurnStreamingMock,
} = vi.hoisted(() => ({
  verifyClerkJwtMock: vi.fn(async () => "user-1"),
  generateLaunchSessionTurnMock: vi.fn(),
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

import {
  handleCreateLaunchSession,
  handleGetLaunchSession,
  handleLaunchSessionMessage,
  handleRetryLaunchSessionTurn,
  handleStreamLaunchSession,
} from "../../worker/src/routes/launch-sessions.ts";

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
  generateLaunchSessionTurnMock.mockReset();
  generateLaunchSessionTurnStreamingMock.mockReset();
});

describe("fix-launch-turn-race: session creation does NOT fire kickoffPendingAssistantTurn", () => {
  it("handleCreateLaunchSession does NOT call generateLaunchSessionTurn (turn stays pending)", async () => {
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RaceFix",
          idea: "AI assistant for testing race condition fix ensures turn stays pending after creation.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // Turn should be pending
    expect(created.currentTurn.status).toBe("pending");

    // Flush all waitUntil tasks
    await ctx.flush();

    // generateLaunchSessionTurn should NOT have been called —
    // the creation handler must NOT kick off the turn
    expect(generateLaunchSessionTurnMock).not.toHaveBeenCalled();

    // ctx should NOT have any waitUntil tasks queued for turn processing
    // (tasks array is exposed for testing)
    // After flush, no turn should have been processed
    // Re-read the session to confirm turn is STILL pending
    const getResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    const session = await getResponse.json() as any;
    // GET endpoint should also NOT run the turn inline
    expect(session.currentTurn.status).toBe("pending");
    expect(generateLaunchSessionTurnMock).not.toHaveBeenCalled();
  });

  it("SSE endpoint claims and processes the pending turn with streaming", async () => {
    const result = makeSuccessResult("## Race fix test\n\nStreaming works.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result, [
      "## Race fix",
      " test\n\n",
      "Streaming works.",
    ])());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create session — turn stays pending
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "StreamClaim",
          idea: "AI assistant to verify SSE endpoint is the sole processor of pending turns after race fix.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;
    expect(created.currentTurn.status).toBe("pending");

    // SSE endpoint should claim and stream the turn
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    // Read response and flush in parallel — the readable stream completes only
    // after the ctx.waitUntil background task finishes writing.
    const [events] = await Promise.all([
      parseSseEvents(streamResponse),
      ctx.flush(),
    ]);
    const tokenEvents = events.filter((e) => e.type === "token");
    const doneEvent = events.find((e) => e.type === "done");

    // Tokens should have been streamed
    expect(tokenEvents.length).toBeGreaterThanOrEqual(2);
    expect(tokenEvents.map((e) => e.content).join("")).toBe("## Race fix test\n\nStreaming works.");

    // Done event should show completed turn
    expect(doneEvent).toBeDefined();
    expect((doneEvent?.session as any)?.processing).toBe(false);
    expect((doneEvent?.session as any)?.messages.at(-1)?.content).toContain("## Race fix test");
  });

  it("handleGetLaunchSession does NOT run turns inline (no blocking 90-120s call)", async () => {
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "GetNoBlock",
          idea: "AI assistant to verify GET endpoint does not block on turn processing after race fix.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;
    expect(created.currentTurn.status).toBe("pending");

    // GET should return immediately without processing the turn
    const getResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    const session = await getResponse.json() as any;

    // Turn should still be pending — GET did NOT run it inline
    expect(session.currentTurn.status).toBe("pending");
    expect(session.processing).toBe(true);

    // No LLM call should have been made
    expect(generateLaunchSessionTurnMock).not.toHaveBeenCalled();
  });

  it("handleLaunchSessionMessage does NOT fire kickoffPendingAssistantTurn", async () => {
    const result = makeSuccessResult("## First response");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "MsgNoKickoff",
          idea: "AI assistant to verify message endpoint does not fire kickoff after race fix.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // Complete the first turn via SSE — read and flush in parallel
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    await Promise.all([
      streamResponse.text(), // consume the readable stream
      ctx.flush(),
    ]);

    // Now send a message — it should NOT fire kickoffPendingAssistantTurn
    generateLaunchSessionTurnMock.mockReset();
    const msgResponse = await handleLaunchSessionMessage(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "Focus on storm-damage recovery" }),
      }),
      env,
      ctx as any,
      created.id,
    );
    expect(msgResponse.status).toBe(200);
    const msgData = await msgResponse.json() as any;
    expect(msgData.currentTurn.status).toBe("pending");

    // Flush all background tasks and verify no LLM call was made
    await ctx.flush();
    expect(generateLaunchSessionTurnMock).not.toHaveBeenCalled();
  });

  it("handleRetryLaunchSessionTurn does NOT fire kickoffPendingAssistantTurn", async () => {
    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RetryNoKickoff",
          idea: "AI assistant to verify retry endpoint does not fire kickoff after race fix.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // Manually set turn to error state (use session_id since currentTurn has no id field)
    sqlite.prepare(
      `UPDATE launch_session_turns SET status = 'error', last_error = 'Provider timeout' WHERE session_id = ?`,
    ).run(created.id);

    // Retry should NOT fire kickoffPendingAssistantTurn
    generateLaunchSessionTurnMock.mockReset();
    const retryResponse = await handleRetryLaunchSessionTurn(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/retry`, {
        method: "POST",
      }),
      env,
      ctx as any,
      created.id,
    );
    expect(retryResponse.status).toBe(200);

    // Flush and verify no LLM call
    await ctx.flush();
    expect(generateLaunchSessionTurnMock).not.toHaveBeenCalled();
  });
});
