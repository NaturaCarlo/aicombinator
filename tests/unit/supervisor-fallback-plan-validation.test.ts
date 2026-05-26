import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock routing to allow all assignments (CEO can assign to anyone)
vi.mock("../../supervisor/src/routing.ts", () => ({
  canAssignTo: vi.fn(() => true),
  getReportTarget: vi.fn(() => "ceo"),
}));

import { SupervisorDb } from "../../supervisor/src/db.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { buildFallbackInitialPlan } from "../../supervisor/src/scheduler-prompts.ts";
import type { CompanyRow } from "../../supervisor/src/types.ts";

function makeCompany(overrides: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: "company_test_1",
    user_id: "user_1",
    name: "TestCo",
    goal: "Build a test product",
    state: "planning",
    workspace_dir: "/tmp/test-workspace",
    container_id: "container_1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("Fallback plan validation", () => {
  let db: SupervisorDb;
  let tm: TaskManager;

  beforeEach(() => {
    db = new SupervisorDb(":memory:");
    db.migrate();
    tm = new TaskManager(db);

    // Seed a company
    db.run(
      `INSERT INTO companies (id, user_id, name, goal, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["company_test_1", "user_1", "TestCo", "Build a test product", "planning", new Date().toISOString(), new Date().toISOString()],
    );
  });

  it("buildFallbackInitialPlan produces a valid plan that passes validate_plan", () => {
    const company = makeCompany();
    const plan = buildFallbackInitialPlan(company);

    const errors = tm.validate_plan(company.id, plan);

    expect(errors).toEqual([]);
  });

  it("fallback plan has milestones, tasks, and agents_needed", () => {
    const company = makeCompany();
    const plan = buildFallbackInitialPlan(company);

    expect(plan.milestones.length).toBeGreaterThan(0);
    expect(plan.agents_needed.length).toBeGreaterThan(0);

    const totalTasks = plan.milestones.reduce((sum, m) => sum + m.tasks.length, 0);
    expect(totalTasks).toBeGreaterThan(0);
  });

  it("fallback plan tasks all have acceptance criteria", () => {
    const company = makeCompany();
    const plan = buildFallbackInitialPlan(company);

    for (const milestone of plan.milestones) {
      for (const task of milestone.tasks) {
        expect(task.acceptance_criteria.length).toBeGreaterThan(0);
      }
    }
  });

  it("fallback plan works with different company names", () => {
    const company = makeCompany({ name: "Acme Widgets Inc" });
    const plan = buildFallbackInitialPlan(company);

    const errors = tm.validate_plan(company.id, plan);
    expect(errors).toEqual([]);
  });
});
