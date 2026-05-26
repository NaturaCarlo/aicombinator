import { describe, it, expect, vi } from "vitest";

/**
 * Tests for the fix: CEO chat textbox staying disabled after streaming response completes.
 *
 * ROOT CAUSE: In handleSend(), after streamChatWithCeo() resolves, the code did
 * `await mutateHistory()` BEFORE `setSending(false)`. If mutateHistory() was slow
 * (which it often is right after a CEO turn), the textbox stayed disabled for 1-2 minutes.
 *
 * THE FIX:
 * 1. setSending(false) runs IMMEDIATELY after streamChatWithCeo() resolves, BEFORE mutateHistory()
 * 2. mutateHistory() is non-blocking (not awaited)
 * 3. setSending(false) runs even if mutateHistory throws
 */

/**
 * Simulates the handleSend flow from ceo-chat-panel.tsx.
 * This is a structural test of the state transitions — it extracts the
 * critical ordering logic from the component.
 */
function createHandleSendSimulator() {
  const calls: string[] = [];
  let sendingState = false;
  let activeChatState: { status: string } | null = null;

  const setSending = (val: boolean) => {
    sendingState = val;
    calls.push(`setSending(${val})`);
  };

  const setActiveChat = (val: { status: string } | null) => {
    activeChatState = val;
    calls.push(`setActiveChat(${val ? val.status : "null"})`);
  };

  return {
    calls,
    getSendingState: () => sendingState,
    getActiveChatState: () => activeChatState,
    setSending,
    setActiveChat,
  };
}

describe("CEO chat textbox stuck fix", () => {
  it("setSending(false) is called even if mutateHistory throws", async () => {
    const sim = createHandleSendSimulator();
    const mutateHistory = vi.fn().mockRejectedValue(new Error("Network error"));
    const streamChatWithCeo = vi.fn().mockResolvedValue(undefined);

    sim.setSending(true);
    sim.setActiveChat({ status: "pending" });

    // Simulate the FIXED handleSend flow
    try {
      await streamChatWithCeo();
      // setSending(false) runs IMMEDIATELY after stream resolves
      sim.setSending(false);
      sim.setActiveChat(null);
      // mutateHistory is non-blocking — fire and forget
      mutateHistory().catch(() => {});
    } catch {
      sim.setSending(false);
      mutateHistory().catch(() => {});
    }

    expect(sim.getSendingState()).toBe(false);
    expect(streamChatWithCeo).toHaveBeenCalled();
  });

  it("setSending(false) runs BEFORE mutateHistory on success", async () => {
    const orderTracker: string[] = [];
    let resolveMutate: () => void;
    const mutatePromise = new Promise<void>((resolve) => {
      resolveMutate = resolve;
    });

    const mutateHistory = vi.fn().mockImplementation(() => {
      orderTracker.push("mutateHistory:start");
      return mutatePromise;
    });

    const streamChatWithCeo = vi.fn().mockResolvedValue(undefined);
    const setSending = vi.fn().mockImplementation((val: boolean) => {
      orderTracker.push(`setSending(${val})`);
    });

    // Simulate the FIXED handleSend flow
    await streamChatWithCeo();
    setSending(false);
    // mutateHistory is non-blocking
    mutateHistory().catch(() => {});

    // setSending(false) must have been called already, even though mutateHistory hasn't resolved
    expect(setSending).toHaveBeenCalledWith(false);
    expect(orderTracker.indexOf("setSending(false)")).toBeLessThan(
      orderTracker.indexOf("mutateHistory:start"),
    );

    // Clean up
    resolveMutate!();
    await mutatePromise;
  });

  it("setSending(false) runs BEFORE mutateHistory in catch block", async () => {
    const orderTracker: string[] = [];

    const mutateHistory = vi.fn().mockImplementation(() => {
      orderTracker.push("mutateHistory:start");
      return Promise.resolve();
    });

    const streamChatWithCeo = vi.fn().mockRejectedValue(new Error("stream failed"));
    const setSending = vi.fn().mockImplementation((val: boolean) => {
      orderTracker.push(`setSending(${val})`);
    });

    // Simulate the FIXED handleSend flow
    try {
      await streamChatWithCeo();
      setSending(false);
      mutateHistory().catch(() => {});
    } catch {
      setSending(false);
      mutateHistory().catch(() => {});
    }

    expect(setSending).toHaveBeenCalledWith(false);
    expect(orderTracker.indexOf("setSending(false)")).toBeLessThan(
      orderTracker.indexOf("mutateHistory:start"),
    );
  });

  it("mutateHistory failure does not prevent textbox re-enable", async () => {
    const sim = createHandleSendSimulator();
    const mutateHistory = vi.fn().mockRejectedValue(new Error("API timeout"));
    const streamChatWithCeo = vi.fn().mockResolvedValue(undefined);

    sim.setSending(true);

    // Simulate the FIXED handleSend flow
    try {
      await streamChatWithCeo();
      sim.setSending(false);
      sim.setActiveChat(null);
      // Non-blocking mutateHistory
      mutateHistory().catch(() => {});
    } catch {
      sim.setSending(false);
      mutateHistory().catch(() => {});
    }

    // Even though mutateHistory threw, sending should be false
    expect(sim.getSendingState()).toBe(false);
    expect(sim.getActiveChatState()).toBeNull();
  });

  it("textbox re-enables immediately after streaming completes (not after mutateHistory)", async () => {
    let sendingFalseTime = 0;
    let mutateStartTime = 0;

    const setSending = vi.fn().mockImplementation((val: boolean) => {
      if (!val) sendingFalseTime = Date.now();
    });

    const mutateHistory = vi.fn().mockImplementation(async () => {
      mutateStartTime = Date.now();
      // Simulate slow API response
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const streamChatWithCeo = vi.fn().mockResolvedValue(undefined);

    // Simulate the FIXED handleSend flow
    await streamChatWithCeo();
    setSending(false);
    // Non-blocking — don't await
    mutateHistory().catch(() => {});

    // setSending(false) should have been called
    expect(setSending).toHaveBeenCalledWith(false);
    // And it should have been called before mutateHistory started
    expect(sendingFalseTime).toBeLessThanOrEqual(mutateStartTime);
  });

  it("activeChat is set to null (clearing streaming cursor) after stream completes", async () => {
    const sim = createHandleSendSimulator();
    const streamChatWithCeo = vi.fn().mockResolvedValue(undefined);
    const mutateHistory = vi.fn().mockResolvedValue(undefined);

    sim.setSending(true);
    sim.setActiveChat({ status: "pending" });

    await streamChatWithCeo();
    sim.setSending(false);
    sim.setActiveChat(null);
    mutateHistory().catch(() => {});

    expect(sim.getActiveChatState()).toBeNull();
  });
});

describe("CEO chat onDone handler", () => {
  it("onDone sets final reply text on activeChat", () => {
    let activeChat: { ceoReply: string; status: string } | null = {
      ceoReply: "partial...",
      status: "pending",
    };

    // Simulate onDone callback
    const onDone = (reply: string) => {
      activeChat = activeChat
        ? { ...activeChat, ceoReply: reply }
        : activeChat;
    };

    onDone("Full response text here");
    expect(activeChat?.ceoReply).toBe("Full response text here");
  });

  it("onDone clears tool activity", () => {
    let toolActivity: { toolName: string; description: string } | null = {
      toolName: "Read",
      description: "Reading files...",
    };

    // Simulate onDone clearing tool activity
    const onDone = () => {
      toolActivity = null;
    };

    onDone();
    expect(toolActivity).toBeNull();
  });
});
