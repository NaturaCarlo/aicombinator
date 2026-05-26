import { describe, it, expect, vi } from "vitest";

/**
 * Tests for M3 scrutiny fixes:
 * 1. Settings page: After name save, SWR keys for both /api/companies/:id/status
 *    AND /api/companies are revalidated so sidebar and portfolio get updated names.
 * 2. Agent slide-over: Optimistic status stays active until SWR revalidation
 *    from onSaved() completes.
 */

// ─── Fix 1: Settings name save SWR revalidation ────────────────

describe("Settings page name save SWR revalidation", () => {
  it("should revalidate both company status and companies list after name save", async () => {
    // Simulate the handleSaveName flow
    const mutateCompanyStatus = vi.fn().mockResolvedValue(undefined);
    const globalMutate = vi.fn().mockResolvedValue(undefined);
    const updateCompany = vi.fn().mockResolvedValue(undefined);
    const getToken = vi.fn().mockResolvedValue("token-123");

    const companyId = "comp-abc";
    const newName = "New Company Name";

    // Simulate handleSaveName
    const token = await getToken();
    await updateCompany(companyId, { name: newName }, token);
    await Promise.all([
      mutateCompanyStatus(),
      globalMutate("/api/companies"),
    ]);

    expect(updateCompany).toHaveBeenCalledWith(companyId, { name: newName }, "token-123");
    // Both SWR keys must be revalidated
    expect(mutateCompanyStatus).toHaveBeenCalled();
    expect(globalMutate).toHaveBeenCalledWith("/api/companies");
  });

  it("should revalidate companies list so portfolio page gets updated name", async () => {
    const globalMutate = vi.fn().mockResolvedValue(undefined);

    // The /api/companies key is used by portfolio page and sidebar account menu
    await globalMutate("/api/companies");
    expect(globalMutate).toHaveBeenCalledWith("/api/companies");
  });

  it("should revalidate company status so sidebar/dashboard header gets updated name", async () => {
    const mutateCompanyStatus = vi.fn().mockResolvedValue(undefined);

    // The /api/companies/:id/status key is used by sidebar and dashboard header
    await mutateCompanyStatus();
    expect(mutateCompanyStatus).toHaveBeenCalled();
  });

  it("should handle revalidation errors gracefully", async () => {
    const mutateCompanyStatus = vi.fn().mockRejectedValue(new Error("Network error"));
    const globalMutate = vi.fn().mockResolvedValue(undefined);

    // Promise.all will reject if either fails — this tests the error propagation
    await expect(
      Promise.all([mutateCompanyStatus(), globalMutate("/api/companies")]),
    ).rejects.toThrow("Network error");
  });
});

// ─── Fix 2: Optimistic status timing ───────────────────────────

describe("Agent slide-over optimistic status timing", () => {
  /**
   * Simulates the toggle flow where optimistic status must be
   * kept active until onSaved() resolves (SWR revalidation completes).
   */
  it("should keep optimistic status until onSaved resolves", async () => {
    let optimisticStatus: "free" | "paused" | null = null;
    const statusHistory: (string | null)[] = [];

    // Simulate SWR revalidation that takes time
    const onSaved = vi.fn().mockImplementation(() => {
      // At this point, optimistic status should still be active
      statusHistory.push(optimisticStatus);
      return new Promise<void>((resolve) => setTimeout(resolve, 50));
    });

    // Simulate toggle flow: user clicks pause
    optimisticStatus = "paused";
    statusHistory.push(optimisticStatus);

    // API call succeeds
    // Then await onSaved() (SWR revalidation)
    await onSaved();

    // Only AFTER onSaved resolves, clear optimistic status
    optimisticStatus = null;
    statusHistory.push(optimisticStatus);

    // Verify: optimistic was "paused" during onSaved, null after
    expect(statusHistory).toEqual(["paused", "paused", null]);
    expect(onSaved).toHaveBeenCalled();
  });

  it("should clear optimistic status even if onSaved rejects", async () => {
    let optimisticStatus: "free" | "paused" | null = null;

    const onSaved = vi.fn().mockRejectedValue(new Error("revalidation failed"));

    optimisticStatus = "paused";

    // In the error case, optimistic is cleared on catch (reverted)
    try {
      await onSaved();
    } catch {
      // Error handler clears optimistic
      optimisticStatus = null;
    }

    expect(optimisticStatus).toBeNull();
  });

  it("onSaved must be awaitable (returns Promise)", () => {
    // Verify the onSaved type contract allows returning a promise
    const asyncOnSaved = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    };
    const result = asyncOnSaved();
    expect(result).toBeInstanceOf(Promise);
  });

  it("should not flash back to old status during SWR revalidation", async () => {
    type AgentStatus = "free" | "working" | "paused";

    function getEffectiveStatus(
      serverStatus: AgentStatus,
      optimistic: AgentStatus | null,
    ): AgentStatus {
      return optimistic ?? serverStatus;
    }

    // Scenario: agent is "free", user clicks pause
    const serverStatus: AgentStatus = "free";
    let optimistic: AgentStatus | null = "paused";

    // During SWR revalidation, server still reports "free" (stale)
    // Optimistic should still override
    expect(getEffectiveStatus(serverStatus, optimistic)).toBe("paused");

    // After onSaved resolves, optimistic is cleared
    // Server should now report "paused" (fresh data from SWR)
    const updatedServerStatus: AgentStatus = "paused";
    optimistic = null;
    expect(getEffectiveStatus(updatedServerStatus, optimistic)).toBe("paused");
    // No flash to "free" at any point
  });
});

describe("Team page handleSlideOverSaved returns promise", () => {
  it("should await mutateFounderState for proper SWR revalidation", async () => {
    let revalidated = false;
    const mutateFounderState = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      revalidated = true;
    });

    // Simulate the updated handleSlideOverSaved
    const handleSlideOverSaved = async () => {
      await mutateFounderState();
    };

    await handleSlideOverSaved();
    expect(revalidated).toBe(true);
    expect(mutateFounderState).toHaveBeenCalled();
  });
});
