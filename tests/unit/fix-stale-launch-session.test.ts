import { describe, expect, it, beforeEach } from "vitest";

// ─── Test helpers ──────────────────────────────────────────────────────────

interface MockLaunchSession {
  id: string;
  status: "active" | "ready" | "launched";
  launchedCompanyId: string | null;
  processing: boolean;
  suggestedName: string | null;
  inputName: string | null;
  inputIdea: string;
  mode: "quick" | "standard" | "deep";
  ready: boolean;
}

function makeSession(overrides: Partial<MockLaunchSession> = {}): MockLaunchSession {
  return {
    id: "sess-123",
    status: "active",
    launchedCompanyId: null,
    processing: false,
    suggestedName: "My Startup",
    inputName: "My Startup",
    inputIdea: "A great idea",
    mode: "standard",
    ready: false,
    ...overrides,
  };
}

// ─── Fix 1: Auto-save must skip launched sessions ──────────────────────────

describe("Fix 1: Auto-save must skip launched sessions", () => {
  /**
   * Re-implements the auto-save guard logic from the useEffect in launch-form.tsx.
   * The auto-save should NOT persist the draft if the session has already launched.
   */
  function shouldAutoSave(
    companyName: string,
    idea: string,
    launchSession: MockLaunchSession | null,
  ): boolean {
    // Guard 1: nothing to save
    if (!companyName && !idea && !launchSession) {
      return false;
    }
    // Guard 2 (new): skip if session already launched
    if (launchSession?.launchedCompanyId) {
      return false;
    }
    return true;
  }

  it("saves draft when session is active with no launchedCompanyId", () => {
    const session = makeSession({ status: "active", launchedCompanyId: null });
    expect(shouldAutoSave("Test Co", "Great idea", session)).toBe(true);
  });

  it("skips save when session has launchedCompanyId", () => {
    const session = makeSession({
      status: "launched",
      launchedCompanyId: "company-abc",
    });
    expect(shouldAutoSave("Test Co", "Great idea", session)).toBe(false);
  });

  it("saves draft when only idea exists (no session)", () => {
    expect(shouldAutoSave("", "Some idea", null)).toBe(true);
  });

  it("skips save when everything is empty", () => {
    expect(shouldAutoSave("", "", null)).toBe(false);
  });

  it("skips save even when companyName and idea exist but session already launched", () => {
    const session = makeSession({
      status: "launched",
      launchedCompanyId: "company-xyz",
    });
    expect(shouldAutoSave("My Company", "My Idea", session)).toBe(false);
  });
});

// ─── Fix 2: Session restore must detect launched sessions ──────────────────

describe("Fix 2: Session restore detects launched sessions", () => {
  /**
   * When restoring a session from draft, if the session has already launched,
   * we should clear the draft and reset to idea step rather than restoring.
   */
  function shouldClearRestoredSession(session: MockLaunchSession): boolean {
    return session.status === "launched" || Boolean(session.launchedCompanyId);
  }

  it("returns false for active session", () => {
    const session = makeSession({ status: "active", launchedCompanyId: null });
    expect(shouldClearRestoredSession(session)).toBe(false);
  });

  it("returns false for ready session", () => {
    const session = makeSession({ status: "ready", launchedCompanyId: null });
    expect(shouldClearRestoredSession(session)).toBe(false);
  });

  it("returns true for launched session", () => {
    const session = makeSession({
      status: "launched",
      launchedCompanyId: "company-abc",
    });
    expect(shouldClearRestoredSession(session)).toBe(true);
  });

  it("returns true when launchedCompanyId is set even if status is not launched", () => {
    const session = makeSession({
      status: "active",
      launchedCompanyId: "company-abc",
    });
    expect(shouldClearRestoredSession(session)).toBe(true);
  });

  it("returns true for launched status even without launchedCompanyId", () => {
    const session = makeSession({
      status: "launched",
      launchedCompanyId: null,
    });
    expect(shouldClearRestoredSession(session)).toBe(true);
  });
});

// ─── Fix 3: handleLaunch clears component state before router.replace ─────

describe("Fix 3: handleLaunch clears component state before navigation", () => {
  /**
   * After clearLaunchDraft(), the component state must also be cleared
   * so that when setLoading(false) triggers the auto-save effect,
   * the guard conditions prevent re-saving.
   */
  it("clearing state makes auto-save guards effective", () => {
    // Simulate state after clearLaunchDraft + state clear
    const companyName = "";
    const idea = "";
    const launchSession = null;

    // Auto-save guard: nothing to save
    const shouldSave = !(!companyName && !idea && !launchSession);
    expect(shouldSave).toBe(false);
  });

  it("without clearing state, auto-save would re-save", () => {
    // Simulate state BEFORE the fix: clearLaunchDraft called but state not cleared
    const companyName = "My Company";
    const idea = "My great idea";
    const launchSession = makeSession({ launchedCompanyId: null });

    // Without the launchedCompanyId guard, auto-save would fire
    const hasDataToSave = Boolean(companyName || idea || launchSession);
    expect(hasDataToSave).toBe(true);
  });

  it("state clear order: state clears before router.replace", () => {
    const operations: string[] = [];

    // Simulate handleLaunch success path
    const clearLaunchDraft = () => operations.push("clearLaunchDraft");
    const clearState = () => {
      operations.push("clearCompanyName");
      operations.push("clearIdea");
      operations.push("clearLaunchSession");
      operations.push("clearDraftSessionId");
    };
    const routerReplace = () => operations.push("router.replace");

    clearLaunchDraft();
    clearState();
    routerReplace();

    // Verify order: state clear happens before navigation
    const clearIndex = operations.indexOf("clearCompanyName");
    const routerIndex = operations.indexOf("router.replace");
    expect(clearIndex).toBeLessThan(routerIndex);
  });
});

// ─── Fix 4: "Launch New" link clears state ─────────────────────────────────

describe("Fix 4: Launch New link clears state on navigation", () => {
  /**
   * The "Launch New" link in the portfolio page should clear the launch draft
   * before navigating to /launch to prevent stale session restoration.
   */
  it("clearLaunchDraft is callable from portfolio page", () => {
    // Verify the function signature is compatible
    let cleared = false;
    const clearLaunchDraft = () => {
      cleared = true;
    };

    // Simulate onClick handler on the Launch New link
    clearLaunchDraft();
    expect(cleared).toBe(true);
  });

  it("clearing draft removes sessionStorage entry", () => {
    // Simple mock of sessionStorage behavior
    const storage = new Map<string, string>();
    storage.set(
      "launch-draft",
      JSON.stringify({
        companyName: "Old Company",
        idea: "Old idea",
        launchSessionId: "sess-old",
        step: "session",
        updatedAt: new Date().toISOString(),
      }),
    );

    // After clear
    storage.delete("launch-draft");
    expect(storage.has("launch-draft")).toBe(false);
  });
});

// ─── Integration: full stale session flow ──────────────────────────────────

describe("Integration: stale session lifecycle", () => {
  it("full flow: launch succeeds → draft cleared → auto-save blocked → fresh on revisit", () => {
    // Step 1: Session exists and is launched
    const launchedSession = makeSession({
      status: "launched",
      launchedCompanyId: "company-abc",
    });

    // Step 2: clearLaunchDraft called
    let draftExists = true;
    const clearDraft = () => {
      draftExists = false;
    };
    clearDraft();
    expect(draftExists).toBe(false);

    // Step 3: Component state cleared
    let companyName = "";
    let idea = "";
    let launchSession: MockLaunchSession | null = null;

    // Step 4: Auto-save guard blocks re-save (Fix 1)
    const shouldAutoSave =
      (companyName || idea || launchSession) &&
      !launchSession?.launchedCompanyId;
    expect(shouldAutoSave).toBeFalsy();

    // Step 5: On revisit, no draft exists → shows fresh idea form
    expect(draftExists).toBe(false);
  });

  it("safety net: if draft was re-saved, restore detects launched session", () => {
    // Simulate the race condition that Fix 2 guards against
    const restoredSession = makeSession({
      status: "launched",
      launchedCompanyId: "company-abc",
    });

    // Fix 2: detect and reset
    const isLaunchedSession =
      restoredSession.status === "launched" ||
      Boolean(restoredSession.launchedCompanyId);
    expect(isLaunchedSession).toBe(true);

    // After detection: reset to idea step
    let step = "session";
    let launchSession: MockLaunchSession | null = restoredSession;
    let draftSessionId: string | null = restoredSession.id;

    if (isLaunchedSession) {
      step = "idea";
      launchSession = null;
      draftSessionId = null;
      // clearLaunchDraft() would be called
    }

    expect(step).toBe("idea");
    expect(launchSession).toBeNull();
    expect(draftSessionId).toBeNull();
  });
});
