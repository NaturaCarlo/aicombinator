import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("AbortController signal wired to sendLaunchSessionMessage network request (VAL-FE-STATE-005)", () => {
  const apiTs = readFile("lib/api.ts");
  const launchForm = readFile("components/launch-form.tsx");

  it("sendLaunchSessionMessage accepts an optional signal parameter", () => {
    // Find the sendLaunchSessionMessage function signature
    const fnStart = apiTs.indexOf("export async function sendLaunchSessionMessage");
    expect(fnStart).toBeGreaterThan(-1);

    // Extract the function signature (up to the opening brace of the function body)
    const sigEnd = apiTs.indexOf("{", fnStart);
    const signature = apiTs.substring(fnStart, sigEnd);

    // Should accept a signal parameter (AbortSignal)
    expect(signature).toContain("signal");
    expect(signature).toMatch(/signal\??\s*:\s*AbortSignal/);
  });

  it("sendLaunchSessionMessage passes signal to the apiFetch call", () => {
    // Find the function body
    const fnStart = apiTs.indexOf("export async function sendLaunchSessionMessage");
    expect(fnStart).toBeGreaterThan(-1);

    // Find the next export function or end of file
    const fnBodyStart = apiTs.indexOf("{", fnStart);
    const nextExport = apiTs.indexOf("\nexport ", fnStart + 10);
    const fnBody = apiTs.substring(fnBodyStart, nextExport > -1 ? nextExport : undefined);

    // The signal should be passed in the options object to apiFetch
    expect(fnBody).toContain("signal");
  });

  it("handleSendLaunchMessage passes the abort signal to sendLaunchSessionMessage", () => {
    const fnStart = launchForm.indexOf("const handleSendLaunchMessage");
    expect(fnStart).toBeGreaterThan(-1);

    // Find the end of the function
    const fnBody = launchForm.substring(fnStart, launchForm.indexOf("\n  const handle", fnStart + 10));

    // The call to sendLaunchSessionMessage should include the signal
    // Look for a pattern like sendLaunchSessionMessage(..., signal) or
    // sendLaunchSessionMessage(..., controller.signal) or
    // sendLaunchSessionMessage(..., { signal })
    const sendCallIdx = fnBody.indexOf("sendLaunchSessionMessage(");
    expect(sendCallIdx).toBeGreaterThan(-1);

    // Extract the call arguments
    const callStart = fnBody.indexOf("(", sendCallIdx + "sendLaunchSessionMessage".length);
    let depth = 1;
    let i = callStart + 1;
    while (depth > 0 && i < fnBody.length) {
      if (fnBody[i] === "(") depth++;
      if (fnBody[i] === ")") depth--;
      i++;
    }
    const callArgs = fnBody.substring(callStart, i);

    // The signal should be passed as an argument
    expect(callArgs).toContain("signal");
  });

  it("handleSendLaunchMessage catch block handles AbortError gracefully", () => {
    const fnStart = launchForm.indexOf("const handleSendLaunchMessage");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = launchForm.substring(fnStart, launchForm.indexOf("\n  const handle", fnStart + 10));

    const catchIdx = fnBody.indexOf("} catch");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = fnBody.substring(catchIdx, catchIdx + 400);

    // Should handle AbortError specifically (from the actual network abort)
    // by either checking error name === 'AbortError' or signal.aborted
    const handlesAbort =
      catchBody.includes("AbortError") || catchBody.includes("signal.aborted");
    expect(handlesAbort).toBe(true);
  });
});

describe("apiFetch respects external signal parameter", () => {
  const apiTs = readFile("lib/api.ts");

  it("apiFetch uses options.signal when provided (allows external abort)", () => {
    // Find the apiFetch function
    const fnStart = apiTs.indexOf("async function apiFetch");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBodyStart = apiTs.indexOf("{", fnStart);
    const fnEnd = apiTs.indexOf("\n}\n", fnBodyStart);
    const fnBody = apiTs.substring(fnBodyStart, fnEnd);

    // apiFetch should use options.signal if provided, falling back to its own controller.signal
    // The pattern `options.signal ?? controller.signal` already exists
    expect(fnBody).toContain("options.signal");
  });
});
