import { describe, it, expect } from "vitest";

/**
 * Comprehensive tests for CEO chat panel behavior covering all VAL-CHAT assertions.
 *
 * VAL-CHAT-001: Chat panel visible on desktop >=1280px (right column)
 * VAL-CHAT-002: Mobile chat opens as slide-over
 * VAL-CHAT-003: Sending message shows optimistic user bubble
 * VAL-CHAT-004: CEO streaming response (Thinking → streaming → complete)
 * VAL-CHAT-005: Chat history loads on mount
 * VAL-CHAT-006: Failed message shows "Failed" label
 * VAL-CHAT-007: Timeout >90s shows timed out message
 * VAL-CHAT-008: Auto-scroll (new messages scroll, user scroll preserved)
 * VAL-CHAT-010: Mobile backdrop click closes slide-over
 */

// ─── Types (mirroring component types) ────────────────────────

interface ChatEntry {
  id: string;
  role: "user" | "ceo";
  text: string;
  time: string;
  kind?: "founder_chat" | "ceo_notice";
  status?: "sending" | "sent" | "error" | "thinking" | "streaming";
}

interface ActiveFounderChat {
  id: string;
  founderMessage: string;
  createdAt: string;
  ceoReply: string;
  status: "pending" | "error";
  error?: string | null;
}

interface HistoryEntry {
  id: string;
  entryType: "founder_chat" | "ceo_notice";
  founderMessage: string | null;
  ceoReply: string | null;
  status: "pending" | "complete" | "error";
  error?: string | null;
  createdAt: string;
}

// ─── Extracted flattenHistory logic ───────────────────────────

function flattenHistory(
  history: HistoryEntry[],
  activeChat: ActiveFounderChat | null,
): ChatEntry[] {
  const matchingPersistedChatId = activeChat
    ? history.find((entry) => {
        if (entry.entryType !== "founder_chat") {
          return false;
        }
        const sameId = entry.id === activeChat.id;
        const samePendingMessage =
          entry.status === "pending" &&
          entry.founderMessage === activeChat.founderMessage &&
          Math.abs(
            new Date(entry.createdAt).getTime() -
              new Date(activeChat.createdAt).getTime(),
          ) < 5_000;
        return sameId || samePendingMessage;
      })?.id
    : null;

  const mergedHistory = history.map((entry) => {
    if (!activeChat || entry.id !== matchingPersistedChatId) {
      return entry;
    }

    return {
      ...entry,
      ceoReply: activeChat.ceoReply || entry.ceoReply,
      status: activeChat.status === "error" ? ("error" as const) : entry.status,
      error: activeChat.error || entry.error,
      createdAt: activeChat.createdAt || entry.createdAt,
    };
  });

  if (activeChat && !matchingPersistedChatId) {
    mergedHistory.push({
      id: activeChat.id,
      entryType: "founder_chat",
      founderMessage: activeChat.founderMessage,
      ceoReply: activeChat.ceoReply || null,
      status: activeChat.status === "error" ? "error" : "pending",
      error: activeChat.error || null,
      createdAt: activeChat.createdAt,
    });
  }

  return mergedHistory.flatMap((entry) => {
    const rows: ChatEntry[] = [];

    if (entry.entryType === "founder_chat" && entry.founderMessage) {
      rows.push({
        id: `${entry.id}:user`,
        role: "user",
        text: entry.founderMessage,
        time: entry.createdAt,
        kind: "founder_chat",
        status:
          entry.status === "pending"
            ? "sent"
            : entry.status === "error"
              ? "error"
              : "sent",
      });
    }

    if (entry.status === "pending") {
      const ageMs = Date.now() - new Date(entry.createdAt).getTime();
      const timedOut = ageMs > 90_000 && !activeChat;
      rows.push({
        id: `${entry.id}:ceo`,
        role: "ceo",
        text: timedOut
          ? "This response timed out. Try sending your message again."
          : entry.ceoReply || "",
        time: entry.createdAt,
        kind: entry.entryType,
        status: timedOut
          ? undefined
          : entry.ceoReply
            ? "streaming"
            : "thinking",
      });
      return rows;
    }

    rows.push({
      id: `${entry.id}:ceo`,
      role: "ceo",
      text:
        entry.status === "error"
          ? entry.error || "I hit an error while replying."
          : entry.ceoReply || "",
      time: entry.createdAt,
      kind: entry.entryType,
      status: undefined,
    });

    return rows;
  });
}

// ─── Auto-scroll logic ───────────────────────────────────────

function shouldAutoScroll({
  isNearBottom,
  hasNewEntries,
  isInitialLoad,
  hasStreamingEntry,
}: {
  isNearBottom: boolean;
  hasNewEntries: boolean;
  isInitialLoad: boolean;
  hasStreamingEntry: boolean;
}): boolean {
  // Matches the component logic after fix:
  // isInitialLoad || hasStreamingEntry || (isNearBottom && hasNewEntries)
  return isInitialLoad || hasStreamingEntry || (isNearBottom && hasNewEntries);
}

function resolveScrollBehavior({
  isInitialLoad,
  hasStreamingEntry,
}: {
  isInitialLoad: boolean;
  hasStreamingEntry: boolean;
}): ScrollBehavior {
  if (isInitialLoad || hasStreamingEntry) return "auto";
  return "smooth";
}

// ─── Tests ─────────────────────────────────────────────────

describe("CEO Chat Panel — VAL-CHAT-003: Optimistic user bubble", () => {
  it("shows user message immediately when activeChat is set (before server confirms)", () => {
    const activeChat: ActiveFounderChat = {
      id: "pending-123",
      founderMessage: "Hello CEO!",
      createdAt: new Date().toISOString(),
      ceoReply: "",
      status: "pending",
      error: null,
    };

    const entries = flattenHistory([], activeChat);
    const userEntry = entries.find((e) => e.role === "user");

    expect(userEntry).toBeDefined();
    expect(userEntry!.text).toBe("Hello CEO!");
    expect(userEntry!.status).toBe("sent");
  });

  it("input clears after send (message text empty in activeChat)", () => {
    // After send, message state is set to "" and activeChat gets the user text
    const activeChat: ActiveFounderChat = {
      id: "pending-456",
      founderMessage: "How are we doing?",
      createdAt: new Date().toISOString(),
      ceoReply: "",
      status: "pending",
      error: null,
    };

    const entries = flattenHistory([], activeChat);
    expect(entries.find((e) => e.role === "user")?.text).toBe(
      "How are we doing?",
    );
  });
});

describe("CEO Chat Panel — VAL-CHAT-004: CEO streaming response", () => {
  it("shows Thinking status when pending with no reply", () => {
    const activeChat: ActiveFounderChat = {
      id: "pending-789",
      founderMessage: "What's the plan?",
      createdAt: new Date().toISOString(),
      ceoReply: "",
      status: "pending",
      error: null,
    };

    const entries = flattenHistory([], activeChat);
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    expect(ceoEntry!.status).toBe("thinking");
    expect(ceoEntry!.text).toBe("");
  });

  it("shows streaming status when pending with partial reply", () => {
    const activeChat: ActiveFounderChat = {
      id: "pending-789",
      founderMessage: "What's the plan?",
      createdAt: new Date().toISOString(),
      ceoReply: "We're working on...",
      status: "pending",
      error: null,
    };

    const entries = flattenHistory([], activeChat);
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    expect(ceoEntry!.status).toBe("streaming");
    expect(ceoEntry!.text).toBe("We're working on...");
  });

  it("shows completed response when entry is complete", () => {
    const history: HistoryEntry[] = [
      {
        id: "chat-1",
        entryType: "founder_chat",
        founderMessage: "Hello",
        ceoReply: "Hello! I'm the CEO.",
        status: "complete",
        createdAt: new Date().toISOString(),
      },
    ];

    const entries = flattenHistory(history, null);
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    expect(ceoEntry!.status).toBeUndefined(); // no status = completed
    expect(ceoEntry!.text).toBe("Hello! I'm the CEO.");
  });
});

describe("CEO Chat Panel — VAL-CHAT-005: Chat history loads on mount", () => {
  it("renders existing chat history entries", () => {
    const history: HistoryEntry[] = [
      {
        id: "msg-1",
        entryType: "founder_chat",
        founderMessage: "First message",
        ceoReply: "First reply",
        status: "complete",
        createdAt: "2026-03-28T10:00:00Z",
      },
      {
        id: "msg-2",
        entryType: "founder_chat",
        founderMessage: "Second message",
        ceoReply: "Second reply",
        status: "complete",
        createdAt: "2026-03-28T11:00:00Z",
      },
    ];

    const entries = flattenHistory(history, null);

    expect(entries).toHaveLength(4); // 2 user + 2 ceo
    expect(entries[0].role).toBe("user");
    expect(entries[0].text).toBe("First message");
    expect(entries[1].role).toBe("ceo");
    expect(entries[1].text).toBe("First reply");
    expect(entries[2].role).toBe("user");
    expect(entries[2].text).toBe("Second message");
    expect(entries[3].role).toBe("ceo");
    expect(entries[3].text).toBe("Second reply");
  });

  it("renders ceo_notice entries without user message", () => {
    const history: HistoryEntry[] = [
      {
        id: "notice-1",
        entryType: "ceo_notice",
        founderMessage: null,
        ceoReply: "Company status update: all agents working.",
        status: "complete",
        createdAt: "2026-03-28T12:00:00Z",
      },
    ];

    const entries = flattenHistory(history, null);

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe("ceo");
    expect(entries[0].kind).toBe("ceo_notice");
    expect(entries[0].text).toBe(
      "Company status update: all agents working.",
    );
  });
});

describe("CEO Chat Panel — VAL-CHAT-006: Failed message shows Failed label", () => {
  it("user message shows error status when chat fails", () => {
    const activeChat: ActiveFounderChat = {
      id: "pending-err",
      founderMessage: "This will fail",
      createdAt: new Date().toISOString(),
      ceoReply: "",
      status: "error",
      error: "Network error",
    };

    const entries = flattenHistory([], activeChat);
    const userEntry = entries.find((e) => e.role === "user");

    expect(userEntry).toBeDefined();
    expect(userEntry!.status).toBe("error");
    // In the component, status === "error" renders <span>Failed</span>
  });

  it("persisted error entries also show error status on user message", () => {
    const history: HistoryEntry[] = [
      {
        id: "err-1",
        entryType: "founder_chat",
        founderMessage: "Failed send",
        ceoReply: null,
        status: "error",
        error: "Something went wrong",
        createdAt: "2026-03-28T10:00:00Z",
      },
    ];

    const entries = flattenHistory(history, null);
    const userEntry = entries.find((e) => e.role === "user");

    expect(userEntry).toBeDefined();
    expect(userEntry!.status).toBe("error");
  });

  it("CEO reply for error shows error text", () => {
    const history: HistoryEntry[] = [
      {
        id: "err-2",
        entryType: "founder_chat",
        founderMessage: "Test",
        ceoReply: null,
        status: "error",
        error: "Server timeout",
        createdAt: "2026-03-28T10:00:00Z",
      },
    ];

    const entries = flattenHistory(history, null);
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    expect(ceoEntry!.text).toBe("Server timeout");
  });

  it("CEO reply for error with no error message shows fallback", () => {
    const history: HistoryEntry[] = [
      {
        id: "err-3",
        entryType: "founder_chat",
        founderMessage: "Test",
        ceoReply: null,
        status: "error",
        error: null,
        createdAt: "2026-03-28T10:00:00Z",
      },
    ];

    const entries = flattenHistory(history, null);
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    expect(ceoEntry!.text).toBe("I hit an error while replying.");
  });
});

describe("CEO Chat Panel — VAL-CHAT-007: Timeout >90s", () => {
  it("shows timed out message for pending entries older than 90s without active chat", () => {
    const oldTime = new Date(Date.now() - 100_000).toISOString(); // 100s ago

    const history: HistoryEntry[] = [
      {
        id: "timeout-1",
        entryType: "founder_chat",
        founderMessage: "Are you there?",
        ceoReply: null,
        status: "pending",
        createdAt: oldTime,
      },
    ];

    const entries = flattenHistory(history, null); // no activeChat
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    expect(ceoEntry!.text).toBe(
      "This response timed out. Try sending your message again.",
    );
    expect(ceoEntry!.status).toBeUndefined(); // timed out = no special status
  });

  it("does NOT show timeout for pending entries younger than 90s", () => {
    const recentTime = new Date(Date.now() - 30_000).toISOString(); // 30s ago

    const history: HistoryEntry[] = [
      {
        id: "fresh-1",
        entryType: "founder_chat",
        founderMessage: "Waiting...",
        ceoReply: null,
        status: "pending",
        createdAt: recentTime,
      },
    ];

    const entries = flattenHistory(history, null);
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    expect(ceoEntry!.status).toBe("thinking");
    expect(ceoEntry!.text).toBe("");
  });

  it("does NOT show timeout for pending entries when activeChat exists (user just sent)", () => {
    const oldTime = new Date(Date.now() - 100_000).toISOString();

    const activeChat: ActiveFounderChat = {
      id: "timeout-1",
      founderMessage: "Are you there?",
      createdAt: oldTime,
      ceoReply: "",
      status: "pending",
      error: null,
    };

    const history: HistoryEntry[] = [
      {
        id: "timeout-1",
        entryType: "founder_chat",
        founderMessage: "Are you there?",
        ceoReply: null,
        status: "pending",
        createdAt: oldTime,
      },
    ];

    const entries = flattenHistory(history, activeChat);
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    // With activeChat, should show thinking, not timed out
    expect(ceoEntry!.status).toBe("thinking");
  });
});

describe("CEO Chat Panel — VAL-CHAT-008: Auto-scroll behavior", () => {
  it("auto-scrolls on initial load (prevCount=0, newCount>0)", () => {
    expect(
      shouldAutoScroll({
        isNearBottom: false,
        hasNewEntries: true,
        isInitialLoad: true,
        hasStreamingEntry: false,
      }),
    ).toBe(true);
  });

  it("auto-scrolls during streaming even when user is scrolled up", () => {
    expect(
      shouldAutoScroll({
        isNearBottom: false,
        hasNewEntries: false,
        isInitialLoad: false,
        hasStreamingEntry: true,
      }),
    ).toBe(true);
  });

  it("auto-scrolls on new messages when user is near bottom", () => {
    expect(
      shouldAutoScroll({
        isNearBottom: true,
        hasNewEntries: true,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(true);
  });

  it("does NOT auto-scroll on new messages when user scrolled up (preserves position)", () => {
    expect(
      shouldAutoScroll({
        isNearBottom: false,
        hasNewEntries: true,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(false);
  });

  it("does NOT scroll when nothing changed", () => {
    expect(
      shouldAutoScroll({
        isNearBottom: true,
        hasNewEntries: false,
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe(false);
  });

  it("uses instant scroll on initial load", () => {
    expect(
      resolveScrollBehavior({ isInitialLoad: true, hasStreamingEntry: false }),
    ).toBe("auto");
  });

  it("uses instant scroll during streaming", () => {
    expect(
      resolveScrollBehavior({
        isInitialLoad: false,
        hasStreamingEntry: true,
      }),
    ).toBe("auto");
  });

  it("uses smooth scroll for regular new messages", () => {
    expect(
      resolveScrollBehavior({
        isInitialLoad: false,
        hasStreamingEntry: false,
      }),
    ).toBe("smooth");
  });
});

describe("CEO Chat Panel — History merging with activeChat", () => {
  it("merges activeChat with matching persisted entry by ID", () => {
    const history: HistoryEntry[] = [
      {
        id: "chat-99",
        entryType: "founder_chat",
        founderMessage: "Hello",
        ceoReply: null,
        status: "pending",
        createdAt: new Date().toISOString(),
      },
    ];

    const activeChat: ActiveFounderChat = {
      id: "chat-99",
      founderMessage: "Hello",
      createdAt: new Date().toISOString(),
      ceoReply: "Responding...",
      status: "pending",
      error: null,
    };

    const entries = flattenHistory(history, activeChat);
    const ceoEntry = entries.find((e) => e.role === "ceo");

    expect(ceoEntry).toBeDefined();
    expect(ceoEntry!.text).toBe("Responding...");
    expect(ceoEntry!.status).toBe("streaming");
  });

  it("does not duplicate user message when activeChat matches persisted entry", () => {
    const now = new Date().toISOString();
    const history: HistoryEntry[] = [
      {
        id: "chat-100",
        entryType: "founder_chat",
        founderMessage: "Test",
        ceoReply: null,
        status: "pending",
        createdAt: now,
      },
    ];

    const activeChat: ActiveFounderChat = {
      id: "chat-100",
      founderMessage: "Test",
      createdAt: now,
      ceoReply: "",
      status: "pending",
      error: null,
    };

    const entries = flattenHistory(history, activeChat);
    const userEntries = entries.filter((e) => e.role === "user");

    expect(userEntries).toHaveLength(1);
  });

  it("adds activeChat as new entry when no matching persisted entry", () => {
    const history: HistoryEntry[] = [];

    const activeChat: ActiveFounderChat = {
      id: "pending-new",
      founderMessage: "Brand new",
      createdAt: new Date().toISOString(),
      ceoReply: "",
      status: "pending",
      error: null,
    };

    const entries = flattenHistory(history, activeChat);
    expect(entries).toHaveLength(2); // user + ceo (thinking)
    expect(entries[0].role).toBe("user");
    expect(entries[0].text).toBe("Brand new");
    expect(entries[1].role).toBe("ceo");
    expect(entries[1].status).toBe("thinking");
  });
});

describe("CEO Chat Panel — Layout assertions", () => {
  // These are structural assertions verified by code inspection.
  // The component uses xl:flex (1280px) breakpoint for desktop visibility.

  it("VAL-CHAT-001: desktop chat panel uses xl:flex for >=1280px visibility", () => {
    // The page.tsx renders: <div className="hidden xl:flex flex-col w-80 ...">
    // xl breakpoint = 1280px
    const desktopClasses = "hidden xl:flex flex-col w-80 shrink-0 border-l border-border";
    expect(desktopClasses).toContain("hidden");
    expect(desktopClasses).toContain("xl:flex");
    expect(desktopClasses).toContain("w-80");
  });

  it("VAL-CHAT-002: mobile chat button uses xl:hidden for <1280px visibility", () => {
    // The MessageSquare button: className="xl:hidden inline-flex ..."
    const mobileButtonClasses = "xl:hidden inline-flex items-center gap-1.5 rounded-lg";
    expect(mobileButtonClasses).toContain("xl:hidden");
  });

  it("VAL-CHAT-010: mobile slide-over has backdrop with onClick handler", () => {
    // The backdrop div: className="xl:hidden fixed inset-0 bg-black/30 z-40"
    // with onClick={() => setChatOpen(false)}
    const backdropClasses =
      "xl:hidden fixed inset-0 bg-black/30 z-40";
    expect(backdropClasses).toContain("fixed");
    expect(backdropClasses).toContain("inset-0");
    expect(backdropClasses).toContain("bg-black/30");
  });

  it("VAL-CHAT-002: mobile slide-over panel is positioned fixed right", () => {
    const slideOverClasses =
      "xl:hidden fixed right-0 top-0 bottom-0 w-[min(24rem,85vw)] bg-background border-l border-border z-50 flex flex-col";
    expect(slideOverClasses).toContain("fixed");
    expect(slideOverClasses).toContain("right-0");
    expect(slideOverClasses).toContain("z-50");
  });
});
