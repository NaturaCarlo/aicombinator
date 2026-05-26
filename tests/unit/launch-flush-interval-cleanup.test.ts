import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("Flush interval cleanup in fallback poll timeout path", () => {
  const launchForm = readFile("components/launch-form.tsx");

  // Extract the fallbackPoll function body (extends to the "resetStallTimer" or cleanup)
  const fallbackPollStart = launchForm.indexOf("const fallbackPoll = async");
  // fallbackPoll extends until the next top-level statement in the effect
  // (which is "resetStallTimer()" call or the cleanup "return () =>")
  const cleanupReturnIdx = launchForm.indexOf("void connectStream()", fallbackPollStart);

  it("fallbackPoll function exists", () => {
    expect(fallbackPollStart).toBeGreaterThan(-1);
  });

  it("clears flushInterval before returning on 5-minute timeout", () => {
    expect(fallbackPollStart).toBeGreaterThan(-1);
    expect(cleanupReturnIdx).toBeGreaterThan(-1);

    const fallbackPollBody = launchForm.substring(fallbackPollStart, cleanupReturnIdx);

    // Find the timeout check: if (Date.now() - pollStartedAt >= FALLBACK_POLL_TIMEOUT_MS)
    const timeoutCheckIdx = fallbackPollBody.indexOf("FALLBACK_POLL_TIMEOUT_MS");
    expect(timeoutCheckIdx).toBeGreaterThan(-1);

    // Between the timeout check and the return statement, clearInterval(flushInterval) should appear
    const afterTimeout = fallbackPollBody.substring(timeoutCheckIdx);
    const returnIdx = afterTimeout.indexOf("return");
    expect(returnIdx).toBeGreaterThan(-1);

    const timeoutBlock = afterTimeout.substring(0, returnIdx);
    expect(timeoutBlock).toContain("clearInterval(flushInterval)");
  });
});

describe("Flush interval cleanup in all early return paths from streaming effect", () => {
  const launchForm = readFile("components/launch-form.tsx");

  // Extract the full streaming effect body
  const effectStart = launchForm.indexOf("useEffect(() => {\n    if (!launchSession?.id || !launchSession.processing");
  const effectEnd = launchForm.indexOf("}, [getToken, isLoaded, launchSession?.id, launchSession?.processing");

  it("streaming effect scope is found", () => {
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectEnd).toBeGreaterThan(-1);
  });

  it("fallbackPoll clears flushInterval when session stops processing", () => {
    const effectBody = launchForm.substring(effectStart, effectEnd);

    // Find the "if (!session.processing)" return path in fallbackPoll
    const fallbackPollStart = effectBody.indexOf("const fallbackPoll = async");
    expect(fallbackPollStart).toBeGreaterThan(-1);

    const fallbackPollBody = effectBody.substring(fallbackPollStart);
    const notProcessingIdx = fallbackPollBody.indexOf("if (!session.processing)");
    expect(notProcessingIdx).toBeGreaterThan(-1);

    // Between notProcessing check and the return, clearInterval(flushInterval) should appear
    const afterNotProcessing = fallbackPollBody.substring(notProcessingIdx);
    const returnIdx = afterNotProcessing.indexOf("return");
    expect(returnIdx).toBeGreaterThan(-1);

    const blockBeforeReturn = afterNotProcessing.substring(0, returnIdx);
    expect(blockBeforeReturn).toContain("clearInterval(flushInterval)");
  });

  it("effect cleanup still clears flushInterval", () => {
    const effectBody = launchForm.substring(effectStart, effectEnd + 200);

    // The cleanup return function should still have clearInterval(flushInterval)
    const cleanupReturn = effectBody.indexOf("return () => {", effectBody.indexOf("void connectStream()"));
    expect(cleanupReturn).toBeGreaterThan(-1);

    const cleanupBody = effectBody.substring(cleanupReturn, cleanupReturn + 300);
    expect(cleanupBody).toContain("clearInterval(flushInterval)");
  });

  it("stall recovery callback does not need to clear flushInterval (streaming may resume)", () => {
    const effectBody = launchForm.substring(effectStart, effectEnd);

    // The stall recovery callback fetches fresh state but streaming could resume
    // (connectStream is still running or polling restarts). So stall recovery
    // should NOT clear the flushInterval — it only clears streaming content.
    // This test documents that design choice.
    const stallCallbackStart = effectBody.indexOf("stallTimer = setTimeout(async ()");
    expect(stallCallbackStart).toBeGreaterThan(-1);

    // Verify stall recovery exists and does its job
    const stallCallbackEnd = effectBody.indexOf("} catch", stallCallbackStart);
    const stallCallbackBody = effectBody.substring(stallCallbackStart, stallCallbackEnd);
    expect(stallCallbackBody).toContain("setStreamingContent(null)");
  });
});
