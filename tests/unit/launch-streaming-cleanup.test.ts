import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("Streaming content cleanup on session restart (VAL-FE-STREAM-001)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("handleRestartLaunchSession clears streamingContent before starting new session", () => {
    // Extract the handleRestartLaunchSession function body
    const fnStart = launchForm.indexOf("const handleRestartLaunchSession");
    expect(fnStart).toBeGreaterThan(-1);

    const startLaunchIdx = launchForm.indexOf("await startLaunchSession", fnStart);
    expect(startLaunchIdx).toBeGreaterThan(-1);

    // setStreamingContent(null) must appear between the function start and the startLaunchSession call
    const fnBody = launchForm.substring(fnStart, startLaunchIdx);
    expect(fnBody).toContain("setStreamingContent(null)");
  });

  it("streaming content is cleared before any new session state is set", () => {
    // The setStreamingContent(null) in handleRestartLaunchSession should appear
    // before the startLaunchSession call, ensuring no stale content leaks
    const fnStart = launchForm.indexOf("const handleRestartLaunchSession");
    const setStreamingIdx = launchForm.indexOf("setStreamingContent(null)", fnStart);
    const startSessionIdx = launchForm.indexOf("await startLaunchSession", fnStart);
    expect(setStreamingIdx).toBeGreaterThan(-1);
    expect(startSessionIdx).toBeGreaterThan(-1);
    expect(setStreamingIdx).toBeLessThan(startSessionIdx);
  });
});

describe("Streaming content cleanup on effect unmount (VAL-FE-STREAM-002)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("streaming effect cleanup function clears streamingContent", () => {
    // Find the streaming effect (the one that has connectStream)
    const effectStart = launchForm.indexOf("void connectStream()");
    expect(effectStart).toBeGreaterThan(-1);

    // Find the cleanup return function after connectStream
    const cleanupReturn = launchForm.indexOf("return () => {", effectStart);
    expect(cleanupReturn).toBeGreaterThan(-1);

    // Find the end of the cleanup function (closing brace + semicolon)
    // The cleanup function should contain setStreamingContent(null)
    const cleanupBody = launchForm.substring(cleanupReturn, cleanupReturn + 300);
    expect(cleanupBody).toContain("setStreamingContent(null)");
  });

  it("cleanup also aborts the stream controller and sets cancelled flag", () => {
    // Ensure the cleanup function still has the existing cleanup logic
    const effectStart = launchForm.indexOf("void connectStream()");
    const cleanupReturn = launchForm.indexOf("return () => {", effectStart);
    const cleanupBody = launchForm.substring(cleanupReturn, cleanupReturn + 300);

    expect(cleanupBody).toContain("cancelled = true");
    expect(cleanupBody).toContain("controller.abort()");
    expect(cleanupBody).toContain("streamAbortRef.current = null");
    expect(cleanupBody).toContain("setStreamingContent(null)");
  });
});

describe("New session starts with empty streaming state", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("streamingContent initial state is null", () => {
    expect(launchForm).toContain("useState<string | null>(null)");
    // Verify the specific streamingContent state initialization
    const streamingStateIdx = launchForm.indexOf("const [streamingContent, setStreamingContent] = useState<string | null>(null)");
    expect(streamingStateIdx).toBeGreaterThan(-1);
  });

  it("back navigation also clears streaming content", () => {
    // The onBack handler in the session view should clear streamingContent
    const onBackIdx = launchForm.indexOf("onBack={() => {");
    expect(onBackIdx).toBeGreaterThan(-1);
    const onBackBody = launchForm.substring(onBackIdx, onBackIdx + 300);
    expect(onBackBody).toContain("setStreamingContent(null)");
  });
});
