import { describe, it, expect } from "vitest";

/**
 * Tests for the CEO chat scroll behavior logic.
 * The component uses a pattern where:
 * - Initial load (prevCount=0, newCount>0): behavior:"auto" (instant)
 * - Subsequent messages: behavior:"smooth"
 * - Streaming: behavior:"auto"
 */

function resolveScrollBehavior({
  prevCount,
  newCount,
  hasStreamingEntry,
}: {
  prevCount: number;
  newCount: number;
  hasStreamingEntry: boolean;
}): ScrollBehavior {
  const isInitialLoad = prevCount === 0 && newCount > 0;
  if (isInitialLoad || hasStreamingEntry) return "auto";
  return "smooth";
}

describe("CEO chat scroll behavior", () => {
  it("uses 'auto' (instant) on initial load when prev count was 0", () => {
    expect(
      resolveScrollBehavior({ prevCount: 0, newCount: 5, hasStreamingEntry: false }),
    ).toBe("auto");
  });

  it("uses 'smooth' for subsequent new messages", () => {
    expect(
      resolveScrollBehavior({ prevCount: 5, newCount: 6, hasStreamingEntry: false }),
    ).toBe("smooth");
  });

  it("uses 'auto' during streaming regardless of count", () => {
    expect(
      resolveScrollBehavior({ prevCount: 5, newCount: 6, hasStreamingEntry: true }),
    ).toBe("auto");
  });

  it("uses 'auto' on initial load even with streaming", () => {
    expect(
      resolveScrollBehavior({ prevCount: 0, newCount: 3, hasStreamingEntry: true }),
    ).toBe("auto");
  });

  it("uses 'smooth' when counts are equal and not streaming", () => {
    expect(
      resolveScrollBehavior({ prevCount: 5, newCount: 5, hasStreamingEntry: false }),
    ).toBe("smooth");
  });

  it("uses 'auto' when counts are equal but streaming", () => {
    expect(
      resolveScrollBehavior({ prevCount: 5, newCount: 5, hasStreamingEntry: true }),
    ).toBe("auto");
  });
});
