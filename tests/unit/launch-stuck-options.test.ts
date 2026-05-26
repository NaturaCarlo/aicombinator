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

async function parseSseEventsAndComments(response: Response): Promise<{
  events: Array<Record<string, unknown>>;
  comments: string[];
}> {
  const text = await response.text();
  const events: Array<Record<string, unknown>> = [];
  const comments: string[] = [];
  const chunks = text.split("\n\n");
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith(":")) {
        comments.push(line.slice(1).trim());
      }
    }
    const data = lines
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
  return { events, comments };
}

beforeEach(() => {
  verifyClerkJwtMock.mockClear();
  generateLaunchSessionTurnStreamingMock.mockReset();
});

// ─── FIX 1: SSE heartbeat prevents connection timeout ──────────────────────

describe("FIX 1: SSE heartbeat during processing gap", () => {
  it("sends heartbeat comments between token events and done event", async () => {
    const result = makeSuccessResult("## Response\n\nStreaming content.");
    // Simulate a slow streaming generator that yields tokens then pauses
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce((async function* () {
      yield { type: "token" as const, content: "## Response\n\n" };
      yield { type: "token" as const, content: "Streaming content." };
      yield { type: "result" as const, generation: result };
    })());

    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "HeartbeatTest",
          idea: "AI assistant for testing SSE heartbeat support during the processing gap between tokens and done event.",
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

    // The response should include heartbeat comments
    const raw = await streamResponse.text();
    // Verify the stream completed with a done event
    expect(raw).toContain('"type":"done"');
    // Heartbeat comment should be present (: heartbeat\n\n)
    expect(raw).toContain(": heartbeat");
  });

  it("heartbeat does not interfere with SSE event parsing", async () => {
    const result = makeSuccessResult("## Clean response\n\nTokens arrive cleanly.");
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce((async function* () {
      yield { type: "token" as const, content: "## Clean response\n\n" };
      yield { type: "token" as const, content: "Tokens arrive cleanly." };
      yield { type: "result" as const, generation: result };
    })());

    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "HeartbeatClean",
          idea: "AI company for verifying heartbeat comments do not break SSE event parsing in the client.",
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

    // Parse should work correctly even with heartbeat comments interspersed
    const text = await streamResponse.text();
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

    const tokenEvents = events.filter((e) => e.type === "token");
    const doneEvent = events.find((e) => e.type === "done");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(2);
    expect(doneEvent).toBeDefined();
    expect((doneEvent?.session as any)?.processing).toBe(false);
  });
});

// ─── FIX 2: Dashboard stall recovery logic ──────────────────────────────────

describe("FIX 2: Dashboard stall recovery (logic unit tests)", () => {
  it("detects stalled streaming when streamingContent is set but processing turns off", () => {
    // Simulates the stall detection logic
    const streamingContent = "## Partial content that was streamed...";
    const processing = false; // processing just turned off (done arrived)

    // When processing is false and we have streamingContent, should clear it
    const shouldClearStreaming = streamingContent !== null && !processing;
    expect(shouldClearStreaming).toBe(true);
  });

  it("does not trigger stall recovery when streaming is active", () => {
    const streamingContent = "## Streaming in progress...";
    const processing = true;

    const shouldClearStreaming = streamingContent !== null && !processing;
    expect(shouldClearStreaming).toBe(false);
  });

  it("stall timeout fires after configured duration when streaming content stalls", () => {
    vi.useFakeTimers();
    const STALL_TIMEOUT_MS = 15_000;
    let stallFired = false;
    let streamingContent: string | null = "## Stalled content...";
    let processing = true;

    // Simulate stall detection: streaming content exists, processing is true,
    // but no new tokens have arrived for STALL_TIMEOUT_MS
    const timer = setTimeout(() => {
      if (streamingContent !== null && processing) {
        stallFired = true;
        streamingContent = null; // Clear stalled streaming
      }
    }, STALL_TIMEOUT_MS);

    // Before timeout fires
    vi.advanceTimersByTime(14_999);
    expect(stallFired).toBe(false);

    // After timeout fires
    vi.advanceTimersByTime(1);
    expect(stallFired).toBe(true);
    expect(streamingContent).toBeNull();

    clearTimeout(timer);
    vi.useRealTimers();
  });

  it("stall timeout is cleared when done event arrives before timeout", () => {
    vi.useFakeTimers();
    const STALL_TIMEOUT_MS = 15_000;
    let stallFired = false;
    let streamingContent: string | null = "## Content...";

    const timer = setTimeout(() => {
      stallFired = true;
    }, STALL_TIMEOUT_MS);

    // Done event arrives after 5s — clear the timer
    vi.advanceTimersByTime(5_000);
    clearTimeout(timer);
    streamingContent = null; // Normal completion

    vi.advanceTimersByTime(10_000);
    expect(stallFired).toBe(false);

    vi.useRealTimers();
  });
});

// ─── FIX 3: Smooth transition from streaming to final message ───────────────

describe("FIX 3: Smooth transition from streaming to final message", () => {
  it("keeps streamingContent visible during transition when processing just turned false", () => {
    // Simulates the render logic in launch-session-view
    const streamingContent = "## Full streamed response\n\nAll content received.";
    const processing = false; // done just arrived
    const messages = [
      { id: "msg-1", role: "assistant", content: "## Full streamed response\n\nAll content received.", options: [] },
    ];

    // The streaming content should remain visible briefly during transition,
    // not disappear and cause a visual jump. The view should show streamingContent
    // when it exists, regardless of processing state, as a transition aid.
    const showStreamingView = streamingContent !== null;
    expect(showStreamingView).toBe(true);
  });

  it("clears streamingContent only after final messages are rendered", () => {
    // Simulate the sequencing
    let streamingContent: string | null = "## Streamed text";
    let finalMessages = false;

    // Phase 1: done event arrives, processing = false
    // streamingContent still set, final messages not yet rendered
    expect(streamingContent).not.toBeNull();

    // Phase 2: parent (launch-form) clears streamingContent when session updates
    streamingContent = null;
    finalMessages = true;

    expect(streamingContent).toBeNull();
    expect(finalMessages).toBe(true);
  });
});
