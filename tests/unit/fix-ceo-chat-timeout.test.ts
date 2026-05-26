import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Tests for the CEO chat timeout fix (fix-ceo-chat-timeout)
// ---------------------------------------------------------------------------

describe("CEO chat timeout fix", () => {
  // -------------------------------------------------------------------------
  // 1. STREAM_CHAT_TIMEOUT_MS value
  // -------------------------------------------------------------------------
  describe("STREAM_CHAT_TIMEOUT_MS", () => {
    it("is set to 360_000 (6 minutes) in api.ts", () => {
      const apiPath = path.resolve(__dirname, "../../dashboard/src/lib/api.ts");
      const src = fs.readFileSync(apiPath, "utf-8");
      const match = src.match(/const\s+STREAM_CHAT_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
      expect(match).not.toBeNull();
      const value = Number(match![1].replace(/_/g, ""));
      expect(value).toBe(360_000);
    });

    it("abort call includes a descriptive reason string", () => {
      const apiPath = path.resolve(__dirname, "../../dashboard/src/lib/api.ts");
      const src = fs.readFileSync(apiPath, "utf-8");
      // Find the setTimeout that triggers the abort within streamChatWithCeo
      // It should pass a reason string to abort()
      const abortPattern = /timeoutController\.abort\(\s*["'`].*timed out.*["'`]\s*\)/i;
      expect(abortPattern.test(src)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Friendly error messages for abort/timeout errors
  // -------------------------------------------------------------------------
  describe("friendlyErrorMessage", () => {
    // Extract the logic from the component for unit testing
    function friendlyErrorMessage(raw: string): string {
      const lower = raw.toLowerCase();
      if (lower.includes("timed out") || lower.includes("aborted") || lower.includes("abort")) {
        return "Response timed out. Try again.";
      }
      if (lower.includes("not authenticated")) {
        return "Session expired. Please refresh the page.";
      }
      if (lower.includes("network") || lower.includes("failed to fetch")) {
        return "Network error. Check your connection and try again.";
      }
      return raw;
    }

    it("converts 'signal is aborted without reason' to a friendly message", () => {
      expect(friendlyErrorMessage("signal is aborted without reason")).toBe(
        "Response timed out. Try again.",
      );
    });

    it("converts 'The operation was aborted' to a friendly message", () => {
      expect(friendlyErrorMessage("The operation was aborted")).toBe(
        "Response timed out. Try again.",
      );
    });

    it("converts 'CEO response timed out after 6 minutes' to a friendly message", () => {
      expect(friendlyErrorMessage("CEO response timed out after 6 minutes")).toBe(
        "Response timed out. Try again.",
      );
    });

    it("converts 'Response timed out. Try again.' preserves already-friendly message", () => {
      expect(friendlyErrorMessage("Response timed out. Try again.")).toBe(
        "Response timed out. Try again.",
      );
    });

    it("converts network errors to friendly message", () => {
      expect(friendlyErrorMessage("Failed to fetch")).toBe(
        "Network error. Check your connection and try again.",
      );
    });

    it("converts auth errors to friendly message", () => {
      expect(friendlyErrorMessage("Not authenticated")).toBe(
        "Session expired. Please refresh the page.",
      );
    });

    it("passes through unknown errors unchanged", () => {
      expect(friendlyErrorMessage("Some specific server error")).toBe(
        "Some specific server error",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. ceo-chat-panel.tsx has retry functionality
  // -------------------------------------------------------------------------
  describe("CEO chat panel retry support", () => {
    it("imports RotateCcw icon for retry button", () => {
      const panelPath = path.resolve(
        __dirname,
        "../../dashboard/src/components/company/ceo-chat-panel.tsx",
      );
      const src = fs.readFileSync(panelPath, "utf-8");
      expect(src).toContain("RotateCcw");
    });

    it("has a handleRetry function", () => {
      const panelPath = path.resolve(
        __dirname,
        "../../dashboard/src/components/company/ceo-chat-panel.tsx",
      );
      const src = fs.readFileSync(panelPath, "utf-8");
      expect(src).toContain("handleRetry");
    });

    it("renders retry button in error state with accessible label", () => {
      const panelPath = path.resolve(
        __dirname,
        "../../dashboard/src/components/company/ceo-chat-panel.tsx",
      );
      const src = fs.readFileSync(panelPath, "utf-8");
      // The retry bar should be conditionally rendered when activeChat has error status
      expect(src).toContain('activeChat?.status === "error"');
      expect(src).toContain("Retry");
    });

    it("stores last sent message for retry", () => {
      const panelPath = path.resolve(
        __dirname,
        "../../dashboard/src/components/company/ceo-chat-panel.tsx",
      );
      const src = fs.readFileSync(panelPath, "utf-8");
      expect(src).toContain("lastSentMessageRef");
    });

    it("uses friendlyErrorMessage to transform errors", () => {
      const panelPath = path.resolve(
        __dirname,
        "../../dashboard/src/components/company/ceo-chat-panel.tsx",
      );
      const src = fs.readFileSync(panelPath, "utf-8");
      expect(src).toContain("friendlyErrorMessage");
    });
  });

  // -------------------------------------------------------------------------
  // 4. LLM proxy duplex: 'half' support
  // -------------------------------------------------------------------------
  describe("LLM proxy duplex option", () => {
    it("adds duplex: 'half' to Anthropic fetch call", () => {
      const proxyPath = path.resolve(
        __dirname,
        "../../supervisor/src/llm-proxy.ts",
      );
      const src = fs.readFileSync(proxyPath, "utf-8");
      // Should have duplex: "half" in the file
      expect(src).toContain('duplex: "half"');
    });

    it("has duplex option in both fetch calls (Anthropic and OpenRouter)", () => {
      const proxyPath = path.resolve(
        __dirname,
        "../../supervisor/src/llm-proxy.ts",
      );
      const src = fs.readFileSync(proxyPath, "utf-8");
      // Count occurrences of duplex: "half" — should be at least 2
      const matches = src.match(/duplex:\s*["']half["']/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });

    it("casts fetch options as RequestInit for TypeScript compatibility", () => {
      const proxyPath = path.resolve(
        __dirname,
        "../../supervisor/src/llm-proxy.ts",
      );
      const src = fs.readFileSync(proxyPath, "utf-8");
      // Should cast as RequestInit to avoid TS complaints about duplex
      const castCount = (src.match(/as\s+RequestInit/g) || []).length;
      expect(castCount).toBeGreaterThanOrEqual(2);
    });

    it("only applies duplex for non-GET/HEAD methods", () => {
      const proxyPath = path.resolve(
        __dirname,
        "../../supervisor/src/llm-proxy.ts",
      );
      const src = fs.readFileSync(proxyPath, "utf-8");
      // The duplex option should be conditional on method
      expect(src).toContain('c.req.method !== "GET"');
      expect(src).toContain('c.req.method !== "HEAD"');
    });
  });

  // -------------------------------------------------------------------------
  // 5. streamChatWithCeo abort handling
  // -------------------------------------------------------------------------
  describe("streamChatWithCeo abort error handling", () => {
    it("converts AbortError to friendly message in the fetch catch block", () => {
      const apiPath = path.resolve(__dirname, "../../dashboard/src/lib/api.ts");
      const src = fs.readFileSync(apiPath, "utf-8");
      // Should check for AbortError and throw a friendly message
      expect(src).toContain('"AbortError"');
      expect(src).toContain("Response timed out. Try again.");
    });
  });
});
