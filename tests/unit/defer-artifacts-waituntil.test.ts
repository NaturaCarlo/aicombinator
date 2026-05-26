import fs from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyClerkJwtMock,
  generateLaunchSessionTurnStreamingMock,
  generateLaunchArtifactsMock,
} = vi.hoisted(() => ({
  verifyClerkJwtMock: vi.fn(async () => "user-1"),
  generateLaunchSessionTurnStreamingMock: vi.fn(),
  generateLaunchArtifactsMock: vi.fn(async () => ({
    companySpecMd: "# Company Spec",
    missionMd: "# Mission",
    firstMilestoneMd: "# First Milestone",
    autonomyContractMd: "# Autonomy Contract",
  })),
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

import {
  handleCreateLaunchSession,
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

/**
 * TestExecutionContext that tracks waitUntil calls separately.
 * This lets us verify that artifact generation has its own waitUntil()
 * call, independent of the main streaming waitUntil().
 */
class TestExecutionContext {
  private readonly tasks: Promise<unknown>[] = [];
  public waitUntilCallCount = 0;

  waitUntil(promise: Promise<unknown>) {
    this.waitUntilCallCount++;
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

function makeReadyResult(message = "## Your company is ready!\n\nLet's launch.") {
  return {
    ok: true as const,
    result: {
      assistantMessage: message,
      suggestedCompanyName: "ArtifactTestCo",
      brief: {
        concept: "AI testing tool for artifact generation timing.",
        targetCustomer: "developers building AI apps",
        painfulProblem: "Slow SSE done events due to inline artifact generation.",
        firstOffer: "Instant done events with deferred artifact generation",
        whyNow: "SSE latency impacts user experience significantly.",
        businessModel: "SaaS subscription",
        distributionWedge: "Developer community adoption",
        founderConstraints: [],
        autonomyBoundaries: [],
        founderSetupTasks: [],
        nonGoals: [],
        firstMilestone: "Ship the done-event fix",
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

function makeStreamingGenerator(result: ReturnType<typeof makeReadyResult>) {
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

beforeEach(() => {
  verifyClerkJwtMock.mockClear();
  generateLaunchSessionTurnStreamingMock.mockReset();
  generateLaunchArtifactsMock.mockClear();
});

describe("Deferred artifact generation lifecycle-bound to ctx.waitUntil (VAL-BE-SSE-004, VAL-BE-SSE-005)", () => {
  it("artifact generation has its own ctx.waitUntil() call, separate from the stream handler", async () => {
    const result = makeReadyResult();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());

    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    // Create a session
    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "ArtifactTestCo",
          idea: "AI testing tool for artifact generation timing.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;

    // Stream — the ready result triggers artifact generation
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    // Consume SSE response
    await parseSseEvents(streamResponse);

    // The main streaming handler registers one ctx.waitUntil() (for the stream processing).
    // The deferred artifact generation should register a SECOND ctx.waitUntil() call.
    // Before the fix, the artifact IIFE was detached (not wrapped in ctx.waitUntil),
    // so only 1 waitUntil call was made.
    expect(ctx.waitUntilCallCount).toBeGreaterThanOrEqual(2);

    // Flush to let artifacts complete
    await ctx.flush();
    expect(generateLaunchArtifactsMock).toHaveBeenCalledTimes(1);
  });

  it("artifact generation completes even after the SSE writer closes", async () => {
    const result = makeReadyResult();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());

    // Track the timing: artifact generation starts AFTER writer.close()
    let artifactStarted = false;
    let artifactResolve: () => void;
    const artifactPromise = new Promise<void>((resolve) => { artifactResolve = resolve; });
    generateLaunchArtifactsMock.mockImplementationOnce(async () => {
      artifactStarted = true;
      await artifactPromise;
      return {
        companySpecMd: "# Company Spec",
        missionMd: "# Mission",
        firstMilestoneMd: "# First Milestone",
        autonomyContractMd: "# Autonomy Contract",
      };
    });

    const { env, sqlite } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "ArtifactTestCo",
          idea: "AI testing tool for artifact generation timing.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;

    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    // After consuming SSE events, the writer has closed (stream is done).
    // But artifact generation should still be tracked by its own ctx.waitUntil.
    const events = await parseSseEvents(streamResponse);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // Let artifact generation complete
    artifactResolve!();
    await ctx.flush();

    // Verify artifacts were saved to the database
    const row = sqlite.prepare("SELECT artifacts_json FROM launch_sessions WHERE id = ?").get(created.id) as any;
    expect(row).toBeDefined();
    expect(row.artifacts_json).toBeTruthy();
    const artifacts = JSON.parse(row.artifacts_json);
    expect(artifacts.companySpecMd).toBe("# Company Spec");
    expect(artifacts.missionMd).toBe("# Mission");
  });

  it("SSE done event still fires immediately (not blocked by artifact generation)", async () => {
    const result = makeReadyResult();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());

    // Block artifact generation indefinitely
    generateLaunchArtifactsMock.mockImplementationOnce(async () => {
      await new Promise(() => {}); // never resolves
      return {
        companySpecMd: "# Company Spec",
        missionMd: "# Mission",
        firstMilestoneMd: "# First Milestone",
        autonomyContractMd: "# Autonomy Contract",
      };
    });

    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "ArtifactTestCo",
          idea: "AI testing tool for artifact generation timing.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;

    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    // Done event should be emitted even though artifacts never complete
    const events = await parseSseEvents(streamResponse);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent?.session as any)?.ready).toBe(true);
  });
});
