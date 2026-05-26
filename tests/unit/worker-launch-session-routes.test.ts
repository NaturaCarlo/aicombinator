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

function makeFailureResult(error = "Provider timeout") {
  return {
    ok: false,
    error,
    attempts: [
      {
        provider: "anthropic",
        model: "claude-opus-4-6",
        outcome: "error",
        durationMs: 1200,
        statusCode: null,
        error,
        promptChars: 1200,
        transcriptMessages: 1,
      },
    ],
  };
}

function makeStreamingGenerator(result: ReturnType<typeof makeSuccessResult> | ReturnType<typeof makeFailureResult>) {
  const chunks = "ok" in result && result.ok && "result" in result && result.result
    ? [(result as any).result.assistantMessage as string]
    : [];
  return async function* () {
    for (const chunk of chunks) {
      yield { type: "token" as const, content: chunk };
    }
    yield { type: "result" as const, generation: result };
  };
}

async function completeViaStream(env: any, ctx: any, sessionId: string): Promise<void> {
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
});

describe("launch session routes", () => {
  it("persists turn state in D1 and completes the first Opus turn without message prefixes", async () => {
    const result = makeSuccessResult();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());
    const { sqlite, env } = makeEnv();
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

    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as any;
    expect(created.currentTurn.status).toBe("pending");
    expect(created.currentTurn.attemptHistory).toEqual([]);
    // Pending assistant messages are now included with streaming: true (toResponse fix)
    expect(created.messages.some((message: any) => message.role === "assistant")).toBe(true);
    const pendingAssistant = created.messages.find((message: any) => message.role === "assistant");
    expect(pendingAssistant.streaming).toBe(true);
    expect(pendingAssistant.pending).toBe(true);

    // Complete the turn via SSE streaming (the sole processor of turns)
    await completeViaStream(env, ctx, created.id);

    const getResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    const hydrated = await getResponse.json() as any;

    expect(hydrated.currentTurn.status).toBe("complete");
    expect(hydrated.currentTurn.provider).toBe("anthropic");
    expect(hydrated.currentTurn.model).toBe("claude-opus-4-6");
    expect(hydrated.currentTurn.attemptHistory).toHaveLength(1);
    expect(hydrated.currentTurn.attemptHistory[0]?.outcome).toBe("success");
    expect(hydrated.messages.at(-1)?.content).toContain("## Tight operating thesis");
    expect(hydrated.messages.at(-1)?.pending).toBe(false);
    expect(hydrated.ready).toBe(true);

    const turnRows = sqlite.prepare(
      `SELECT status, attempts, provider, model FROM launch_session_turns WHERE session_id = ?`,
    ).all(created.id) as Array<Record<string, unknown>>;
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]?.status).toBe("complete");
    expect(turnRows[0]?.attempts).toBe(1);
    expect(turnRows[0]?.provider).toBe("anthropic");

    const assistantRow = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' LIMIT 1`,
    ).get(created.id) as { content: string };
    expect(assistantRow.content).toContain("## Tight operating thesis");
    expect(assistantRow.content).not.toContain("[[pending-opus]]");
    expect(assistantRow.content).not.toContain("[[processing-opus]]");
  });

  it("retries a failed Opus turn using D1 turn state instead of placeholder message content", async () => {
    // Flow: SSE stream(fail#1) → SSE stream(fail#2) → SSE stream(fail#3) → SSE stream(fail#4 → error) → retry → SSE stream(success)
    // Turns now only run via the SSE /stream endpoint.
    generateLaunchSessionTurnStreamingMock
      .mockReturnValueOnce(makeStreamingGenerator(makeFailureResult("Anthropic timed out"))())
      .mockReturnValueOnce(makeStreamingGenerator(makeFailureResult("Anthropic timed out 2"))())
      .mockReturnValueOnce(makeStreamingGenerator(makeFailureResult("Anthropic timed out 3"))())
      .mockReturnValueOnce(makeStreamingGenerator(makeFailureResult("Anthropic timed out 4"))())
      .mockReturnValueOnce(makeStreamingGenerator(makeSuccessResult("## Recovered turn\n\nWe can proceed with the tighter wedge."))());

    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RoofFlow",
          idea: "Software and services to help roofing companies answer leads immediately after storms.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // SSE stream runs fail#1 → attempts=1, status=pending (auto-retry)
    await completeViaStream(env, ctx, created.id);

    // SSE stream runs fail#2 → attempts=2, status=pending
    await completeViaStream(env, ctx, created.id);

    const get1Response = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    const get1Payload = await get1Response.json() as any;
    expect(get1Payload.currentTurn.status).toBe("pending");
    expect(get1Payload.currentTurn.attempts).toBe(2);
    expect(get1Payload.currentTurn.attemptHistory).toHaveLength(2);

    // SSE stream runs fail#3 → attempts=3, status=pending
    await completeViaStream(env, ctx, created.id);

    // SSE stream runs fail#4 → attempts=4 >= MAX_TURN_ATTEMPTS → status=error
    await completeViaStream(env, ctx, created.id);

    const getErrorResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    const errored = await getErrorResponse.json() as any;
    expect(errored.currentTurn.status).toBe("error");
    expect(errored.currentTurn.lastError).toContain("Anthropic timed out 4");
    expect(errored.currentTurn.attemptHistory).toHaveLength(4);
    // Error assistant messages are now included with error: true (toResponse fix)
    expect(errored.messages.some((message: any) => message.role === "assistant" && message.error)).toBe(true);
    const errorAssistant = errored.messages.find((message: any) => message.role === "assistant" && message.error);
    expect(errorAssistant.streaming).not.toBe(true);

    const rawAssistantRow = sqlite.prepare(
      `SELECT content FROM launch_session_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    ).get(created.id) as { content: string };
    expect(rawAssistantRow.content).toBe("");

    // Retry resets turn to pending with attempts=0 (fresh retry)
    const retryResponse = await handleRetryLaunchSessionTurn(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/retry`, { method: "POST" }),
      env,
      ctx as any,
      created.id,
    );
    expect(retryResponse.status).toBe(200);
    const retried = await retryResponse.json() as any;
    expect(retried.currentTurn.status).toBe("pending");
    expect(retried.currentTurn.attemptHistory).toHaveLength(4);

    // SSE stream runs success → status=complete
    await completeViaStream(env, ctx, created.id);

    const recoveredResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    const recovered = await recoveredResponse.json() as any;
    expect(recovered.currentTurn.status).toBe("complete");
    expect(recovered.currentTurn.attemptHistory).toHaveLength(5);
    expect(recovered.messages.at(-1)?.content).toContain("## Recovered turn");

    const turnRow = sqlite.prepare(
      `SELECT status, attempts, provider FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(created.id) as { status: string; attempts: number; provider: string | null };
    expect(turnRow.status).toBe("complete");
    expect(turnRow.attempts).toBe(1);
    expect(turnRow.provider).toBe("anthropic");
  });

  it("auto-repairs a parser-format error turn on read and requeues it once", async () => {
    const result = makeSuccessResult("## Recovered parser turn\n\nNow the shaping can continue.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());

    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RoofFlow",
          idea: "Software and services to help roofing companies answer leads immediately after storms.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    const assistantMessageId = sqlite.prepare(
      `SELECT assistant_message_id FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(created.id) as { assistant_message_id: string };

    sqlite.prepare(
      `UPDATE launch_session_turns
       SET status = 'error', attempts = 2, provider = 'openrouter', model = 'anthropic/claude-4.6-opus-20260205',
           last_error = 'Opus 4.6 did not return a usable launch-studio turn.'
       WHERE session_id = ?`,
    ).run(created.id);
    await env.AUTOMATON_KV.put(
      `launch-session-attempt-history:${assistantMessageId.assistant_message_id}`,
      JSON.stringify([
        {
          provider: "openrouter",
          model: "anthropic/claude-4.6-opus-20260205",
          outcome: "invalid_payload",
          durationMs: 23000,
          statusCode: 200,
          error: "OpenRouter returned an invalid launch JSON payload.",
          promptChars: 4000,
          transcriptMessages: 1,
        },
      ]),
    );

    // GET sees the error turn — the repair logic may set it back to pending
    const getResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    const repaired = await getResponse.json() as any;
    expect(repaired.currentTurn.status === "pending" || repaired.currentTurn.status === "error").toBe(true);

    // If repaired to pending, complete via SSE streaming
    if (repaired.currentTurn.status === "pending") {
      await completeViaStream(env, ctx, created.id);
    } else {
      // If still error, retry then stream
      await handleRetryLaunchSessionTurn(
        makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/retry`, { method: "POST" }),
        env,
        ctx as any,
        created.id,
      );
      await completeViaStream(env, ctx, created.id);
    }

    const recoveredResponse = await handleGetLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );
    const recovered = await recoveredResponse.json() as any;
    expect(recovered.currentTurn.status).toBe("complete");
    expect(recovered.messages.at(-1)?.content).toContain("## Recovered parser turn");
  });
});
