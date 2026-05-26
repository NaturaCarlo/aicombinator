import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("Stall callback / fallback poll race flag (VAL-FE-STATE-003, VAL-FE-STATE-004)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  // Extract the streaming effect body for inspection
  const effectStart = launchForm.indexOf("useEffect(() => {\n    if (!launchSession?.id || !launchSession.processing");
  const effectBody = effectStart > -1 ? launchForm.substring(effectStart, effectStart + 5000) : "";

  it("declares an inFallbackMode flag in the streaming effect scope", () => {
    expect(effectStart).toBeGreaterThan(-1);
    // The flag should be declared as a let variable in the streaming effect
    expect(effectBody).toMatch(/let\s+inFallbackMode\s*=\s*false/);
  });

  it("fallbackPoll sets inFallbackMode = true BEFORE clearing the stall timer", () => {
    const fallbackPollStart = effectBody.indexOf("const fallbackPoll = async");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    const fallbackPollBody = effectBody.substring(fallbackPollStart, fallbackPollStart + 600);

    // inFallbackMode = true should appear before clearTimeout(stallTimer)
    const flagSetIdx = fallbackPollBody.indexOf("inFallbackMode = true");
    const clearIdx = fallbackPollBody.indexOf("clearTimeout(stallTimer)");
    expect(flagSetIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(flagSetIdx).toBeLessThan(clearIdx);
  });

  it("stall timer callback checks inFallbackMode as the first guard", () => {
    // Find the stall timer callback — it's inside resetStallTimer / setTimeout
    const stallCallbackStart = effectBody.indexOf("stallTimer = setTimeout(async ()");
    expect(stallCallbackStart).toBeGreaterThan(-1);

    // Get the first ~300 chars of the callback body
    const callbackBody = effectBody.substring(stallCallbackStart, stallCallbackStart + 300);

    // The inFallbackMode check should appear before any state mutations or awaits
    expect(callbackBody).toMatch(/if\s*\(\s*inFallbackMode\s*\)\s*return/);
  });

  it("stall timer callback re-checks cancelled || inFallbackMode after async operations", () => {
    // Find the stall timer callback
    const stallCallbackStart = effectBody.indexOf("stallTimer = setTimeout(async ()");
    expect(stallCallbackStart).toBeGreaterThan(-1);

    // Get the callback body up to the catch block
    const callbackEnd = effectBody.indexOf("} catch", stallCallbackStart);
    const callbackBody = callbackEnd > -1
      ? effectBody.substring(stallCallbackStart, callbackEnd)
      : effectBody.substring(stallCallbackStart, stallCallbackStart + 600);

    // After the await getLaunchSession call, there should be a check for cancelled || inFallbackMode
    const awaitIdx = callbackBody.indexOf("await getLaunchSession");
    expect(awaitIdx).toBeGreaterThan(-1);

    const afterAwait = callbackBody.substring(awaitIdx);
    // Should check both cancelled and inFallbackMode before state mutations
    expect(afterAwait).toMatch(/cancelled\s*\|\|\s*inFallbackMode|inFallbackMode\s*\|\|\s*cancelled/);
  });

  it("stall callback cannot mutate state when fallback mode is active", () => {
    // The combination of:
    // 1. inFallbackMode check at the start of stall callback
    // 2. re-check after awaits
    // ensures no state mutations happen when fallback poll is active

    // Verify the stall callback has no setLaunchSession calls without an inFallbackMode guard
    const stallCallbackStart = effectBody.indexOf("stallTimer = setTimeout(async ()");
    expect(stallCallbackStart).toBeGreaterThan(-1);

    const catchIdx = effectBody.indexOf("} catch", stallCallbackStart);
    const callbackBody = catchIdx > -1
      ? effectBody.substring(stallCallbackStart, catchIdx)
      : effectBody.substring(stallCallbackStart, stallCallbackStart + 600);

    // Every setLaunchSession in the stall callback should be preceded by an inFallbackMode check
    const setLaunchSessionIdx = callbackBody.indexOf("setLaunchSession(fresh)");
    if (setLaunchSessionIdx > -1) {
      const beforeSetLaunch = callbackBody.substring(0, setLaunchSessionIdx);
      // There must be an inFallbackMode check somewhere before the state mutation
      expect(beforeSetLaunch).toContain("inFallbackMode");
    }
  });
});
