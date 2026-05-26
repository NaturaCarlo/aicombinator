import { describe, expect, it, vi } from "vitest";
import {
  buildCeoUserMessagePrompt,
  buildFounderStateSnapshotBlock,
} from "../../supervisor/src/scheduler-prompts.ts";
import {
  build_grounded_founder_fallback,
  gather_ceo_context,
} from "../../supervisor/src/scheduler-founder.ts";
import type { CEOContextInput } from "../../supervisor/src/agent-runner.ts";
import type {
  CompanyRow,
  FounderStateSnapshot,
  FounderStateTaskSnapshot,
} from "../../supervisor/src/types.ts";

// Mock blueprints module
vi.mock("../../supervisor/src/blueprints.ts", () => ({
  getBlueprint: vi.fn(() => null),
  getAllBlueprints: vi.fn(() => []),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"],
}));

// ─── Fixtures ────────────────────────────────────────────────────

function makeCompany(overrides: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: "company-1",
    name: "TestCo",
    user_id: "user-1",
    state: "running",
    genesis_prompt: "Build a widget",
    goal: "Build a widget",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  } as CompanyRow;
}

function makeCtx(overrides: Partial<CEOContextInput> = {}): CEOContextInput {
  return {
    company: makeCompany(),
    milestones: [
      { id: "ms-1", title: "Engineering", status: "in_progress", sort_order: 1, tasks_done: 1, tasks_total: 3 },
    ],
    active_tasks: [
      { id: "t-1", title: "Build landing page", status: "in_progress", owner_agent_id: "agent-1", blocked_reason: null, artifact: null },
      { id: "t-2", title: "Write blog post", status: "in_progress", owner_agent_id: "agent-2", blocked_reason: null, artifact: null },
    ],
    recent_completions: [
      { id: "t-0", title: "Competitor research", artifact: "docs/competitor-brief.md", completed_at: "2025-01-01T10:00:00Z" },
    ],
    cancelled_tasks: [],
    agents: [
      { id: "agent-1", name: "Frontend Dev", role: "frontend-dev", title: "Frontend Developer", status: "working", current_task_id: "t-1" },
      { id: "agent-2", name: "CMO", role: "cmo", title: "Chief Marketing Officer", status: "working", current_task_id: "t-2" },
    ],
    credit_balance: 500,
    credit_burn_rate_per_hour: 10,
    ...overrides,
  };
}

function makeStaleFounderState(): FounderStateSnapshot {
  // Client snapshot shows NO active tasks — everything looks idle (stale data)
  return {
    companyId: "company-1",
    name: "TestCo",
    state: "running",
    credits: {
      balance: 500,
      reserved: 100,
      available: 400,
      currentCompanyReserved: 100,
      otherCompanyReserved: 0,
      contentionReason: null,
      reservations: [],
    },
    agents: [
      { id: "agent-1", name: "Frontend Dev", title: "Frontend Developer", status: "free", icon: null },
      { id: "agent-2", name: "CMO", title: "Chief Marketing Officer", status: "free", icon: null },
    ],
    tasks: [
      // All tasks show as "done" or "queued" — none as "active" (stale mapping)
      {
        id: "t-0",
        title: "Competitor research",
        description: null,
        status: "done",
        ownerAgentId: "agent-2",
        ownerName: "CMO",
        ownerTitle: "Chief Marketing Officer",
        ownerIcon: null,
        updatedAt: "2025-01-01T10:00:00Z",
        completedAt: "2025-01-01T10:00:00Z",
        detail: null,
        parentTaskId: null,
      },
      {
        id: "t-1",
        title: "Build landing page",
        description: null,
        status: "done", // stale — server says in_progress
        ownerAgentId: "agent-1",
        ownerName: "Frontend Dev",
        ownerTitle: "Frontend Developer",
        ownerIcon: null,
        updatedAt: "2025-01-01T09:00:00Z",
        completedAt: null,
        detail: null,
        parentTaskId: null,
      },
      {
        id: "t-2",
        title: "Write blog post",
        description: null,
        status: "done", // stale — server says in_progress
        ownerAgentId: "agent-2",
        ownerName: "CMO",
        ownerTitle: "Chief Marketing Officer",
        ownerIcon: null,
        updatedAt: "2025-01-01T09:00:00Z",
        completedAt: null,
        detail: null,
        parentTaskId: null,
      },
    ],
    opsSummary: {
      headline: "All quiet — the team's idle",
      detail: "",
    },
  };
}

function makeAccurateFounderState(): FounderStateSnapshot {
  return {
    ...makeStaleFounderState(),
    tasks: [
      {
        id: "t-1",
        title: "Build landing page",
        description: null,
        status: "active",
        ownerAgentId: "agent-1",
        ownerName: "Frontend Dev",
        ownerTitle: "Frontend Developer",
        ownerIcon: null,
        updatedAt: "2025-01-01T09:00:00Z",
        completedAt: null,
        detail: null,
        parentTaskId: null,
      },
    ],
    opsSummary: {
      headline: "Frontend Dev is working on Build landing page",
      detail: "",
    },
  };
}

// ─── Tests: FIX 1 — buildCeoUserMessagePrompt staleness correction ──

describe("buildCeoUserMessagePrompt — stale snapshot correction", () => {
  it("includes stale-snapshot correction when server shows in_progress tasks but client shows none active", () => {
    const company = makeCompany();
    const founderState = makeStaleFounderState();
    const ctx = makeCtx();

    const prompt = buildCeoUserMessagePrompt("How's the team doing?", company, founderState, ctx);

    // Should warn about stale data
    expect(prompt).toContain("stale");
    // Should mention in_progress tasks from server
    expect(prompt).toContain("Build landing page");
    expect(prompt).toContain("Write blog post");
  });

  it("does NOT include stale correction when client snapshot matches server state", () => {
    const company = makeCompany();
    const founderState = makeAccurateFounderState();
    const ctx = makeCtx({
      active_tasks: [
        { id: "t-1", title: "Build landing page", status: "in_progress", owner_agent_id: "agent-1", blocked_reason: null, artifact: null },
      ],
    });

    const prompt = buildCeoUserMessagePrompt("How's the team doing?", company, founderState, ctx);

    // Should NOT contain stale warning
    expect(prompt).not.toMatch(/dashboard snapshot may be stale/i);
  });

  it("removes 'canonical truth' instruction from prompt", () => {
    const company = makeCompany();
    const founderState = makeAccurateFounderState();
    const ctx = makeCtx();

    const prompt = buildCeoUserMessagePrompt("Update me", company, founderState, ctx);

    expect(prompt).not.toMatch(/canonical.*truth/i);
  });

  it("tells CEO to prefer server context on conflict", () => {
    const company = makeCompany();
    const founderState = makeStaleFounderState();
    const ctx = makeCtx();

    const prompt = buildCeoUserMessagePrompt("What's happening?", company, founderState, ctx);

    // Should tell CEO to trust server context over stale snapshot
    expect(prompt).toMatch(/server|execution context|company state/i);
  });
});

// ─── Tests: FIX 2 — build_grounded_founder_fallback staleness handling ──

describe("build_grounded_founder_fallback — stale snapshot handling", () => {
  function makeMockDeps(ctx: CEOContextInput) {
    const db = {
      get: vi.fn(() => ({ spent: 100 })),
      all: vi.fn(() => []),
    };
    const task_manager = {
      get_company: vi.fn(() => ctx.company),
      get_milestones: vi.fn(() => ctx.milestones.map((m) => ({ ...m }))),
      get_tasks: vi.fn(() => [
        ...ctx.active_tasks.map((t) => ({
          ...t,
          milestone_id: "ms-1",
          owner_agent_id: t.owner_agent_id,
          completed_at: null,
        })),
        ...ctx.recent_completions.map((t) => ({
          ...t,
          status: "done",
          milestone_id: "ms-1",
          owner_agent_id: null,
          blocked_reason: null,
        })),
      ]),
      get_agents: vi.fn(() => ctx.agents),
    };
    const credit_manager = {
      get_balance: vi.fn(() => ctx.credit_balance),
    };
    return { db, task_manager, credit_manager } as any;
  }

  it("does NOT say 'All planned work is complete' when server shows in_progress tasks", () => {
    const ctx = makeCtx();
    const deps = makeMockDeps(ctx);
    const staleFounderState = makeStaleFounderState();

    const fallback = build_grounded_founder_fallback("company-1", deps, staleFounderState, ctx);

    expect(fallback).not.toContain("All planned work is complete");
    // Should mention tasks that are actually in progress
    expect(fallback).toContain("Build landing page");
  });

  it("says 'All planned work is complete' when server ALSO shows no active tasks", () => {
    const ctx = makeCtx({
      active_tasks: [],
      recent_completions: [
        { id: "t-0", title: "Competitor research", artifact: null, completed_at: "2025-01-01T10:00:00Z" },
      ],
    });
    const deps = makeMockDeps(ctx);
    const founderState: FounderStateSnapshot = {
      ...makeStaleFounderState(),
      tasks: [
        {
          id: "t-0",
          title: "Competitor research",
          description: null,
          status: "done",
          ownerAgentId: "agent-2",
          ownerName: "CMO",
          ownerTitle: "Chief Marketing Officer",
          ownerIcon: null,
          updatedAt: "2025-01-01T10:00:00Z",
          completedAt: "2025-01-01T10:00:00Z",
          detail: null,
          parentTaskId: null,
        },
      ],
    };

    const fallback = build_grounded_founder_fallback("company-1", deps, founderState, ctx);

    expect(fallback).toContain("All planned work is complete");
  });

  it("mentions server-side in-progress tasks when client snapshot shows all done", () => {
    const ctx = makeCtx();
    const deps = makeMockDeps(ctx);
    const staleFounderState = makeStaleFounderState();

    const fallback = build_grounded_founder_fallback("company-1", deps, staleFounderState, ctx);

    // Should reference the server-side in-progress tasks
    expect(fallback).toMatch(/working on|in progress|active/i);
    expect(fallback).toContain("Build landing page");
  });
});

// ─── Tests: FIX 3 — opsSummary staleness correction in snapshot block ──

describe("buildFounderStateSnapshotBlock — stale ops summary correction", () => {
  it("includes ops summary from the founder state", () => {
    const founderState = makeStaleFounderState();
    const block = buildFounderStateSnapshotBlock(founderState);

    expect(block).toContain("Ops summary:");
    expect(block).toContain("idle");
  });
});
