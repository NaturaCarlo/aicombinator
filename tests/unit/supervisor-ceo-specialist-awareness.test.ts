/**
 * Tests for CEO specialist hiring awareness.
 *
 * Covers:
 * - CEO system prompt mentions specialist agents
 * - Planning prompt includes specialist agent info
 * - Continuation plan prompt includes specialist agent info
 * - CEO user message prompt includes specialist hiring context
 */
import { describe, it, expect } from "vitest";

import { build_system_prompt } from "../../supervisor/src/agent-runner.ts";
import {
  buildPlanningPrompt,
  buildInitialPlanningSystemPrompt,
  buildCeoContinuationPlanPrompt,
  buildCeoUserMessagePrompt,
} from "../../supervisor/src/scheduler-prompts.ts";
import type { CompanyRow, MilestoneRow, TaskRow } from "../../supervisor/src/types.ts";
import type { CEOContextInput } from "../../supervisor/src/agent-runner.ts";

function makeCompany(overrides: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: "company-1",
    user_id: "user-1",
    name: "Test Corp",
    goal: "Build something great",
    state: "running",
    container_id: null,
    workspace_dir: "/tmp/test-workspace",
    mode: "autonomous",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCeoAgent() {
  return {
    id: "agent-ceo-1",
    company_id: "company-1",
    blueprint_id: "ceo",
    name: "CEO",
    role: "ceo",
    title: "CEO",
    model_tier: "sonnet-4-6",
    status: "idle",
    session_id: null,
    current_task_id: null,
    total_credits: 100,
    total_credits_consumed: 0,
    department: "executive",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  };
}

function makeCtx(overrides: Partial<CEOContextInput> = {}): CEOContextInput {
  return {
    company: makeCompany(),
    milestones: [],
    active_tasks: [],
    recent_completions: [],
    cancelled_tasks: [],
    agents: [],
    credit_balance: 1000,
    credit_burn_rate_per_hour: 10,
    ...overrides,
  };
}

// ─── CEO System Prompt Tests ─────────────────────────────────

describe("CEO system prompt specialist awareness", () => {
  it("mentions specialist agents in the system prompt", () => {
    const company = makeCompany();
    const agent = makeCeoAgent();
    const prompt = build_system_prompt(agent as any, company);

    expect(prompt).toContain("Specialist Agents");
  });

  it("mentions seo-specialist specifically", () => {
    const company = makeCompany();
    const agent = makeCeoAgent();
    const prompt = build_system_prompt(agent as any, company);

    expect(prompt).toContain("seo-specialist");
  });

  it("explains how to hire specialists via activate_agents", () => {
    const company = makeCompany();
    const agent = makeCeoAgent();
    const prompt = build_system_prompt(agent as any, company);

    expect(prompt).toContain("activate_agents");
  });

  it("describes when to hire specialists", () => {
    const company = makeCompany();
    const agent = makeCeoAgent();
    const prompt = build_system_prompt(agent as any, company);

    expect(prompt).toContain("SEO");
    expect(prompt).toContain("web presence");
  });

  it("mentions specialists auto-maintain themselves", () => {
    const company = makeCompany();
    const agent = makeCeoAgent();
    const prompt = build_system_prompt(agent as any, company);

    expect(prompt).toContain("auto-maintain");
  });
});

// ─── Planning Prompt Tests ───────────────────────────────────

describe("Planning prompt specialist awareness", () => {
  it("mentions specialist agents in planning prompt", () => {
    const company = makeCompany();
    const prompt = buildPlanningPrompt(company);

    expect(prompt).toContain("specialist");
    expect(prompt).toContain("seo-specialist");
  });

  it("instructs CEO to consider specialists during planning", () => {
    const company = makeCompany();
    const prompt = buildPlanningPrompt(company);

    expect(prompt).toContain("seo-specialist");
  });

  it("includes specialist in available agents list", () => {
    const company = makeCompany();
    const prompt = buildPlanningPrompt(company);

    // The planning prompt should mention specialists alongside founding agents
    expect(prompt).toContain("seo-specialist");
  });
});

// ─── Initial Planning System Prompt Tests ────────────────────

describe("Initial planning system prompt specialist awareness", () => {
  it("mentions specialist agents", () => {
    const company = makeCompany();
    const prompt = buildInitialPlanningSystemPrompt(company);

    expect(prompt).toContain("specialist");
    expect(prompt).toContain("seo-specialist");
  });
});

// ─── Continuation Plan Prompt Tests ──────────────────────────

describe("Continuation plan prompt specialist awareness", () => {
  it("mentions specialist agents in continuation prompt", () => {
    const company = makeCompany();
    const ctx = makeCtx();
    const prompt = buildCeoContinuationPlanPrompt(company, ctx, [], []);

    expect(prompt).toContain("specialist");
    expect(prompt).toContain("seo-specialist");
  });

  it("includes activate_agents for specialists in continuation prompt", () => {
    const company = makeCompany();
    const ctx = makeCtx();
    const prompt = buildCeoContinuationPlanPrompt(company, ctx, [], []);

    expect(prompt).toContain("activate_agents");
  });
});

// ─── CEO User Message Prompt Tests ───────────────────────────

describe("CEO user message prompt specialist awareness", () => {
  it("mentions specialist hiring when founder asks about SEO", () => {
    const company = makeCompany();
    const ctx = makeCtx();
    const founderState = null; // simplified

    const prompt = buildCeoUserMessagePrompt(
      "I need help with SEO for our website",
      company,
      founderState,
      ctx,
    );

    // The user message prompt should reference specialists since the founder asked about SEO
    expect(prompt).toContain("specialist");
  });

  it("includes activate_agents instructions in user message prompt", () => {
    const company = makeCompany();
    const ctx = makeCtx();

    const prompt = buildCeoUserMessagePrompt(
      "Can we improve our search rankings?",
      company,
      null,
      ctx,
    );

    expect(prompt).toContain("activate_agents");
  });
});
