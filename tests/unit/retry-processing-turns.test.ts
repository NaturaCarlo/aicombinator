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

beforeEach(() => {
  verifyClerkJwtMock.mockClear();
  generateLaunchSessionTurnStreamingMock.mockReset();
});

describe("handleRetryLaunchSessionTurn — processing and pending turns", () => {
  it("returns 409 for a pending turn", async () => {
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session (turn starts as pending)
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RetryPendingTest",
          idea: "Test retry on pending turn returns 409.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;
    expect(created.currentTurn.status).toBe("pending");

    // Retry on pending turn should return 409
    const retryResponse = await handleRetryLaunchSessionTurn(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/retry`, { method: "POST" }),
      env,
      ctx as any,
      created.id,
    );
    expect(retryResponse.status).toBe(409);
    const body = await retryResponse.json() as any;
    expect(body.error).toContain("queued");
  });

  it("returns 409 for a recently-processing turn (< PROCESSING_STALE_MS)", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RetryRecentProcessing",
          idea: "Test retry on recently-processing turn returns 409.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // Set turn to processing with a recent updated_at (now)
    sqlite.prepare(
      `UPDATE launch_session_turns SET status = 'processing', updated_at = ? WHERE session_id = ?`,
    ).run(new Date().toISOString(), created.id);

    // Retry on recently-processing turn should return 409
    const retryResponse = await handleRetryLaunchSessionTurn(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/retry`, { method: "POST" }),
      env,
      ctx as any,
      created.id,
    );
    expect(retryResponse.status).toBe(409);
    const body = await retryResponse.json() as any;
    expect(body.error).toContain("still being processed");
  });

  it("resets a stale processing turn (> PROCESSING_STALE_MS) and requeues it", async () => {
    const result = makeSuccessResult("## Recovered from stale processing\n\nTurn was force-reset.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());

    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RetryStaleProcessing",
          idea: "Test retry on stale processing turn resets and requeues.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // Set turn to processing with a stale updated_at (3 minutes ago)
    const staleTime = new Date(Date.now() - 180_000).toISOString();
    sqlite.prepare(
      `UPDATE launch_session_turns SET status = 'processing', attempts = 2, updated_at = ? WHERE session_id = ?`,
    ).run(staleTime, created.id);

    // Retry on stale processing turn should succeed and reset to pending
    const retryResponse = await handleRetryLaunchSessionTurn(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/retry`, { method: "POST" }),
      env,
      ctx as any,
      created.id,
    );
    expect(retryResponse.status).toBe(200);
    const retried = await retryResponse.json() as any;
    expect(retried.currentTurn.status).toBe("pending");

    // Verify the turn was actually reset in DB
    const turnRow = sqlite.prepare(
      `SELECT status, attempts FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(created.id) as { status: string; attempts: number };
    expect(turnRow.status).toBe("pending");
    expect(turnRow.attempts).toBe(0);

    // Verify we can complete the turn via SSE streaming after the reset
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

    const completedTurn = sqlite.prepare(
      `SELECT status FROM launch_session_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(created.id) as { status: string };
    expect(completedTurn.status).toBe("complete");
  });

  it("retry on error turn still works as before (resets to pending)", async () => {
    const { sqlite, env } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "RetryErrorTurn",
          idea: "Test retry on error turn still resets correctly.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = await createResponse.json() as any;

    // Set turn to error state
    sqlite.prepare(
      `UPDATE launch_session_turns SET status = 'error', last_error = 'Provider timeout' WHERE session_id = ?`,
    ).run(created.id);

    // Retry should succeed (200) and reset to pending
    const retryResponse = await handleRetryLaunchSessionTurn(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/retry`, { method: "POST" }),
      env,
      ctx as any,
      created.id,
    );
    expect(retryResponse.status).toBe(200);
    const retried = await retryResponse.json() as any;
    expect(retried.currentTurn.status).toBe("pending");
  });
});
