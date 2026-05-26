import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { BashAdapter } from "../../supervisor/src/adapters/bash.ts";
import type { AgentRow } from "../../supervisor/src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AgentRow with a script path in metadata. */
function makeAgent(scriptPath: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-bash-001",
    company_id: "company-001",
    blueprint_id: null,
    name: "Test Bash Agent",
    role: "specialist",
    model_tier: "sonnet",
    status: "idle",
    session_id: null,
    current_task_id: "task-001",
    total_credits: 0,
    created_at: new Date().toISOString(),
    metadata: JSON.stringify({ scriptPath, adapterType: "bash" }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test fixture: temp directory with test scripts
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "bash-adapter-test-"));

  // Script that echoes its first argument
  const echoScript = `#!/bin/bash
echo "Received: $1"
`;
  await writeFile(join(tempDir, "echo-script.sh"), echoScript);
  await chmod(join(tempDir, "echo-script.sh"), 0o755);

  // Script that exits with code 42
  const failScript = `#!/bin/bash
echo "About to fail"
exit 42
`;
  await writeFile(join(tempDir, "fail-script.sh"), failScript);
  await chmod(join(tempDir, "fail-script.sh"), 0o755);

  // Script that sleeps for a long time (for timeout testing)
  const sleepScript = `#!/bin/bash
sleep 60
echo "Should not reach here"
`;
  await writeFile(join(tempDir, "sleep-script.sh"), sleepScript);
  await chmod(join(tempDir, "sleep-script.sh"), 0o755);

  // Script that outputs multi-line content
  const multiLineScript = `#!/bin/bash
echo "Line 1: Hello"
echo "Line 2: $1"
echo "Line 3: Done"
`;
  await writeFile(join(tempDir, "multiline-script.sh"), multiLineScript);
  await chmod(join(tempDir, "multiline-script.sh"), 0o755);

  // Script that writes to stderr and exits non-zero
  const stderrScript = `#!/bin/bash
echo "stdout content" >&1
echo "stderr content" >&2
exit 7
`;
  await writeFile(join(tempDir, "stderr-script.sh"), stderrScript);
  await chmod(join(tempDir, "stderr-script.sh"), 0o755);
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BashAdapter", () => {
  const adapter = new BashAdapter();

  // ------------------------------------------------------------------
  // VAL-ADAPT-010: Bash adapter executes script and captures stdout
  // ------------------------------------------------------------------
  describe("successful script execution (VAL-ADAPT-010)", () => {
    it("executes script with prompt as argument and captures stdout", async () => {
      const scriptPath = join(tempDir, "echo-script.sh");
      const agent = makeAgent(scriptPath);
      const result = await adapter.invoke(agent, "Hello World", tempDir, {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Received: Hello World");
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.aborted).toBe(false);
      expect(result.toolCallCount).toBe(0);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns all required AgentTurnResult fields", async () => {
      const scriptPath = join(tempDir, "echo-script.sh");
      const agent = makeAgent(scriptPath);
      const result = await adapter.invoke(agent, "Check fields", tempDir);

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

    it("captures multi-line stdout output", async () => {
      const scriptPath = join(tempDir, "multiline-script.sh");
      const agent = makeAgent(scriptPath);
      const result = await adapter.invoke(agent, "TestPrompt", tempDir, {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Line 1: Hello");
      expect(result.output).toContain("Line 2: TestPrompt");
      expect(result.output).toContain("Line 3: Done");
    });
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-011: Bash adapter handles non-zero exit code
  // ------------------------------------------------------------------
  describe("non-zero exit code handling (VAL-ADAPT-011)", () => {
    it("returns success:false with exit code 42 in error", async () => {
      const scriptPath = join(tempDir, "fail-script.sh");
      const agent = makeAgent(scriptPath);
      const result = await adapter.invoke(agent, "Fail test", tempDir, {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!).toMatch(/exit.*42/i);
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.toolCallCount).toBe(0);
      expect(typeof result.durationMs).toBe("number");
    });

    it("returns success:false with exit code 7 when script writes to stderr", async () => {
      const scriptPath = join(tempDir, "stderr-script.sh");
      const agent = makeAgent(scriptPath);
      const result = await adapter.invoke(agent, "Stderr test", tempDir, {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!).toMatch(/exit.*7/i);
      // stdout should still be captured even on failure
      expect(result.output).toContain("stdout content");
    });
  });

  // ------------------------------------------------------------------
  // VAL-ADAPT-012: Bash adapter handles timeout
  // ------------------------------------------------------------------
  describe("timeout handling (VAL-ADAPT-012)", () => {
    it("kills process and returns timeout error when script exceeds timeout", async () => {
      const scriptPath = join(tempDir, "sleep-script.sh");
      const agent = makeAgent(scriptPath);
      const result = await adapter.invoke(agent, "Slow task", tempDir, {
        turnLimits: { turnTimeoutMs: 500 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toMatch(/timeout/i);
      expect(result.aborted).toBe(true);
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.toolCallCount).toBe(0);
      expect(typeof result.durationMs).toBe("number");
    }, 10_000); // Allow extra time for the test itself
  });

  // ------------------------------------------------------------------
  // Edge cases
  // ------------------------------------------------------------------
  describe("edge cases", () => {
    it("returns error when no script path is configured", async () => {
      const agent = makeAgent("", {
        metadata: JSON.stringify({}), // No scriptPath
      });
      const result = await adapter.invoke(agent, "No script", tempDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/no script path/i);
    });

    it("handles agent with null metadata gracefully", async () => {
      const agent = makeAgent("", {
        metadata: null as unknown as string,
      });
      const result = await adapter.invoke(agent, "No metadata", tempDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/no script path/i);
    });

    it("handles agent with invalid metadata JSON gracefully", async () => {
      const agent = makeAgent("", {
        metadata: "not-json",
      });
      const result = await adapter.invoke(agent, "Bad metadata", tempDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/no script path/i);
    });

    it("reads scriptPath from snake_case metadata field", async () => {
      const scriptPath = join(tempDir, "echo-script.sh");
      const agent = makeAgent("", {
        metadata: JSON.stringify({ script_path: scriptPath }),
      });
      const result = await adapter.invoke(agent, "Snake case", tempDir, {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Received: Snake case");
    });

    it("returns spawn error for non-existent script", async () => {
      const agent = makeAgent("/nonexistent/path/to/script.sh");
      const result = await adapter.invoke(agent, "Missing script", tempDir, {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Should mention spawn failure or ENOENT
      expect(result.error!.toLowerCase()).toMatch(/spawn|enoent|no such file/i);
    });

    it("zeroes tokenUsage for bash agents", async () => {
      const scriptPath = join(tempDir, "echo-script.sh");
      const agent = makeAgent(scriptPath);
      const result = await adapter.invoke(agent, "Token check", tempDir, {
        turnLimits: { turnTimeoutMs: 5000 },
      });

      expect(result.tokenUsage.inputTokens).toBe(0);
      expect(result.tokenUsage.outputTokens).toBe(0);
    });
  });
});
