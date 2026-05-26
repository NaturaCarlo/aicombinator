import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { HttpWebhookAdapter } from "../../supervisor/src/adapters/http-webhook.ts";
import type { AgentRow } from "../../supervisor/src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AgentRow with a webhook URL in metadata. */
function makeAgent(webhookUrl: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-test-001",
    company_id: "company-001",
    blueprint_id: null,
    name: "Test Webhook Agent",
    role: "specialist",
    model_tier: "sonnet",
    status: "idle",
    session_id: null,
    current_task_id: "task-001",
    total_credits: 0,
    created_at: new Date().toISOString(),
    metadata: JSON.stringify({ webhookUrl, adapterType: "http-webhook" }),
    ...overrides,
  };
}

/** Start a temporary HTTP server that invokes `handler` for each request. */
function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("Failed to get server address"));
      }
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HttpWebhookAdapter", () => {
  const adapter = new HttpWebhookAdapter();

  // ------------------------------------------------------------------
  // VAL-ADAPT-005: Successful POST with task payload
  // ------------------------------------------------------------------
  describe("successful POST (VAL-ADAPT-005)", () => {
    let server: Server;
    let port: number;
    let receivedBody: Record<string, unknown> | null = null;
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    beforeAll(async () => {
      ({ server, port } = await startMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          receivedBody = JSON.parse(body) as Record<string, unknown>;
          receivedHeaders = req.headers;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ output: "Task completed successfully", success: true }));
        });
      }));
    });

    afterAll(async () => {
      await closeServer(server);
    });

    it("sends POST with correct payload fields and returns success", async () => {
      const agent = makeAgent(`http://127.0.0.1:${port}/webhook`);
      const result = await adapter.invoke(agent, "Do the task", "/workspace/test", {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      // Verify the request payload
      expect(receivedBody).toEqual({
        prompt: "Do the task",
        agentId: "agent-test-001",
        taskId: "task-001",
        workspaceDir: "/workspace/test",
      });

      // Verify Content-Type header
      expect(receivedHeaders["content-type"]).toBe("application/json");

      // Verify result shape
      expect(result.success).toBe(true);
      expect(result.output).toBe("Task completed successfully");
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.aborted).toBe(false);
      expect(result.toolCallCount).toBe(0);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns all required AgentTurnResult fields", async () => {
      const agent = makeAgent(`http://127.0.0.1:${port}/webhook`);
      const result = await adapter.invoke(agent, "Check fields", "/workspace/test");

      // Verify all AgentTurnResult fields are present
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("tokenUsage");
      expect(result).toHaveProperty("output");
      expect(result).toHaveProperty("aborted");
      expect(result).toHaveProperty("toolCallCount");
      expect(result).toHaveProperty("durationMs");
      expect(result.tokenUsage).toHaveProperty("inputTokens");
      expect(result.tokenUsage).toHaveProperty("outputTokens");
    });
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-006: Timeout handling
  // ------------------------------------------------------------------
  describe("timeout handling (VAL-ADAPT-006)", () => {
    let server: Server;
    let port: number;

    beforeAll(async () => {
      ({ server, port } = await startMockServer((_req, _res) => {
        // Never respond — simulates a hanging server
      }));
    });

    afterAll(async () => {
      await closeServer(server);
    });

    it("returns success:false with timeout error when server does not respond", async () => {
      const agent = makeAgent(`http://127.0.0.1:${port}/webhook`);
      const result = await adapter.invoke(agent, "Long task", "/workspace/test", {
        turnLimits: { turnTimeoutMs: 500 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toMatch(/timeout/i);
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.toolCallCount).toBe(0);
      expect(typeof result.durationMs).toBe("number");
    });
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-007: Non-2xx HTTP response handling
  // ------------------------------------------------------------------
  describe("non-2xx response handling (VAL-ADAPT-007)", () => {
    const statusCodes = [400, 500, 502, 404] as const;

    for (const statusCode of statusCodes) {
      it(`returns success:false with status ${statusCode} in error`, async () => {
        const { server, port } = await startMockServer((req, res) => {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            res.writeHead(statusCode, { "Content-Type": "text/plain" });
            res.end(`Error ${statusCode}`);
          });
        });

        try {
          const agent = makeAgent(`http://127.0.0.1:${port}/webhook`);
          const result = await adapter.invoke(agent, "Fail task", "/workspace/test", {
            turnLimits: { turnTimeoutMs: 5000 },
          });

          expect(result.success).toBe(false);
          expect(result.error).toBeDefined();
          expect(result.error).toContain(String(statusCode));
          expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
          expect(result.toolCallCount).toBe(0);
          expect(typeof result.durationMs).toBe("number");
        } finally {
          await closeServer(server);
        }
      });
    }
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-008: Malformed JSON response handling
  // ------------------------------------------------------------------
  describe("malformed JSON response handling (VAL-ADAPT-008)", () => {
    let server: Server;
    let port: number;

    beforeAll(async () => {
      ({ server, port } = await startMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("not valid json {{{");
        });
      }));
    });

    afterAll(async () => {
      await closeServer(server);
    });

    it("returns success:false with parse error for malformed JSON", async () => {
      const agent = makeAgent(`http://127.0.0.1:${port}/webhook`);
      const result = await adapter.invoke(agent, "Parse fail", "/workspace/test", {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toMatch(/parse|invalid|json/i);
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.toolCallCount).toBe(0);
      expect(typeof result.durationMs).toBe("number");
    });
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-009: Connection refused handling
  // ------------------------------------------------------------------
  describe("connection refused handling (VAL-ADAPT-009)", () => {
    it("returns success:false without unhandled exception for unreachable URL", async () => {
      // Use a port that is definitely not listening
      const agent = makeAgent("http://127.0.0.1:19999/webhook");
      const result = await adapter.invoke(agent, "Unreachable", "/workspace/test", {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toMatch(/econnrefused|fetch failed|refused|connect/i);
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.toolCallCount).toBe(0);
      expect(typeof result.durationMs).toBe("number");
    });
  });

  // ------------------------------------------------------------------
  // Edge cases
  // ------------------------------------------------------------------
  describe("edge cases", () => {
    it("returns error when no webhook URL is configured", async () => {
      const agent = makeAgent("", {
        metadata: JSON.stringify({}), // No webhookUrl
      });
      const result = await adapter.invoke(agent, "No URL", "/workspace/test");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/no webhook url/i);
    });

    it("handles agent with null metadata gracefully", async () => {
      const agent = makeAgent("", {
        metadata: null as unknown as string,
      });
      const result = await adapter.invoke(agent, "No metadata", "/workspace/test");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/no webhook url/i);
    });

    it("handles agent with invalid metadata JSON gracefully", async () => {
      const agent = makeAgent("", {
        metadata: "not-json",
      });
      const result = await adapter.invoke(agent, "Bad metadata", "/workspace/test");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/no webhook url/i);
    });

    it("sends null taskId when agent has no current_task_id", async () => {
      let receivedBody: Record<string, unknown> | null = null;
      const { server, port } = await startMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          receivedBody = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ output: "done", success: true }));
        });
      });

      try {
        const agent = makeAgent(`http://127.0.0.1:${port}/webhook`, {
          current_task_id: null,
        });
        await adapter.invoke(agent, "No task", "/workspace/test", {
          turnLimits: { turnTimeoutMs: 5000 },
        });

        expect(receivedBody).toBeDefined();
        expect(receivedBody!.taskId).toBeNull();
      } finally {
        await closeServer(server);
      }
    });

    it("reads webhookUrl from snake_case metadata field", async () => {
      const { server, port } = await startMockServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ output: "snake case worked", success: true }));
        });
      });

      try {
        const agent = makeAgent("", {
          metadata: JSON.stringify({ webhook_url: `http://127.0.0.1:${port}/webhook` }),
        });
        const result = await adapter.invoke(agent, "Snake case", "/workspace/test", {
          turnLimits: { turnTimeoutMs: 5000 },
        });

        expect(result.success).toBe(true);
        expect(result.output).toBe("snake case worked");
      } finally {
        await closeServer(server);
      }
    });
  });
});
