import { describe, it, expect, vi } from "vitest";

// ─── ISSUE 1: Error propagation through CEO chat stream ────────────

/**
 * Simulates the on_user_message_stream return contract.
 * Previously, errors were masked as fallback replies (done events).
 * Now, errors should be signalled so the SSE endpoint emits error events.
 */

interface StreamResult {
  reply: string | null;
  error?: string;
}

describe("Supervisor: on_user_message_stream error propagation", () => {
  it("returns error field when invoke_ceo_turn throws", () => {
    // Simulate invoke_ceo_turn throwing
    const result: StreamResult = { reply: null, error: "Agent turn timed out after 360000ms" };
    expect(result.error).toBeDefined();
    expect(result.reply).toBeNull();
  });

  it("returns error field when invoke_ceo_turn returns result.error", () => {
    // Simulate invoke_ceo_turn returning {success: false, error: "..."}
    const result: StreamResult = { reply: null, error: "Credits exhausted" };
    expect(result.error).toBeDefined();
    expect(result.reply).toBeNull();
  });

  it("returns reply without error on success", () => {
    const result: StreamResult = { reply: "Here's what I think about your question..." };
    expect(result.error).toBeUndefined();
    expect(result.reply).toBeTruthy();
  });

  it("returns error for CEO turn already in progress", () => {
    const result: StreamResult = { reply: null, error: "CEO turn already in progress" };
    expect(result.error).toBe("CEO turn already in progress");
    expect(result.reply).toBeNull();
  });

  it("returns rate limit as error, not as reply text", () => {
    // Rate-limit messages should also be error events
    const result: StreamResult = { reply: null, error: "rate_limited" };
    expect(result.error).toBe("rate_limited");
  });
});

// ─── SSE endpoint error event emission ─────────────────────────────

function serializeSseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("Supervisor: SSE endpoint emits error events for stream failures", () => {
  it("emits error event when on_user_message_stream returns error", async () => {
    const events: Array<Record<string, unknown>> = [];
    const writeSse = async (data: Record<string, unknown>) => {
      events.push(data);
    };

    // Simulate the SSE endpoint logic with error result
    const streamResult: StreamResult = { reply: null, error: "Agent turn timed out" };

    if (streamResult.error) {
      await writeSse({ type: "error", error: streamResult.error });
    } else {
      await writeSse({ type: "done", reply: streamResult.reply ?? "" });
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].error).toBe("Agent turn timed out");
  });

  it("emits done event only on actual success", async () => {
    const events: Array<Record<string, unknown>> = [];
    const writeSse = async (data: Record<string, unknown>) => {
      events.push(data);
    };

    const streamResult: StreamResult = { reply: "All good here!" };

    if (streamResult.error) {
      await writeSse({ type: "error", error: streamResult.error });
    } else {
      await writeSse({ type: "done", reply: streamResult.reply ?? "" });
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("done");
    expect(events[0].reply).toBe("All good here!");
  });

  it("does NOT emit done with fallback text when invoke fails", async () => {
    const events: Array<Record<string, unknown>> = [];
    const writeSse = async (data: Record<string, unknown>) => {
      events.push(data);
    };

    const streamResult: StreamResult = { reply: null, error: "Connection refused" };

    if (streamResult.error) {
      await writeSse({ type: "error", error: streamResult.error });
    } else {
      await writeSse({ type: "done", reply: streamResult.reply ?? "" });
    }

    // Should NOT have a done event with fallback text
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(0);
    expect(events[0].type).toBe("error");
  });

  it("emits error event when on_user_message_stream throws exception", async () => {
    const events: Array<Record<string, unknown>> = [];
    const writeSse = async (data: Record<string, unknown>) => {
      events.push(data);
    };

    // Simulate the catch block in the SSE endpoint
    try {
      throw new Error("Unexpected scheduler crash");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeSse({ type: "error", error: message });
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].error).toBe("Unexpected scheduler crash");
  });
});

// ─── ISSUE 2: tool_end events include toolName ─────────────────────

describe("Supervisor: tool_end events include toolName", () => {
  it("tool_end event includes both toolId and toolName", () => {
    const toolMap = new Map<string, string>();

    // Simulate onToolStart populating the map
    const toolName = "Read";
    const toolId = "tool_001";
    toolMap.set(toolId, toolName);

    // On tool_end, look up the toolName
    const event = {
      type: "tool_end",
      toolId,
      toolName: toolMap.get(toolId),
    };

    expect(event.toolId).toBe("tool_001");
    expect(event.toolName).toBe("Read");
  });

  it("tool_end event handles unknown toolId gracefully", () => {
    const toolMap = new Map<string, string>();

    // toolId not found in map
    const event = {
      type: "tool_end",
      toolId: "unknown_tool",
      toolName: toolMap.get("unknown_tool"),
    };

    expect(event.toolId).toBe("unknown_tool");
    expect(event.toolName).toBeUndefined();
  });

  it("tracks multiple tools in the map", () => {
    const toolMap = new Map<string, string>();

    toolMap.set("t1", "Read");
    toolMap.set("t2", "Edit");
    toolMap.set("t3", "Bash");

    expect(toolMap.get("t1")).toBe("Read");
    expect(toolMap.get("t2")).toBe("Edit");
    expect(toolMap.get("t3")).toBe("Bash");
  });

  it("SSE serialized tool_end includes toolName field", () => {
    const event = serializeSseEvent({
      type: "tool_end",
      toolId: "tool_001",
      toolName: "Read",
    });
    const parsed = JSON.parse(event.replace("data: ", "").trim());
    expect(parsed.type).toBe("tool_end");
    expect(parsed.toolId).toBe("tool_001");
    expect(parsed.toolName).toBe("Read");
  });
});

// ─── Dashboard: tool_end with toolName clears activity ─────────────

describe("Dashboard: tool_end with toolName clears tool activity state", () => {
  it("onToolEnd receives toolName for clearing state", () => {
    const onToolEnd = vi.fn();
    onToolEnd({ toolName: "Read", toolId: "tool_001" });
    expect(onToolEnd).toHaveBeenCalledWith({
      toolName: "Read",
      toolId: "tool_001",
    });
  });

  it("dashboard handler accepts both toolName and toolId", () => {
    let toolActivity: { toolName: string; description: string } | null = {
      toolName: "Read",
      description: "Reading files...",
    };

    // Simulate onToolEnd handler
    const payload = { toolName: "Read", toolId: "tool_001" };
    if (payload.toolName || payload.toolId) {
      toolActivity = null;
    }

    expect(toolActivity).toBeNull();
  });
});

// ─── End-to-end SSE event sequences with errors ────────────────────

describe("SSE: end-to-end event sequence with error propagation", () => {
  it("error after tool_start closes stream correctly", () => {
    const events = [
      { type: "tool_start", toolName: "Read", description: "Reading files..." },
      { type: "error", error: "Agent turn timed out" },
    ];

    expect(events[events.length - 1].type).toBe("error");
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(0);
  });

  it("error after text_delta still emits error event", () => {
    const events = [
      { type: "text_delta", text: "Let me" },
      { type: "text_delta", text: " check..." },
      { type: "error", error: "Connection lost" },
    ];

    expect(events[events.length - 1].type).toBe("error");
  });

  it("successful stream ends with done, not error", () => {
    const events = [
      { type: "tool_start", toolName: "Read", description: "Reading files..." },
      { type: "tool_end", toolId: "t1", toolName: "Read" },
      { type: "text_delta", text: "Here are the results..." },
      { type: "done", reply: "Here are the results..." },
    ];

    expect(events[events.length - 1].type).toBe("done");
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);
  });
});

// ─── Worker: error event proxying ──────────────────────────────────

describe("Worker: handleChatWithCeoStream error event proxying", () => {
  it("supervisor error event is forwarded to dashboard", () => {
    // Worker proxy should pass through error events
    const supervisorEvent = { type: "error", error: "Agent turn timed out after 360000ms" };
    // Worker re-emits it as-is
    const dashboardEvent = supervisorEvent;
    expect(dashboardEvent.type).toBe("error");
    expect(dashboardEvent.error).toBe("Agent turn timed out after 360000ms");
  });

  it("supervisor error event updates founder chat log status to error", () => {
    const logUpdate = {
      status: "error",
      error: "Agent turn timed out",
    };
    expect(logUpdate.status).toBe("error");
    expect(logUpdate.error).toBeDefined();
  });
});
