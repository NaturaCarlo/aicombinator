/**
 * Pure logic for building task hierarchy, progress calculation, and breadcrumb trails.
 * Extracted from tasks-summary.tsx so that it can be imported in both production code and tests
 * without pulling in React/JSX or path-alias dependencies.
 */

import type { FounderTaskStatus, FounderVisibleTask } from "./types";

/** Returns a numeric ordering for task statuses (lower = higher priority). */
export function statusOrder(status: FounderTaskStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "queued":
      return 1;
    case "waiting_on_founder":
      return 2;
    case "waiting_on_dependency":
      return 3;
    case "done":
      return 4;
    case "paused":
      return 5;
  }
}

/** A top-level entry: either a standalone task or a parent goal with children. */
export interface HierarchyEntry {
  task: FounderVisibleTask;
  children: FounderVisibleTask[];
}

export interface HierarchyEntryWithProgress extends HierarchyEntry {
  progress: { done: number; total: number };
}

/**
 * Build a hierarchical list from flat tasks.
 * Tasks whose parentTaskId matches another task's id are grouped as children.
 * Top-level tasks (parentTaskId is null or parent not found in list) remain at top level.
 * Parent tasks that have children are rendered as collapsible goal headers.
 */
export function buildHierarchy(tasks: FounderVisibleTask[]): HierarchyEntry[] {
  const taskMap = new Map<string, FounderVisibleTask>();
  for (const t of tasks) {
    taskMap.set(t.id, t);
  }

  // Group children by their parent id
  const childrenByParent = new Map<string, FounderVisibleTask[]>();
  const topLevel: FounderVisibleTask[] = [];

  for (const t of tasks) {
    if (t.parentTaskId && taskMap.has(t.parentTaskId)) {
      const existing = childrenByParent.get(t.parentTaskId) ?? [];
      existing.push(t);
      childrenByParent.set(t.parentTaskId, existing);
    } else {
      topLevel.push(t);
    }
  }

  // Sort children within each parent by status then by updatedAt
  for (const [, children] of childrenByParent) {
    children.sort((a, b) => {
      const byStatus = statusOrder(a.status) - statusOrder(b.status);
      if (byStatus !== 0) return byStatus;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }

  return topLevel.map((t) => ({
    task: t,
    children: childrenByParent.get(t.id) ?? [],
  }));
}

/** Build hierarchy with progress (done/total) for each entry. */
export function buildHierarchyWithProgress(tasks: FounderVisibleTask[]): HierarchyEntryWithProgress[] {
  const entries = buildHierarchy(tasks);
  return entries.map((entry) => ({
    ...entry,
    progress: {
      done: entry.children.filter((c) => c.status === "done").length,
      total: entry.children.length,
    },
  }));
}

/**
 * Build a breadcrumb trail for a given task, walking up the parent chain.
 * Returns array of { id, title } from root ancestor down to the task itself.
 * Only includes parents that exist in the provided task list.
 */
export function getBreadcrumbTrail(
  taskId: string,
  tasks: FounderVisibleTask[],
): Array<{ id: string; title: string }> {
  const taskMap = new Map<string, FounderVisibleTask>();
  for (const t of tasks) {
    taskMap.set(t.id, t);
  }

  const trail: Array<{ id: string; title: string }> = [];
  let current = taskMap.get(taskId);

  const visited = new Set<string>();
  while (current) {
    trail.unshift({ id: current.id, title: current.title });
    visited.add(current.id);
    if (current.parentTaskId && !visited.has(current.parentTaskId)) {
      current = taskMap.get(current.parentTaskId);
    } else {
      break;
    }
  }

  return trail;
}
