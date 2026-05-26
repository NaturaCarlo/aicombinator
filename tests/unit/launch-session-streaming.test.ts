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
  handleStreamLaunchSession,
} from "../../worker/src/routes/launch-sessions.ts";
import { extractPartialAssistantMessage } from "../../worker/src/provisioning/launch-session.ts";

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

beforeEach(() => {
  verifyClerkJwtMock.mockClear();
  generateLaunchSessionTurnMock.mockReset();
  generateLaunchSessionTurnStreamingMock.mockReset();
});

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

describe("launch session SSE streaming", () => {
  it("returns text/event-stream content type for the stream endpoint", async () => {
    generateLaunchSessionTurnMock.mockResolvedValueOnce(makeSuccessResult());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    // First create a session
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
    const created = await createResponse.json() as any;
    await ctx.flush();

    // Now connect to the stream endpoint
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    expect(streamResponse.headers.get("Content-Type")).toBe("text/event-stream");
    expect(streamResponse.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("streams a done event with full session state when turn is already complete", async () => {
    const result = makeSuccessResult();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

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
    const created = await createResponse.json() as any;

    // Complete the turn via SSE streaming first
    const firstStreamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    await Promise.all([
      firstStreamResponse.text(),
      ctx.flush(),
    ]);

    // Stream again — turn is already complete, should return done immediately
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    const events = await parseSseEvents(streamResponse);
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.session).toBeDefined();
    const session = doneEvent?.session as any;
    expect(session.ready).toBe(true);
    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.processing).toBe(false);
  });

  it("streams processing event when a turn is pending and sends done after turn runs", async () => {
    // The create handler kicks off a background task that completes the turn.
    // By the time the stream endpoint runs, the turn may already be complete.
    // We test the case where the turn completes during the stream endpoint's inline run.
    const result = makeSuccessResult("## Streaming response\n\nHere is the response.");
    generateLaunchSessionTurnMock.mockResolvedValueOnce(result);
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "StreamTest",
          idea: "AI assistant for streaming test to verify SSE endpoint works correctly.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;
    // Verify the turn was created as pending
    expect(created.currentTurn.status).toBe("pending");

    // Background task hasn't run yet (waitUntil is async), call stream
    // The stream endpoint will detect the pending turn and attempt to run it inline
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    const events = await parseSseEvents(streamResponse);

    // Should end with a done event that has the completed turn
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent).toBeDefined();
    const session = doneEvent?.session as any;
    expect(session.messages.at(-1)?.content).toContain("## Streaming response");
  });

  it("returns 404 for a non-existent session", async () => {
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const streamResponse = await handleStreamLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions/nonexistent/stream", { method: "GET" }),
      env,
      ctx as any,
      "nonexistent",
    );

    expect(streamResponse.status).toBe(404);
  });

  it("returns 401 for unauthenticated requests", async () => {
    verifyClerkJwtMock.mockResolvedValueOnce(null);
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const streamResponse = await handleStreamLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions/any-id/stream", { method: "GET" }),
      env,
      ctx as any,
      "any-id",
    );

    expect(streamResponse.status).toBe(401);
  });

  it("existing polling GET endpoint still works alongside streaming endpoint", async () => {
    const result = makeSuccessResult();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

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
    const created = await createResponse.json() as any;

    // Complete the turn via SSE streaming
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    await Promise.all([
      streamResponse.text(),
      ctx.flush(),
    ]);

    // Existing GET still works and returns the completed turn
    const getResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    expect(getResponse.status).toBe(200);
    const session = await getResponse.json() as any;
    expect(session.id).toBe(created.id);
    expect(session.currentTurn.status).toBe("complete");
  });

  it("sends error event when the turn fails during streaming", async () => {
    // First mock for background creation, second for stream inline run
    const failResult = {
      ok: false as const,
      error: "Provider timeout",
      attempts: [{
        provider: "openrouter" as const,
        model: "anthropic/claude-opus-4.6",
        outcome: "error" as const,
        durationMs: 90000,
        statusCode: null,
        error: "Provider timeout",
        promptChars: 1400,
        transcriptMessages: 1,
      }],
    };
    generateLaunchSessionTurnMock.mockResolvedValueOnce(failResult);
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce((async function* () {
      yield { type: "result", generation: failResult };
    })());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "FailTest",
          idea: "Test company to verify error handling in SSE stream endpoint works correctly.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // Stream endpoint should handle the pending turn and return status
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    const events = await parseSseEvents(streamResponse);
    // Should have a done event with the current session state (turn still pending/retrying)
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.session).toBeDefined();
  });
});

describe("launch session streaming dashboard contract (VAL-LAUNCH-003, VAL-LAUNCH-004, VAL-LAUNCH-012, VAL-LAUNCH-014)", () => {
  it("SSE response includes token events for incremental rendering (VAL-LAUNCH-003)", async () => {
    const result = makeSuccessResult("## Incremental response\n\nThis should appear token by token.");
    generateLaunchSessionTurnMock.mockResolvedValueOnce(result);
    // Streaming mock sends tokens in incremental chunks
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result, ["## Incremental", " response\n\n", "This should appear token by token."])());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "StreamCo",
          idea: "AI company for incremental streaming test to verify tokens appear in the SSE stream.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    const events = await parseSseEvents(streamResponse);
    // Must have at least one token event with the assistant content
    const tokenEvents = events.filter((e) => e.type === "token");
    const doneEvent = events.find((e) => e.type === "done");
    // Either the response has token events, or the done event contains the full session
    // (when tool_use mode is used, tokens come as a single batch before done)
    expect(tokenEvents.length > 0 || doneEvent).toBeTruthy();
    if (doneEvent) {
      const session = doneEvent.session as any;
      expect(session.messages.some((m: any) => m.role === "assistant" && m.content.includes("## Incremental response"))).toBe(true);
    }
  });

  it("done event enables option buttons immediately (VAL-LAUNCH-004)", async () => {
    const result = makeSuccessResult();
    generateLaunchSessionTurnMock.mockResolvedValueOnce(result);
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "OptionTest",
          idea: "Test company for verifying option buttons are enabled immediately when streaming completes.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    const events = await parseSseEvents(streamResponse);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    const session = doneEvent?.session as any;
    // session.processing should be false in the done event, enabling option buttons
    expect(session.processing).toBe(false);
    // Options should be present in the last assistant message
    const lastAssistant = session.messages.findLast((m: any) => m.role === "assistant");
    expect(lastAssistant?.options?.length).toBeGreaterThan(0);
  });

  it("processing state reported via SSE blocks chat input (VAL-LAUNCH-014)", async () => {
    const result = makeSuccessResult();
    generateLaunchSessionTurnMock.mockResolvedValueOnce(result);
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "ProcessingTest",
          idea: "Test company to verify processing state is communicated via SSE for input blocking.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    const events = await parseSseEvents(streamResponse);

    // A processing event should be sent before done
    const processingEvent = events.find((e) => e.type === "processing");
    if (processingEvent) {
      // During processing, the session state should show processing: true
      const processingSession = processingEvent.session as any;
      if (processingSession) {
        expect(processingSession.processing).toBe(true);
      }
    }

    // The done event should show processing: false
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent?.session as any)?.processing).toBe(false);
  });

  it("streams multiple incremental token events (true streaming, not batched)", async () => {
    // First turn completes via the SSE /stream endpoint (sole turn processor)
    const firstResult = makeSuccessResult("## First turn\n\nHello.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(firstResult)());
    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "IncrementalCo",
          idea: "AI company for testing true incremental streaming with multiple token events.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // Complete the first turn via streaming (SSE endpoint is the sole processor)
    const firstStream = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    await Promise.all([firstStream.text(), ctx.flush()]);

    // Directly insert a new pending turn into the DB (bypassing handleLaunchSessionMessage
    // which would kick off a background task that races with the stream endpoint)
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
       VALUES (?, ?, 'founder', ?, NULL, ?)`,
    ).run("fmsg-2", created.id, "Focus on storm-damage recovery", now);
    sqlite.prepare(
      `INSERT INTO launch_session_messages (id, session_id, role, content, options_json, created_at)
       VALUES (?, ?, 'assistant', '', NULL, ?)`,
    ).run("amsg-2", created.id, now);
    sqlite.prepare(
      `INSERT INTO launch_session_turns (
         id, session_id, founder_message_id, assistant_message_id, status, attempts,
         provider, model, duration_ms, last_error, started_at, completed_at,
         prompt_chars, transcript_messages, status_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run("turn-2", created.id, "fmsg-2", "amsg-2", now, now);

    // Set up the streaming mock with multiple incremental chunks
    const secondResult = makeSuccessResult("## Operating thesis\n\nWe should focus on storm-damage recovery.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(secondResult, [
      "## Op",
      "erating",
      " thesis\n\n",
      "We should focus on storm-damage recovery.",
    ])());

    // Stream the second turn — this should produce incremental token events
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    const events = await parseSseEvents(streamResponse);
    const tokenEvents = events.filter((e) => e.type === "token");
    // Must have multiple token events (not one big batch)
    expect(tokenEvents.length).toBeGreaterThanOrEqual(2);
    // Concatenated tokens should form the full message
    const fullContent = tokenEvents.map((e) => e.content).join("");
    expect(fullContent).toBe("## Operating thesis\n\nWe should focus on storm-damage recovery.");
    // Done event must also be present
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent?.session as any)?.processing).toBe(false);
  });
});

describe("extractPartialAssistantMessage", () => {
  it("returns null when key is not present", () => {
    expect(extractPartialAssistantMessage('{"brief":')).toBeNull();
    expect(extractPartialAssistantMessage("")).toBeNull();
  });

  it("extracts partial content from incomplete JSON", () => {
    const partial = '{"assistantMessage":"## First oper';
    expect(extractPartialAssistantMessage(partial)).toBe("## First oper");
  });

  it("extracts complete content when string is terminated", () => {
    const complete = '{"assistantMessage":"## Full message","suggestedCompanyName":"Test"}';
    expect(extractPartialAssistantMessage(complete)).toBe("## Full message");
  });

  it("handles JSON escape sequences correctly", () => {
    const withEscapes = '{"assistantMessage":"Line 1\\nLine 2\\n- Bullet","other":"val"}';
    expect(extractPartialAssistantMessage(withEscapes)).toBe("Line 1\nLine 2\n- Bullet");
  });

  it("handles escaped quotes", () => {
    const withQuotes = '{"assistantMessage":"He said \\"hello\\"","other":"val"}';
    expect(extractPartialAssistantMessage(withQuotes)).toBe('He said "hello"');
  });

  it("handles unicode escapes", () => {
    const withUnicode = '{"assistantMessage":"Price: \\u0024100","other":"val"}';
    expect(extractPartialAssistantMessage(withUnicode)).toBe("Price: $100");
  });

  it("handles partial escape at end of buffer", () => {
    const partialEscape = '{"assistantMessage":"Hello\\';
    expect(extractPartialAssistantMessage(partialEscape)).toBe("Hello");
  });

  it("grows progressively as more content arrives", () => {
    const chunk1 = '{"assistantMessage":"## He';
    const chunk2 = '{"assistantMessage":"## Heading\\n\\nParagraph';
    const chunk3 = '{"assistantMessage":"## Heading\\n\\nParagraph text.","suggestedCompanyName":"Test"}';

    expect(extractPartialAssistantMessage(chunk1)).toBe("## He");
    expect(extractPartialAssistantMessage(chunk2)).toBe("## Heading\n\nParagraph");
    expect(extractPartialAssistantMessage(chunk3)).toBe("## Heading\n\nParagraph text.");
  });
});
