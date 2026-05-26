import { describe, it, expect } from "vitest";
import {
  buildHierarchy,
  buildHierarchyWithProgress,
  getBreadcrumbTrail,
} from "../../dashboard/src/lib/task-hierarchy";
import type { FounderVisibleTask } from "../../dashboard/src/lib/types";

// ─── Test fixtures ────────────────────────────────────────────────

function makeTask(overrides: Partial<FounderVisibleTask> & { id: string; title: string }): FounderVisibleTask {
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

// ─── Tests ────────────────────────────────────────────────────────

describe("Goal Tree: buildHierarchy", () => {
  it("returns empty array for empty tasks", () => {
    expect(buildHierarchy([])).toHaveLength(0);
  });

  it("treats tasks without parentTaskId as top-level", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1" }),
      makeTask({ id: "t2", title: "Task 2" }),
    ];
    const result = buildHierarchy(tasks);
    expect(result).toHaveLength(2);
    expect(result[0].children).toHaveLength(0);
    expect(result[1].children).toHaveLength(0);
  });

  it("groups children under parent tasks", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "child-1", title: "Child 1", parentTaskId: "goal-1" }),
      makeTask({ id: "child-2", title: "Child 2", parentTaskId: "goal-1" }),
    ];
    const result = buildHierarchy(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].task.id).toBe("goal-1");
    expect(result[0].children).toHaveLength(2);
  });

  it("treats task with parentTaskId referencing non-existent parent as top-level", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1", parentTaskId: "non-existent" }),
    ];
    const result = buildHierarchy(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].task.id).toBe("t1");
    expect(result[0].children).toHaveLength(0);
  });

  it("sorts children by status order then by date descending", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({
        id: "child-done",
        title: "Done Child",
        parentTaskId: "goal-1",
        status: "done",
        updatedAt: "2025-01-02T00:00:00Z",
      }),
      makeTask({
        id: "child-active",
        title: "Active Child",
        parentTaskId: "goal-1",
        status: "active",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
      makeTask({
        id: "child-queued",
        title: "Queued Child",
        parentTaskId: "goal-1",
        status: "queued",
        updatedAt: "2025-01-03T00:00:00Z",
      }),
    ];
    const result = buildHierarchy(tasks);
    expect(result[0].children[0].id).toBe("child-active");
    expect(result[0].children[1].id).toBe("child-queued");
    expect(result[0].children[2].id).toBe("child-done");
  });

  it("handles multiple goals with separate children", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "goal-2", title: "Goal 2" }),
      makeTask({ id: "c1", title: "Child of Goal 1", parentTaskId: "goal-1" }),
      makeTask({ id: "c2", title: "Child of Goal 2", parentTaskId: "goal-2" }),
      makeTask({ id: "c3", title: "Another child of Goal 1", parentTaskId: "goal-1" }),
    ];
    const result = buildHierarchy(tasks);
    expect(result).toHaveLength(2);
    const goal1 = result.find((e) => e.task.id === "goal-1");
    const goal2 = result.find((e) => e.task.id === "goal-2");
    expect(goal1!.children).toHaveLength(2);
    expect(goal2!.children).toHaveLength(1);
  });

  it("handles mix of standalone tasks and goals with children", () => {
    const tasks = [
      makeTask({ id: "standalone", title: "Standalone Task" }),
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "c1", title: "Child 1", parentTaskId: "goal-1" }),
    ];
    const result = buildHierarchy(tasks);
    expect(result).toHaveLength(2);
    const standalone = result.find((e) => e.task.id === "standalone");
    const goal = result.find((e) => e.task.id === "goal-1");
    expect(standalone!.children).toHaveLength(0);
    expect(goal!.children).toHaveLength(1);
  });
});

describe("Goal Tree: buildHierarchyWithProgress", () => {
  it("calculates progress for goals with no children", () => {
    const tasks = [makeTask({ id: "goal-1", title: "Goal 1" })];
    const result = buildHierarchyWithProgress(tasks);
    expect(result[0].progress).toEqual({ done: 0, total: 0 });
  });

  it("calculates progress with all children done", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "c1", title: "Child 1", parentTaskId: "goal-1", status: "done" }),
      makeTask({ id: "c2", title: "Child 2", parentTaskId: "goal-1", status: "done" }),
      makeTask({ id: "c3", title: "Child 3", parentTaskId: "goal-1", status: "done" }),
    ];
    const result = buildHierarchyWithProgress(tasks);
    expect(result[0].progress).toEqual({ done: 3, total: 3 });
  });

  it("calculates progress with some children done", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "c1", title: "Active Child", parentTaskId: "goal-1", status: "active" }),
      makeTask({ id: "c2", title: "Done Child", parentTaskId: "goal-1", status: "done" }),
      makeTask({ id: "c3", title: "Queued Child", parentTaskId: "goal-1", status: "queued" }),
    ];
    const result = buildHierarchyWithProgress(tasks);
    expect(result[0].progress).toEqual({ done: 1, total: 3 });
  });

  it("calculates progress with no children done", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "c1", title: "Active Child", parentTaskId: "goal-1", status: "active" }),
      makeTask({ id: "c2", title: "Queued Child", parentTaskId: "goal-1", status: "queued" }),
    ];
    const result = buildHierarchyWithProgress(tasks);
    expect(result[0].progress).toEqual({ done: 0, total: 2 });
  });

  it("calculates progress independently per goal", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "goal-2", title: "Goal 2" }),
      makeTask({ id: "c1", title: "Done child G1", parentTaskId: "goal-1", status: "done" }),
      makeTask({ id: "c2", title: "Active child G1", parentTaskId: "goal-1", status: "active" }),
      makeTask({ id: "c3", title: "Done child G2", parentTaskId: "goal-2", status: "done" }),
      makeTask({ id: "c4", title: "Done child G2 (2)", parentTaskId: "goal-2", status: "done" }),
      makeTask({ id: "c5", title: "Queued child G2", parentTaskId: "goal-2", status: "queued" }),
    ];
    const result = buildHierarchyWithProgress(tasks);
    const goal1 = result.find((e) => e.task.id === "goal-1");
    const goal2 = result.find((e) => e.task.id === "goal-2");
    expect(goal1!.progress).toEqual({ done: 1, total: 2 });
    expect(goal2!.progress).toEqual({ done: 2, total: 3 });
  });

  it("standalone tasks (no children) have zero progress", () => {
    const tasks = [
      makeTask({ id: "standalone", title: "Standalone" }),
    ];
    const result = buildHierarchyWithProgress(tasks);
    expect(result[0].progress).toEqual({ done: 0, total: 0 });
  });

  it("preserves hierarchy entry structure alongside progress", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "c1", title: "Child 1", parentTaskId: "goal-1", status: "done" }),
    ];
    const result = buildHierarchyWithProgress(tasks);
    expect(result[0].task.id).toBe("goal-1");
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe("c1");
    expect(result[0].progress).toEqual({ done: 1, total: 1 });
  });

  it("counts various non-done statuses correctly", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Goal 1" }),
      makeTask({ id: "c1", title: "Active", parentTaskId: "goal-1", status: "active" }),
      makeTask({ id: "c2", title: "Queued", parentTaskId: "goal-1", status: "queued" }),
      makeTask({ id: "c3", title: "Waiting Founder", parentTaskId: "goal-1", status: "waiting_on_founder" }),
      makeTask({ id: "c4", title: "Waiting Dep", parentTaskId: "goal-1", status: "waiting_on_dependency" }),
      makeTask({ id: "c5", title: "Paused", parentTaskId: "goal-1", status: "paused" }),
      makeTask({ id: "c6", title: "Done", parentTaskId: "goal-1", status: "done" }),
    ];
    const result = buildHierarchyWithProgress(tasks);
    expect(result[0].progress).toEqual({ done: 1, total: 6 });
  });
});

// ─── Breadcrumb ancestry logic ────────────────────────────────────

describe("Goal Tree: getBreadcrumbTrail", () => {
  it("returns single item for a top-level task (no parent)", () => {
    const tasks = [makeTask({ id: "goal-1", title: "My Goal" })];
    const trail = getBreadcrumbTrail("goal-1", tasks);
    expect(trail).toEqual([{ id: "goal-1", title: "My Goal" }]);
  });

  it("returns parent then child for a child task", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Build Website" }),
      makeTask({ id: "task-1", title: "Design Homepage", parentTaskId: "goal-1" }),
    ];
    const trail = getBreadcrumbTrail("task-1", tasks);
    expect(trail).toEqual([
      { id: "goal-1", title: "Build Website" },
      { id: "task-1", title: "Design Homepage" },
    ]);
  });

  it("returns empty array for non-existent task id", () => {
    const tasks = [makeTask({ id: "goal-1", title: "Goal" })];
    const trail = getBreadcrumbTrail("non-existent", tasks);
    expect(trail).toEqual([]);
  });

  it("handles deep nesting (grandparent > parent > child)", () => {
    const tasks = [
      makeTask({ id: "root", title: "Root Goal" }),
      makeTask({ id: "mid", title: "Mid Task", parentTaskId: "root" }),
      makeTask({ id: "leaf", title: "Leaf Task", parentTaskId: "mid" }),
    ];
    const trail = getBreadcrumbTrail("leaf", tasks);
    expect(trail).toEqual([
      { id: "root", title: "Root Goal" },
      { id: "mid", title: "Mid Task" },
      { id: "leaf", title: "Leaf Task" },
    ]);
  });

  it("handles parent not in task list (orphan scenario)", () => {
    const tasks = [
      makeTask({ id: "child-1", title: "Orphan Child", parentTaskId: "missing-parent" }),
    ];
    const trail = getBreadcrumbTrail("child-1", tasks);
    expect(trail).toEqual([{ id: "child-1", title: "Orphan Child" }]);
  });

  it("handles circular reference gracefully", () => {
    const tasks = [
      makeTask({ id: "a", title: "Task A", parentTaskId: "b" }),
      makeTask({ id: "b", title: "Task B", parentTaskId: "a" }),
    ];
    // Should not infinite loop; visited set prevents it
    const trail = getBreadcrumbTrail("a", tasks);
    expect(trail.length).toBeGreaterThanOrEqual(1);
    expect(trail.length).toBeLessThanOrEqual(2);
  });

  it("breadcrumb trail shows goal > task pattern", () => {
    const tasks = [
      makeTask({ id: "goal-1", title: "Revenue Growth" }),
      makeTask({ id: "goal-2", title: "Product Development" }),
      makeTask({ id: "task-a", title: "Close Q1 deals", parentTaskId: "goal-1" }),
      makeTask({ id: "task-b", title: "Launch MVP", parentTaskId: "goal-2" }),
    ];
    const trailA = getBreadcrumbTrail("task-a", tasks);
    expect(trailA).toEqual([
      { id: "goal-1", title: "Revenue Growth" },
      { id: "task-a", title: "Close Q1 deals" },
    ]);
    const trailB = getBreadcrumbTrail("task-b", tasks);
    expect(trailB).toEqual([
      { id: "goal-2", title: "Product Development" },
      { id: "task-b", title: "Launch MVP" },
    ]);
  });
});
