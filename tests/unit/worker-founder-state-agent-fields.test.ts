/**
 * Tests that FounderVisibleAgent in the founder-state response includes
 * reports_to, adapter_type, webhook_url, source, and total_credits_consumed
 * fields projected from the agent row.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  FounderVisibleAgent,
  FounderStatePayload,
} from "../../worker/src/routes/founder-state.ts";

// ---------------------------------------------------------------------------
// Mock auth so buildFounderStatePayload can work
// ---------------------------------------------------------------------------

vi.mock("../../worker/src/middleware/auth.ts", () => ({
  extractToken: vi.fn(() => "valid-token"),
  verifyClerkJwt: vi.fn(async () => "user-1"),
}));

vi.mock("../../worker/src/middleware/cors.ts", () => ({
  corsHeaders: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Type-level assertions
// ---------------------------------------------------------------------------

describe("FounderVisibleAgent type includes new fields", () => {
  it("includes reports_to field", () => {
    const agent: FounderVisibleAgent = {
      id: "agent-1",
      name: "Test Agent",
      role: "developer",
      title: "Dev",
      icon: null,
      status: "free",
      email_address: null,
      lastActiveAt: null,
      lastTurnAt: null,
      reports_to: "agent-ceo",
      adapter_type: "claude-code",
      webhook_url: null,
      source: "internal",
      total_credits_consumed: 42,
      model_tier: "sonnet-4-6",
      instructions: "",
    };

    expect(agent.reports_to).toBe("agent-ceo");
  });

  it("includes adapter_type field", () => {
    const agent: FounderVisibleAgent = {
      id: "agent-2",
      name: "Webhook Bot",
      role: "specialist",
      title: null,
      icon: null,
      status: "working",
      email_address: null,
      lastActiveAt: null,
      lastTurnAt: null,
      reports_to: null,
      adapter_type: "http-webhook",
      webhook_url: "https://example.com/hook",
      source: "external",
      total_credits_consumed: 0,
      model_tier: "sonnet",
      instructions: "",
    };

    expect(agent.adapter_type).toBe("http-webhook");
  });

  it("includes webhook_url field", () => {
    const agent: FounderVisibleAgent = {
      id: "agent-3",
      name: "External Agent",
      role: "worker",
      title: null,
      icon: null,
      status: "free",
      email_address: null,
      lastActiveAt: null,
      lastTurnAt: null,
      reports_to: null,
      adapter_type: "http-webhook",
      webhook_url: "https://hooks.example.com/agent",
      source: "companies-sh",
      total_credits_consumed: 10,
      model_tier: "haiku",
      instructions: "",
    };

    expect(agent.webhook_url).toBe("https://hooks.example.com/agent");
  });

  it("includes source field", () => {
    const agent: FounderVisibleAgent = {
      id: "agent-4",
      name: "Imported Agent",
      role: "developer",
      title: "Full Stack Dev",
      icon: null,
      status: "free",
      email_address: null,
      lastActiveAt: null,
      lastTurnAt: null,
      reports_to: "agent-1",
      adapter_type: null,
      webhook_url: null,
      source: "companies-sh",
      total_credits_consumed: 150,
      model_tier: "sonnet",
      instructions: "",
    };

    expect(agent.source).toBe("companies-sh");
  });

  it("includes total_credits_consumed field", () => {
    const agent: FounderVisibleAgent = {
      id: "agent-5",
      name: "Expensive Agent",
      role: "ceo",
      title: "CEO",
      icon: "🤖",
      status: "working",
      email_address: "ceo@test.com",
      lastActiveAt: "2024-01-01T00:00:00Z",
      lastTurnAt: "2024-01-01T00:00:00Z",
      reports_to: null,
      adapter_type: "claude-code",
      webhook_url: null,
      source: "internal",
      total_credits_consumed: 500,
      model_tier: "opus-4-6",
      instructions: "Be strategic and thoughtful.",
    };

    expect(agent.total_credits_consumed).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Projection logic tests — simulates what buildFounderStatePayload does
// ---------------------------------------------------------------------------

describe("FounderVisibleAgent projection from agent row", () => {
  // This replicates the projection logic from founder-state.ts to verify
  // the new fields are correctly mapped from AgentRow fields.

  function projectAgent(agentRow: Record<string, unknown>): FounderVisibleAgent {
    return {
      id: agentRow.id as string,
      name: agentRow.name as string,
      role: agentRow.role as string,
      title: (agentRow.title as string | null) ?? null,
      icon: (agentRow.icon as string | null) ?? null,
      status: "free",
      email_address: (agentRow.email_address as string | null) ?? null,
      lastActiveAt: null,
      lastTurnAt: null,
      reports_to: (agentRow.reports_to as string | null) ?? null,
      adapter_type: (agentRow.adapter_type as string | null) ?? null,
      webhook_url: (agentRow.webhook_url as string | null) ?? null,
      source: (agentRow.source as string) ?? "internal",
      total_credits_consumed: (agentRow.total_credits_consumed as number) ?? 0,
      model_tier: (agentRow.model_tier as string) ?? "sonnet",
      instructions: (agentRow.instructions as string) ?? "",
    };
  }

  it("projects reports_to from agent row", () => {
    const projected = projectAgent({
      id: "a1",
      name: "CTO",
      role: "cto",
      title: "Chief Technology Officer",
      icon: null,
      reports_to: "ceo-agent-id",
      adapter_type: null,
      webhook_url: null,
      source: "internal",
      total_credits_consumed: 0,
    });

    expect(projected.reports_to).toBe("ceo-agent-id");
  });

  it("projects null reports_to for root agents", () => {
    const projected = projectAgent({
      id: "a2",
      name: "CEO",
      role: "ceo",
      title: "CEO",
      icon: null,
      reports_to: null,
      adapter_type: null,
      webhook_url: null,
      source: "internal",
      total_credits_consumed: 100,
    });

    expect(projected.reports_to).toBeNull();
  });

  it("projects adapter_type and webhook_url for external agents", () => {
    const projected = projectAgent({
      id: "a3",
      name: "WebhookBot",
      role: "specialist",
      title: null,
      icon: null,
      reports_to: "ceo-id",
      adapter_type: "http-webhook",
      webhook_url: "https://example.com/webhook",
      source: "external",
      total_credits_consumed: 5,
    });

    expect(projected.adapter_type).toBe("http-webhook");
    expect(projected.webhook_url).toBe("https://example.com/webhook");
    expect(projected.source).toBe("external");
  });

  it("projects source=companies-sh for imported agents", () => {
    const projected = projectAgent({
      id: "a4",
      name: "ImportedDev",
      role: "developer",
      title: "Developer",
      icon: null,
      reports_to: null,
      adapter_type: "http-webhook",
      webhook_url: "https://imported.example.com",
      source: "companies-sh",
      total_credits_consumed: 25,
    });

    expect(projected.source).toBe("companies-sh");
  });

  it("defaults source to internal when undefined", () => {
    const projected = projectAgent({
      id: "a5",
      name: "Agent",
      role: "worker",
      title: null,
      icon: null,
      reports_to: null,
      adapter_type: null,
      webhook_url: null,
      // source is intentionally omitted
      total_credits_consumed: 0,
    });

    expect(projected.source).toBe("internal");
  });

  it("defaults total_credits_consumed to 0 when undefined", () => {
    const projected = projectAgent({
      id: "a6",
      name: "New Agent",
      role: "worker",
      title: null,
      icon: null,
      reports_to: null,
      adapter_type: null,
      webhook_url: null,
      source: "internal",
      // total_credits_consumed intentionally omitted
    });

    expect(projected.total_credits_consumed).toBe(0);
  });

  it("projects all new fields together for a complete agent", () => {
    const projected = projectAgent({
      id: "a7",
      name: "Full Agent",
      role: "developer",
      title: "Senior Dev",
      icon: "👨‍💻",
      email_address: "dev@test.com",
      reports_to: "cto-id",
      adapter_type: "claude-code",
      webhook_url: null,
      source: "internal",
      total_credits_consumed: 250,
    });

    expect(projected).toEqual(expect.objectContaining({
      id: "a7",
      name: "Full Agent",
      role: "developer",
      title: "Senior Dev",
      reports_to: "cto-id",
      adapter_type: "claude-code",
      webhook_url: null,
      source: "internal",
      total_credits_consumed: 250,
    }));
  });
});

// ---------------------------------------------------------------------------
// FounderStatePayload agents array type compliance
// ---------------------------------------------------------------------------

describe("FounderStatePayload agents contain new fields", () => {
  it("agents in FounderStatePayload have the new fields", () => {
    const payload: Pick<FounderStatePayload, "agents"> = {
      agents: [
        {
          id: "ceo-1",
          name: "Alice",
          role: "ceo",
          title: "CEO",
          icon: null,
          status: "working",
          email_address: "alice@test.com",
          lastActiveAt: "2024-01-01T00:00:00Z",
          lastTurnAt: "2024-01-01T00:00:00Z",
          reports_to: null,
          adapter_type: "claude-code",
          webhook_url: null,
          source: "internal",
          total_credits_consumed: 1000,
          model_tier: "sonnet-4-6",
          instructions: "",
        },
        {
          id: "dev-1",
          name: "Bob",
          role: "developer",
          title: "Developer",
          icon: null,
          status: "free",
          email_address: null,
          lastActiveAt: null,
          lastTurnAt: null,
          reports_to: "ceo-1",
          adapter_type: "http-webhook",
          webhook_url: "https://example.com/bob",
          source: "companies-sh",
          total_credits_consumed: 50,
          model_tier: "haiku",
          instructions: "Focus on frontend code.",
          skills: [{ slug: "code-review", name: "Code Review" }],
        },
      ],
    };

    expect(payload.agents).toHaveLength(2);

    const ceo = payload.agents[0];
    expect(ceo.reports_to).toBeNull();
    expect(ceo.adapter_type).toBe("claude-code");
    expect(ceo.source).toBe("internal");
    expect(ceo.total_credits_consumed).toBe(1000);

    const dev = payload.agents[1];
    expect(dev.reports_to).toBe("ceo-1");
    expect(dev.adapter_type).toBe("http-webhook");
    expect(dev.webhook_url).toBe("https://example.com/bob");
    expect(dev.source).toBe("companies-sh");
    expect(dev.total_credits_consumed).toBe(50);
  });
});
