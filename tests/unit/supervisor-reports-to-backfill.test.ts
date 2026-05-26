import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentRow } from "../../supervisor/src/types.ts";

// Mock blueprints module
vi.mock("../../supervisor/src/blueprints.ts", () => ({
  getBlueprint: vi.fn((id: string) => {
    const blueprints: Record<string, unknown> = {
      ceo: {
        id: "ceo",
        name: "CEO",
        role: "ceo",
        title: "Chief Executive Officer",
        department: "executive",
        reportsTo: "",
        systemPrompt: "You are the CEO.",
        skills: [],
        workflows: [],
        requiredTools: [],
        requiredApiKeys: [],
        mcpServers: [],
        relayChannels: [],
        provider: "claude",
        modelTier: "sonnet",
        estimatedCreditsPerDay: 100,
        tested: true,
        version: "1.0.0",
        description: "CEO agent",
      },
      cto: {
        id: "cto",
        name: "CTO",
        role: "cto",
        title: "Chief Technology Officer",
        department: "engineering",
        reportsTo: "ceo",
        systemPrompt: "You are the CTO.",
        skills: [],
        workflows: [],
        requiredTools: [],
        requiredApiKeys: [],
        mcpServers: [],
        relayChannels: [],
        provider: "claude",
        modelTier: "sonnet",
        estimatedCreditsPerDay: 100,
        tested: true,
        version: "1.0.0",
        description: "CTO agent",
      },
      cmo: {
        id: "cmo",
        name: "CMO",
        role: "cmo",
        title: "Chief Marketing Officer",
        department: "marketing",
        reportsTo: "ceo",
        systemPrompt: "You are the CMO.",
        skills: [],
        workflows: [],
        requiredTools: [],
        requiredApiKeys: [],
        mcpServers: [],
        relayChannels: [],
        provider: "claude",
        modelTier: "sonnet",
        estimatedCreditsPerDay: 100,
        tested: true,
        version: "1.0.0",
        description: "CMO agent",
      },
      "frontend-dev": {
        id: "frontend-dev",
        name: "Frontend Dev",
        role: "specialist",
        title: "Frontend Developer",
        department: "engineering",
        reportsTo: "cto",
        systemPrompt: "You are the Frontend Dev.",
        skills: [],
        workflows: [],
        requiredTools: [],
        requiredApiKeys: [],
        mcpServers: [],
        relayChannels: [],
        provider: "claude",
        modelTier: "sonnet",
        estimatedCreditsPerDay: 100,
        tested: true,
        version: "1.0.0",
        description: "Frontend Dev agent",
      },
      "backend-dev": {
        id: "backend-dev",
        name: "Backend Dev",
        role: "specialist",
        title: "Backend Developer",
        department: "engineering",
        reportsTo: "cto",
        systemPrompt: "You are the Backend Dev.",
        skills: [],
        workflows: [],
        requiredTools: [],
        requiredApiKeys: [],
        mcpServers: [],
        relayChannels: [],
        provider: "claude",
        modelTier: "sonnet",
        estimatedCreditsPerDay: 100,
        tested: true,
        version: "1.0.0",
        description: "Backend Dev agent",
      },
      "qa-tester": {
        id: "qa-tester",
        name: "QA Tester",
        role: "specialist",
        title: "QA Engineer",
        department: "engineering",
        reportsTo: "cto",
        systemPrompt: "You are the QA Tester.",
        skills: [],
        workflows: [],
        requiredTools: [],
        requiredApiKeys: [],
        mcpServers: [],
        relayChannels: [],
        provider: "claude",
        modelTier: "sonnet",
        estimatedCreditsPerDay: 100,
        tested: true,
        version: "1.0.0",
        description: "QA Tester agent",
      },
    };
    return blueprints[id] ?? null;
  }),
  getAllBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"],
  isSpecialistBlueprint: vi.fn(() => false),
  SPECIALIST_BLUEPRINTS: new Set(),
  getAllSpecialistBlueprints: vi.fn(() => []),
}));

// Mock routing to allow all assignments
vi.mock("../../supervisor/src/routing.ts", () => ({
  canAssignTo: vi.fn(() => true),
  getReportTarget: vi.fn(() => "ceo"),
}));

import { SupervisorDb } from "../../supervisor/src/db.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";

describe("Agent reports_to from blueprints", () => {
  let db: SupervisorDb;
  let tm: TaskManager;

  beforeEach(() => {
    db = new SupervisorDb(":memory:");
    db.migrate();
    tm = new TaskManager(db);

    // Seed a company
    db.run(
      `INSERT INTO companies (id, user_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["company_1", "user_1", "Test Co", "running", new Date().toISOString(), new Date().toISOString()],
    );
  });

  describe("activate_agent resolves reports_to from blueprint", () => {
    it("sets reports_to to null for CEO (no reportsTo in blueprint)", () => {
      const ceo = tm.activate_agent("company_1", "ceo");
      expect(ceo.reports_to).toBeNull();
    });

    it("sets reports_to to CEO UUID when activating CTO after CEO exists", () => {
      const ceo = tm.activate_agent("company_1", "ceo");
      const cto = tm.activate_agent("company_1", "cto");

      expect(cto.reports_to).toBe(ceo.id);

      // Verify it's persisted in the database
      const ctoFromDb = tm.get_agent(cto.id);
      expect(ctoFromDb?.reports_to).toBe(ceo.id);
    });

    it("sets reports_to to CEO UUID when activating CMO after CEO exists", () => {
      const ceo = tm.activate_agent("company_1", "ceo");
      const cmo = tm.activate_agent("company_1", "cmo");

      expect(cmo.reports_to).toBe(ceo.id);
    });

    it("sets reports_to to CTO UUID when activating frontend-dev after CTO exists", () => {
      tm.activate_agent("company_1", "ceo");
      const cto = tm.activate_agent("company_1", "cto");
      const frontendDev = tm.activate_agent("company_1", "frontend-dev");

      expect(frontendDev.reports_to).toBe(cto.id);
    });

    it("sets reports_to to CTO UUID when activating backend-dev after CTO exists", () => {
      tm.activate_agent("company_1", "ceo");
      const cto = tm.activate_agent("company_1", "cto");
      const backendDev = tm.activate_agent("company_1", "backend-dev");

      expect(backendDev.reports_to).toBe(cto.id);
    });

    it("sets reports_to to CTO UUID when activating qa-tester after CTO exists", () => {
      tm.activate_agent("company_1", "ceo");
      const cto = tm.activate_agent("company_1", "cto");
      const qaTester = tm.activate_agent("company_1", "qa-tester");

      expect(qaTester.reports_to).toBe(cto.id);
    });

    it("sets reports_to to null when parent agent does not exist yet", () => {
      // Activate CTO before CEO — parent does not exist
      const cto = tm.activate_agent("company_1", "cto");
      expect(cto.reports_to).toBeNull();
    });

    it("includes reports_to in the sync queue payload", () => {
      const ceo = tm.activate_agent("company_1", "ceo");
      const cto = tm.activate_agent("company_1", "cto");

      const syncItems = db.get_pending_sync_items(100);
      const ctoSync = syncItems.find(
        (item) => item.table_name === "agents" && item.record_id === cto.id,
      );
      expect(ctoSync).toBeDefined();

      const payload = JSON.parse(ctoSync!.payload) as Record<string, unknown>;
      expect(payload.reports_to).toBe(ceo.id);
    });

    it("returns existing agent without modifying it on second activate call", () => {
      const ceo = tm.activate_agent("company_1", "ceo");
      const cto1 = tm.activate_agent("company_1", "cto");
      const cto2 = tm.activate_agent("company_1", "cto");

      expect(cto1.id).toBe(cto2.id);
    });
  });

  describe("backfill_reports_to", () => {
    it("backfills null reports_to for agents with blueprint reportsTo", () => {
      const now = new Date().toISOString();

      // Manually insert agents with null reports_to (simulating old behavior)
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_ceo", "company_1", "ceo", "CEO", "ceo", "sonnet", "idle", null, 0, "internal", now, now],
      );
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_cto", "company_1", "cto", "CTO", "cto", "sonnet", "idle", null, 0, "internal", now, now],
      );
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_cmo", "company_1", "cmo", "CMO", "cmo", "sonnet", "idle", null, 0, "internal", now, now],
      );
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_fe", "company_1", "frontend-dev", "Frontend Dev", "specialist", "sonnet", "idle", null, 0, "internal", now, now],
      );

      const updated = tm.backfill_reports_to();

      // CTO → CEO, CMO → CEO, Frontend Dev → CTO = 3 updates
      expect(updated).toBe(3);

      const cto = tm.get_agent("agent_cto");
      expect(cto?.reports_to).toBe("agent_ceo");

      const cmo = tm.get_agent("agent_cmo");
      expect(cmo?.reports_to).toBe("agent_ceo");

      const fe = tm.get_agent("agent_fe");
      expect(fe?.reports_to).toBe("agent_cto");

      // CEO should still have null reports_to (no reportsTo in blueprint)
      const ceo = tm.get_agent("agent_ceo");
      expect(ceo?.reports_to).toBeNull();
    });

    it("does not update agents that already have reports_to set", () => {
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_ceo", "company_1", "ceo", "CEO", "ceo", "sonnet", "idle", null, 0, "internal", now, now],
      );
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_cto", "company_1", "cto", "CTO", "cto", "sonnet", "idle", "agent_ceo", 0, "internal", now, now],
      );

      const updated = tm.backfill_reports_to();
      expect(updated).toBe(0);
    });

    it("does not update agents without a blueprint_id", () => {
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_external", "company_1", null, "External Agent", "specialist", "sonnet", "idle", null, 0, "external", now, now],
      );

      const updated = tm.backfill_reports_to();
      expect(updated).toBe(0);
    });

    it("handles agents whose parent blueprint agent does not exist yet", () => {
      const now = new Date().toISOString();

      // CTO without CEO — can't resolve parent
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_cto", "company_1", "cto", "CTO", "cto", "sonnet", "idle", null, 0, "internal", now, now],
      );

      const updated = tm.backfill_reports_to();
      expect(updated).toBe(0);
    });

    it("syncs backfilled reports_to to D1 via sync_queue", () => {
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_ceo", "company_1", "ceo", "CEO", "ceo", "sonnet", "idle", null, 0, "internal", now, now],
      );
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_cto", "company_1", "cto", "CTO", "cto", "sonnet", "idle", null, 0, "internal", now, now],
      );

      tm.backfill_reports_to();

      const syncItems = db.get_pending_sync_items(100);
      const ctoSync = syncItems.find(
        (item) => item.table_name === "agents" && item.record_id === "agent_cto",
      );
      expect(ctoSync).toBeDefined();

      const payload = JSON.parse(ctoSync!.payload) as Record<string, unknown>;
      expect(payload.reports_to).toBe("agent_ceo");
    });

    it("backfills across multiple companies", () => {
      const now = new Date().toISOString();

      // Seed second company
      db.run(
        `INSERT INTO companies (id, user_id, name, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["company_2", "user_2", "Test Co 2", "running", now, now],
      );

      // Company 1 agents
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["c1_ceo", "company_1", "ceo", "CEO", "ceo", "sonnet", "idle", null, 0, "internal", now, now],
      );
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["c1_cto", "company_1", "cto", "CTO", "cto", "sonnet", "idle", null, 0, "internal", now, now],
      );

      // Company 2 agents
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["c2_ceo", "company_2", "ceo", "CEO", "ceo", "sonnet", "idle", null, 0, "internal", now, now],
      );
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["c2_cto", "company_2", "cto", "CTO", "cto", "sonnet", "idle", null, 0, "internal", now, now],
      );

      const updated = tm.backfill_reports_to();
      expect(updated).toBe(2);

      // Company 1 CTO reports to company 1 CEO
      const c1Cto = tm.get_agent("c1_cto");
      expect(c1Cto?.reports_to).toBe("c1_ceo");

      // Company 2 CTO reports to company 2 CEO (not company 1 CEO!)
      const c2Cto = tm.get_agent("c2_cto");
      expect(c2Cto?.reports_to).toBe("c2_ceo");
    });

    it("is idempotent — running twice does not double-update", () => {
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_ceo", "company_1", "ceo", "CEO", "ceo", "sonnet", "idle", null, 0, "internal", now, now],
      );
      db.run(
        `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, reports_to, total_credits, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent_cto", "company_1", "cto", "CTO", "cto", "sonnet", "idle", null, 0, "internal", now, now],
      );

      const first = tm.backfill_reports_to();
      expect(first).toBe(1);

      const second = tm.backfill_reports_to();
      expect(second).toBe(0);
    });
  });

  describe("full hierarchy activation order", () => {
    it("activating all founding agents in order sets correct hierarchy", () => {
      const ceo = tm.activate_agent("company_1", "ceo");
      const cto = tm.activate_agent("company_1", "cto");
      const cmo = tm.activate_agent("company_1", "cmo");
      const fe = tm.activate_agent("company_1", "frontend-dev");
      const be = tm.activate_agent("company_1", "backend-dev");
      const qa = tm.activate_agent("company_1", "qa-tester");

      // CEO has no manager
      expect(ceo.reports_to).toBeNull();

      // CTO and CMO report to CEO
      expect(cto.reports_to).toBe(ceo.id);
      expect(cmo.reports_to).toBe(ceo.id);

      // Devs and QA report to CTO
      expect(fe.reports_to).toBe(cto.id);
      expect(be.reports_to).toBe(cto.id);
      expect(qa.reports_to).toBe(cto.id);
    });
  });
});
