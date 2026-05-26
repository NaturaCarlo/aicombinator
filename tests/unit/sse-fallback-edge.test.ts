import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for the SSE fallback edge case:
 * - streamLaunchSession should surface incomplete stream termination
 * - The caller should trigger polling fallback when done event is missing
 */

// Helper: create a ReadableStream from SSE event strings
function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

// Helper: create a mock Response with SSE body
function mockSseResponse(events: string[]): Response {
  return new Response(createSseStream(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("streamLaunchSession incomplete stream detection", () => {
  let streamLaunchSession: typeof import("../../dashboard/src/lib/api.ts").streamLaunchSession;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Dynamic import to get fresh module
    const mod = await import("../../dashboard/src/lib/api.ts");
    streamLaunchSession = mod.streamLaunchSession;
  });

  it("returns complete: true when stream includes a done event", async () => {
    const doneSession = {
      id: "session-1",
      processing: false,
      messages: [{ role: "assistant", content: "Hello" }],
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockSseResponse([
        `data: ${JSON.stringify({ type: "token", content: "Hello" })}\n\n`,
        `data: ${JSON.stringify({ type: "done", session: doneSession })}\n\n`,
      ]),
    );

    const handlers = {
      onToken: vi.fn(),
      onDone: vi.fn(),
    };

    const result = await streamLaunchSession("session-1", "test-token", handlers);

    expect(handlers.onDone).toHaveBeenCalledWith(doneSession);
    expect(result).toEqual({ complete: true });
  });

  it("returns complete: false when stream ends without done event (early server close)", async () => {
    // Server sends tokens but closes stream before sending done
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockSseResponse([
        `data: ${JSON.stringify({ type: "token", content: "Partial response" })}\n\n`,
        `data: ${JSON.stringify({ type: "processing", session: { id: "session-1", processing: true } })}\n\n`,
        // No done event — stream just closes
      ]),
    );

    const handlers = {
      onToken: vi.fn(),
      onProcessing: vi.fn(),
      onDone: vi.fn(),
    };

    const result = await streamLaunchSession("session-1", "test-token", handlers);

    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(result).toEqual({ complete: false });
  });

  it("returns complete: false when stream is empty (no events at all)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockSseResponse([]),
    );

    const handlers = {
      onDone: vi.fn(),
    };

    const result = await streamLaunchSession("session-1", "test-token", handlers);

    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(result).toEqual({ complete: false });
  });

  it("returns complete: false when AbortError occurs during stream read", async () => {
    // Create a stream that errors when aborted
    const controller = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        streamController = ctrl;
        const encoder = new TextEncoder();
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "token", content: "start" })}\n\n`));
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const handlers = {
      onToken: vi.fn(),
      onDone: vi.fn(),
    };

    // Close the stream after a brief delay to simulate early server close
    setTimeout(() => {
      streamController.close();
    }, 50);

    const result = await streamLaunchSession("session-1", "test-token", handlers, controller.signal);

    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(result).toEqual({ complete: false });
  }, 10000);

  it("returns complete: false when AbortError occurs during fetch", async () => {
    const controller = new AbortController();

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      // Simulate abort during fetch
      controller.abort();
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const handlers = {
      onDone: vi.fn(),
    };

    const result = await streamLaunchSession("session-1", "test-token", handlers, controller.signal);

    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(result).toEqual({ complete: false });
  });

  it("still throws non-abort errors during fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const handlers = {
      onDone: vi.fn(),
    };

    await expect(
      streamLaunchSession("session-1", "test-token", handlers),
    ).rejects.toThrow("Network error");
  });

  it("still throws on non-ok responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not found", { status: 404 }),
    );

    const handlers = {
      onDone: vi.fn(),
    };

    await expect(
      streamLaunchSession("session-1", "test-token", handlers),
    ).rejects.toThrow();
  });

  it("returns complete: false when only token events are sent before close", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockSseResponse([
        `data: ${JSON.stringify({ type: "token", content: "chunk 1" })}\n\n`,
        `data: ${JSON.stringify({ type: "token", content: "chunk 2" })}\n\n`,
        `data: ${JSON.stringify({ type: "token", content: "chunk 3" })}\n\n`,
      ]),
    );

    const handlers = {
      onToken: vi.fn(),
      onDone: vi.fn(),
    };

    const result = await streamLaunchSession("session-1", "test-token", handlers);

    expect(handlers.onToken).toHaveBeenCalledTimes(3);
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(result).toEqual({ complete: false });
  });
});
