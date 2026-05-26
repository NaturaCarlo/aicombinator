import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateLaunchSessionTurnStreaming } from "../../worker/src/provisioning/launch-session.ts";
import type { StreamingLaunchTurnEvent } from "../../worker/src/provisioning/launch-session.ts";

/**
 * Tests for VAL-BE-SSE-006 and VAL-BE-SSE-007:
 * Non-streaming fallback must emit at least one token event with the full assistant message
 * BEFORE the result event. This ensures the frontend receives content through the normal
 * streaming pipeline even when all streaming providers fail.
 */

const MOCK_TOOL_RESPONSE = {
  assistantMessage: "## Storm Recovery\n\nWe should start with inbound lead recovery.",
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
};

function makeOpenRouterToolCallResponse(toolResponse: Record<string, unknown> = MOCK_TOOL_RESPONSE) {
  return {
    id: "gen-test-123",
    model: "anthropic/claude-sonnet-4-20250514",
    provider: "Anthropic",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_test_1",
              type: "function",
              function: {
                name: "submit_launch_turn",
                arguments: JSON.stringify(toolResponse),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
  };
}

function makeInput(envOverrides: Partial<Record<string, string>> = {}) {
  return {
    env: {
      OPENROUTER_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      FRONTEND_URL: "https://aicombinator.live",
      ...envOverrides,
    } as any,
    mode: "normal" as const,
    companyName: "PatchPilot",
    idea: "AI assistant for storm-damage roofing companies to recover missed leads and book work faster.",
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
      firstMilestone: "Launch a live lead-recovery funnel",
      openQuestions: [],
      autonomyConfidence: 82,
    },
    messages: [
      { role: "founder" as const, content: "I want to build an AI assistant for roofing companies." },
    ],
  };
}

async function collectEvents(gen: AsyncGenerator<StreamingLaunchTurnEvent>): Promise<StreamingLaunchTurnEvent[]> {
  const events: StreamingLaunchTurnEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("non-streaming fallback emits token events (VAL-BE-SSE-006, VAL-BE-SSE-007)", () => {
  it("emits token event before result when both streaming providers fail and non-streaming succeeds", async () => {
    // Both Anthropic and OpenRouter streaming fail, then non-streaming fallback via OpenRouter succeeds
    globalThis.fetch = vi.fn(async (urlArg: string | URL | Request, init?: RequestInit) => {
      const url = typeof urlArg === "string" ? urlArg : urlArg instanceof URL ? urlArg.toString() : urlArg.url;
      const body = init?.body ? JSON.parse(init.body as string) : {};

      if (url.includes("anthropic.com")) {
        // Anthropic streaming fails
        return new Response(JSON.stringify({ error: { message: "Server error" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("openrouter.ai") && body.stream === true) {
        // OpenRouter streaming fails
        return new Response(JSON.stringify({ error: { message: "Streaming unavailable" } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Non-streaming OpenRouter fallback succeeds
      return new Response(JSON.stringify(makeOpenRouterToolCallResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const input = makeInput({
      ANTHROPIC_API_KEY: "sk-test-fake-key",
      OPENROUTER_API_KEY: "sk-test-fake-key",
    });
    const events = await collectEvents(generateLaunchSessionTurnStreaming(input));

    // Must have at least one token event
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);

    // Token event must contain the full assistant message
    const tokenContent = tokenEvents.map((e) => (e as { type: "token"; content: string }).content).join("");
    expect(tokenContent).toBe(MOCK_TOOL_RESPONSE.assistantMessage);

    // Token must precede result
    const tokenIndex = events.findIndex((e) => e.type === "token");
    const resultIndex = events.findIndex((e) => e.type === "result");
    expect(tokenIndex).toBeLessThan(resultIndex);

    // Result event should be present and ok
    const resultEvent = events.find((e) => e.type === "result") as { type: "result"; generation: any };
    expect(resultEvent.generation.ok).toBe(true);
  });

  it("emits token event before result when OpenRouter streaming returns non-OK and non-streaming succeeds", async () => {
    // Only OpenRouter key set — OpenRouter streaming returns 502, non-streaming succeeds
    globalThis.fetch = vi.fn(async (_urlArg: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};

      if (body.stream === true) {
        // Streaming request fails
        return new Response(JSON.stringify({ error: { message: "Bad gateway" } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Non-streaming succeeds
      return new Response(JSON.stringify(makeOpenRouterToolCallResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const input = makeInput({ OPENROUTER_API_KEY: "sk-test-fake-key" });
    const events = await collectEvents(generateLaunchSessionTurnStreaming(input));

    const tokenEvents = events.filter((e) => e.type === "token");
    const resultEvents = events.filter((e) => e.type === "result");

    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(resultEvents.length).toBe(1);

    const tokenContent = tokenEvents.map((e) => (e as { type: "token"; content: string }).content).join("");
    expect(tokenContent).toBe(MOCK_TOOL_RESPONSE.assistantMessage);

    // Token must precede result
    const tokenIndex = events.findIndex((e) => e.type === "token");
    const resultIndex = events.findIndex((e) => e.type === "result");
    expect(tokenIndex).toBeLessThan(resultIndex);
  });

  it("does not emit token event when non-streaming fallback also fails", async () => {
    // No API keys — non-streaming also fails (no keys to use)
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "Service unavailable" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const input = makeInput(); // no API keys
    const events = await collectEvents(generateLaunchSessionTurnStreaming(input));

    // No token event since non-streaming also fails (no API keys means ok: false)
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBe(0);

    // Still has result event
    const resultEvents = events.filter((e) => e.type === "result");
    expect(resultEvents.length).toBe(1);
    const resultEvent = resultEvents[0] as { type: "result"; generation: any };
    expect(resultEvent.generation.ok).toBe(false);
  });

  it("token event contains entire assistant message as a single chunk", async () => {
    const longMessage = "## Detailed Analysis\n\n" + "This is a long response.".repeat(50);
    const customResponse = { ...MOCK_TOOL_RESPONSE, assistantMessage: longMessage };

    // OpenRouter streaming fails, non-streaming succeeds with custom long message
    globalThis.fetch = vi.fn(async (_urlArg: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};

      if (body.stream === true) {
        return new Response(JSON.stringify({ error: { message: "Stream error" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(makeOpenRouterToolCallResponse(customResponse)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const input = makeInput({ OPENROUTER_API_KEY: "sk-test-fake-key" });
    const events = await collectEvents(generateLaunchSessionTurnStreaming(input));

    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBe(1);
    // The normalization may trim the message; verify content matches the result's assistantMessage
    const resultEvent = events.find((e) => e.type === "result") as { type: "result"; generation: any };
    expect((tokenEvents[0] as { type: "token"; content: string }).content).toBe(
      resultEvent.generation.result.assistantMessage,
    );
    expect((tokenEvents[0] as { type: "token"; content: string }).content).toContain("## Detailed Analysis");
  });

  it("emits token event when Anthropic fails and non-streaming OpenRouter fallback succeeds", async () => {
    // Anthropic key set, OpenRouter key set — Anthropic streaming fails, OpenRouter streaming fails,
    // then non-streaming OpenRouter succeeds
    let callCount = 0;
    globalThis.fetch = vi.fn(async (urlArg: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const url = typeof urlArg === "string" ? urlArg : urlArg instanceof URL ? urlArg.toString() : urlArg.url;
      const body = init?.body ? JSON.parse(init.body as string) : {};

      if (url.includes("anthropic.com")) {
        return new Response(JSON.stringify({ error: { message: "Rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("openrouter.ai") && body.stream === true) {
        return new Response(JSON.stringify({ error: { message: "Streaming down" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(makeOpenRouterToolCallResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const input = makeInput({
      ANTHROPIC_API_KEY: "sk-test-anthropic",
      OPENROUTER_API_KEY: "sk-test-openrouter",
    });
    const events = await collectEvents(generateLaunchSessionTurnStreaming(input));

    const tokenEvents = events.filter((e) => e.type === "token");
    const resultEvents = events.filter((e) => e.type === "result");

    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(resultEvents.length).toBe(1);

    const tokenContent = tokenEvents.map((e) => (e as { type: "token"; content: string }).content).join("");
    expect(tokenContent).toContain("## Storm Recovery");

    // Token must precede result
    const tokenIndex = events.findIndex((e) => e.type === "token");
    const resultIndex = events.findIndex((e) => e.type === "result");
    expect(tokenIndex).toBeLessThan(resultIndex);
  });
});
