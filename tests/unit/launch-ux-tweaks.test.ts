import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

// ─── FIX 1: Thinking indicator appears BELOW user messages ──────

describe("Thinking indicator placement below user messages", () => {
  const sessionView = readFile("components/launch/launch-session-view.tsx");

  it("thinking indicator (CEO is thinking) appears after messages.map", () => {
    // The thinking indicator should come AFTER the messages .map() loop, not before
    // After the double-bubble fix, the map uses visibleMessages instead of session.messages
    const messagesMapIndex = sessionView.indexOf("visibleMessages.map") !== -1
      ? sessionView.indexOf("visibleMessages.map")
      : sessionView.indexOf("session.messages.map");
    const thinkingIndex = sessionView.indexOf('CEO is thinking{elapsedSeconds');
    expect(messagesMapIndex).toBeGreaterThan(-1);
    expect(thinkingIndex).toBeGreaterThan(-1);
    expect(thinkingIndex).toBeGreaterThan(messagesMapIndex);
  });

  it("streaming content indicator appears after messages.map", () => {
    const messagesMapIndex = sessionView.indexOf("visibleMessages.map") !== -1
      ? sessionView.indexOf("visibleMessages.map")
      : sessionView.indexOf("session.messages.map");
    // streamingContent block shows whenever streamingContent is non-null
    // (smooth transition: cursor only shown when still processing)
    const streamingIndex = sessionView.indexOf("{streamingContent && (");
    // There should be no streaming indicator before messages.map
    const beforeMap = sessionView.substring(0, messagesMapIndex);
    expect(beforeMap).not.toContain("{streamingContent && (");
    // The streaming indicator should appear after messages
    expect(streamingIndex).toBeGreaterThan(messagesMapIndex);
  });

  it("messagesEndRef is after both indicators", () => {
    const thinkingIndex = sessionView.indexOf('CEO is thinking{elapsedSeconds');
    const streamingIndex = sessionView.indexOf("streaming-cursor");
    const endRefIndex = sessionView.indexOf('ref={messagesEndRef}');
    expect(endRefIndex).toBeGreaterThan(thinkingIndex);
    expect(endRefIndex).toBeGreaterThan(streamingIndex);
  });
});

// ─── FIX 2: Launch button disabled until session.ready ──────────

describe("Launch button disabled until session.ready", () => {
  const sessionView = readFile("components/launch/launch-session-view.tsx");

  it("Launch button only renders when session.ready is true", () => {
    // The launch button section is gated by {session.ready && (
    expect(sessionView).toContain("session.ready && (");
  });

  it("Launch button disabled state includes processing check", () => {
    // The launch button should be disabled when processing
    expect(sessionView).toContain("disabled={loading || sessionBusy || processing}");
  });

  it("Launch button spinner shows during processing", () => {
    // The button should show spinner when processing
    expect(sessionView).toContain("(loading || sessionBusy || processing) ? <Loader2");
  });
});

describe("Auto-launch guards session.ready in launch-form", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("onOption handler checks session.ready before auto-launching", () => {
    // isLaunchIntent(reply) && launchSession?.ready
    expect(launchForm).toContain("isLaunchIntent(reply) && launchSession?.ready");
  });

  it("handleLaunch checks session.ready before proceeding", () => {
    expect(launchForm).toContain("!launchSession.ready");
  });
});

// ─── FIX 3: Launch idea page fits viewport, no A logo ───────────

describe("Launch idea page design fixes", () => {
  const ideaStep = readFile("components/launch/launch-idea-step.tsx");

  it("does NOT import DitheredIcon", () => {
    expect(ideaStep).not.toContain("DitheredIcon");
    expect(ideaStep).not.toContain("dithered-icon");
  });

  it("does NOT render DitheredIcon component", () => {
    expect(ideaStep).not.toContain("<DitheredIcon");
  });

  it("uses h-full to fit viewport", () => {
    expect(ideaStep).toContain("h-full");
  });

  it("uses responsive overflow: overflow-y-auto on small screens, xl:overflow-hidden on xl", () => {
    // On small screens (stacked layout), content must be scrollable
    expect(ideaStep).toContain("overflow-y-auto");
    // On xl screens (two-column layout), overflow hidden keeps content fitted
    expect(ideaStep).toContain("xl:overflow-hidden");
  });

  it("Start with the CEO button is always reachable (not clipped by overflow-hidden on small viewports)", () => {
    // The form must NOT use bare overflow-hidden without a responsive override
    // overflow-y-auto must appear before or alongside xl:overflow-hidden
    const formClassMatch = ideaStep.match(/className="[^"]*overflow-y-auto[^"]*xl:overflow-hidden[^"]*"/);
    expect(formClassMatch).not.toBeNull();
  });

  it("uses compact padding (py-3 or py-4, not py-6 or py-8)", () => {
    // Should have compact top-level padding
    expect(ideaStep).toMatch(/className="[^"]*py-[34]\b/);
    // Should NOT have large padding on the form container
    expect(ideaStep).not.toMatch(/className="[^"]*\bpy-[6-9]\b[^"]*fade-in-up/);
  });

  it("textarea has reduced rows (4 not 7)", () => {
    expect(ideaStep).toContain('rows={4}');
    expect(ideaStep).not.toContain('rows={7}');
  });

  it("heading is smaller (text-2xl not text-3xl)", () => {
    expect(ideaStep).toContain("text-2xl");
    // At sm breakpoint it can be text-3xl but base should be text-2xl
    expect(ideaStep).toContain("sm:text-3xl");
    expect(ideaStep).not.toContain("sm:text-4xl");
  });

  it("uses flex-1 and min-h-0 for grid to fill available space", () => {
    expect(ideaStep).toContain("flex-1");
    expect(ideaStep).toContain("min-h-0");
  });

  it("mode selector descriptions are compact", () => {
    // Mode descriptions should be shortened
    expect(ideaStep).not.toContain("Best when your idea is already sharp");
    expect(ideaStep).not.toContain("Opus stress-tests the wedge, buyer, and distribution before launch. Best for most founders.");
  });
});
