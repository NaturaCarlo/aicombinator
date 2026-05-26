/**
 * Tests for specialist agent assignment ACL and reportsTo fallback.
 *
 * Covers:
 * - CEO can assign tasks to seo-specialist via ASSIGNMENT_TABLE
 * - CMO can assign tasks to seo-specialist via ASSIGNMENT_TABLE
 * - seo-specialist is in REPORTS_TO_TABLE
 * - activate_agent falls back to CEO when reportsTo manager doesn't exist
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  canAssignTo,
  getReportTarget,
  ASSIGNMENT_TABLE,
  REPORTS_TO_TABLE,
} from "../../supervisor/src/routing.ts";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";

// ─── PART 1: ASSIGNMENT_TABLE ACL tests ──────────────────────

describe("Specialist Assignment ACL", () => {
  describe("ASSIGNMENT_TABLE allows seo-specialist", () => {
    it("CEO can assign to seo-specialist", () => {
      expect(canAssignTo("ceo", "seo-specialist")).toBe(true);
    });

    it("CMO can assign to seo-specialist", () => {
      expect(canAssignTo("cmo", "seo-specialist")).toBe(true);
    });

    it("seo-specialist is in CEO's assignment list", () => {
      expect(ASSIGNMENT_TABLE["ceo"]).toContain("seo-specialist");
    });

    it("seo-specialist is in CMO's assignment list", () => {
      expect(ASSIGNMENT_TABLE["cmo"]).toContain("seo-specialist");
    });

    it("CTO cannot assign to seo-specialist", () => {
      expect(canAssignTo("cto", "seo-specialist")).toBe(false);
    });

    it("seo-specialist cannot assign to anyone", () => {
      expect(canAssignTo("seo-specialist", "ceo")).toBe(false);
      expect(canAssignTo("seo-specialist", "cto")).toBe(false);
    });
  });

  describe("REPORTS_TO_TABLE includes seo-specialist", () => {
    it("seo-specialist reports to cmo", () => {
      expect(getReportTarget("seo-specialist")).toBe("cmo");
    });

    it("seo-specialist is in REPORTS_TO_TABLE", () => {
      expect(REPORTS_TO_TABLE["seo-specialist"]).toBe("cmo");
    });
  });
});

// ─── PART 2: activate_agent reportsTo fallback tests ─────────

function createTestDb(): SupervisorDb {
  const db = new SupervisorDb(":memory:");
  db.migrate();
  return db;
}

function seedCompany(db: SupervisorDb, id: string = "comp-1"): void {
  db.run(
    `INSERT INTO companies (id, user_id, name, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, "user-1", "Test Co", "running", isoNow(), isoNow()],
  );
}

function seedCeo(db: SupervisorDb, companyId: string = "comp-1"): string {
  const ceoId = `agent-ceo-${companyId}`;
  db.run(
    `INSERT INTO agents (id, company_id, blueprint_id, name, role, title, model_tier, status, reports_to, session_id, current_task_id, total_credits, total_credits_consumed, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ceoId, companyId, "ceo", "CEO", "ceo", "CEO", "sonnet-4-6", "idle", null, null, null, 0, 0, "executive", isoNow(), isoNow()],
  );
  return ceoId;
}

function seedCmo(db: SupervisorDb, companyId: string = "comp-1"): string {
  const cmoId = `agent-cmo-${companyId}`;
  db.run(
    `INSERT INTO agents (id, company_id, blueprint_id, name, role, title, model_tier, status, reports_to, session_id, current_task_id, total_credits, total_credits_consumed, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cmoId, companyId, "cmo", "CMO", "cmo", "CMO", "sonnet-4-6", "idle", null, null, null, 0, 0, "marketing", isoNow(), isoNow()],
  );
  return cmoId;
}

describe("activate_agent reportsTo fallback", () => {
  let db: SupervisorDb;
  let tm: TaskManager;

  beforeEach(() => {
    db = createTestDb();
    tm = new TaskManager(db);
    seedCompany(db);
    seedCeo(db);
  });

  it("falls back to CEO when reportsTo manager (CMO) does not exist", () => {
    // No CMO seeded — only CEO exists
    const agent = tm.activate_agent("comp-1", "seo-specialist");
    const ceoId = `agent-ceo-comp-1`;
    expect(agent.reports_to).toBe(ceoId);
  });

  it("uses CMO when CMO exists", () => {
    const cmoId = seedCmo(db);
    const agent = tm.activate_agent("comp-1", "seo-specialist");
    expect(agent.reports_to).toBe(cmoId);
  });

  it("fallback does not apply when reportsTo is empty (e.g. CEO blueprint)", () => {
    // CEO has reportsTo: "" — should remain null, not self-reference
    const ceoAgent = db.get<{ reports_to: string | null }>(
      `SELECT reports_to FROM agents WHERE blueprint_id = 'ceo' AND company_id = 'comp-1'`,
      [],
    );
    expect(ceoAgent!.reports_to).toBeNull();
  });

  it("fallback works for any specialist whose manager is missing", () => {
    // seo-specialist reportsTo cmo, but no CMO exists → should get CEO
    const agent = tm.activate_agent("comp-1", "seo-specialist");
    const ceo = db.get<{ id: string }>(
      `SELECT id FROM agents WHERE blueprint_id = 'ceo' AND company_id = 'comp-1'`,
      [],
    );
    expect(agent.reports_to).toBe(ceo!.id);
  });
});

// ─── PART 3: End-to-end task assignment via validate_and_insert_task ──

describe("CEO assigns task to seo-specialist via validate_and_insert_task", () => {
  let db: SupervisorDb;
  let tm: TaskManager;

  beforeEach(() => {
    db = createTestDb();
    tm = new TaskManager(db);
    seedCompany(db);
    seedCeo(db);
  });

  it("CEO can create a task assigned to seo-specialist (no ACL block)", () => {
    // Activate seo-specialist first
    tm.activate_agent("comp-1", "seo-specialist");

    // Create milestone
    const milestoneId = tm.generate_id("ms");
    db.run(
      `INSERT INTO milestones (id, company_id, title, description, status, sort_order, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [milestoneId, "comp-1", "M1", "Test", "active", 0, "ceo", isoNow()],
    );

    const ceoId = `agent-ceo-comp-1`;
    const taskId = tm.validate_and_insert_task("comp-1", {
      title: "SEO Audit",
      description: "Perform a comprehensive SEO audit",
      assigned_to: "seo-specialist",
      depends_on: [],
      acceptance_criteria: [],
    }, { milestone_id: milestoneId, created_by: ceoId });

    // Task should NOT be blocked
    const task = db.get<{ status: string; blocked_reason: string | null; owner_agent_id: string }>(
      `SELECT status, blocked_reason, owner_agent_id FROM tasks WHERE id = ?`,
      [taskId],
    );
    expect(task!.status).toBe("pending");
    expect(task!.blocked_reason).toBeNull();

    // Task should be owned by the seo-specialist agent
    const seoAgent = db.get<{ id: string }>(
      `SELECT id FROM agents WHERE blueprint_id = 'seo-specialist' AND company_id = 'comp-1'`,
      [],
    );
    expect(task!.owner_agent_id).toBe(seoAgent!.id);
  });

  it("plan validation allows CEO -> seo-specialist assignment", () => {
    const errors = tm.validate_plan("comp-1", {
      milestones: [{
        title: "SEO Milestone",
        tasks: [{
          title: "Keyword Research",
          description: "Research keywords",
          assigned_to: "seo-specialist",
          depends_on: [],
          acceptance_criteria: ["Keywords identified"],
        }],
      }],
      agents_needed: ["seo-specialist"],
    });

    // Should have no errors about CEO cannot assign to seo-specialist
    const aclErrors = errors.filter((e) => e.message.includes("seo-specialist"));
    expect(aclErrors).toHaveLength(0);
  });
});
