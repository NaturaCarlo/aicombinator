import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  generate_design_md,
  materialize_initial_company_files,
} from "../../supervisor/src/scheduler-documents.ts";
import { build_task_prompt } from "../../supervisor/src/agent-runner.ts";
import { getBlueprint } from "../../supervisor/src/blueprints.ts";
import type { CompanyRow, PlanDocument } from "../../supervisor/src/types.ts";
import type { AgentRow, TaskRow } from "../../supervisor/src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompany(overrides: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: "company-test",
    user_id: "user-1",
    name: "TestCo",
    goal: "Build something great",
    state: "running",
    container_id: null,
    workspace_dir: null,
    mode: "autonomous",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makePlan(): PlanDocument {
  return {
    milestones: [
      {
        title: "Initial Launch",
        description: "Get the product out the door",
        tasks: [
          {
            title: "Build landing page",
            description: "Create a landing page for the product",
            assigned_to: "frontend-dev",
            depends_on: [],
            acceptance_criteria: "Landing page exists",
          },
        ],
      },
    ],
    agents_needed: ["cto", "frontend-dev"],
  };
}

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-1",
    company_id: "company-test",
    blueprint_id: "frontend-dev",
    name: "Frontend Dev",
    role: "frontend-dev",
    model_tier: "mid" as AgentRow["model_tier"],
    status: "idle",
    session_id: null,
    current_task_id: null,
    total_credits: 0,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    company_id: "company-test",
    milestone_id: "milestone-1",
    title: "Build landing page",
    description: "Create a polished landing page for TestCo",
    status: "in_progress",
    owner_agent_id: "agent-1",
    depends_on: "[]",
    acceptance_criteria: "[]",
    artifact: null,
    blocked_reason: null,
    credits_spent: 0,
    turns_spent: 0,
    created_by: null,
    parent_task_id: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  } as TaskRow;
}

// Minimal TaskManager mock for build_task_prompt
function makeTaskManager() {
  return {
    get_task: () => null,
    get_agent: () => null,
    get_milestones: () => [],
    get_tasks: () => [],
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DESIGN.md generation for company provisioning", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = join(tmpdir(), `design-md-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(workspace, "docs"), { recursive: true });
    mkdirSync(join(workspace, ".agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  describe("generate_design_md()", () => {
    it("generates DESIGN.md content with all required sections", () => {
      const result = generate_design_md("TestCo", "A fintech platform for small businesses", "fintech");
      expect(result).toContain("# Design System");
      expect(result).toContain("## 1. Visual Theme & Atmosphere");
      expect(result).toContain("## 2. Color Palette & Roles");
      expect(result).toContain("## 3. Typography Rules");
      expect(result).toContain("## 4. Component Stylings");
      expect(result).toContain("## 5. Layout Principles");
      expect(result).toContain("## 6. Do's and Don'ts");
      expect(result).toContain("## 7. Responsive Behavior");
    });

    it("includes company name in the output", () => {
      const result = generate_design_md("Acme Corp", "SaaS analytics", "technology");
      expect(result).toContain("Acme Corp");
    });

    it("includes company brief in the output", () => {
      const result = generate_design_md("HealthFirst", "Telehealth platform for seniors", "healthcare");
      expect(result).toContain("Telehealth platform for seniors");
    });

    it("derives visual theme from industry context", () => {
      const fintech = generate_design_md("PayFlow", "Payments API", "fintech");
      expect(fintech.toLowerCase()).toMatch(/trust|precision|reliable|professional/);

      const health = generate_design_md("MedCare", "Health tracking", "healthcare");
      expect(health.toLowerCase()).toMatch(/warm|caring|calm|wellness/);

      const creative = generate_design_md("DesignHub", "Creative tools", "creative");
      expect(creative.toLowerCase()).toMatch(/creative|expressive|vibrant|bold/);
    });

    it("generates a coherent color palette", () => {
      const result = generate_design_md("TestCo", "Test brief", "technology");
      // Should contain hex color codes
      expect(result).toMatch(/#[0-9a-fA-F]{6}/);
    });

    it("includes typography recommendations", () => {
      const result = generate_design_md("TestCo", "Test brief", "technology");
      expect(result.toLowerCase()).toMatch(/font|heading|body|display/);
    });

    it("includes button and card component guidelines", () => {
      const result = generate_design_md("TestCo", "Test brief", "technology");
      expect(result.toLowerCase()).toMatch(/button/);
      expect(result.toLowerCase()).toMatch(/card/);
    });

    it("includes responsive breakpoints", () => {
      const result = generate_design_md("TestCo", "Test brief", "technology");
      expect(result.toLowerCase()).toMatch(/breakpoint|mobile|tablet|desktop/);
    });
  });

  describe("materialize_initial_company_files writes DESIGN.md", () => {
    it("creates docs/DESIGN.md in the workspace", () => {
      const company = makeCompany({ genesis_prompt: "A fintech SaaS for small businesses" });
      const plan = makePlan();
      materialize_initial_company_files(workspace, company, "Build a fintech platform", plan);
      expect(existsSync(join(workspace, "docs", "DESIGN.md"))).toBe(true);
    });

    it("DESIGN.md contains company name", () => {
      const company = makeCompany({ name: "PayFlow Inc" });
      const plan = makePlan();
      materialize_initial_company_files(workspace, company, "Build a payments API", plan);
      const content = readFileSync(join(workspace, "docs", "DESIGN.md"), "utf8");
      expect(content).toContain("PayFlow Inc");
    });

    it("DESIGN.md is not empty", () => {
      const company = makeCompany();
      const plan = makePlan();
      materialize_initial_company_files(workspace, company, "Build something", plan);
      const content = readFileSync(join(workspace, "docs", "DESIGN.md"), "utf8");
      expect(content.length).toBeGreaterThan(500);
    });

    it("other company files still exist alongside DESIGN.md", () => {
      const company = makeCompany();
      const plan = makePlan();
      materialize_initial_company_files(workspace, company, "Build something", plan);
      expect(existsSync(join(workspace, "docs", "mission.md"))).toBe(true);
      expect(existsSync(join(workspace, "docs", "plan.md"))).toBe(true);
      expect(existsSync(join(workspace, "docs", "goal.md"))).toBe(true);
      expect(existsSync(join(workspace, "docs", "execution-contract.json"))).toBe(true);
      expect(existsSync(join(workspace, "docs", "DESIGN.md"))).toBe(true);
    });
  });

  describe("build_task_prompt includes DESIGN.md instruction for UI tasks", () => {
    it("adds DESIGN.md instruction for landing page tasks", () => {
      const agent = makeAgent();
      const task = makeTask({ title: "Build landing page", description: "Create a polished landing page" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);
      expect(prompt).toContain("DESIGN.md");
      expect(prompt).toContain("design system");
    });

    it("adds DESIGN.md instruction for UI design tasks", () => {
      const agent = makeAgent();
      const task = makeTask({ title: "Design homepage UI", description: "Create the homepage UI components" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);
      expect(prompt).toContain("DESIGN.md");
    });

    it("adds DESIGN.md instruction for frontend tasks", () => {
      const agent = makeAgent();
      const task = makeTask({ title: "Build frontend components", description: "Create React frontend components for the app" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);
      expect(prompt).toContain("DESIGN.md");
    });

    it("adds DESIGN.md instruction for website tasks", () => {
      const agent = makeAgent();
      const task = makeTask({ title: "Build company website", description: "Build the main website" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);
      expect(prompt).toContain("DESIGN.md");
    });

    it("adds DESIGN.md instruction for layout tasks", () => {
      const agent = makeAgent();
      const task = makeTask({ title: "Create page layout", description: "Design the page layout for the product" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);
      expect(prompt).toContain("DESIGN.md");
    });

    it("does NOT add DESIGN.md instruction for non-UI tasks", () => {
      const agent = makeAgent();
      const task = makeTask({ title: "Write API endpoints", description: "Create REST API endpoints for user management" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);
      expect(prompt).not.toContain("DESIGN.md");
    });

    it("does NOT add DESIGN.md instruction for data processing tasks", () => {
      const agent = makeAgent();
      const task = makeTask({ title: "Set up database schema", description: "Create the PostgreSQL schema for the app" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);
      expect(prompt).not.toContain("DESIGN.md");
    });
  });

  // Fix 1: Inline DESIGN.md content into agent task prompts
  describe("build_task_prompt inlines DESIGN.md content for UI tasks", () => {
    it("inlines actual DESIGN.md content (color palette, typography) when file exists", () => {
      // Write a DESIGN.md file to the workspace
      const designContent = generate_design_md("TestCo", "A tech platform", "technology");
      writeFileSync(join(workspace, "docs", "DESIGN.md"), designContent);

      const agent = makeAgent();
      const task = makeTask({ title: "Build landing page", description: "Create a polished landing page" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);

      // Should inline actual hex colors from the design system
      expect(prompt).toMatch(/#[0-9a-fA-F]{6}/);
      // Should include typography info
      expect(prompt).toMatch(/font/i);
      // Should mention color palette concepts
      expect(prompt).toMatch(/primary|secondary|accent/i);
    });

    it("inlines color palette hex values from DESIGN.md", () => {
      const designContent = generate_design_md("TestCo", "A fintech app", "fintech");
      writeFileSync(join(workspace, "docs", "DESIGN.md"), designContent);

      const agent = makeAgent();
      const task = makeTask({ title: "Build landing page", description: "Create landing page" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);

      // Fintech primary color is #0F3460
      expect(prompt).toContain("#0F3460");
    });

    it("falls back to generic instruction when DESIGN.md does not exist", () => {
      // Remove docs/DESIGN.md if it exists
      const designPath = join(workspace, "docs", "DESIGN.md");
      rmSync(designPath, { force: true });

      const agent = makeAgent();
      const task = makeTask({ title: "Build landing page", description: "Create a landing page" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);

      // Should still mention DESIGN.md but with the generic instruction
      expect(prompt).toContain("DESIGN.md");
    });

    it("does NOT inline DESIGN.md content for non-UI tasks", () => {
      const designContent = generate_design_md("TestCo", "A tech platform", "technology");
      writeFileSync(join(workspace, "docs", "DESIGN.md"), designContent);

      const agent = makeAgent();
      const task = makeTask({ title: "Write API endpoints", description: "Build REST API" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);

      // Should not contain inline design content
      expect(prompt).not.toMatch(/#1B1F3B/);
    });

    it("keeps inlined content under reasonable size (~2000 tokens)", () => {
      const designContent = generate_design_md("TestCo", "A tech platform", "technology");
      writeFileSync(join(workspace, "docs", "DESIGN.md"), designContent);

      const agent = makeAgent();
      const task = makeTask({ title: "Build landing page", description: "Create a landing page" });
      const tm = makeTaskManager();
      const prompt = build_task_prompt(agent, task, tm, workspace);

      // The design system section should be present but not bloat the prompt
      // ~2000 tokens is roughly 8000 characters for English text
      const designSectionMatch = prompt.match(/# Design System[\s\S]*?(?=# Important|$)/);
      expect(designSectionMatch).not.toBeNull();
      if (designSectionMatch) {
        expect(designSectionMatch[0].length).toBeLessThan(10000);
      }
    });
  });

  // Fix 2: Landing page composition patterns in generate_design_md
  describe("generate_design_md includes landing page composition patterns", () => {
    it("includes a landing page composition patterns section", () => {
      const result = generate_design_md("TestCo", "A tech platform", "technology");
      expect(result).toMatch(/landing page composition/i);
    });

    it("includes hero section pattern", () => {
      const result = generate_design_md("TestCo", "A tech platform", "technology");
      expect(result).toMatch(/hero\s+section/i);
      expect(result).toMatch(/gradient/i);
    });

    it("includes features grid pattern", () => {
      const result = generate_design_md("TestCo", "A tech platform", "technology");
      expect(result).toMatch(/features?\s+grid/i);
      expect(result).toMatch(/3.column/i);
    });

    it("includes social proof pattern", () => {
      const result = generate_design_md("TestCo", "A tech platform", "technology");
      expect(result).toMatch(/social\s+proof/i);
    });

    it("includes stats section pattern", () => {
      const result = generate_design_md("TestCo", "A tech platform", "technology");
      expect(result).toMatch(/stats/i);
    });

    it("includes CTA section pattern", () => {
      const result = generate_design_md("TestCo", "A tech platform", "technology");
      expect(result).toMatch(/cta\s+section/i);
    });

    it("includes footer pattern", () => {
      const result = generate_design_md("TestCo", "A tech platform", "technology");
      expect(result).toMatch(/footer/i);
      expect(result).toMatch(/multi.column/i);
    });
  });

  // Fix 3: Frontend-dev blueprint has design guidance
  describe("frontend-dev blueprint includes design guidance", () => {
    it("exists and has a system prompt", () => {
      const blueprint = getBlueprint("frontend-dev");
      expect(blueprint).toBeDefined();
      expect(blueprint!.systemPrompt).toBeTruthy();
    });

    it("includes landing page design guidance", () => {
      const blueprint = getBlueprint("frontend-dev");
      const prompt = blueprint!.systemPrompt.toLowerCase();
      expect(prompt).toMatch(/landing\s*page/);
      expect(prompt).toMatch(/gradient|shadow|transition/);
    });

    it("includes instruction to read DESIGN.md", () => {
      const blueprint = getBlueprint("frontend-dev");
      const prompt = blueprint!.systemPrompt;
      expect(prompt).toContain("DESIGN.md");
    });

    it("includes visual hierarchy guidance", () => {
      const blueprint = getBlueprint("frontend-dev");
      const prompt = blueprint!.systemPrompt.toLowerCase();
      expect(prompt).toMatch(/visual\s+hierarchy/);
    });

    it("includes specific section guidance (hero, features, CTA, footer)", () => {
      const blueprint = getBlueprint("frontend-dev");
      const prompt = blueprint!.systemPrompt.toLowerCase();
      expect(prompt).toMatch(/hero\s+section/);
      expect(prompt).toMatch(/features?\s+grid/);
      expect(prompt).toMatch(/cta/);
      expect(prompt).toMatch(/footer/);
    });

    it("warns against plain white backgrounds for heroes", () => {
      const blueprint = getBlueprint("frontend-dev");
      const prompt = blueprint!.systemPrompt.toLowerCase();
      expect(prompt).toMatch(/plain\s+white/);
    });
  });
});
