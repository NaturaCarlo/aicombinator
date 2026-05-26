/**
 * Tests for specialist agent blueprint infrastructure and SEO specialist blueprint.
 *
 * Covers:
 * - SPECIALIST_BLUEPRINTS set and helpers
 * - SEO specialist blueprint exists in registry
 * - Specialist activation allowed in scheduler and task-manager
 * - Auto-create self-update cron on specialist activation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock routing to allow all assignments
vi.mock("../../supervisor/src/routing.ts", () => ({
  canAssignTo: vi.fn(() => true),
  getReportTarget: vi.fn(() => "ceo"),
}));

import {
  getBlueprint,
  getAllBlueprints,
  FOUNDING_BLUEPRINTS,
  isSpecialistBlueprint,
  getAllSpecialistBlueprints,
  SPECIALIST_BLUEPRINTS,
} from "../../supervisor/src/blueprints.ts";
import { SupervisorDb, isoNow } from "../../supervisor/src/db.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";

// ─── PART 1 & 2: Blueprint registry tests ────────────────────

describe("Specialist Blueprint Infrastructure", () => {
  describe("SPECIALIST_BLUEPRINTS set", () => {
    it("contains seo-specialist", () => {
      expect(SPECIALIST_BLUEPRINTS.has("seo-specialist")).toBe(true);
    });

    it("does not contain founding blueprints", () => {
      for (const id of FOUNDING_BLUEPRINTS) {
        expect(SPECIALIST_BLUEPRINTS.has(id)).toBe(false);
      }
    });
  });

  describe("isSpecialistBlueprint()", () => {
    it("returns true for seo-specialist", () => {
      expect(isSpecialistBlueprint("seo-specialist")).toBe(true);
    });

    it("returns false for founding blueprints", () => {
      expect(isSpecialistBlueprint("ceo")).toBe(false);
      expect(isSpecialistBlueprint("cto")).toBe(false);
      expect(isSpecialistBlueprint("cmo")).toBe(false);
      expect(isSpecialistBlueprint("frontend-dev")).toBe(false);
    });

    it("returns false for unknown blueprints", () => {
      expect(isSpecialistBlueprint("unknown-agent")).toBe(false);
    });
  });

  describe("getAllSpecialistBlueprints()", () => {
    it("returns only specialist blueprints", () => {
      const specialists = getAllSpecialistBlueprints();
      expect(specialists.length).toBeGreaterThan(0);
      for (const bp of specialists) {
        expect(SPECIALIST_BLUEPRINTS.has(bp.id)).toBe(true);
      }
    });

    it("includes seo-specialist blueprint", () => {
      const specialists = getAllSpecialistBlueprints();
      const seo = specialists.find((bp) => bp.id === "seo-specialist");
      expect(seo).toBeDefined();
    });
  });
});

describe("SEO Specialist Blueprint", () => {
  it("exists in the registry", () => {
    const seo = getBlueprint("seo-specialist");
    expect(seo).toBeDefined();
  });

  it("has correct metadata", () => {
    const seo = getBlueprint("seo-specialist")!;
    expect(seo.id).toBe("seo-specialist");
    expect(seo.role).toBe("specialist");
    expect(seo.title).toBe("SEO Specialist");
    expect(seo.department).toBe("marketing");
    expect(seo.reportsTo).toBe("cmo");
    expect(seo.provider).toBe("claude");
    expect(seo.modelTier).toBe("sonnet-4-6"); // after policy
    expect(seo.estimatedCreditsPerDay).toBe(50);
    expect(seo.tested).toBe(true);
    expect(seo.version).toBe("1.0.0");
  });

  it("has required skills", () => {
    const seo = getBlueprint("seo-specialist")!;
    expect(seo.skills).toContain("seo-audit");
    expect(seo.skills).toContain("keyword-research");
    expect(seo.skills).toContain("content-optimization");
    expect(seo.skills).toContain("meta-optimization");
    expect(seo.skills).toContain("competitor-analysis");
    expect(seo.skills).toContain("technical-seo");
  });

  it("has browser MCP server", () => {
    const seo = getBlueprint("seo-specialist")!;
    expect(seo.mcpServers).toContain("browser");
  });

  it("has SEO-related system prompt", () => {
    const seo = getBlueprint("seo-specialist")!;
    expect(seo.systemPrompt).toContain("SEO");
    expect(seo.systemPrompt).toContain("keyword");
    expect(seo.systemPrompt).toContain("seo-guidelines.md");
    expect(seo.systemPrompt).toContain("seo-knowledge.md");
    expect(seo.systemPrompt).toContain("keyword-strategy.md");
  });

  it("is included in getAllBlueprints()", () => {
    const all = getAllBlueprints();
    const seo = all.find((bp) => bp.id === "seo-specialist");
    expect(seo).toBeDefined();
  });

  it("is NOT a founding blueprint", () => {
    const foundingSet = new Set<string>(FOUNDING_BLUEPRINTS);
    expect(foundingSet.has("seo-specialist")).toBe(false);
  });

  it("has a description", () => {
    const seo = getBlueprint("seo-specialist")!;
    expect(seo.description).toContain("SEO specialist");
  });
});

// ─── PART 3 & 4: Activation + cron creation tests ────────────

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

describe("Specialist activation in task-manager", () => {
  let db: SupervisorDb;
  let tm: TaskManager;

  beforeEach(() => {
    db = createTestDb();
    tm = new TaskManager(db);
    seedCompany(db);
    seedCeo(db);
    seedCmo(db);
  });

  it("activate_agent succeeds for seo-specialist", () => {
    const agent = tm.activate_agent("comp-1", "seo-specialist");
    expect(agent).toBeDefined();
    expect(agent.blueprint_id).toBe("seo-specialist");
    expect(agent.company_id).toBe("comp-1");
    expect(agent.role).toBe("specialist");
  });

  it("activate_agent sets reports_to to CMO agent", () => {
    const agent = tm.activate_agent("comp-1", "seo-specialist");
    const cmo = db.get<{ id: string }>(
      `SELECT id FROM agents WHERE company_id = ? AND blueprint_id = 'cmo'`,
      ["comp-1"],
    );
    expect(agent.reports_to).toBe(cmo!.id);
  });

  it("auto-creates cron task when specialist is activated", () => {
    tm.activate_agent("comp-1", "seo-specialist");

    const cron = db.get<{ title: string; schedule: string; prompt: string; enabled: number; created_by: string }>(
      `SELECT title, schedule, prompt, enabled, created_by FROM cron_tasks WHERE company_id = ? AND agent_id IN (SELECT id FROM agents WHERE blueprint_id = 'seo-specialist' AND company_id = ?)`,
      ["comp-1", "comp-1"],
    );
    expect(cron).toBeDefined();
    expect(cron!.title).toBe("SEO Self-Update Scan");
    expect(cron!.schedule).toBe("0 7 * * *");
    expect(cron!.enabled).toBe(1);
    expect(cron!.created_by).toBe("system");
    expect(cron!.prompt).toContain("daily self-update scan");
  });

  it("does NOT create cron for founding agent activation", () => {
    // frontend-dev is a founding blueprint, should not get auto-cron
    tm.activate_agent("comp-1", "frontend-dev");

    const cron = db.get<{ id: string }>(
      `SELECT id FROM cron_tasks WHERE company_id = ?`,
      ["comp-1"],
    );
    expect(cron).toBeUndefined();
  });

  it("does not create duplicate cron on re-activation", () => {
    tm.activate_agent("comp-1", "seo-specialist");
    // activate again — should return existing agent, not duplicate cron
    tm.activate_agent("comp-1", "seo-specialist");

    const crons = db.all<{ id: string }>(
      `SELECT id FROM cron_tasks WHERE company_id = ?`,
      ["comp-1"],
    );
    expect(crons.length).toBe(1);
  });

  describe("ingest_plan allows specialist agents", () => {
    it("activates specialist agent from agents_needed", () => {
      // Seed a milestone table to keep ingest_plan happy
      tm.ingest_plan("comp-1", {
        milestones: [],
        agents_needed: ["seo-specialist", "frontend-dev"],
      });

      const seo = db.get<{ id: string; blueprint_id: string }>(
        `SELECT id, blueprint_id FROM agents WHERE company_id = ? AND blueprint_id = 'seo-specialist'`,
        ["comp-1"],
      );
      expect(seo).toBeDefined();
    });
  });

  describe("validate_and_insert_task allows specialist assigned_to", () => {
    it("assigns task to specialist agent", () => {
      // First activate the specialist
      tm.activate_agent("comp-1", "seo-specialist");

      // Create a milestone
      const milestoneId = tm.generate_id("ms");
      db.run(
        `INSERT INTO milestones (id, company_id, title, description, status, sort_order, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [milestoneId, "comp-1", "M1", "Test", "active", 0, "ceo", isoNow()],
      );

      const ceoId = `agent-ceo-comp-1`;

      // Insert a task assigned to the specialist
      const taskId = tm.validate_and_insert_task("comp-1", {
        title: "SEO Audit",
        description: "Run SEO audit",
        assigned_to: "seo-specialist",
        depends_on: [],
        acceptance_criteria: [],
      }, { milestone_id: milestoneId, created_by: ceoId });

      const task = db.get<{ owner_agent_id: string }>(
        `SELECT owner_agent_id FROM tasks WHERE id = ?`,
        [taskId],
      );
      const seoAgent = db.get<{ id: string }>(
        `SELECT id FROM agents WHERE company_id = ? AND blueprint_id = 'seo-specialist'`,
        ["comp-1"],
      );
      expect(task!.owner_agent_id).toBe(seoAgent!.id);
    });
  });
});
