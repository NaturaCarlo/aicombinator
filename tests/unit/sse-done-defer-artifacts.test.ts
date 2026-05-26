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

describe("SSE done event fires before artifact generation (VAL-BE-SSE-004, VAL-BE-SSE-005)", () => {
  it("done event is sent before ensureArtifacts completes", async () => {
    const result = makeReadyResult();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());

    // Make artifact generation take a long time to prove done event doesn't wait for it
    let artifactResolve: () => void;
    const artifactPromise = new Promise<void>((resolve) => { artifactResolve = resolve; });
    generateLaunchArtifactsMock.mockImplementationOnce(async () => {
      await artifactPromise;
      return {
        companySpecMd: "# Company Spec",
        missionMd: "# Mission",
        firstMilestoneMd: "# First Milestone",
        autonomyContractMd: "# Autonomy Contract",
      };
    });

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

    // Stream — the turn should complete and done should fire BEFORE artifacts finish
    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    // Read SSE events — the done event should be readable even though artifacts haven't finished
    const events = await parseSseEvents(streamResponse);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent?.session as any)?.ready).toBe(true);

    // At this point, artifacts should NOT have been awaited yet (still blocked)
    // The done event was sent while generateLaunchArtifacts was still pending

    // Now let the artifacts complete
    artifactResolve!();
    await ctx.flush();

    // Verify artifacts were still generated (just asynchronously)
    expect(generateLaunchArtifactsMock).toHaveBeenCalledTimes(1);
  });

  it("artifacts are generated correctly after deferred execution (VAL-BE-SSE-005)", async () => {
    const result = makeReadyResult();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(result)());

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

    // Consume the SSE response
    const events = await parseSseEvents(streamResponse);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // Flush the ctx.waitUntil tasks (including deferred artifact generation)
    await ctx.flush();

    // Verify artifacts were saved to the database
    const row = sqlite.prepare("SELECT artifacts_json FROM launch_sessions WHERE id = ?").get(created.id) as any;
    expect(row).toBeDefined();
    expect(row.artifacts_json).toBeTruthy();
    const artifacts = JSON.parse(row.artifacts_json);
    expect(artifacts.companySpecMd).toBe("# Company Spec");
    expect(artifacts.missionMd).toBe("# Mission");
  });

  it("non-ready results do not trigger artifact generation", async () => {
    const result = {
      ok: true as const,
      result: {
        assistantMessage: "Tell me more about your target customer.",
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
    const chunks = [result.result.assistantMessage];
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce((async function* () {
      for (const chunk of chunks) {
        yield { type: "token" as const, content: chunk };
      }
      yield { type: "result" as const, generation: result };
    })());

    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "NotReadyCo",
          idea: "AI tool for helping dentists with scheduling that still needs refinement.",
        }),
      }),
      env,
      ctx as any,
    );
    const created = (await createResponse.json()) as any;

    // Reset mock call count right before the streaming call to isolate from setup side effects
    generateLaunchArtifactsMock.mockClear();

    const streamResponse = await handleStreamLaunchSession(
      makeRequest(`https://api.aicombinator.live/api/launch-sessions/${created.id}/stream`, { method: "GET" }),
      env,
      ctx as any,
      created.id,
    );

    await parseSseEvents(streamResponse);
    await ctx.flush();

    // ensureArtifacts should NOT have been called since readiness.ready is false
    expect(generateLaunchArtifactsMock).not.toHaveBeenCalled();
  });
});
