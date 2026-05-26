import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("Fix double CEO bubble during launch conversation streaming", () => {
  const sessionView = readFile("components/launch/launch-session-view.tsx");

  it("filters out empty pending/streaming assistant messages before rendering", () => {
    // There should be a visibleMessages filter that removes empty assistant messages
    // with pending or streaming flags
    expect(sessionView).toContain("visibleMessages");

    // The filter should check for role === "assistant"
    const filterIdx = sessionView.indexOf("visibleMessages");
    expect(filterIdx).toBeGreaterThan(-1);
    const filterBlock = sessionView.substring(filterIdx, filterIdx + 500);
    expect(filterBlock).toContain("assistant");
    expect(filterBlock).toContain("filter");
  });

  it("uses visibleMessages.map() instead of session.messages.map() for rendering", () => {
    // The .map() loop that renders messages should use visibleMessages, not session.messages
    const mapPattern = /visibleMessages\.map\s*\(/;
    expect(sessionView).toMatch(mapPattern);
  });

  it("does NOT remove completed assistant messages with real content", () => {
    // The filter should only remove messages where:
    // 1. role === "assistant"
    // 2. pending or streaming is true
    // 3. content is empty or whitespace-only
    // A completed message with content should NOT be filtered out
    const filterIdx = sessionView.indexOf("visibleMessages");
    const filterBlock = sessionView.substring(filterIdx, filterIdx + 500);
    // The filter must check for empty content (not just any streaming message)
    expect(filterBlock).toMatch(/!m\.content|!m\.content\.trim\(\)/);
  });

  it("still renders the separate streamingContent bubble below the messages list", () => {
    // The streamingContent bubble should still exist — we only filter the EMPTY
    // message from session.messages, not the streaming bubble itself
    expect(sessionView).toContain("streamingContent && (");
  });

  it("session.messages is not used directly in any .map() call for message rendering", () => {
    // After the fix, the messages.map loop should use visibleMessages, not session.messages
    // Check that `session.messages.map` is NOT used for rendering messages
    // (it may still be used for other purposes like .some() or .filter())
    const lines = sessionView.split("\n");
    const mapLines = lines.filter(
      (line) => line.includes("session.messages.map(") || line.includes("session.messages.map (")
    );
    // There should be no session.messages.map usage for rendering
    expect(mapLines.length).toBe(0);
  });
});
