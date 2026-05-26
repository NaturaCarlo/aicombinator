import { describe, expect, it } from "vitest";

/**
 * Tests for the launch conversation speed improvements:
 * 1. Model switched from Opus to Sonnet
 * 2. Direct Anthropic streaming path added
 * 3. max_tokens reduced
 * 4. System prompt trimmed
 */

// Import the source file to inspect constants and functions
import {
  extractPartialAssistantMessage,
} from "../../worker/src/provisioning/launch-session.ts";

// Read the source file to verify constants
import fs from "node:fs";
const sourceCode = fs.readFileSync(
  "/Users/CEF/Projects/automaton/worker/src/provisioning/launch-session.ts",
  "utf8",
);

describe("CHANGE 1: Model switched from Opus to Sonnet", () => {
  it("OPENROUTER_MODEL uses claude-sonnet-4.6 instead of claude-opus-4.6", () => {
    const match = sourceCode.match(/const OPENROUTER_MODEL\s*=\s*"([^"]+)"/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe("anthropic/claude-sonnet-4.6");
  });

  it("ANTHROPIC_DIRECT_MODEL uses claude-sonnet-4-20250514 instead of claude-opus-4-6", () => {
    const match = sourceCode.match(/const ANTHROPIC_DIRECT_MODEL\s*=\s*"([^"]+)"/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe("claude-sonnet-4-20250514");
  });

  it("does not reference claude-opus anywhere in model constants", () => {
    // The file may still mention Opus in comments or error messages, but model constants should be Sonnet
    const lines = sourceCode.split("\n");
    const modelConstantLines = lines.filter(
      (line) =>
        (line.includes("OPENROUTER_MODEL") || line.includes("ANTHROPIC_DIRECT_MODEL")) &&
        line.includes("const ") &&
        !line.includes("ARTIFACT_"),
    );
    for (const line of modelConstantLines) {
      expect(line).not.toContain("opus");
    }
  });
});

describe("CHANGE 2: Direct Anthropic API streaming path", () => {
  it("generateLaunchSessionTurnStreaming tries Anthropic before OpenRouter", () => {
    // The streaming function should contain Anthropic API call before OpenRouter
    const streamingFuncStart = sourceCode.indexOf("async function* generateLaunchSessionTurnStreaming");
    expect(streamingFuncStart).toBeGreaterThan(-1);

    const streamingSection = sourceCode.slice(streamingFuncStart);
    const anthropicCallIndex = streamingSection.indexOf("https://api.anthropic.com/v1/messages");
    const openrouterCallIndex = streamingSection.indexOf("https://openrouter.ai/api/v1/chat/completions");

    // Anthropic should appear before OpenRouter in the streaming function
    expect(anthropicCallIndex).toBeGreaterThan(-1);
    expect(openrouterCallIndex).toBeGreaterThan(-1);
    expect(anthropicCallIndex).toBeLessThan(openrouterCallIndex);
  });

  it("Anthropic streaming uses the correct SSE delta format (content_block_delta + input_json_delta)", () => {
    // The code should handle Anthropic's event format
    expect(sourceCode).toContain("content_block_delta");
    expect(sourceCode).toContain("input_json_delta");
    expect(sourceCode).toContain("partial_json");
  });

  it("Anthropic streaming falls back to OpenRouter on failure", () => {
    const streamingFuncStart = sourceCode.indexOf("async function* generateLaunchSessionTurnStreaming");
    const streamingSection = sourceCode.slice(streamingFuncStart);
    // Should have a fallthrough pattern: after Anthropic failure, code continues to OpenRouter
    expect(streamingSection).toContain("anthropicSucceeded");
    expect(streamingSection).toContain("Fall through to OpenRouter");
  });

  it("Anthropic streaming uses stream: true in the request", () => {
    const streamingFuncStart = sourceCode.indexOf("async function* generateLaunchSessionTurnStreaming");
    const streamingSection = sourceCode.slice(streamingFuncStart);
    // Find the Anthropic fetch call within the streaming function
    const anthropicFetchIndex = streamingSection.indexOf("https://api.anthropic.com/v1/messages");
    expect(anthropicFetchIndex).toBeGreaterThan(-1);
    // Check that stream: true is in the body near that call
    const nearbySection = streamingSection.slice(Math.max(0, anthropicFetchIndex - 500), anthropicFetchIndex + 500);
    expect(nearbySection).toContain("stream: true");
  });

  it("Anthropic streaming uses tool_choice with type: tool", () => {
    const streamingFuncStart = sourceCode.indexOf("async function* generateLaunchSessionTurnStreaming");
    const streamingSection = sourceCode.slice(streamingFuncStart);
    // Anthropic uses { type: "tool", name: "..." } unlike OpenRouter's { type: "function", function: { name: "..." } }
    expect(streamingSection).toContain('tool_choice: { type: "tool", name: "submit_launch_turn" }');
  });
});

describe("CHANGE 3: Reduced max_tokens", () => {
  it("standard mode uses 2200 max_tokens (down from 3500)", () => {
    // Both generateLaunchSessionTurn and generateLaunchSessionTurnStreaming should use 2200
    const matches = sourceCode.match(/const maxTokens = input\.mode === "deep" \? (\d+) : input\.mode === "quick" \? (\d+) : (\d+)/g);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
    for (const match of matches!) {
      const [, deep, quick, standard] = match.match(/(\d+) : input\.mode === "quick" \? (\d+) : (\d+)/)!;
      expect(parseInt(standard)).toBe(2200);
      expect(parseInt(quick)).toBe(1800);
      expect(parseInt(deep)).toBe(3000);
    }
  });
});

describe("CHANGE 4: Trimmed system prompt", () => {
  it("system prompt is significantly shorter than the original 4144 chars", () => {
    // Extract buildLaunchSystemPrompt function body
    const funcStart = sourceCode.indexOf("function buildLaunchSystemPrompt(mode: LaunchSessionMode): string {");
    expect(funcStart).toBeGreaterThan(-1);
    // Find the closing of the function (the return statement's join)
    const funcSection = sourceCode.slice(funcStart);
    const joinEnd = funcSection.indexOf('].join("\\n");\n}');
    expect(joinEnd).toBeGreaterThan(-1);
    const funcBody = funcSection.slice(0, joinEnd + '].join("\\n");\n}'.length);

    // Count the characters of the actual prompt strings (between quotes)
    const promptLines = funcBody.match(/"([^"]+)"/g) || [];
    const totalChars = promptLines.reduce((sum, line) => sum + line.length - 2, 0); // -2 for quotes

    // Original was ~4144 chars. Target is ~30% reduction → ~2900 chars
    expect(totalChars).toBeLessThan(3500);
    // But should still be substantial (not empty)
    expect(totalChars).toBeGreaterThan(1500);
  });

  it("system prompt preserves all key behavioral semantics", () => {
    const funcStart = sourceCode.indexOf("function buildLaunchSystemPrompt(mode: LaunchSessionMode): string {");
    const funcSection = sourceCode.slice(funcStart, funcStart + 5000);

    // Core semantics that must be preserved:
    expect(funcSection).toContain("cofounder"); // Role
    expect(funcSection).toContain("operating brief"); // Goal
    expect(funcSection).toContain("autonomous"); // Team autonomy
    expect(funcSection).toContain("options"); // Provide options
    expect(funcSection).toContain("flatter"); // No flattery
    expect(funcSection).toContain("wedge"); // Smallest wedge
    expect(funcSection).toContain("Synthesize"); // Synthesis first
    expect(funcSection).toContain("locked decision"); // Respect locked decisions
    expect(funcSection).toContain("empty"); // Never empty fields
    expect(funcSection).toContain("credentials"); // No credentials
    expect(funcSection).toContain("readiness"); // Readiness logic
    expect(funcSection).toContain("launch"); // Launch intent detection
    expect(funcSection).toContain("220 words"); // Message length limit
    expect(funcSection).toContain("tool exactly once"); // Tool usage
  });

  it("system prompt no longer references Opus by name", () => {
    const funcStart = sourceCode.indexOf("function buildLaunchSystemPrompt(mode: LaunchSessionMode): string {");
    const funcSection = sourceCode.slice(funcStart, funcStart + 5000);
    expect(funcSection).not.toContain("Opus 4.6");
  });

  it("system prompt does not have duplicate 'don't re-ask' instructions", () => {
    const funcStart = sourceCode.indexOf("function buildLaunchSystemPrompt(mode: LaunchSessionMode): string {");
    const funcSection = sourceCode.slice(funcStart, funcStart + 5000);

    // Count occurrences of key phrases that were previously duplicated
    const reaskCount = (funcSection.match(/re-ask|re ask|reask|same question twice/gi) || []).length;
    expect(reaskCount).toBeLessThanOrEqual(1);

    const credentialInstructionCount = (funcSection.match(/credentials|API keys/gi) || []).length;
    // Should consolidate to 1 mention of credentials/API keys
    expect(credentialInstructionCount).toBeLessThanOrEqual(2);
  });
});

describe("extractPartialAssistantMessage handles Anthropic streaming format", () => {
  it("works with accumulated JSON from Anthropic input_json_delta fragments", () => {
    // Anthropic streams tool use input as JSON fragments via input_json_delta
    // The accumulated string is the same format as OpenRouter tool_call arguments
    const fragment1 = '{"assistantMessage":"## Sharp';
    const fragment2 = '{"assistantMessage":"## Sharp operating thesis\\n\\nHere is the plan.","suggestedCompanyName":"TestCo"}';

    expect(extractPartialAssistantMessage(fragment1)).toBe("## Sharp");
    expect(extractPartialAssistantMessage(fragment2)).toBe("## Sharp operating thesis\n\nHere is the plan.");
  });
});
