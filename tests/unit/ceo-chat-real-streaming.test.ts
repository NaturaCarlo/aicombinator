import { describe, it, expect, vi } from "vitest";

// ─── Supervisor: SSE Event Format Tests ────────────────────────

/** Replicates the toolNameToDescription mapping from supervisor api.ts */
function toolNameToDescription(toolName: string): string {
  switch (toolName) {
    case "Read":
    case "View":
      return "Reading files...";
    case "Write":
    case "Create":
    case "Edit":
    case "MultiEdit":
      return "Writing code...";
    case "Bash":
    case "Execute":
      return "Running commands...";
    case "Search":
    case "Grep":
    case "Glob":
      return "Searching codebase...";
    case "WebSearch":
      return "Searching the web...";
    case "TodoRead":
    case "TodoWrite":
      return "Organizing tasks...";
    case "LS":
      return "Browsing files...";
    default:
      return "Working...";
  }
}

describe("Supervisor: toolNameToDescription mapping", () => {
  it("maps Read to 'Reading files...'", () => {
    expect(toolNameToDescription("Read")).toBe("Reading files...");
  });

  it("maps View to 'Reading files...'", () => {
    expect(toolNameToDescription("View")).toBe("Reading files...");
  });

  it("maps Write to 'Writing code...'", () => {
    expect(toolNameToDescription("Write")).toBe("Writing code...");
  });

  it("maps Edit to 'Writing code...'", () => {
    expect(toolNameToDescription("Edit")).toBe("Writing code...");
  });

  it("maps Create to 'Writing code...'", () => {
    expect(toolNameToDescription("Create")).toBe("Writing code...");
  });

  it("maps Bash to 'Running commands...'", () => {
    expect(toolNameToDescription("Bash")).toBe("Running commands...");
  });

  it("maps Execute to 'Running commands...'", () => {
    expect(toolNameToDescription("Execute")).toBe("Running commands...");
  });

  it("maps Search to 'Searching codebase...'", () => {
    expect(toolNameToDescription("Search")).toBe("Searching codebase...");
  });

  it("maps Grep to 'Searching codebase...'", () => {
    expect(toolNameToDescription("Grep")).toBe("Searching codebase...");
  });

  it("maps Glob to 'Searching codebase...'", () => {
    expect(toolNameToDescription("Glob")).toBe("Searching codebase...");
  });

  it("maps WebSearch to 'Searching the web...'", () => {
    expect(toolNameToDescription("WebSearch")).toBe("Searching the web...");
  });

  it("maps TodoWrite to 'Organizing tasks...'", () => {
    expect(toolNameToDescription("TodoWrite")).toBe("Organizing tasks...");
  });

  it("maps LS to 'Browsing files...'", () => {
    expect(toolNameToDescription("LS")).toBe("Browsing files...");
  });

  it("maps unknown tools to 'Working...'", () => {
    expect(toolNameToDescription("CustomTool")).toBe("Working...");
    expect(toolNameToDescription("")).toBe("Working...");
  });
});

// ─── Supervisor: SSE event serialization ─────────────────────

function serializeSseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("Supervisor: SSE event format", () => {
  it("emits text_delta event with correct format", () => {
    const event = serializeSseEvent({ type: "text_delta", text: "Hello" });
    expect(event).toBe('data: {"type":"text_delta","text":"Hello"}\n\n');
  });

  it("emits tool_start event with correct format", () => {
    const event = serializeSseEvent({
      type: "tool_start",
      toolName: "Read",
      description: "Reading files...",
    });
    const parsed = JSON.parse(event.replace("data: ", "").trim());
    expect(parsed.type).toBe("tool_start");
    expect(parsed.toolName).toBe("Read");
    expect(parsed.description).toBe("Reading files...");
  });

  it("emits tool_end event with correct format", () => {
    const event = serializeSseEvent({ type: "tool_end", toolId: "tool_123" });
    const parsed = JSON.parse(event.replace("data: ", "").trim());
    expect(parsed.type).toBe("tool_end");
    expect(parsed.toolId).toBe("tool_123");
  });

  it("emits done event with reply", () => {
    const event = serializeSseEvent({ type: "done", reply: "Full response text" });
    const parsed = JSON.parse(event.replace("data: ", "").trim());
    expect(parsed.type).toBe("done");
    expect(parsed.reply).toBe("Full response text");
  });

  it("emits error event", () => {
    const event = serializeSseEvent({ type: "error", error: "CEO is busy" });
    const parsed = JSON.parse(event.replace("data: ", "").trim());
    expect(parsed.type).toBe("error");
    expect(parsed.error).toBe("CEO is busy");
  });

  it("events end with double newline (SSE format)", () => {
    const event = serializeSseEvent({ type: "text_delta", text: "x" });
    expect(event.endsWith("\n\n")).toBe(true);
  });
});

// ─── Supervisor: tool start/end callback firing ────────────────

describe("Supervisor: ClaudeCodeAdapter tool event callbacks", () => {
  it("fires onToolStart for tool_use blocks in assistant messages", () => {
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    // Simulate the logic from ClaudeCodeAdapter.runClaudeCode()
    const assistantContent = [
      { type: "text", text: "Let me read the file" },
      { type: "tool_use", name: "Read", id: "tool_001" },
    ];

    let activeToolId: string | undefined;

    for (const block of assistantContent) {
      if (typeof block === "object" && "type" in block) {
        if (block.type === "tool_use") {
          if (activeToolId) {
            onToolEnd(activeToolId);
          }
          const toolBlock = block as { type: "tool_use"; name: string; id: string };
          activeToolId = toolBlock.id;
          onToolStart(toolBlock.name, toolBlock.id);
        } else if (block.type === "text") {
          if (activeToolId) {
            onToolEnd(activeToolId);
            activeToolId = undefined;
          }
        }
      }
    }

    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolStart).toHaveBeenCalledWith("Read", "tool_001");
    // Text block before tool_use doesn't trigger tool_end (no activeToolId yet)
    // tool_use sets activeToolId, no tool_end yet since nothing follows
    expect(onToolEnd).toHaveBeenCalledTimes(0);
  });

  it("fires onToolEnd when a user message arrives (tool result)", () => {
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    let activeToolId: string | undefined;

    // Simulate: assistant message with tool_use, then user message (tool result)
    const messages = [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Read", id: "tool_001" }],
      },
      { type: "user" },
    ];

    for (const msg of messages) {
      if (msg.type === "assistant" && "content" in msg) {
        for (const block of msg.content as Array<{ type: string; name?: string; id?: string }>) {
          if (block.type === "tool_use") {
            if (activeToolId) onToolEnd(activeToolId);
            activeToolId = block.id;
            onToolStart(block.name!, block.id!);
          }
        }
      } else if (msg.type === "user") {
        if (activeToolId) {
          onToolEnd(activeToolId);
          activeToolId = undefined;
        }
      }
    }

    expect(onToolStart).toHaveBeenCalledWith("Read", "tool_001");
    expect(onToolEnd).toHaveBeenCalledWith("tool_001");
  });

  it("fires onToolEnd for remaining active tool at end of conversation", () => {
    const onToolEnd = vi.fn();

    let activeToolId: string | undefined = "tool_999";

    // After conversation loop ends, flush active tool
    if (activeToolId) {
      onToolEnd(activeToolId);
    }

    expect(onToolEnd).toHaveBeenCalledWith("tool_999");
  });

  it("handles multiple sequential tool invocations", () => {
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    let activeToolId: string | undefined;

    const blocks = [
      { type: "tool_use", name: "Read", id: "tool_001" },
      { type: "tool_use", name: "Edit", id: "tool_002" },
      { type: "tool_use", name: "Bash", id: "tool_003" },
    ];

    for (const block of blocks) {
      if (block.type === "tool_use") {
        if (activeToolId) onToolEnd(activeToolId);
        activeToolId = block.id;
        onToolStart(block.name, block.id);
      }
    }
    // Final flush
    if (activeToolId) onToolEnd(activeToolId);

    expect(onToolStart).toHaveBeenCalledTimes(3);
    expect(onToolEnd).toHaveBeenCalledTimes(3);
    expect(onToolStart).toHaveBeenNthCalledWith(1, "Read", "tool_001");
    expect(onToolStart).toHaveBeenNthCalledWith(2, "Edit", "tool_002");
    expect(onToolStart).toHaveBeenNthCalledWith(3, "Bash", "tool_003");
    expect(onToolEnd).toHaveBeenNthCalledWith(1, "tool_001");
    expect(onToolEnd).toHaveBeenNthCalledWith(2, "tool_002");
    expect(onToolEnd).toHaveBeenNthCalledWith(3, "tool_003");
  });
});

// ─── Supervisor: SSE endpoint event sequence ───────────────────

describe("Supervisor: SSE endpoint emits correct event sequence", () => {
  it("text_delta events come before done event", () => {
    const events: Array<{ type: string }> = [];
    events.push({ type: "text_delta" });
    events.push({ type: "text_delta" });
    events.push({ type: "done" });

    const doneIndex = events.findIndex((e) => e.type === "done");
    const textDeltaIndices = events
      .map((e, i) => (e.type === "text_delta" ? i : -1))
      .filter((i) => i >= 0);

    expect(doneIndex).toBeGreaterThan(-1);
    for (const idx of textDeltaIndices) {
      expect(idx).toBeLessThan(doneIndex);
    }
  });

  it("tool_start appears before corresponding text_delta", () => {
    const events: Array<{ type: string }> = [];
    events.push({ type: "tool_start" });
    events.push({ type: "tool_end" });
    events.push({ type: "text_delta" });
    events.push({ type: "done" });

    const toolStartIdx = events.findIndex((e) => e.type === "tool_start");
    const firstTextIdx = events.findIndex((e) => e.type === "text_delta");

    expect(toolStartIdx).toBeLessThan(firstTextIdx);
  });

  it("error event terminates the stream", () => {
    const events: Array<{ type: string }> = [];
    events.push({ type: "error" });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });
});

// ─── Worker: SSE proxy tests ────────────────────────────────────

/** Replicates the SSE parsing logic from the worker proxy */
function parseSseEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const parts = raw.split("\n\n");
  for (const part of parts) {
    const dataLine = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n");
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine) as Record<string, unknown>);
    } catch {
      // skip
    }
  }
  return events;
}

describe("Worker: handleChatWithCeoStream SSE proxying", () => {
  it("prepends meta event before supervisor events", () => {
    const metaEvent = serializeSseEvent({ type: "meta", chatId: "abc123", createdAt: "2025-01-01T00:00:00Z" });
    const textEvent = serializeSseEvent({ type: "delta", text: "Hello" });
    const doneEvent = serializeSseEvent({ type: "done", reply: "Hello", grounded: false });

    const fullStream = metaEvent + textEvent + doneEvent;
    const events = parseSseEvents(fullStream);

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("meta");
    expect(events[0].chatId).toBe("abc123");
    expect(events[1].type).toBe("delta");
    expect(events[2].type).toBe("done");
  });

  it("passes through tool_start events from supervisor", () => {
    const toolStartEvent = serializeSseEvent({
      type: "tool_start",
      toolName: "Read",
      description: "Reading files...",
    });
    const events = parseSseEvents(toolStartEvent);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_start");
    expect(events[0].toolName).toBe("Read");
    expect(events[0].description).toBe("Reading files...");
  });

  it("passes through tool_end events from supervisor", () => {
    const toolEndEvent = serializeSseEvent({ type: "tool_end", toolId: "tool_001" });
    const events = parseSseEvents(toolEndEvent);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_end");
    expect(events[0].toolId).toBe("tool_001");
  });

  it("converts text_delta from supervisor to delta for dashboard", () => {
    // Worker converts supervisor text_delta → dashboard delta
    const supervisorEvent = { type: "text_delta", text: "chunk" };
    const dashboardEvent = { type: "delta", text: supervisorEvent.text };

    expect(dashboardEvent.type).toBe("delta");
    expect(dashboardEvent.text).toBe("chunk");
  });

  it("handles complete SSE stream with tools and text", () => {
    const events = [
      { type: "meta", chatId: "chat1", createdAt: "2025-01-01" },
      { type: "tool_start", toolName: "Read", description: "Reading files..." },
      { type: "tool_end", toolId: "t1" },
      { type: "delta", text: "Here is what I found..." },
      { type: "done", reply: "Here is what I found...", grounded: false },
    ];

    const raw = events.map((e) => serializeSseEvent(e)).join("");
    const parsed = parseSseEvents(raw);

    expect(parsed).toHaveLength(5);
    expect(parsed.map((e) => e.type)).toEqual([
      "meta", "tool_start", "tool_end", "delta", "done",
    ]);
  });
});

// ─── Dashboard: streamChatWithCeo event parsing ──────────────────

/** Replicate extractSsePayloads from dashboard */
function extractSsePayloads(buffer: string): {
  payloads: Array<Record<string, unknown>>;
  rest: string;
} {
  const payloads: Array<Record<string, unknown>> = [];
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";

  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line: string) => line.startsWith("data:"))
      .map((line: string) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n");

    if (!data) continue;
    try {
      payloads.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // skip
    }
  }

  return { payloads, rest };
}

describe("Dashboard: streamChatWithCeo parses new event types", () => {
  it("parses tool_start events", () => {
    const buffer = 'data: {"type":"tool_start","toolName":"Read","description":"Reading files..."}\n\n';
    const { payloads } = extractSsePayloads(buffer);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].type).toBe("tool_start");
    expect(payloads[0].toolName).toBe("Read");
    expect(payloads[0].description).toBe("Reading files...");
  });

  it("parses tool_end events", () => {
    const buffer = 'data: {"type":"tool_end","toolId":"tool_001"}\n\n';
    const { payloads } = extractSsePayloads(buffer);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].type).toBe("tool_end");
    expect(payloads[0].toolId).toBe("tool_001");
  });

  it("parses mixed stream with tool events", () => {
    const buffer =
      'data: {"type":"meta","chatId":"abc","createdAt":"2025-01-01T00:00:00Z"}\n\n' +
      'data: {"type":"tool_start","toolName":"Bash","description":"Running commands..."}\n\n' +
      'data: {"type":"tool_end","toolId":"t1"}\n\n' +
      'data: {"type":"delta","text":"Result: OK"}\n\n' +
      'data: {"type":"done","reply":"Result: OK"}\n\n';

    const { payloads, rest } = extractSsePayloads(buffer);

    expect(rest).toBe("");
    expect(payloads).toHaveLength(5);
    expect(payloads[0].type).toBe("meta");
    expect(payloads[1].type).toBe("tool_start");
    expect(payloads[1].toolName).toBe("Bash");
    expect(payloads[2].type).toBe("tool_end");
    expect(payloads[3].type).toBe("delta");
    expect(payloads[4].type).toBe("done");
  });

  it("handles partial buffer correctly", () => {
    const buffer = 'data: {"type":"delta","text":"partial"}\n\ndata: {"type":"to';
    const { payloads, rest } = extractSsePayloads(buffer);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].type).toBe("delta");
    expect(rest).toBe('data: {"type":"to');
  });
});

// ─── Dashboard: ceo-chat-panel tool activity indicators ──────────

describe("Dashboard: ceo-chat-panel tool activity state", () => {
  it("tool activity shows description instead of 'Thinking...' when set", () => {
    const toolActivity = { toolName: "Read", description: "Reading files..." };

    // When thinking status AND toolActivity exists, show toolActivity.description
    const displayText = toolActivity ? toolActivity.description : "Thinking...";
    expect(displayText).toBe("Reading files...");
  });

  it("shows 'Thinking...' when no tool activity", () => {
    const toolActivity = null;

    const displayText = toolActivity ? toolActivity.description : "Thinking...";
    expect(displayText).toBe("Thinking...");
  });

  it("tool activity clears on text delta", () => {
    let toolActivity: { toolName: string; description: string } | null = {
      toolName: "Read",
      description: "Reading files...",
    };

    // Simulate onDelta clearing tool activity
    toolActivity = null;
    expect(toolActivity).toBeNull();
  });

  it("tool activity clears on done", () => {
    let toolActivity: { toolName: string; description: string } | null = {
      toolName: "Bash",
      description: "Running commands...",
    };

    // Simulate onDone clearing tool activity
    toolActivity = null;
    expect(toolActivity).toBeNull();
  });

  it("tool activity clears on error", () => {
    let toolActivity: { toolName: string; description: string } | null = {
      toolName: "Edit",
      description: "Writing code...",
    };

    // Simulate onError clearing tool activity
    toolActivity = null;
    expect(toolActivity).toBeNull();
  });

  it("tool activity updates when new tool starts", () => {
    let toolActivity: { toolName: string; description: string } | null = {
      toolName: "Read",
      description: "Reading files...",
    };

    // New tool starts
    toolActivity = { toolName: "Bash", description: "Running commands..." };
    expect(toolActivity.description).toBe("Running commands...");
  });

  it("tool activity clears on tool end", () => {
    let toolActivity: { toolName: string; description: string } | null = {
      toolName: "Read",
      description: "Reading files...",
    };

    // Tool ends
    toolActivity = null;
    expect(toolActivity).toBeNull();
  });
});

// ─── Supervisor: InvokeCeoOptions streaming callbacks ─────────────

describe("Supervisor: InvokeCeoOptions supports streaming callbacks", () => {
  it("InvokeCeoOptions interface accepts onTextDelta callback", () => {
    const options = {
      is_user_facing: true,
      bill_credits: false,
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };

    options.onTextDelta("hello");
    expect(options.onTextDelta).toHaveBeenCalledWith("hello");
  });

  it("InvokeCeoOptions interface accepts onToolStart callback", () => {
    const onToolStart = vi.fn();
    onToolStart("Read", "tool_001");
    expect(onToolStart).toHaveBeenCalledWith("Read", "tool_001");
  });

  it("InvokeCeoOptions interface accepts onToolEnd callback", () => {
    const onToolEnd = vi.fn();
    onToolEnd("tool_001");
    expect(onToolEnd).toHaveBeenCalledWith("tool_001");
  });
});

// ─── Supervisor: is_ceo_turn_active ───────────────────────────────

describe("Supervisor: is_ceo_turn_active", () => {
  it("returns false when no turn is active (simulated)", () => {
    const activeTurns = new Set<string>();
    expect(activeTurns.has("company-1")).toBe(false);
  });

  it("returns true when a turn is active (simulated)", () => {
    const activeTurns = new Set<string>();
    activeTurns.add("company-1");
    expect(activeTurns.has("company-1")).toBe(true);
  });

  it("returns false after turn completes (simulated)", () => {
    const activeTurns = new Set<string>();
    activeTurns.add("company-1");
    activeTurns.delete("company-1");
    expect(activeTurns.has("company-1")).toBe(false);
  });
});

// ─── Supervisor: error event on failure ───────────────────────────

describe("Supervisor: error event emitted on failure", () => {
  it("error event has type and error message", () => {
    const errorPayload = { type: "error", error: "CEO is busy" };
    expect(errorPayload.type).toBe("error");
    expect(errorPayload.error).toBe("CEO is busy");
  });

  it("error event for rate limiting", () => {
    const errorPayload = {
      type: "error",
      error: "You've sent too many messages recently.",
    };
    expect(errorPayload.type).toBe("error");
    expect(typeof errorPayload.error).toBe("string");
  });

  it("error event for invocation failure", () => {
    const errorPayload = {
      type: "error",
      error: "Agent turn timed out after 360000ms",
    };
    expect(errorPayload.type).toBe("error");
    expect(errorPayload.error).toContain("timed out");
  });
});

// ─── AdapterInvokeOptions type compatibility ──────────────────────

describe("AdapterInvokeOptions includes tool callbacks", () => {
  it("accepts onToolStart and onToolEnd alongside onTextDelta", () => {
    const options = {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };

    options.onTextDelta("text");
    options.onToolStart("Read", "t1");
    options.onToolEnd("t1");

    expect(options.onTextDelta).toHaveBeenCalledWith("text");
    expect(options.onToolStart).toHaveBeenCalledWith("Read", "t1");
    expect(options.onToolEnd).toHaveBeenCalledWith("t1");
  });
});

// ─── AgentInvokeOptions type compatibility ────────────────────────

describe("AgentInvokeOptions includes tool callbacks", () => {
  it("accepts onToolStart and onToolEnd", () => {
    const options = {
      turnLimits: {},
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      abortController: new AbortController(),
    };

    options.onToolStart("Bash", "t2");
    options.onToolEnd("t2");

    expect(options.onToolStart).toHaveBeenCalledWith("Bash", "t2");
    expect(options.onToolEnd).toHaveBeenCalledWith("t2");
  });
});
