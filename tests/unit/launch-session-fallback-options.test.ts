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
  handleStreamLaunchSession,
} from "../../worker/src/routes/launch-sessions.ts";
import { ensureFallbackOptions } from "../../worker/src/provisioning/launch-session.ts";
import type {
  LaunchSessionBrief,
  LaunchSessionTurnResult,
} from "../../worker/src/provisioning/launch-session.ts";

// --- Test infrastructure (same as launch-session-streaming.test.ts) ---

class TestPreparedStatement {
  private args: unknown[] = [];
  constructor(private readonly db: Database.Database, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
}

class TestD1Database {
  constructor(private readonly db: Database.Database) {}
  prepare(sql: string) { return new TestPreparedStatement(this.db, sql); }
  async batch(statements: Array<TestPreparedStatement>) {
    const results = [];
    for (const statement of statements) { results.push(await statement.run()); }
    return results;
  }
}

class MemoryKv {
  private readonly values = new Map<string, string>();
  async get(key: string, type?: "json") {
    const raw = this.values.get(key) ?? null;
    if (raw === null) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

class TestExecutionContext {
  private readonly tasks: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>) { this.tasks.push(Promise.resolve(promise)); }
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

function makeResultWithEmptyOptions(message = "## Operating thesis\n\nHere is the response.") {
  return {
    ok: true,
    result: {
      assistantMessage: message,
      suggestedCompanyName: "TestCo",
      brief: {
        concept: "AI assistant for roofing companies.",
        targetCustomer: "owner-led roofing companies",
        painfulProblem: "Missed inbound leads.",
        firstOffer: "Lead recovery + qualification",
        whyNow: "Storm-driven lead spikes.",
        businessModel: "Monthly retainer",
        distributionWedge: "Founder-led outbound",
        founderConstraints: [],
        autonomyBoundaries: [],
        founderSetupTasks: [],
        nonGoals: [],
        firstMilestone: "Launch lead-recovery funnel",
        openQuestions: [],
        autonomyConfidence: 82,
      },
      readiness: {
        score: 72,
        ready: false,
        blockers: [],
        strengths: ["Clear first buyer"],
        nextBestQuestion: null,
      },
      options: [], // Empty options — this is the bug scenario
    },
    attempts: [{
      provider: "openrouter" as const,
      model: "anthropic/claude-opus-4.6",
      outcome: "success" as const,
      durationMs: 420,
      statusCode: 200,
      error: null,
      promptChars: 1400,
      transcriptMessages: 1,
    }],
  };
}

function makeStreamingGenerator(result: ReturnType<typeof makeResultWithEmptyOptions>, tokenChunks?: string[]) {
  const chunks = tokenChunks ?? (result.ok && result.result ? [result.result.assistantMessage] : []);
  return async function* () {
    for (const chunk of chunks) { yield { type: "token" as const, content: chunk }; }
    yield { type: "result" as const, generation: result };
  };
}

async function parseSseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const events: Array<Record<string, unknown>> = [];
  for (const chunk of text.split("\n\n")) {
    const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).join("\n");
    if (!data) continue;
    try { events.push(JSON.parse(data)); } catch { /* skip */ }
  }
  return events;
}

beforeEach(() => {
  verifyClerkJwtMock.mockClear();
  generateLaunchSessionTurnMock.mockReset();
  generateLaunchSessionTurnStreamingMock.mockReset();
});

// --- Tests ---

describe("ensureFallbackOptions (unit)", () => {
  const baseBrief: LaunchSessionBrief = {
    concept: "AI assistant for roofing companies",
    targetCustomer: "owner-led roofing companies",
    painfulProblem: "Missed inbound leads",
    firstOffer: "Lead recovery",
    whyNow: "Storm spikes",
    businessModel: "Monthly retainer",
    distributionWedge: "Founder outbound",
    founderConstraints: [],
    autonomyBoundaries: [],
    founderSetupTasks: [],
    nonGoals: [],
    firstMilestone: "Launch funnel",
    openQuestions: [],
    autonomyConfidence: 82,
  };

  it("returns original result when options are non-empty", () => {
    const result: LaunchSessionTurnResult = {
      assistantMessage: "Test",
      suggestedCompanyName: "Co",
      brief: baseBrief,
      readiness: { score: 70, ready: false, blockers: [], strengths: [], nextBestQuestion: null },
      options: [{ title: "A", description: "B", founderReply: "C" }],
    };
    const output = ensureFallbackOptions(result, { idea: "test idea" });
    expect(output.options).toEqual(result.options);
  });

  it("generates fallback options when options array is empty", () => {
    const result: LaunchSessionTurnResult = {
      assistantMessage: "Test",
      suggestedCompanyName: "Co",
      brief: baseBrief,
      readiness: { score: 70, ready: false, blockers: [], strengths: [], nextBestQuestion: null },
      options: [],
    };
    const output = ensureFallbackOptions(result, { idea: "AI assistant for roofing companies" });
    expect(output.options.length).toBeGreaterThanOrEqual(2);
    expect(output.options.length).toBeLessThanOrEqual(3);
    for (const opt of output.options) {
      expect(opt.title).toBeTruthy();
      expect(opt.description).toBeTruthy();
      expect(opt.founderReply).toBeTruthy();
    }
  });

  it("generates readiness-based generic options when brief is fully populated", () => {
    // When all brief fields are filled, buildFallbackContinuationOptions returns kickoff.options
    // which may also be filled (for general category) — but if all fields ARE non-placeholder,
    // the function should still produce options
    const result: LaunchSessionTurnResult = {
      assistantMessage: "All set",
      suggestedCompanyName: "Co",
      brief: baseBrief,
      readiness: { score: 85, ready: true, blockers: [], strengths: ["Strong"], nextBestQuestion: null },
      options: [],
    };
    const output = ensureFallbackOptions(result, { idea: "AI assistant for roofing companies" });
    expect(output.options.length).toBeGreaterThanOrEqual(2);
  });

  it("generates low-readiness options when score < 50 and all fields populated", () => {
    const result: LaunchSessionTurnResult = {
      assistantMessage: "Needs work",
      suggestedCompanyName: "Co",
      brief: baseBrief,
      readiness: { score: 30, ready: false, blockers: ["Weak"], strengths: [], nextBestQuestion: null },
      options: [],
    };
    const output = ensureFallbackOptions(result, { idea: "AI assistant for roofing companies" });
    expect(output.options.length).toBeGreaterThanOrEqual(2);
  });

  it("generates brief-gap-based options when targetCustomer is missing", () => {
    const incompleteBrief = { ...baseBrief, targetCustomer: "" };
    const result: LaunchSessionTurnResult = {
      assistantMessage: "Need buyer",
      suggestedCompanyName: "Co",
      brief: incompleteBrief,
      readiness: { score: 40, ready: false, blockers: [], strengths: [], nextBestQuestion: null },
      options: [],
    };
    const output = ensureFallbackOptions(result, { idea: "AI assistant" });
    expect(output.options.length).toBeGreaterThanOrEqual(2);
    // Should produce buyer-narrowing options
    const titles = output.options.map((o) => o.title.toLowerCase());
    expect(titles.some((t) => t.includes("buyer") || t.includes("narrow") || t.includes("market") || t.includes("urgency"))).toBe(true);
  });
});

describe("empty options get fallback via SSE streaming handler", () => {
  it("done event always contains options even when Opus returns empty", async () => {
    const emptyOptionsResult = makeResultWithEmptyOptions();
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(emptyOptionsResult)());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "EmptyOptCo",
          idea: "AI assistant for storm-damage roofing companies to recover missed leads.",
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
    expect(session.processing).toBe(false);

    // The last assistant message should have options despite Opus returning []
    const lastAssistant = session.messages.findLast((m: any) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant.options.length).toBeGreaterThanOrEqual(2);
    for (const opt of lastAssistant.options) {
      expect(opt.title).toBeTruthy();
      expect(opt.description).toBeTruthy();
      expect(opt.founderReply).toBeTruthy();
    }
  });

  it("preserves Opus options when they are non-empty", async () => {
    const withOptions = makeResultWithEmptyOptions();
    withOptions.result.options = [
      { title: "Go narrow", description: "Focus first.", founderReply: "Go narrow." },
      { title: "Go wide", description: "Explore more.", founderReply: "Go wide." },
    ];
    generateLaunchSessionTurnStreamingMock.mockReturnValueOnce(makeStreamingGenerator(withOptions)());
    const { env } = makeEnv();
    const ctx = new TestExecutionContext();

    const createResponse = await handleCreateLaunchSession(
      makeRequest("https://api.aicombinator.live/api/launch-sessions", {
        method: "POST",
        body: JSON.stringify({
          companyName: "KeepOptCo",
          idea: "AI assistant for storm-damage roofing companies to recover missed leads.",
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
    const session = doneEvent?.session as any;
    const lastAssistant = session.messages.findLast((m: any) => m.role === "assistant");
    expect(lastAssistant.options).toHaveLength(2);
    expect(lastAssistant.options[0].title).toBe("Go narrow");
  });
});
