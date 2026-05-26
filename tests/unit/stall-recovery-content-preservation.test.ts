import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("Stall recovery preserves visible content during fetch (VAL-FE-STREAM-003)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("stall timer callback does NOT call setStreamingContent(null) before getLaunchSession", () => {
    // Find the stall timer callback (setTimeout inside resetStallTimer)
    const stallTimerStart = launchForm.indexOf("stallTimer = setTimeout(async ()");
    expect(stallTimerStart).toBeGreaterThan(-1);

    // Find the getLaunchSession call inside the stall timer callback
    const getLaunchIdx = launchForm.indexOf("getLaunchSession(launchSession.id", stallTimerStart);
    expect(getLaunchIdx).toBeGreaterThan(-1);

    // The section between setTimeout start and getLaunchSession should NOT contain
    // setStreamingContent(null) — content must be preserved during the fetch
    const beforeFetch = launchForm.substring(stallTimerStart, getLaunchIdx);
    expect(beforeFetch).not.toContain("setStreamingContent(null)");
  });

  it("streaming content is only cleared AFTER fresh session data is set", () => {
    // In the stall timer callback, setStreamingContent(null) should come AFTER
    // setLaunchSession(fresh), not before the fetch
    const stallTimerStart = launchForm.indexOf("stallTimer = setTimeout(async ()");
    expect(stallTimerStart).toBeGreaterThan(-1);

    // Find the try block inside the stall timer
    const tryIdx = launchForm.indexOf("try {", stallTimerStart);
    expect(tryIdx).toBeGreaterThan(-1);

    // Find the setLaunchSession(fresh) call
    const setLaunchIdx = launchForm.indexOf("setLaunchSession(fresh)", tryIdx);
    expect(setLaunchIdx).toBeGreaterThan(-1);

    // setStreamingContent(null) should come after setLaunchSession(fresh)
    const setStreamingIdx = launchForm.indexOf("setStreamingContent(null)", setLaunchIdx);
    expect(setStreamingIdx).toBeGreaterThan(-1);
    expect(setStreamingIdx).toBeGreaterThan(setLaunchIdx);
  });
});

describe("Stall recovery shows correct replacement content (VAL-FE-STREAM-004)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("stall timer fetches fresh session and updates all session state", () => {
    // The stall timer callback should contain setLaunchSession(fresh) to update state
    const stallTimerStart = launchForm.indexOf("stallTimer = setTimeout(async ()");
    expect(stallTimerStart).toBeGreaterThan(-1);

    // Find the fetch and state update in the try block
    const tryIdx = launchForm.indexOf("try {", stallTimerStart);
    const catchIdx = launchForm.indexOf("catch", tryIdx + 5);
    const tryBody = launchForm.substring(tryIdx, catchIdx);

    expect(tryBody).toContain("getLaunchSession(launchSession.id");
    expect(tryBody).toContain("setLaunchSession(fresh)");
    expect(tryBody).toContain("setStreamingContent(null)");
  });

  it("if recovery fetch fails, existing streaming content is NOT cleared", () => {
    // The catch block of the stall timer should NOT contain setStreamingContent(null)
    const stallTimerStart = launchForm.indexOf("stallTimer = setTimeout(async ()");
    expect(stallTimerStart).toBeGreaterThan(-1);

    const tryIdx = launchForm.indexOf("try {", stallTimerStart);
    // Find the catch block
    const catchIdx = launchForm.indexOf("catch", tryIdx + 5);
    expect(catchIdx).toBeGreaterThan(-1);

    // Find the end of the catch block (closing brace of setTimeout callback)
    // The catch block should NOT clear streaming content
    const catchBody = launchForm.substring(catchIdx, catchIdx + 200);
    expect(catchBody).not.toContain("setStreamingContent(null)");
  });
});

describe("Stall timer cleared when entering fallback poll (VAL-FE-STATE-003)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("fallbackPoll function clears the stall timer at the start", () => {
    // Find the fallbackPoll function definition
    const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async ()");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    // The stall timer should be cleared near the top of fallbackPoll,
    // before the while loop begins
    const whileLoopIdx = launchForm.indexOf("while (!cancelled)", fallbackPollStart);
    expect(whileLoopIdx).toBeGreaterThan(-1);

    const beforeLoop = launchForm.substring(fallbackPollStart, whileLoopIdx);
    // Should clear the stallTimer
    expect(beforeLoop).toMatch(/if\s*\(\s*stallTimer\s*\)\s*clearTimeout\s*\(\s*stallTimer\s*\)/);
  });

  it("stall timer variable is nulled after clearing to prevent re-clear", () => {
    const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async ()");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    const whileLoopIdx = launchForm.indexOf("while (!cancelled)", fallbackPollStart);
    const beforeLoop = launchForm.substring(fallbackPollStart, whileLoopIdx);

    // stallTimer should be set to null after clearing
    expect(beforeLoop).toContain("stallTimer = null");
  });
});

describe("No double recovery from stall + poll race (VAL-FE-STATE-004)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("connectStream calls fallbackPoll which clears stall timer first", () => {
    // When connectStream exhausts retries and enters fallbackPoll,
    // the stall timer should be cleared in fallbackPoll to prevent both
    // stall recovery and fallback poll from running concurrently

    const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async ()");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    // The first thing in fallbackPoll (before the while loop) should clear stall timer
    const functionBody = launchForm.substring(fallbackPollStart, fallbackPollStart + 600);
    const clearStallIdx = functionBody.indexOf("clearTimeout(stallTimer)");
    const whileIdx = functionBody.indexOf("while (!cancelled)");

    expect(clearStallIdx).toBeGreaterThan(-1);
    expect(whileIdx).toBeGreaterThan(-1);
    expect(clearStallIdx).toBeLessThan(whileIdx);
  });

  it("stall timer callback checks cancelled flag before taking action", () => {
    // The stall timer callback already has 'if (cancelled) return;' at the start
    // This ensures that if the component unmounted or was cancelled, stall recovery
    // doesn't fire
    const stallTimerStart = launchForm.indexOf("stallTimer = setTimeout(async ()");
    expect(stallTimerStart).toBeGreaterThan(-1);

    const callbackBody = launchForm.substring(stallTimerStart, stallTimerStart + 200);
    expect(callbackBody).toContain("if (cancelled) return");
  });
});
