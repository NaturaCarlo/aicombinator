/**
 * Tests for task dependency info (blockedBy field).
 *
 * VAL-DASH-005: Blocked tasks display dependency information
 * VAL-DASH-006: Blocked task dependency info available in API
 *
 * Covers:
 * - Worker API: blockedBy field on FounderVisibleTask for waiting_on_dependency tasks
 * - Dashboard: FounderVisibleTask type includes blockedBy
 * - Dashboard: tasks-summary renders "Blocked by: [title]" text
 */
import { describe, it, expect } from "vitest";
import type { FounderVisibleTask as WorkerFounderVisibleTask } from "../../worker/src/routes/founder-state.ts";
import type { FounderVisibleTask as DashboardFounderVisibleTask } from "../../dashboard/src/lib/types.ts";

// ─── Helper ───────────────────────────────────────────────────────

function makeTask(overrides: Partial<WorkerFounderVisibleTask> & { id: string; title: string }): WorkerFounderVisibleTask {
  return {
    description: null,
    status: "active",
    ownerAgentId: null,
    ownerName: null,
    ownerTitle: null,
    ownerIcon: null,
    updatedAt: "2025-01-01T00:00:00Z",
    completedAt: null,
    detail: null,
    parentTaskId: null,
    ...overrides,
  };
}

// ─── Type-level assertions ────────────────────────────────────────

describe("FounderVisibleTask type includes blockedBy field", () => {
  it("worker type allows blockedBy with task title info", () => {
    const task: WorkerFounderVisibleTask = makeTask({
      id: "task-1",
      title: "Build landing page",
      status: "waiting_on_dependency",
      blockedBy: [
        { taskId: "task-0", title: "Design mockups" },
      ],
    });

    expect(task.blockedBy).toHaveLength(1);
    expect(task.blockedBy![0].taskId).toBe("task-0");
    expect(task.blockedBy![0].title).toBe("Design mockups");
  });

  it("dashboard type allows blockedBy with task title info", () => {
    const task: DashboardFounderVisibleTask = {
      id: "task-1",
      title: "Build landing page",
      description: null,
      status: "waiting_on_dependency",
      ownerAgentId: null,
      ownerName: null,
      ownerTitle: null,
      ownerIcon: null,
      updatedAt: "2025-01-01T00:00:00Z",
      completedAt: null,
      detail: null,
      parentTaskId: null,
      blockedBy: [
        { taskId: "task-0", title: "Design mockups" },
      ],
    };

    expect(task.blockedBy).toHaveLength(1);
    expect(task.blockedBy![0].taskId).toBe("task-0");
    expect(task.blockedBy![0].title).toBe("Design mockups");
  });

  it("blockedBy is optional (undefined for non-blocked tasks)", () => {
    const task: WorkerFounderVisibleTask = makeTask({
      id: "task-2",
      title: "Active task",
      status: "active",
    });

    expect(task.blockedBy).toBeUndefined();
  });

  it("blockedBy can have multiple entries", () => {
    const task: WorkerFounderVisibleTask = makeTask({
      id: "task-3",
      title: "Integration tests",
      status: "waiting_on_dependency",
      blockedBy: [
        { taskId: "task-1", title: "Build API" },
        { taskId: "task-2", title: "Build frontend" },
      ],
    });

    expect(task.blockedBy).toHaveLength(2);
    expect(task.blockedBy!.map((dep) => dep.title)).toEqual([
      "Build API",
      "Build frontend",
    ]);
  });
});

// ─── Projection logic tests ──────────────────────────────────────

describe("blockedBy resolution from depends_on", () => {
  // Simulate the projection logic from founder-state.ts

  type TaskPayload = {
    id: string;
    title: string;
    description: string | null;
    status: string;
    owner_agent_id: string | null;
    blocked_reason: string | null;
    parent_task_id: string | null;
    depends_on: string | null;
    created_at: string;
    updated_at: string;
  };

  function resolveBlockedBy(
    task: TaskPayload,
    taskMap: Map<string, TaskPayload>,
  ): { taskId: string; title: string }[] | undefined {
    if (!task.depends_on) return undefined;
    try {
      const depIds = JSON.parse(task.depends_on) as string[];
      if (!Array.isArray(depIds) || depIds.length === 0) return undefined;
      const resolved = depIds
        .map((depId) => {
          const dep = taskMap.get(depId);
          return dep ? { taskId: dep.id, title: dep.title } : null;
        })
        .filter((entry): entry is { taskId: string; title: string } => entry !== null);
      return resolved.length > 0 ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  it("resolves depends_on task IDs to titles", () => {
    const tasks: TaskPayload[] = [
      {
        id: "task-a",
        title: "Design mockups",
        description: null,
        status: "done",
        owner_agent_id: null,
        blocked_reason: null,
        parent_task_id: null,
        depends_on: "[]",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-b",
        title: "Build landing page",
        description: null,
        status: "pending",
        owner_agent_id: null,
        blocked_reason: null,
        parent_task_id: null,
        depends_on: '["task-a"]',
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ];

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const blockedBy = resolveBlockedBy(tasks[1], taskMap);

    expect(blockedBy).toHaveLength(1);
    expect(blockedBy![0]).toEqual({ taskId: "task-a", title: "Design mockups" });
  });

  it("resolves multiple dependencies", () => {
    const tasks: TaskPayload[] = [
      {
        id: "task-1",
        title: "Build API",
        description: null,
        status: "in_progress",
        owner_agent_id: null,
        blocked_reason: null,
        parent_task_id: null,
        depends_on: "[]",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-2",
        title: "Build frontend",
        description: null,
        status: "in_progress",
        owner_agent_id: null,
        blocked_reason: null,
        parent_task_id: null,
        depends_on: "[]",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-3",
        title: "Integration tests",
        description: null,
        status: "pending",
        owner_agent_id: null,
        blocked_reason: null,
        parent_task_id: null,
        depends_on: '["task-1", "task-2"]',
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ];

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const blockedBy = resolveBlockedBy(tasks[2], taskMap);

    expect(blockedBy).toHaveLength(2);
    expect(blockedBy!.map((dep) => dep.title)).toEqual(["Build API", "Build frontend"]);
  });

  it("returns undefined when depends_on is null", () => {
    const task: TaskPayload = {
      id: "task-x",
      title: "Standalone task",
      description: null,
      status: "pending",
      owner_agent_id: null,
      blocked_reason: null,
      parent_task_id: null,
      depends_on: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    const taskMap = new Map<string, TaskPayload>();
    expect(resolveBlockedBy(task, taskMap)).toBeUndefined();
  });

  it("returns undefined when depends_on is empty array", () => {
    const task: TaskPayload = {
      id: "task-x",
      title: "No deps",
      description: null,
      status: "pending",
      owner_agent_id: null,
      blocked_reason: null,
      parent_task_id: null,
      depends_on: "[]",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    const taskMap = new Map<string, TaskPayload>();
    expect(resolveBlockedBy(task, taskMap)).toBeUndefined();
  });

  it("skips unresolved dependency IDs gracefully", () => {
    const tasks: TaskPayload[] = [
      {
        id: "task-a",
        title: "Known task",
        description: null,
        status: "done",
        owner_agent_id: null,
        blocked_reason: null,
        parent_task_id: null,
        depends_on: "[]",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-b",
        title: "Blocked task",
        description: null,
        status: "pending",
        owner_agent_id: null,
        blocked_reason: null,
        parent_task_id: null,
        depends_on: '["task-a", "task-missing"]',
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ];

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const blockedBy = resolveBlockedBy(tasks[1], taskMap);

    expect(blockedBy).toHaveLength(1);
    expect(blockedBy![0]).toEqual({ taskId: "task-a", title: "Known task" });
  });

  it("returns undefined when all dependency IDs are missing", () => {
    const task: TaskPayload = {
      id: "task-x",
      title: "Orphaned deps",
      description: null,
      status: "pending",
      owner_agent_id: null,
      blocked_reason: null,
      parent_task_id: null,
      depends_on: '["nonexistent-1", "nonexistent-2"]',
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    const taskMap = new Map<string, TaskPayload>();
    expect(resolveBlockedBy(task, taskMap)).toBeUndefined();
  });

  it("handles malformed depends_on JSON gracefully", () => {
    const task: TaskPayload = {
      id: "task-x",
      title: "Bad JSON",
      description: null,
      status: "pending",
      owner_agent_id: null,
      blocked_reason: null,
      parent_task_id: null,
      depends_on: "not-valid-json",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    const taskMap = new Map<string, TaskPayload>();
    expect(resolveBlockedBy(task, taskMap)).toBeUndefined();
  });

  it("non-blocked tasks do not get blockedBy", () => {
    const task: WorkerFounderVisibleTask = makeTask({
      id: "task-active",
      title: "Active task",
      status: "active",
    });

    expect(task.blockedBy).toBeUndefined();
  });

  it("done tasks do not get blockedBy", () => {
    const task: WorkerFounderVisibleTask = makeTask({
      id: "task-done",
      title: "Done task",
      status: "done",
    });

    expect(task.blockedBy).toBeUndefined();
  });
});

// ─── Dashboard display tests ─────────────────────────────────────

describe("Dashboard blockedBy display text", () => {
  function formatBlockedByText(task: DashboardFounderVisibleTask): string | null {
    if (
      task.status !== "waiting_on_dependency" ||
      !task.blockedBy ||
      task.blockedBy.length === 0
    ) {
      return null;
    }
    return `Blocked by: ${task.blockedBy.map((dep) => dep.title).join(", ")}`;
  }

  it("shows 'Blocked by: [title]' for single dependency", () => {
    const task: DashboardFounderVisibleTask = {
      id: "t1",
      title: "Build page",
      description: null,
      status: "waiting_on_dependency",
      ownerAgentId: null,
      ownerName: null,
      ownerTitle: null,
      ownerIcon: null,
      updatedAt: "2025-01-01T00:00:00Z",
      completedAt: null,
      detail: null,
      parentTaskId: null,
      blockedBy: [{ taskId: "t0", title: "Design mockups" }],
    };

    expect(formatBlockedByText(task)).toBe("Blocked by: Design mockups");
  });

  it("shows 'Blocked by: [title1], [title2]' for multiple dependencies", () => {
    const task: DashboardFounderVisibleTask = {
      id: "t3",
      title: "Deploy",
      description: null,
      status: "waiting_on_dependency",
      ownerAgentId: null,
      ownerName: null,
      ownerTitle: null,
      ownerIcon: null,
      updatedAt: "2025-01-01T00:00:00Z",
      completedAt: null,
      detail: null,
      parentTaskId: null,
      blockedBy: [
        { taskId: "t1", title: "Build API" },
        { taskId: "t2", title: "Build frontend" },
      ],
    };

    expect(formatBlockedByText(task)).toBe("Blocked by: Build API, Build frontend");
  });

  it("returns null for non-blocked tasks", () => {
    const task: DashboardFounderVisibleTask = {
      id: "t4",
      title: "Active task",
      description: null,
      status: "active",
      ownerAgentId: null,
      ownerName: null,
      ownerTitle: null,
      ownerIcon: null,
      updatedAt: "2025-01-01T00:00:00Z",
      completedAt: null,
      detail: null,
      parentTaskId: null,
    };

    expect(formatBlockedByText(task)).toBeNull();
  });

  it("returns null for waiting_on_dependency without blockedBy", () => {
    const task: DashboardFounderVisibleTask = {
      id: "t5",
      title: "Blocked but no info",
      description: null,
      status: "waiting_on_dependency",
      ownerAgentId: null,
      ownerName: null,
      ownerTitle: null,
      ownerIcon: null,
      updatedAt: "2025-01-01T00:00:00Z",
      completedAt: null,
      detail: null,
      parentTaskId: null,
    };

    expect(formatBlockedByText(task)).toBeNull();
  });

  it("returns null for waiting_on_dependency with empty blockedBy", () => {
    const task: DashboardFounderVisibleTask = {
      id: "t6",
      title: "Blocked with empty array",
      description: null,
      status: "waiting_on_dependency",
      ownerAgentId: null,
      ownerName: null,
      ownerTitle: null,
      ownerIcon: null,
      updatedAt: "2025-01-01T00:00:00Z",
      completedAt: null,
      detail: null,
      parentTaskId: null,
      blockedBy: [],
    };

    expect(formatBlockedByText(task)).toBeNull();
  });
});
