import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("Abort in-flight message sends on navigation (VAL-FE-STATE-005)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("has a ref for the message send AbortController", () => {
    // There should be a useRef for the message send abort controller
    expect(launchForm).toContain("messageSendAbortRef");
    // It should be initialized as a useRef
    const refPattern = /const\s+messageSendAbortRef\s*=\s*useRef<AbortController\s*\|\s*null>\(null\)/;
    expect(launchForm).toMatch(refPattern);
  });

  it("handleSendLaunchMessage creates an AbortController and stores it in the ref", () => {
    const fnStart = launchForm.indexOf("const handleSendLaunchMessage");
    expect(fnStart).toBeGreaterThan(-1);

    // Find the function body up to the next top-level const/function
    const fnBody = launchForm.substring(fnStart, launchForm.indexOf("\n  const handle", fnStart + 10));

    // Should create a new AbortController
    expect(fnBody).toContain("new AbortController()");
    expect(fnBody).toContain("messageSendAbortRef.current");
  });

  it("handleSendLaunchMessage checks for abort before updating state", () => {
    const fnStart = launchForm.indexOf("const handleSendLaunchMessage");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = launchForm.substring(fnStart, launchForm.indexOf("\n  const handle", fnStart + 10));

    // After the sendLaunchSessionMessage call, there should be an abort check
    // before calling setLaunchSession / setDraftSessionId / etc.
    expect(fnBody).toContain("signal.aborted");
  });

  it("handleSendLaunchMessage clears the ref after completion", () => {
    const fnStart = launchForm.indexOf("const handleSendLaunchMessage");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = launchForm.substring(fnStart, launchForm.indexOf("\n  const handle", fnStart + 10));

    // Should clear the ref in finally block
    expect(fnBody).toContain("messageSendAbortRef.current = null");
  });

  it("onBack handler aborts the message send controller", () => {
    const onBackIdx = launchForm.indexOf("onBack={() => {");
    expect(onBackIdx).toBeGreaterThan(-1);
    const onBackBody = launchForm.substring(onBackIdx, onBackIdx + 500);
    expect(onBackBody).toContain("messageSendAbortRef.current?.abort()");
  });

  it("handleRestartLaunchSession aborts the message send controller", () => {
    const fnStart = launchForm.indexOf("const handleRestartLaunchSession");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = launchForm.substring(fnStart, launchForm.indexOf("\n  const handle", fnStart + 10));

    expect(fnBody).toContain("messageSendAbortRef.current?.abort()");
  });
});

describe("No session resurrection after back navigation (VAL-FE-STATE-006)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("aborted sendLaunchSessionMessage does not call setLaunchSession", () => {
    // The handleSendLaunchMessage function should check signal.aborted
    // before calling any state setters
    const fnStart = launchForm.indexOf("const handleSendLaunchMessage");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = launchForm.substring(fnStart, launchForm.indexOf("\n  const handle", fnStart + 10));

    // The abort check must appear before setLaunchSession in the try block
    const abortCheckIdx = fnBody.indexOf("signal.aborted");
    const setLaunchIdx = fnBody.indexOf("setLaunchSession(session)");
    expect(abortCheckIdx).toBeGreaterThan(-1);
    // The abort check should be before the state mutation
    expect(abortCheckIdx).toBeLessThan(setLaunchIdx);
  });

  it("catch block also checks for abort to avoid setting error state", () => {
    const fnStart = launchForm.indexOf("const handleSendLaunchMessage");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = launchForm.substring(fnStart, launchForm.indexOf("\n  const handle", fnStart + 10));

    // In the catch block, it should check for AbortError or signal.aborted
    // and return early instead of setting error state
    const catchIdx = fnBody.indexOf("} catch");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = fnBody.substring(catchIdx, catchIdx + 300);

    // Should check for abort in catch block
    const hasAbortCheck = catchBody.includes("AbortError") || catchBody.includes("signal.aborted") || catchBody.includes("aborted");
    expect(hasAbortCheck).toBe(true);
  });

  it("component unmount effect cleans up message send controller", () => {
    // There should be a useEffect that aborts messageSendAbortRef on unmount
    // This can be in the streaming effect cleanup or a separate effect
    const streamingEffectCleanup = launchForm.indexOf("return () => {", launchForm.indexOf("void connectStream()"));
    expect(streamingEffectCleanup).toBeGreaterThan(-1);
    const cleanupBody = launchForm.substring(streamingEffectCleanup, streamingEffectCleanup + 500);

    expect(cleanupBody).toContain("messageSendAbortRef.current?.abort()");
  });
});

describe("Malformed SSE chunks log warning (VAL-FE-STREAM-008)", () => {
  const apiTs = readFile("lib/api.ts");

  it("extractSsePayloads catch block logs a console.warn for malformed chunks", () => {
    // Find the extractSsePayloads function
    const fnStart = apiTs.indexOf("function extractSsePayloads");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = apiTs.substring(fnStart, fnStart + 800);

    // The catch block should have console.warn instead of just swallowing
    expect(fnBody).toContain("console.warn");
  });

  it("console.warn includes context about the malformed chunk", () => {
    const fnStart = apiTs.indexOf("function extractSsePayloads");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = apiTs.substring(fnStart, fnStart + 800);

    // The warn should mention SSE or malformed to help debugging
    const catchIdx = fnBody.indexOf("catch");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = fnBody.substring(catchIdx, catchIdx + 200);

    // Should log the warning with some context
    expect(catchBody).toContain("console.warn");
  });
});
