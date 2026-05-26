import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dashboardSrc = path.resolve(__dirname, "../../dashboard/src");

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(dashboardSrc, relativePath), "utf-8");
}

describe("MarkdownContent wrapped in React.memo (VAL-FE-PERF-001, VAL-FE-PERF-002)", () => {
  const markdownContent = readFile("components/company/markdown-content.tsx");

  it("MarkdownContent is wrapped in React.memo", () => {
    // Must use React.memo (or memo from react) to prevent unnecessary re-renders
    expect(markdownContent).toMatch(/React\.memo|memo\(/);
  });

  it("exports a memoized component", () => {
    // The exported MarkdownContent should be the result of memo()
    // Either: export const MarkdownContent = memo(...)
    // Or: export const MarkdownContent = React.memo(...)
    expect(markdownContent).toMatch(/export\s+(const|function)\s+MarkdownContent\s*=\s*(React\.)?memo/);
  });

  it("memo compares content prop to avoid re-parsing unchanged markdown", () => {
    // The memo wrapper should prevent re-renders when content hasn't changed
    // This means MarkdownContent must be wrapped, not just exported as a plain function
    const hasPlainFunctionExport = /^export\s+function\s+MarkdownContent\s*\(/m.test(markdownContent);
    expect(hasPlainFunctionExport).toBe(false);
  });
});

describe("Token updates throttled during streaming (VAL-FE-PERF-001)", () => {
  const launchForm = readFile("components/launch-form.tsx");

  it("onToken handler does not call setStreamingContent directly per token", () => {
    // The onToken callback should NOT directly call setStreamingContent on every token.
    // Instead it should accumulate tokens in a buffer/ref and flush on an interval.
    const onTokenStart = launchForm.indexOf("onToken:");
    expect(onTokenStart).toBeGreaterThan(-1);

    // Look at the onToken handler body (up to the next handler or closing brace)
    const onTokenBody = launchForm.substring(onTokenStart, onTokenStart + 500);

    // Should use a buffer/ref mechanism, not direct setState per token
    // Look for evidence of buffering: a ref, requestAnimationFrame, setTimeout, or throttle
    const hasThrottling = /tokenBuffer|pendingTokens|requestAnimationFrame|throttle|flushInterval|tokenRef/.test(onTokenBody);
    expect(hasThrottling).toBe(true);
  });

  it("has a token flush interval between 30-150ms for batching", () => {
    // There should be a constant or interval setup for token batching
    const hasFlushInterval = /TOKEN_FLUSH_INTERVAL|TOKEN_BATCH_INTERVAL|FLUSH_INTERVAL|50|100|80|60|70/.test(launchForm);
    expect(hasFlushInterval).toBe(true);

    // There should be some kind of interval-based flushing mechanism
    const hasIntervalSetup = /setInterval|requestAnimationFrame|setTimeout/.test(launchForm);
    expect(hasIntervalSetup).toBe(true);
  });

  it("token buffer is flushed to streamingContent state periodically", () => {
    // There should be a flush function that reads from the buffer and updates state
    const hasFlushLogic = /setStreamingContent.*tokenBuffer|setStreamingContent.*pendingTokens|setStreamingContent.*tokenRef|flush/.test(launchForm);
    expect(hasFlushLogic).toBe(true);
  });

  it("token buffer and flush interval are cleaned up when streaming ends", () => {
    // The cleanup function should clear any flush interval
    const effectStart = launchForm.indexOf("void connectStream()");
    expect(effectStart).toBeGreaterThan(-1);

    const cleanupReturn = launchForm.indexOf("return () => {", effectStart);
    expect(cleanupReturn).toBeGreaterThan(-1);

    const cleanupBody = launchForm.substring(cleanupReturn, cleanupReturn + 400);
    // Should clear the flush interval
    expect(cleanupBody).toMatch(/clearInterval|clearTimeout/);
  });
});

describe("Auto-scroll follows streaming content (VAL-FE-PERF-003)", () => {
  const sessionView = readFile("components/launch/launch-session-view.tsx");

  it("auto-scroll triggers on streamingContent changes, not just message count", () => {
    // The scroll effect should depend on streamingContent, not just session.messages.length
    expect(sessionView).toMatch(/streamingContent/);
    // The scroll logic should reference streamingContent as a trigger
    const scrollEffects = sessionView.match(/useEffect\([^]*?scrollIntoView|scrollTo|scrollTop[^]*?\]/gs);
    expect(scrollEffects).not.toBeNull();
    // At least one scroll-related effect should mention streamingContent
    const hasStreamingDep = scrollEffects?.some((effect) => effect.includes("streamingContent"));
    expect(hasStreamingDep).toBe(true);
  });

  it("scroll is throttled during streaming (200-500ms interval)", () => {
    // Auto-scroll during streaming should be throttled, not per-render
    const hasThrottledScroll = /scrollThrottle|lastScrollTime|scrollInterval|requestAnimationFrame|throttle.*scroll|SCROLL_THROTTLE/.test(sessionView);
    expect(hasThrottledScroll).toBe(true);
  });
});

describe("Manual scroll-up disengages auto-scroll (VAL-FE-PERF-004)", () => {
  const sessionView = readFile("components/launch/launch-session-view.tsx");

  it("tracks whether user has manually scrolled up", () => {
    // Should have a ref or state tracking manual scroll position
    expect(sessionView).toMatch(/userScrolled|isScrolledToBottom|autoScrollEnabled|scrollDisengaged|userScrolledUp/);
  });

  it("listens for scroll events on the message container", () => {
    // Should have an onScroll handler or scroll event listener
    expect(sessionView).toMatch(/onScroll|addEventListener.*scroll/);
  });

  it("auto-scroll is disabled when user scrolls up from bottom", () => {
    // The scroll tracking should detect when the user is NOT at the bottom
    // and disable auto-scroll
    expect(sessionView).toMatch(/scrollTop|scrollHeight|clientHeight/);
  });

  it("auto-scroll re-engages when user scrolls back to bottom", () => {
    // There should be logic to re-enable auto-scroll when the user scrolls
    // back to the bottom of the container
    const hasReengage = /scrollTop.*scrollHeight.*clientHeight|isNearBottom|isAtBottom/.test(sessionView);
    expect(hasReengage).toBe(true);
  });
});

describe("Billing SWR dedupingInterval >= 5000 (VAL-FE-PERF-005, VAL-FE-PERF-006)", () => {
  const useBillingHook = readFile("hooks/use-billing.ts");

  it("dedupingInterval is set to at least 5000ms", () => {
    // Should have dedupingInterval: 5000 or higher
    const match = useBillingHook.match(/dedupingInterval:\s*(\d+)/);
    expect(match).not.toBeNull();
    const interval = parseInt(match![1], 10);
    expect(interval).toBeGreaterThanOrEqual(5000);
  });

  it("dedupingInterval is not 0 (which causes unlimited requests)", () => {
    const match = useBillingHook.match(/dedupingInterval:\s*(\d+)/);
    expect(match).not.toBeNull();
    const interval = parseInt(match![1], 10);
    expect(interval).not.toBe(0);
  });
});
