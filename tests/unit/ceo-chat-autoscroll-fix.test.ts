import { describe, it, expect } from "vitest";

/**
 * Tests for the CEO chat autoscroll fix (m4-chat-autoscroll-fix).
 *
 * Problem: The previous implementation checked near-bottom AFTER DOM update,
 * meaning a tall new message could push scroll position away from bottom
 * before the check happened, causing false "not near bottom" detection.
 *
 * Fix: Capture near-bottom state BEFORE DOM growth by storing it in a ref
 * that gets updated on scroll events. The useEffect then reads this
 * pre-captured ref value instead of computing it post-DOM-mutation.
 *
 * The approach uses:
 * - A `wasNearBottomRef` that tracks whether user was near bottom
 * - A scroll event handler that continuously updates this ref
 * - The useEffect reads the ref value (captured BEFORE DOM update)
 *   to decide whether to auto-scroll
 */

// ─── Simulated scroll state tracking ──────────────────────────

/**
 * Simulates the wasNearBottomRef behavior:
 * Given scroll container dimensions, returns whether user is "near bottom".
 */
function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold: number = 100,
): boolean {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  return distanceFromBottom < threshold;
}

/**
 * Simulates the autoscroll decision logic after the fix.
 * Uses the pre-captured wasNearBottom value (from scroll handler ref),
 * NOT a post-DOM-mutation measurement.
 */
function shouldAutoScroll({
  wasNearBottom,
  hasNewEntries,
  isInitialLoad,
  hasStreamingEntry,
}: {
  wasNearBottom: boolean;
  hasNewEntries: boolean;
  isInitialLoad: boolean;
  hasStreamingEntry: boolean;
}): boolean {
  return isInitialLoad || hasStreamingEntry || (wasNearBottom && hasNewEntries);
}

// ─── Tests ─────────────────────────────────────────────────

describe("CEO Chat Autoscroll Fix — wasNearBottom ref tracking", () => {
  it("detects user is near bottom when within 100px threshold", () => {
    // Container: scrollHeight=1000, clientHeight=500, scrollTop=450
    // distanceFromBottom = 1000 - 450 - 500 = 50 (< 100)
    expect(isNearBottom(450, 500, 1000)).toBe(true);
  });

  it("detects user is NOT near bottom when scrolled up beyond threshold", () => {
    // Container: scrollHeight=1000, clientHeight=500, scrollTop=200
    // distanceFromBottom = 1000 - 200 - 500 = 300 (>= 100)
    expect(isNearBottom(200, 500, 1000)).toBe(false);
  });

  it("detects user is at exact bottom", () => {
    // scrollTop + clientHeight === scrollHeight
    expect(isNearBottom(500, 500, 1000)).toBe(true);
  });

  it("detects user is at exact threshold boundary (99px from bottom)", () => {
    // distanceFromBottom = 1000 - 401 - 500 = 99 (< 100)
    expect(isNearBottom(401, 500, 1000)).toBe(true);
  });

  it("detects user is just beyond threshold (100px from bottom)", () => {
    // distanceFromBottom = 1000 - 400 - 500 = 100 (NOT < 100)
    expect(isNearBottom(400, 500, 1000)).toBe(false);
  });
});

describe("CEO Chat Autoscroll Fix — pre-captured near-bottom prevents missed scroll", () => {
  it("auto-scrolls when user was at bottom BEFORE tall message arrived", () => {
    // Scenario: User at bottom, tall message comes in.
    // The ref captured wasNearBottom=true BEFORE DOM grew.
    // Even though post-DOM the scroll position is far from new bottom,
    // the pre-captured ref correctly triggers autoscroll.
    expect(
      shouldAutoScroll({
        wasNearBottom: true, // captured BEFORE DOM update
        hasNewEntries: true,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(true);
  });

  it("does NOT auto-scroll when user had scrolled up before tall message arrived", () => {
    // Scenario: User scrolled up to read history, tall message arrives.
    // The ref captured wasNearBottom=false from scroll handler.
    expect(
      shouldAutoScroll({
        wasNearBottom: false, // user was scrolled up
        hasNewEntries: true,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(false);
  });

  it("always auto-scrolls on initial load regardless of wasNearBottom", () => {
    expect(
      shouldAutoScroll({
        wasNearBottom: false,
        hasNewEntries: true,
        isInitialLoad: true,
        hasStreamingEntry: false,
      }),
    ).toBe(true);
  });

  it("always auto-scrolls during streaming regardless of wasNearBottom", () => {
    expect(
      shouldAutoScroll({
        wasNearBottom: false,
        hasNewEntries: false,
        isInitialLoad: false,
        hasStreamingEntry: true,
      }),
    ).toBe(true);
  });

  it("does NOT auto-scroll when no new entries even if wasNearBottom", () => {
    expect(
      shouldAutoScroll({
        wasNearBottom: true,
        hasNewEntries: false,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(false);
  });
});

describe("CEO Chat Autoscroll Fix — tall message simulation", () => {
  it("simulates the bug scenario: user at bottom, 500px message pushes scroll away", () => {
    // BEFORE new message:
    // scrollHeight=1000, clientHeight=500, scrollTop=500 (at exact bottom)
    const wasAtBottom = isNearBottom(500, 500, 1000);
    expect(wasAtBottom).toBe(true);

    // AFTER DOM update: new 500px tall message added
    // scrollHeight becomes 1500, scrollTop stays at 500, clientHeight still 500
    // Post-DOM distanceFromBottom = 1500 - 500 - 500 = 500 (far from bottom!)
    const postDomNearBottom = isNearBottom(500, 500, 1500);
    expect(postDomNearBottom).toBe(false); // OLD code would fail here

    // With the fix: we use the PRE-captured value (wasAtBottom=true)
    expect(
      shouldAutoScroll({
        wasNearBottom: wasAtBottom, // pre-captured = true
        hasNewEntries: true,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(true); // Correctly auto-scrolls!
  });

  it("simulates: user scrolled up 300px, tall message arrives, no autoscroll", () => {
    // BEFORE new message:
    // scrollHeight=1000, clientHeight=500, scrollTop=200 (scrolled up)
    const wasAtBottom = isNearBottom(200, 500, 1000);
    expect(wasAtBottom).toBe(false);

    // AFTER DOM update: new message added
    // scrollHeight becomes 1200, scrollTop stays at 200
    // Post-DOM distanceFromBottom = 1200 - 200 - 500 = 500

    // With the fix: pre-captured wasNearBottom=false → no autoscroll
    expect(
      shouldAutoScroll({
        wasNearBottom: wasAtBottom,
        hasNewEntries: true,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(false); // Correctly preserved user position
  });

  it("simulates: user near bottom (50px away), small message arrives, autoscrolls", () => {
    // BEFORE: scrollHeight=1000, clientHeight=500, scrollTop=450
    // distanceFromBottom = 50
    const wasAtBottom = isNearBottom(450, 500, 1000);
    expect(wasAtBottom).toBe(true);

    // AFTER: small 30px message, scrollHeight=1030, scrollTop=450
    // distanceFromBottom = 1030-450-500 = 80 (still near bottom post-DOM)
    // But the fix doesn't check post-DOM — it uses pre-captured value
    expect(
      shouldAutoScroll({
        wasNearBottom: wasAtBottom,
        hasNewEntries: true,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(true);
  });
});

describe("CEO Chat Autoscroll Fix — scroll handler ref update pattern", () => {
  it("ref value updates correctly across multiple scroll positions", () => {
    // Simulate scroll handler updating the ref at different positions
    const scrollPositions = [
      { scrollTop: 0, clientHeight: 500, scrollHeight: 2000, expected: false },
      { scrollTop: 500, clientHeight: 500, scrollHeight: 2000, expected: false },
      { scrollTop: 1000, clientHeight: 500, scrollHeight: 2000, expected: false },
      { scrollTop: 1401, clientHeight: 500, scrollHeight: 2000, expected: true }, // 99px from bottom
      { scrollTop: 1450, clientHeight: 500, scrollHeight: 2000, expected: true }, // 50px from bottom
      { scrollTop: 1500, clientHeight: 500, scrollHeight: 2000, expected: true }, // at bottom
      { scrollTop: 1200, clientHeight: 500, scrollHeight: 2000, expected: false }, // scrolled back up
    ];

    for (const pos of scrollPositions) {
      const result = isNearBottom(pos.scrollTop, pos.clientHeight, pos.scrollHeight);
      expect(result).toBe(pos.expected);
    }
  });

  it("ref captures state independently of React render cycle", () => {
    // The key insight: scroll handler runs synchronously on scroll events,
    // which happen BEFORE React's commit phase adds new DOM elements.
    // So the ref always has the "before DOM update" value.

    // Step 1: User scrolls to bottom
    let wasNearBottomRef = isNearBottom(500, 500, 1000); // true
    expect(wasNearBottomRef).toBe(true);

    // Step 2: New message arrives (React re-renders)
    // The scroll handler doesn't fire during render —
    // so wasNearBottomRef still holds the pre-render value
    const shouldScroll = shouldAutoScroll({
      wasNearBottom: wasNearBottomRef,
      hasNewEntries: true,
      isInitialLoad: false,
      hasStreamingEntry: false,
    });
    expect(shouldScroll).toBe(true);

    // Step 3: After autoscroll, user scrolls up
    wasNearBottomRef = isNearBottom(200, 500, 1500); // false (scrolled up in longer container)
    expect(wasNearBottomRef).toBe(false);

    // Step 4: Another message arrives — no autoscroll since user scrolled up
    const shouldScroll2 = shouldAutoScroll({
      wasNearBottom: wasNearBottomRef,
      hasNewEntries: true,
      isInitialLoad: false,
      hasStreamingEntry: false,
    });
    expect(shouldScroll2).toBe(false);
  });
});
