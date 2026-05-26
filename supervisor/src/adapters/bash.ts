/**
 * Bash Adapter — executes agents via shell scripts.
 *
 * Spawns the agent's configured script path using child_process.spawn,
 * passing the prompt as the first argument. Captures stdout as output.
 *
 * Error handling:
 * - Non-zero exit code: returns success:false with exit code in error
 * - Timeout: kills the process tree and returns timeout error
 * - Script not found / spawn errors: returns success:false with error message
 */

import { spawn } from "node:child_process";
import type { AgentRow, AgentTurnResult } from "../types.js";
import type { AgentAdapter, AdapterInvokeOptions } from "./types.js";

/** Default timeout for bash script execution (60 seconds). */
const DEFAULT_BASH_TIMEOUT_MS = 60_000;

export class BashAdapter implements AgentAdapter {
  /**
   * Invoke an agent by spawning its configured script with the prompt as
   * the first argument.
   *
   * The agent row must have a `scriptPath` (or `script_path`) stored in its
   * metadata JSON. The script is executed with `prompt` as argv[1].
   *
   * @param agent - The agent row (must have script path in metadata)
   * @param prompt - The user/task prompt, passed as first argument
   * @param workspaceDir - The workspace directory (set as cwd for the script)
   * @param options - Optional invocation parameters (turnLimits for timeout)
   */
  async invoke(
    agent: AgentRow,
    prompt: string,
    workspaceDir: string,
    options?: AdapterInvokeOptions,
  ): Promise<AgentTurnResult> {
    const startTime = Date.now();
    const timeoutMs =
      options?.turnLimits?.turnTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;

    // Extract script path from agent metadata
    const scriptPath = this.getScriptPath(agent);
    if (!scriptPath) {
      return {
        success: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        error: `No script path configured for agent ${agent.id}`,
        aborted: false,
        toolCallCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    return new Promise<AgentTurnResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let resolved = false;

      const safeResolve = (result: AgentTurnResult): void => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      // Spawn the script with prompt as first argument
      const child = spawn(scriptPath, [prompt], {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        // Ensure child processes can be killed as a group
        detached: false,
      });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        killed = true;
        // Kill the process (and children via negative PID if available)
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // Process may already be dead or negative kill not supported
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may already be dead
        }
        safeResolve({
          success: false,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          error: `Script execution timeout after ${timeoutMs}ms`,
          aborted: true,
          toolCallCount: 0,
          durationMs: Date.now() - startTime,
        });
      }, timeoutMs);

      // Handle external abort
      if (options?.abortController) {
        const onAbort = (): void => {
          killed = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may already be dead
          }
          clearTimeout(timeoutId);
          safeResolve({
            success: false,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            error: "Script execution aborted",
            aborted: true,
            toolCallCount: 0,
            durationMs: Date.now() - startTime,
          });
        };

        if (options.abortController.signal.aborted) {
          onAbort();
          return;
        }
        options.abortController.signal.addEventListener("abort", onAbort, {
          once: true,
        });
      }

      // Capture stdout
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      // Capture stderr
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Handle spawn errors (e.g., script not found)
      child.on("error", (err: Error) => {
        clearTimeout(timeoutId);
        safeResolve({
          success: false,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          error: `Script spawn failed: ${err.message}`,
          aborted: false,
          toolCallCount: 0,
          durationMs: Date.now() - startTime,
        });
      });

      // Handle process exit
      child.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(timeoutId);

        if (killed) {
          // Already resolved by timeout or abort handler
          return;
        }

        if (code !== null && code !== 0) {
          safeResolve({
            success: false,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            output: stdout || undefined,
            error: `Script exited with code ${code}`,
            aborted: false,
            toolCallCount: 0,
            durationMs: Date.now() - startTime,
          });
          return;
        }

        if (signal) {
          safeResolve({
            success: false,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            output: stdout || undefined,
            error: `Script killed by signal ${signal}`,
            aborted: true,
            toolCallCount: 0,
            durationMs: Date.now() - startTime,
          });
          return;
        }

        // Success: exit code 0
        safeResolve({
          success: true,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          output: stdout,
          aborted: false,
          toolCallCount: 0,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * Extract the script path from an agent row's metadata JSON.
   * Checks for `scriptPath` (camelCase) and `script_path` (snake_case).
   */
  private getScriptPath(agent: AgentRow): string | null {
    if (agent.metadata) {
      try {
        const meta = JSON.parse(agent.metadata) as Record<string, unknown>;
        if (typeof meta.scriptPath === "string" && meta.scriptPath) {
          return meta.scriptPath;
        }
        // Also check snake_case variant
        if (typeof meta.script_path === "string" && meta.script_path) {
          return meta.script_path;
        }
      } catch {
        // Metadata is not valid JSON — ignore
      }
    }
    return null;
  }
}
