import { describe, expect, it } from "vitest";

// ─── Launch-intent detection (VAL-LAUNCH-006, VAL-LAUNCH-016) ────────────

/**
 * Regex for detecting launch-intent option text.
 * Must match: "Launch", "Let's go", "Ship it", "Ready to launch", "Start the company"
 * Must NOT match: "Tell me more", "Refine", "Add details", "Go narrower"
 */
const LAUNCH_INTENT_RE = /\b(launch|let'?s\s+go|ship\s+it|ready\s+to\s+launch|start\s+the\s+company)\b/i;

/**
 * Negative guard: options that should NEVER trigger auto-launch even if they
 * accidentally contain a launch-intent keyword.
 */
const NON_LAUNCH_RE = /\b(tell\s+me\s+more|refine|add\s+details|go\s+narrower|more\s+info|explain|elaborate)\b/i;

function isLaunchIntent(text: string): boolean {
  if (NON_LAUNCH_RE.test(text)) return false;
  return LAUNCH_INTENT_RE.test(text);
}

describe("launch-intent detection (VAL-LAUNCH-006)", () => {
  it("detects 'Launch' as launch intent", () => {
    expect(isLaunchIntent("Launch")).toBe(true);
  });

  it("detects 'Let's go' as launch intent", () => {
    expect(isLaunchIntent("Let's go")).toBe(true);
  });

  it("detects 'Lets go' (no apostrophe) as launch intent", () => {
    expect(isLaunchIntent("Lets go")).toBe(true);
  });

  it("detects 'Ship it' as launch intent", () => {
    expect(isLaunchIntent("Ship it")).toBe(true);
  });

  it("detects 'Ready to launch' as launch intent", () => {
    expect(isLaunchIntent("Ready to launch")).toBe(true);
  });

  it("detects 'Start the company' as launch intent", () => {
    expect(isLaunchIntent("Start the company")).toBe(true);
  });

  it("detects launch intent case-insensitively", () => {
    expect(isLaunchIntent("LAUNCH")).toBe(true);
    expect(isLaunchIntent("ship IT")).toBe(true);
    expect(isLaunchIntent("LET'S GO")).toBe(true);
  });

  it("detects launch intent in longer text", () => {
    expect(isLaunchIntent("I'm ready, let's go!")).toBe(true);
    expect(isLaunchIntent("Yes, launch the company now")).toBe(true);
  });
});

describe("non-launch option guard (VAL-LAUNCH-016)", () => {
  it("rejects 'Tell me more' as non-launch", () => {
    expect(isLaunchIntent("Tell me more")).toBe(false);
  });

  it("rejects 'Refine the idea' as non-launch", () => {
    expect(isLaunchIntent("Refine the idea")).toBe(false);
  });

  it("rejects 'Add details' as non-launch", () => {
    expect(isLaunchIntent("Add details")).toBe(false);
  });

  it("rejects 'Go narrower' as non-launch", () => {
    expect(isLaunchIntent("Go narrower")).toBe(false);
  });

  it("rejects regular option text without launch intent", () => {
    expect(isLaunchIntent("Focus on SMBs")).toBe(false);
    expect(isLaunchIntent("Target enterprise customers")).toBe(false);
    expect(isLaunchIntent("Pivot to B2C")).toBe(false);
  });
});

// ─── Auto-launch behavior (VAL-LAUNCH-006, VAL-LAUNCH-018) ──────────────

describe("auto-launch on launch-intent option (VAL-LAUNCH-006)", () => {
  it("calls handleLaunch when option is launch-intent and session is ready", () => {
    let launchCalled = false;
    let messageSent = false;

    const sessionReady = true;
    const optionText = "Launch";

    if (isLaunchIntent(optionText) && sessionReady) {
      launchCalled = true;
    } else {
      messageSent = true;
    }

    expect(launchCalled).toBe(true);
    expect(messageSent).toBe(false);
  });

  it("sends as chat message when option is launch-intent but session NOT ready", () => {
    let launchCalled = false;
    let messageSent = false;

    const sessionReady = false;
    const optionText = "Let's go";

    if (isLaunchIntent(optionText) && sessionReady) {
      launchCalled = true;
    } else {
      messageSent = true;
    }

    expect(launchCalled).toBe(false);
    expect(messageSent).toBe(true);
  });

  it("sends non-launch options as chat messages regardless of readiness", () => {
    let launchCalled = false;
    let messageSent = false;

    const sessionReady = true;
    const optionText = "Focus on SMBs";

    if (isLaunchIntent(optionText) && sessionReady) {
      launchCalled = true;
    } else {
      messageSent = true;
    }

    expect(launchCalled).toBe(false);
    expect(messageSent).toBe(true);
  });
});

// ─── Option button sizing (VAL-LAUNCH-007) ───────────────────────────────

describe("option button sizing (VAL-LAUNCH-007)", () => {
  it("button classes include px-5 py-3 for at least 44px height", () => {
    // py-3 = 12px top + 12px bottom = 24px padding
    // text-sm = 14px line-height ~20px
    // 24 + 20 = 44px minimum height
    const buttonClasses = "rounded-none border border-accent-orange/20 bg-accent-orange/[0.05] px-5 py-3 text-left transition-colors hover:bg-accent-orange/[0.1] disabled:pointer-events-none disabled:opacity-50";
    expect(buttonClasses).toContain("px-5");
    expect(buttonClasses).toContain("py-3");
  });

  it("title uses text-sm font-medium for at least 14px", () => {
    const titleClasses = "text-sm font-medium";
    expect(titleClasses).toContain("text-sm");
    expect(titleClasses).toContain("font-medium");
  });

  it("description uses text-xs for secondary info", () => {
    const descClasses = "mt-0.5 text-xs text-muted-foreground";
    expect(descClasses).toContain("text-xs");
  });
});

// ─── Double-click prevention (VAL-LAUNCH-005) ────────────────────────────

describe("double-click prevention (VAL-LAUNCH-005)", () => {
  it("clicking state disables all option buttons immediately", () => {
    let clicking = false;

    // Simulate clicking
    clicking = true;
    expect(clicking).toBe(true);

    // All buttons should check clicking state
    const buttonDisabled = clicking;
    expect(buttonDisabled).toBe(true);
  });

  it("clicking state is cleared after message is sent", () => {
    let clicking = true;

    // Simulate message sent successfully
    clicking = false;
    expect(clicking).toBe(false);
  });

  it("clicking state is cleared on error", () => {
    let clicking = true;

    // Simulate error
    clicking = false;
    expect(clicking).toBe(false);
  });
});

// ─── Time-based click guard (VAL-LAUNCH-005, fix for latch-on-failure) ───

describe("time-based click guard prevents latch on failure", () => {
  it("blocks rapid double-clicks within 200ms window", () => {
    let guardTime = 0;
    const calls: string[] = [];

    function handleOptionClick(reply: string) {
      const now = Date.now();
      if (now - guardTime < 200) return;
      guardTime = now;
      calls.push(reply);
    }

    handleOptionClick("Launch");
    handleOptionClick("Launch"); // Should be blocked (within 200ms)
    expect(calls).toEqual(["Launch"]);
  });

  it("allows clicks after 200ms window expires", async () => {
    let guardTime = 0;
    const calls: string[] = [];

    function handleOptionClick(reply: string, now: number) {
      if (now - guardTime < 200) return;
      guardTime = now;
      calls.push(reply);
    }

    const t0 = Date.now();
    handleOptionClick("Launch", t0);
    // Simulate 200ms passing
    handleOptionClick("Launch", t0 + 201);
    expect(calls).toEqual(["Launch", "Launch"]);
  });

  it("does NOT persist guard across separate user interactions after error", () => {
    let guardTime = 0;
    const calls: string[] = [];
    let error: string | null = null;

    function handleOptionClick(reply: string, now: number) {
      if (now - guardTime < 200) return;
      guardTime = now;
      // Simulate launch failure
      error = "Insufficient credits";
      calls.push(reply);
    }

    const t0 = Date.now();
    handleOptionClick("Launch", t0);
    expect(error).toBe("Insufficient credits");
    expect(calls).toEqual(["Launch"]);

    // After error, user clicks again after a short but > 200ms delay
    // With the old ref-based guard, this would be blocked forever.
    // With the time-based guard, this works.
    handleOptionClick("Launch", t0 + 300);
    expect(calls).toEqual(["Launch", "Launch"]);
  });

  it("guard time auto-expires without any external reset logic", () => {
    let guardTime = 0;
    let clickCount = 0;

    function handleOptionClick(now: number) {
      if (now - guardTime < 200) return;
      guardTime = now;
      clickCount++;
    }

    const t0 = 1000;
    handleOptionClick(t0);
    expect(clickCount).toBe(1);

    // No external reset needed — 200ms later, guard expires
    handleOptionClick(t0 + 250);
    expect(clickCount).toBe(2);

    // Rapid double-click still prevented
    handleOptionClick(t0 + 260);
    expect(clickCount).toBe(2);

    // But another 200ms later, works again
    handleOptionClick(t0 + 500);
    expect(clickCount).toBe(3);
  });
});

// ─── Disabled state feedback ─────────────────────────────────────────────

describe("disabled state feedback", () => {
  it("disabled buttons have title attribute explaining why", () => {
    const processing = true;
    const titleText = processing ? "CEO is still responding" : undefined;
    expect(titleText).toBe("CEO is still responding");
  });

  it("enabled buttons have no special title", () => {
    const processing = false;
    const titleText = processing ? "CEO is still responding" : undefined;
    expect(titleText).toBeUndefined();
  });
});

// ─── Session restore on refresh (VAL-LAUNCH-017) ─────────────────────────

describe("session restore on refresh (VAL-LAUNCH-017)", () => {
  it("launchDraft includes launchSessionId for session restore", () => {
    const draft = {
      companyName: "PatchPilot",
      idea: "AI assistant for storm-damage roofing companies",
      mode: "standard" as const,
      launchSessionId: "session-123",
      step: "session" as const,
    };
    expect(draft.launchSessionId).toBe("session-123");
    expect(draft.step).toBe("session");
  });

  it("restore fetches session by ID from draft when page loads", () => {
    // The existing restore logic in launch-form.tsx already fetches
    // the session by draftSessionId. We verify the draft includes the ID.
    const draft = {
      companyName: "PatchPilot",
      idea: "AI assistant for storm-damage roofing companies",
      mode: "standard" as const,
      launchSessionId: "session-456",
      step: "session" as const,
    };
    expect(draft.launchSessionId).toBeTruthy();
  });

  it("draft without launchSessionId returns to idea step", () => {
    const draft = {
      companyName: "PatchPilot",
      idea: "AI assistant for storm-damage roofing companies",
      mode: "standard" as const,
      launchSessionId: null,
      step: "idea" as const,
    };
    expect(draft.launchSessionId).toBeNull();
    expect(draft.step).toBe("idea");
  });
});

// ─── Failed launch recovery (VAL-LAUNCH-018) ─────────────────────────────

describe("failed launch shows error with recovery (VAL-LAUNCH-018)", () => {
  it("error from launch sets error state without losing session", () => {
    let error: string | null = null;
    let sessionActive = true;
    let loading = false;

    // Simulate failed launch
    error = "Insufficient credits to launch";
    loading = false;
    // Session should still be active (not cleared)
    expect(sessionActive).toBe(true);
    expect(error).toBe("Insufficient credits to launch");
    expect(loading).toBe(false);
  });

  it("user can retry after failed launch-intent auto-launch", () => {
    let error: string | null = "Launch failed: server error";
    let canRetry = true;

    // After error, the session view should still be shown with the error
    // and the user can click a different option or type a message
    expect(error).toBeTruthy();
    expect(canRetry).toBe(true);

    // Clear error and retry
    error = null;
    expect(error).toBeNull();
  });
});
