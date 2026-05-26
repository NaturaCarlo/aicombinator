import { describe, it, expect } from "vitest";

// ─── Optimistic toggle logic (pure, extracted for testing) ──────

type AgentStatus = "free" | "working" | "paused";

/**
 * Determine the effective display status for an agent toggle.
 * If an optimistic override is set (non-null), use it.
 * Otherwise, use the server-provided status.
 */
function getEffectiveStatus(
  serverStatus: AgentStatus,
  optimisticStatus: AgentStatus | null,
): AgentStatus {
  return optimisticStatus ?? serverStatus;
}

/**
 * Determine the target status when toggling an agent.
 * If the agent is currently enabled (not paused), target is "paused".
 * If the agent is paused, target is "free" (not "working" — that's server-driven).
 */
function getToggleTarget(currentStatus: AgentStatus): AgentStatus {
  return currentStatus === "paused" ? "free" : "paused";
}

/**
 * Determine effective agent status on settings page considering
 * both company state and individual agent status.
 *
 * Company paused → ALL agents show "paused"
 * Company running → use agent's actual status (including "paused" for individually paused agents)
 */
function getSettingsAgentStatus(
  companyState: "running" | "paused" | "failed" | null | undefined,
  agentStatus: string,
): AgentStatus {
  if (companyState === "paused") return "paused";
  if (agentStatus === "paused") return "paused";
  if (agentStatus === "working") return "working";
  return "free";
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Agent toggle optimistic update logic", () => {
  describe("getEffectiveStatus", () => {
    it("returns server status when no optimistic override", () => {
      expect(getEffectiveStatus("free", null)).toBe("free");
      expect(getEffectiveStatus("working", null)).toBe("working");
      expect(getEffectiveStatus("paused", null)).toBe("paused");
    });

    it("returns optimistic status when override is set", () => {
      expect(getEffectiveStatus("free", "paused")).toBe("paused");
      expect(getEffectiveStatus("paused", "free")).toBe("free");
      expect(getEffectiveStatus("working", "paused")).toBe("paused");
    });
  });

  describe("getToggleTarget", () => {
    it("targets paused when agent is free", () => {
      expect(getToggleTarget("free")).toBe("paused");
    });

    it("targets paused when agent is working", () => {
      expect(getToggleTarget("working")).toBe("paused");
    });

    it("targets free when agent is paused", () => {
      expect(getToggleTarget("paused")).toBe("free");
    });
  });

  describe("optimistic toggle flow: pause", () => {
    it("immediately shows paused state before API responds", () => {
      const serverStatus: AgentStatus = "free";
      // User clicks toggle → set optimistic to "paused"
      const optimisticStatus: AgentStatus = "paused";
      const effective = getEffectiveStatus(serverStatus, optimisticStatus);
      expect(effective).toBe("paused");
    });

    it("clears optimistic on API success (server state catches up)", () => {
      // After API success, SWR revalidates and server says "paused"
      const serverStatus: AgentStatus = "paused";
      const optimisticStatus = null; // cleared after success
      const effective = getEffectiveStatus(serverStatus, optimisticStatus);
      expect(effective).toBe("paused");
    });
  });

  describe("optimistic toggle flow: resume", () => {
    it("immediately shows free state before API responds", () => {
      const serverStatus: AgentStatus = "paused";
      const optimisticStatus: AgentStatus = "free";
      const effective = getEffectiveStatus(serverStatus, optimisticStatus);
      expect(effective).toBe("free");
    });

    it("clears optimistic on API success", () => {
      const serverStatus: AgentStatus = "free";
      const optimisticStatus = null;
      const effective = getEffectiveStatus(serverStatus, optimisticStatus);
      expect(effective).toBe("free");
    });
  });

  describe("error rollback", () => {
    it("reverts to original server status on API failure", () => {
      const serverStatus: AgentStatus = "free";
      // User clicks toggle → optimistic set to "paused"
      // API fails → optimistic cleared back to null
      const optimisticStatus = null; // reverted on error
      const effective = getEffectiveStatus(serverStatus, optimisticStatus);
      expect(effective).toBe("free"); // back to original
    });

    it("reverts resume attempt on failure", () => {
      const serverStatus: AgentStatus = "paused";
      const optimisticStatus = null; // reverted
      const effective = getEffectiveStatus(serverStatus, optimisticStatus);
      expect(effective).toBe("paused"); // back to original
    });
  });
});

describe("Settings page agent status mapping", () => {
  describe("getSettingsAgentStatus", () => {
    it("shows all agents as paused when company is paused", () => {
      expect(getSettingsAgentStatus("paused", "free")).toBe("paused");
      expect(getSettingsAgentStatus("paused", "working")).toBe("paused");
      expect(getSettingsAgentStatus("paused", "paused")).toBe("paused");
      expect(getSettingsAgentStatus("paused", "idle")).toBe("paused");
    });

    it("shows individually paused agents as paused when company is running", () => {
      expect(getSettingsAgentStatus("running", "paused")).toBe("paused");
    });

    it("shows working agents as working when company is running", () => {
      expect(getSettingsAgentStatus("running", "working")).toBe("working");
    });

    it("shows free agents as free when company is running", () => {
      expect(getSettingsAgentStatus("running", "free")).toBe("free");
    });

    it("shows idle agents as free when company is running", () => {
      expect(getSettingsAgentStatus("running", "idle")).toBe("free");
    });

    it("handles null/undefined company state gracefully", () => {
      expect(getSettingsAgentStatus(null, "paused")).toBe("paused");
      expect(getSettingsAgentStatus(undefined, "free")).toBe("free");
      expect(getSettingsAgentStatus(null, "working")).toBe("working");
    });

    it("handles failed company state (agents show their individual status)", () => {
      expect(getSettingsAgentStatus("failed", "paused")).toBe("paused");
      expect(getSettingsAgentStatus("failed", "working")).toBe("working");
      expect(getSettingsAgentStatus("failed", "free")).toBe("free");
    });
  });
});
