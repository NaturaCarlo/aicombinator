import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentRow, TaskRow } from "../../supervisor/src/types.ts";

// Mock blueprints module to avoid loading real blueprint files
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
      "frontend-dev": {
        id: "frontend-dev",
        name: "Frontend Dev",
        role: "developer",
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
    };
    return blueprints[id] ?? null;
  }),
  getAllBlueprints: vi.fn(() => []),
  getAllSpecialistBlueprints: vi.fn(() => []),
  FOUNDING_BLUEPRINTS: ["ceo", "cto", "cmo", "frontend-dev", "backend-dev", "qa-tester"],
}));

// Mock routing to allow all assignments
vi.mock("../../supervisor/src/routing.ts", () => ({
  canAssignTo: vi.fn(() => true),
  getReportTarget: vi.fn(() => "ceo"),
}));

import { SupervisorDb } from "../../supervisor/src/db.ts";
import { TaskManager } from "../../supervisor/src/task-manager.ts";
import { build_task_prompt } from "../../supervisor/src/agent-runner.ts";

describe("Goal Hierarchy - parent_task_id support", () => {
  let db: SupervisorDb;
  let tm: TaskManager;

  beforeEach(() => {
    // Use in-memory DB for tests
    db = new SupervisorDb(":memory:");
    db.migrate();
    tm = new TaskManager(db);

    // Seed a company
    db.run(
      `INSERT INTO companies (id, user_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["company_1", "user_1", "Test Co", "running", new Date().toISOString(), new Date().toISOString()],
    );

    // Seed a milestone
    db.run(
      `INSERT INTO milestones (id, company_id, title, sort_order, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["milestone_1", "company_1", "Test Milestone", 0, "active", "system", new Date().toISOString()],
    );

    // Seed agents
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["agent_ceo", "company_1", "ceo", "CEO", "ceo", "sonnet", "idle", 0, "internal", new Date().toISOString(), new Date().toISOString()],
    );
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["agent_cto", "company_1", "cto", "CTO", "cto", "sonnet", "idle", 0, "internal", new Date().toISOString(), new Date().toISOString()],
    );
    db.run(
      `INSERT INTO agents (id, company_id, blueprint_id, name, role, model_tier, status, total_credits, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["agent_fe", "company_1", "frontend-dev", "Frontend Dev", "developer", "sonnet", "idle", 0, "internal", new Date().toISOString(), new Date().toISOString()],
    );
  });

  describe("supervisor tasks table has parent_task_id column", () => {
    it("creates tasks with parent_task_id NULL by default", () => {
      const taskId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Build homepage",
          description: "Create the homepage",
          assigned_to: "frontend-dev",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/site/index.html" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo" },
      );

      const task = tm.get_task(taskId);
      expect(task).toBeDefined();
      expect(task!.parent_task_id).toBeNull();
    });

    it("creates tasks with parent_task_id when specified", () => {
      // Create parent task
      const parentId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Engineering Goal",
          description: "Complete all engineering tasks",
          assigned_to: "cto",
          depends_on: [],
          acceptance_criteria: [{ type: "custom", description: "All subtasks done" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo" },
      );

      // Create child task with parent_task_id
      const childId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Build frontend",
          description: "Create the frontend",
          assigned_to: "frontend-dev",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/site/index.html" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_cto", parent_task_id: parentId },
      );

      const child = tm.get_task(childId);
      expect(child).toBeDefined();
      expect(child!.parent_task_id).toBe(parentId);
    });
  });

  describe("FounderVisibleTask includes parent_task_id field (VAL-GOAL-001)", () => {
    it("supervisor tasks include parent_task_id in SELECT *", () => {
      // Create parent
      const parentId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Goal A",
          description: "Top-level goal",
          assigned_to: "cto",
          depends_on: [],
          acceptance_criteria: [{ type: "custom", description: "Done" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo" },
      );

      // Create child
      const childId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Subtask A1",
          description: "Subtask of Goal A",
          assigned_to: "frontend-dev",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/a1.txt" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_cto", parent_task_id: parentId },
      );

      // Fetch via get_tasks (used by founder-state)
      const tasks = tm.get_tasks("company_1");
      const childTask = tasks.find((t) => t.id === childId);

      expect(childTask).toBeDefined();
      expect(childTask!.parent_task_id).toBe(parentId);

      // Parent task should have null parent_task_id
      const parentTask = tasks.find((t) => t.id === parentId);
      expect(parentTask).toBeDefined();
      expect(parentTask!.parent_task_id).toBeNull();
    });
  });

  describe("goal hierarchy data in founder-state API (VAL-GOAL-003)", () => {
    it("tasks with parent-child relationships expressed via parent_task_id", () => {
      // Create two-level hierarchy
      const goalId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Shipping Goal",
          description: "Ship the product",
          assigned_to: "cto",
          depends_on: [],
          acceptance_criteria: [{ type: "custom", description: "Product shipped" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo" },
      );

      const subtask1Id = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Build API",
          description: "Build the REST API",
          assigned_to: "cto",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/api.ts" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo", parent_task_id: goalId },
      );

      const subtask2Id = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Build UI",
          description: "Build the user interface",
          assigned_to: "frontend-dev",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/ui.html" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo", parent_task_id: goalId },
      );

      const tasks = tm.get_tasks("company_1");

      // At least one task has non-null parent_task_id matching another task's id
      const childTasks = tasks.filter((t) => t.parent_task_id !== null);
      expect(childTasks.length).toBeGreaterThanOrEqual(2);

      for (const child of childTasks) {
        expect(child.parent_task_id).toBe(goalId);
        // Ensure parent exists
        const parent = tasks.find((t) => t.id === child.parent_task_id);
        expect(parent).toBeDefined();
      }
    });
  });

  describe("agent prompts include goal ancestry (VAL-GOAL-004)", () => {
    it("includes parent task title and description in prompt for child tasks", () => {
      // Create parent
      const parentId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Launch Marketing Campaign",
          description: "Execute full marketing campaign for product launch",
          assigned_to: "cto",
          depends_on: [],
          acceptance_criteria: [{ type: "custom", description: "Campaign launched" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo" },
      );

      // Create child
      const childId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Write social media copy",
          description: "Write 5 social media posts",
          assigned_to: "frontend-dev",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/social.md" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_cto", parent_task_id: parentId },
      );

      const agent = tm.get_agent("agent_fe") as AgentRow;
      const task = tm.get_task(childId) as TaskRow;

      const prompt = build_task_prompt(agent, task, tm, "/tmp/workspace");

      // Prompt should contain goal ancestry section
      expect(prompt).toContain("Goal Ancestry");
      expect(prompt).toContain("Launch Marketing Campaign");
      expect(prompt).toContain("Execute full marketing campaign for product launch");
    });

    it("includes multi-level goal ancestry in prompt", () => {
      // Create grandparent
      const grandparentId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Company OKR: Ship v1",
          description: "Ship version 1 of the product",
          assigned_to: "cto",
          depends_on: [],
          acceptance_criteria: [{ type: "custom", description: "v1 shipped" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo" },
      );

      // Create parent
      const parentId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Build Frontend Module",
          description: "Create the frontend components",
          assigned_to: "cto",
          depends_on: [],
          acceptance_criteria: [{ type: "custom", description: "Frontend done" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo", parent_task_id: grandparentId },
      );

      // Create child
      const childId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Implement login page",
          description: "Create the login page component",
          assigned_to: "frontend-dev",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/login.tsx" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_cto", parent_task_id: parentId },
      );

      const agent = tm.get_agent("agent_fe") as AgentRow;
      const task = tm.get_task(childId) as TaskRow;

      const prompt = build_task_prompt(agent, task, tm, "/tmp/workspace");

      // Should include both levels of ancestry
      expect(prompt).toContain("Goal Ancestry");
      expect(prompt).toContain("Company OKR: Ship v1");
      expect(prompt).toContain("Build Frontend Module");
      expect(prompt).toContain("broader context");
    });

    it("does not include goal ancestry for top-level tasks", () => {
      const taskId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Top-level task",
          description: "No parent",
          assigned_to: "frontend-dev",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/top.txt" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo" },
      );

      const agent = tm.get_agent("agent_fe") as AgentRow;
      const task = tm.get_task(taskId) as TaskRow;

      const prompt = build_task_prompt(agent, task, tm, "/tmp/workspace");

      expect(prompt).not.toContain("Goal Ancestry");
    });
  });

  describe("sync propagates parent_task_id", () => {
    it("enqueue_sync includes parent_task_id in task payload", () => {
      const parentId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Parent Goal",
          description: "Top goal",
          assigned_to: "cto",
          depends_on: [],
          acceptance_criteria: [{ type: "custom", description: "Done" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_ceo" },
      );

      const childId = tm.validate_and_insert_task(
        "company_1",
        {
          title: "Child Task",
          description: "Subtask",
          assigned_to: "frontend-dev",
          depends_on: [],
          acceptance_criteria: [{ type: "file_exists", path: "/workspace/child.txt" }],
        },
        { milestone_id: "milestone_1", created_by: "agent_cto", parent_task_id: parentId },
      );

      // Check sync queue has the child task with parent_task_id
      const syncItems = db.get_pending_sync_items(100);
      const childSync = syncItems.find(
        (item) => item.table_name === "tasks" && item.record_id === childId,
      );
      expect(childSync).toBeDefined();

      const payload = JSON.parse(childSync!.payload) as Record<string, unknown>;
      expect(payload.parent_task_id).toBe(parentId);
    });
  });
});
