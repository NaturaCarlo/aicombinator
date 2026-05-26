import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("SSE error handled exactly once — no throw after onError (VAL-FE-STREAM-005)", () => {
  const apiTs = readFile("lib/api.ts");

  it("streamLaunchSession error handler calls onError without throwing", () => {
    // Find the error handling block in streamLaunchSession
    const fnStart = apiTs.indexOf("export async function streamLaunchSession");
    expect(fnStart).toBeGreaterThan(-1);

    // Find the error event handler within streamLaunchSession
    const errorBlockIdx = apiTs.indexOf('payload.type === "error"', fnStart);
    expect(errorBlockIdx).toBeGreaterThan(-1);

    // Find the onError call
    const onErrorIdx = apiTs.indexOf("handlers.onError?.(payload.error)", errorBlockIdx);
    expect(onErrorIdx).toBeGreaterThan(-1);

    // After calling onError, the next meaningful statement should be
    // "return { complete: false }" — NOT "throw new Error(payload.error)"
    // Get the section from onError to the closing brace of the if block
    const afterOnError = apiTs.substring(onErrorIdx, onErrorIdx + 200);

    // Should NOT contain a throw statement
    expect(afterOnError).not.toMatch(/throw\s+new\s+Error\(payload\.error\)/);
  });

  it("streamLaunchSession error handler returns { complete: false } after onError", () => {
    const fnStart = apiTs.indexOf("export async function streamLaunchSession");
    expect(fnStart).toBeGreaterThan(-1);

    const errorBlockIdx = apiTs.indexOf('payload.type === "error"', fnStart);
    expect(errorBlockIdx).toBeGreaterThan(-1);

    const onErrorIdx = apiTs.indexOf("handlers.onError?.(payload.error)", errorBlockIdx);
    expect(onErrorIdx).toBeGreaterThan(-1);

    // The return { complete: false } should follow the onError call
    const afterOnError = apiTs.substring(onErrorIdx, onErrorIdx + 200);
    expect(afterOnError).toContain("return { complete: false }");
  });
});

describe("No unhandled exception from SSE error path (VAL-FE-STREAM-006)", () => {
  const apiTs = readFile("lib/api.ts");

  it("streamLaunchSession does not throw from within the SSE payload error handler", () => {
    // Find the streamLaunchSession function
    const fnStart = apiTs.indexOf("export async function streamLaunchSession");
    expect(fnStart).toBeGreaterThan(-1);

    // Find the next function definition after streamLaunchSession to get the boundary
    const fnEnd = apiTs.indexOf("\nexport ", fnStart + 10);
    expect(fnEnd).toBeGreaterThan(-1);

    const functionBody = apiTs.substring(fnStart, fnEnd);

    // Within the error payload handler block, there should be no throw
    // Find the error type check block
    const errorBlockIdx = functionBody.indexOf('payload.type === "error"');
    expect(errorBlockIdx).toBeGreaterThan(-1);

    // Extract the if-block for the error handler (next closing brace)
    const blockStart = functionBody.lastIndexOf("if (", errorBlockIdx);
    expect(blockStart).toBeGreaterThan(-1);

    // Get a reasonable chunk of code from the error block
    const errorBlock = functionBody.substring(blockStart, blockStart + 300);

    // Should have onError callback call
    expect(errorBlock).toContain("handlers.onError?.(payload.error)");

    // Should NOT have throw — clean return instead
    expect(errorBlock).not.toContain("throw new Error");

    // Should have return statement for clean exit
    expect(errorBlock).toContain("return { complete: false }");
  });

  it("caller (attemptStream) can handle {complete: false} from error path", () => {
    // Verify that launch-form.tsx attemptStream checks result.complete
    const launchForm = readFile("components/launch-form.tsx");

    const attemptStreamStart = launchForm.indexOf("const attemptStream = async ()");
    expect(attemptStreamStart).toBeGreaterThan(-1);

    const attemptStreamBody = launchForm.substring(attemptStreamStart, attemptStreamStart + 1200);

    // attemptStream should check result.complete to decide what to do
    expect(attemptStreamBody).toContain("result.complete");

    // The onError handler should set the notice without needing a catch
    expect(attemptStreamBody).toContain("onError:");
  });
});
