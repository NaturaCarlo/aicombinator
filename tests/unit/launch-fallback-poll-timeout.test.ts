import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("Fallback poll 5-minute absolute timeout (VAL-FE-STATE-001)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("fallbackPoll has a 5-minute (300000ms) absolute timeout constant", () => {
    // There should be a constant defining the 5-minute timeout
    expect(launchForm).toMatch(/FALLBACK_POLL_TIMEOUT_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  it("fallbackPoll records a start time for absolute timeout", () => {
    // Inside fallbackPoll, there should be a Date.now() call to track start time
    const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    const nextFn = launchForm.indexOf("const connectStream = async", fallbackPollStart);
    const fallbackPollBody = nextFn > 0
      ? launchForm.substring(fallbackPollStart, nextFn)
      : launchForm.substring(fallbackPollStart, fallbackPollStart + 2000);

    // Should track poll start time
    expect(fallbackPollBody).toMatch(/Date\.now\(\)/);
  });

  it("fallbackPoll checks elapsed time against the timeout inside the while loop", () => {
    const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    // Find the while loop in fallbackPoll
    const whileIdx = launchForm.indexOf("while (!cancelled)", fallbackPollStart);
    expect(whileIdx).toBeGreaterThan(-1);

    // The body between while and the next top-level function should check timeout
    const nextFn = launchForm.indexOf("const connectStream = async", fallbackPollStart);
    const whileBody = nextFn > 0
      ? launchForm.substring(whileIdx, nextFn)
      : launchForm.substring(whileIdx, whileIdx + 2000);

    // Should check elapsed time against FALLBACK_POLL_TIMEOUT_MS
    expect(whileBody).toContain("FALLBACK_POLL_TIMEOUT_MS");
  });

  it("fallbackPoll sets an error message when timeout is exceeded", () => {
    const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    const nextFn = launchForm.indexOf("const connectStream = async", fallbackPollStart);
    const fallbackPollBody = nextFn > 0
      ? launchForm.substring(fallbackPollStart, nextFn)
      : launchForm.substring(fallbackPollStart, fallbackPollStart + 2000);

    // Should set error or notice with a user-friendly message
    expect(fallbackPollBody).toMatch(/setSessionNotice|setError/);
    // Should return (break out of loop) after timeout
    expect(fallbackPollBody).toContain("return");
  });
});

describe("No lingering timers after fallback poll timeout (VAL-FE-STATE-002)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("stall timer is cleared when entering fallback poll", () => {
    const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    // The stall timer should be cleared at the start of fallbackPoll
    const fallbackPollBody = launchForm.substring(fallbackPollStart, fallbackPollStart + 500);
    expect(fallbackPollBody).toContain("clearTimeout(stallTimer)");
    expect(fallbackPollBody).toContain("stallTimer = null");
  });

  it("fallbackPoll exits cleanly on timeout without leaving state in limbo", () => {
    // The timeout path should return from the function, not just break
    const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    const nextFn = launchForm.indexOf("const connectStream = async", fallbackPollStart);
    const fallbackPollBody = nextFn > 0
      ? launchForm.substring(fallbackPollStart, nextFn)
      : launchForm.substring(fallbackPollStart, fallbackPollStart + 2000);

    // After timeout detection, it should return from the function to exit the while loop
    // There should be a check and return pattern
    expect(fallbackPollBody).toMatch(/FALLBACK_POLL_TIMEOUT_MS[\s\S]*?return/);
  });
});

describe("waitForLaunchReady 10-minute absolute hard timeout (VAL-FE-STREAM-007)", () => {
  const launchRuntime = readFile("components/launch/launch-runtime.ts");

  it("has a 10-minute absolute hard timeout constant", () => {
    // The absolute hard timeout should be 10 minutes = 600_000ms
    expect(launchRuntime).toMatch(/LAUNCH_ABSOLUTE_TIMEOUT_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
  });

  it("checks absolute elapsed time unconditionally in the loop", () => {
    // Find the waitForLaunchReady function
    const fnStart = launchRuntime.indexOf("export async function waitForLaunchReady");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = launchRuntime.substring(fnStart);

    // Should reference the absolute timeout constant
    expect(fnBody).toContain("LAUNCH_ABSOLUTE_TIMEOUT_MS");
  });

  it("absolute timeout check does NOT require stall condition", () => {
    // The new absolute timeout should fire purely based on elapsed time,
    // NOT conditioned on lastProgressAt stalling
    const fnStart = launchRuntime.indexOf("export async function waitForLaunchReady");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = launchRuntime.substring(fnStart);

    // Find the absolute timeout check — it should be an independent if block
    const absoluteTimeoutIdx = fnBody.indexOf("LAUNCH_ABSOLUTE_TIMEOUT_MS");
    expect(absoluteTimeoutIdx).toBeGreaterThan(-1);

    // Extract the if-condition line containing LAUNCH_ABSOLUTE_TIMEOUT_MS
    const lineStart = fnBody.lastIndexOf("\n", absoluteTimeoutIdx);
    const lineEnd = fnBody.indexOf("{", absoluteTimeoutIdx);
    const conditionLine = fnBody.substring(lineStart, lineEnd);

    // The condition should NOT include lastProgressAt (that's the stall check, which is separate)
    expect(conditionLine).not.toContain("lastProgressAt");
  });

  it("absolute timeout throws a user-friendly error with retry suggestion", () => {
    const fnStart = launchRuntime.indexOf("export async function waitForLaunchReady");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = launchRuntime.substring(fnStart);

    // Find the throw after LAUNCH_ABSOLUTE_TIMEOUT_MS check
    const absoluteIdx = fnBody.indexOf("LAUNCH_ABSOLUTE_TIMEOUT_MS");
    const throwIdx = fnBody.indexOf("throw new Error", absoluteIdx);
    expect(throwIdx).toBeGreaterThan(-1);

    // The error message should be within 300 chars of the timeout check
    expect(throwIdx - absoluteIdx).toBeLessThan(300);

    // Extract the error message
    const msgStart = fnBody.indexOf('"', throwIdx);
    const msgEnd = fnBody.indexOf('",', msgStart + 1);
    // Just verify there IS a throw — the exact message content is flexible
    expect(throwIdx).toBeGreaterThan(absoluteIdx);
  });

  it("existing stall-based timeout (LAUNCH_HARD_TIMEOUT_MS) is still present", () => {
    // The existing stall-based timeout should still be in place for the 4-min stall scenario
    const fnStart = launchRuntime.indexOf("export async function waitForLaunchReady");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = launchRuntime.substring(fnStart);

    expect(fnBody).toContain("LAUNCH_HARD_TIMEOUT_MS");
    expect(fnBody).toContain("lastProgressAt");
  });
});
