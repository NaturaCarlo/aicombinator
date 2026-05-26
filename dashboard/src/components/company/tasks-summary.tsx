"use client";

import { useState, useCallback } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  GitBranch,
  List,
  PauseCircle,
  PlayCircle,
} from "lucide-react";
import { approveApproval, rejectApproval, resolveAvatarUrl, updateTask } from "@/lib/api";
import { MarkdownContent } from "./markdown-content";
import type { FounderTaskAction, FounderTaskStatus, FounderVisibleTask } from "@/lib/types";
import {
  statusOrder,
  buildHierarchy,
  buildHierarchyWithProgress,
  getBreadcrumbTrail,
} from "@/lib/task-hierarchy";
export type { HierarchyEntry, HierarchyEntryWithProgress } from "@/lib/task-hierarchy";
export { statusOrder, buildHierarchy, buildHierarchyWithProgress, getBreadcrumbTrail } from "@/lib/task-hierarchy";

function timeAgo(dateStr: string | null | undefined): string | null {
  if (!dateStr) {
    return null;
  }
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function taskStatusMeta(status: FounderTaskStatus): {
  label: string;
  color: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case "active":
      return {
        label: "Active",
        color: "text-accent-orange",
        icon: <PlayCircle className="h-4 w-4 text-accent-orange shrink-0" />,
      };
    case "queued":
      return {
        label: "Queued",
        color: "text-blue-500",
        icon: <Clock className="h-4 w-4 text-blue-500 shrink-0" />,
      };
    case "waiting_on_founder":
      return {
        label: "Waiting on founder",
        color: "text-amber-600 dark:text-amber-400",
        icon: <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
      };
    case "waiting_on_dependency":
      return {
        label: "Waiting on dependency",
        color: "text-sky-500",
        icon: <Clock className="h-4 w-4 text-sky-500 shrink-0" />,
      };
    case "paused":
      return {
        label: "Paused",
        color: "text-muted-foreground",
        icon: <PauseCircle className="h-4 w-4 text-muted-foreground shrink-0" />,
      };
    case "done":
      return {
        label: "Done",
        color: "text-green-500",
        icon: <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />,
      };
  }
}

function statusHeading(status: FounderTaskStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "queued":
      return "Queued";
    case "waiting_on_founder":
      return "Waiting on founder";
    case "waiting_on_dependency":
      return "Waiting on dependency";
    case "done":
      return "Done";
    case "paused":
      return "Paused";
  }
}

function ApprovalActionPanel({
  action,
  onAction,
}: {
  action: FounderTaskAction;
  onAction: () => void;
}) {
  const { getToken } = useAuth();
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyMode, setReplyMode] = useState(false);
  const [reply, setReply] = useState("");

  async function handleDecision(decision: "approve" | "reject", note?: string) {
    setActing(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      for (const approvalId of action.resolutionIds) {
        if (decision === "approve") {
          await approveApproval(approvalId, token, note);
        } else {
          await rejectApproval(approvalId, token, note);
        }
      }
      setReply("");
      setReplyMode(false);
      onAction();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setError(message);
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="mt-3 rounded-none border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
      {action.prompt && (
        <p className="text-[11px] leading-relaxed text-foreground">{action.prompt}</p>
      )}

      {error && (
        <p className="mt-2 text-[11px] leading-relaxed text-red-600 dark:text-red-400">{error}</p>
      )}

      {replyMode && (
        <textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          placeholder={action.replyPlaceholder || "Add context for the CEO..."}
          className="mt-3 w-full rounded-none border border-border bg-background px-3 py-2 text-xs leading-relaxed placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-accent-orange/40 resize-none"
          rows={3}
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {replyMode ? (
          <>
            <button
              onClick={() => handleDecision("approve", reply.trim() || undefined)}
              disabled={acting || (action.replyRequired && !reply.trim())}
              className="rounded-none bg-accent-orange px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-accent-orange/90 disabled:opacity-40"
            >
              {acting ? "Sending..." : "Send & resolve"}
            </button>
            <button
              onClick={() => {
                setReplyMode(false);
                setReply("");
              }}
              disabled={acting}
              className="px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {action.replyPlaceholder && (
              <button
                onClick={() => setReplyMode(true)}
                disabled={acting}
                className="rounded-none border border-accent-orange/30 bg-accent-orange/5 px-3 py-1.5 text-[11px] font-medium text-accent-orange transition-colors hover:bg-accent-orange/10"
              >
                Reply with info
              </button>
            )}
            <button
              onClick={() => handleDecision("approve")}
              disabled={acting}
              className="rounded-none bg-green-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-40"
            >
              {acting ? "Working..." : action.approveLabel}
            </button>
            <button
              onClick={() => handleDecision("reject")}
              disabled={acting}
              className="px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {action.rejectLabel}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function BreadcrumbTrail({ trail }: { trail: Array<{ id: string; title: string }> }) {
  if (trail.length <= 1) return null;
  return (
    <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-2 flex-wrap">
      {trail.map((item, index) => (
        <span key={item.id} className="flex items-center gap-1">
          {index > 0 && <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/50" />}
          <span className={index === trail.length - 1 ? "text-foreground font-medium" : ""}>
            {item.title}
          </span>
        </span>
      ))}
    </div>
  );
}

function EditableGoalTitle({
  title,
  isEditing,
  onStartEdit,
  onSave,
  onCancel,
}: {
  title: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onSave: (newTitle: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && value.trim()) {
      e.stopPropagation();
      onSave(value.trim());
    } else if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  }

  if (isEditing) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => onCancel()}
        onClick={(e) => e.stopPropagation()}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        className="text-xs font-medium bg-transparent border-b border-accent-orange/40 focus:outline-none focus:border-accent-orange min-w-0 w-full"
      />
    );
  }

  return (
    <span
      onDoubleClick={(e) => {
        e.stopPropagation();
        setValue(title);
        onStartEdit();
      }}
      className="cursor-text"
    >
      {title}
    </span>
  );
}

function TaskRow({
  task,
  expanded,
  onToggle,
  onTaskAction,
  breadcrumbTrail,
  isEditing,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
}: {
  task: FounderVisibleTask;
  expanded: boolean;
  onToggle: () => void;
  onTaskAction: () => void;
  breadcrumbTrail?: Array<{ id: string; title: string }>;
  isEditing?: boolean;
  onStartEdit?: () => void;
  onSaveEdit?: (newTitle: string) => void;
  onCancelEdit?: () => void;
}) {
  const meta = taskStatusMeta(task.status);
  const ownerLabel = task.ownerName || task.ownerTitle || null;
  const touched = timeAgo(task.status === "done" ? task.completedAt || task.updatedAt : task.updatedAt);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/40"
      >
        <div className="flex items-center gap-2 shrink-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {meta.icon}
        </div>

        <div className="min-w-0 flex-1">
          <p className={`text-xs font-medium truncate ${task.status === "done" ? "text-muted-foreground line-through decoration-muted-foreground/30" : ""}`}>
            {onStartEdit && onSaveEdit && onCancelEdit ? (
              <EditableGoalTitle
                title={task.title}
                isEditing={isEditing ?? false}
                onStartEdit={onStartEdit}
                onSave={onSaveEdit}
                onCancel={onCancelEdit}
              />
            ) : (
              task.title
            )}
          </p>
          <p className={`text-[10px] ${meta.color}`}>
            {meta.label}
            {ownerLabel ? ` · ${ownerLabel}` : ""}
            {touched ? ` · ${touched}` : ""}
          </p>
          {task.status === "waiting_on_dependency" && task.blockedBy && task.blockedBy.length > 0 && (
            <p className="text-[10px] text-muted-foreground truncate">
              Blocked by: {task.blockedBy.map((dep) => dep.title).join(", ")}
            </p>
          )}
        </div>

        {task.ownerName && (
          <div
            className="shrink-0 h-6 w-6 rounded-none bg-secondary overflow-hidden flex items-center justify-center"
            title={task.ownerName}
          >
            {task.ownerIcon ? (
              <img src={resolveAvatarUrl(task.ownerIcon)} alt={task.ownerName} className="h-6 w-6 rounded-none object-cover" />
            ) : (
              <span className="text-[9px] font-semibold text-muted-foreground">
                {task.ownerName.charAt(0)}
              </span>
            )}
          </div>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 pl-[52px]">
          {breadcrumbTrail && <BreadcrumbTrail trail={breadcrumbTrail} />}
          <div className={`rounded-none border px-3 py-2.5 ${task.status === "waiting_on_founder" ? "border-amber-500/20 bg-amber-500/5" : "border-border bg-secondary/20"}`}>
            {task.description && (
              <MarkdownContent content={task.description} className="text-[11px] leading-relaxed text-foreground" />
            )}
            {task.detail && (
              <p className={`${task.description ? "mt-2 " : ""}text-[11px] leading-relaxed text-muted-foreground`}>
                {task.detail}
              </p>
            )}
            {task.action && task.status === "waiting_on_founder" && (
              <ApprovalActionPanel action={task.action} onAction={onTaskAction} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function ParentGoalHeader({
  task,
  childCount,
  progress,
  isExpanded,
  onToggle,
  isEditing,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
}: {
  task: FounderVisibleTask;
  childCount: number;
  progress: { done: number; total: number };
  isExpanded: boolean;
  onToggle: () => void;
  isEditing: boolean;
  onStartEdit: () => void;
  onSaveEdit: (newTitle: string) => void;
  onCancelEdit: () => void;
}) {
  const meta = taskStatusMeta(task.status);
  const touched = timeAgo(task.status === "done" ? task.completedAt || task.updatedAt : task.updatedAt);
  const progressPct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/40"
    >
      <div className="flex items-center gap-2 shrink-0">
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {meta.icon}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={`text-xs font-medium truncate ${task.status === "done" ? "text-muted-foreground line-through decoration-muted-foreground/30" : ""}`}>
            <EditableGoalTitle
              title={task.title}
              isEditing={isEditing}
              onStartEdit={onStartEdit}
              onSave={onSaveEdit}
              onCancel={onCancelEdit}
            />
          </p>
          <span className="shrink-0 rounded-none bg-secondary px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
            {childCount}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <p className={`text-[10px] ${meta.color}`}>
            {meta.label}
            {touched ? ` · ${touched}` : ""}
          </p>
          {progress.total > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="h-1 w-16 rounded-none bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-none bg-green-500 transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-[9px] text-muted-foreground">
                {progress.done}/{progress.total}
              </span>
            </div>
          )}
        </div>
        {task.status === "waiting_on_dependency" && task.blockedBy && task.blockedBy.length > 0 && (
          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
            Blocked by: {task.blockedBy.map((dep) => dep.title).join(", ")}
          </p>
        )}
      </div>
    </button>
  );
}

type ViewMode = "list" | "tree";

export function TasksSummary({
  tasks,
  isLoading,
  onTaskAction,
  onMutate,
}: {
  tasks: FounderVisibleTask[];
  isLoading: boolean;
  onTaskAction: () => void;
  companyId?: string;
  onMutate?: () => void;
}) {
  const { getToken } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(() => new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);

  function toggleGoal(goalId: string) {
    setExpandedGoals((prev) => {
      const next = new Set(prev);
      if (next.has(goalId)) {
        next.delete(goalId);
      } else {
        next.add(goalId);
      }
      return next;
    });
  }

  const handleSaveGoalTitle = useCallback(async (taskId: string, newTitle: string) => {
    try {
      const token = await getToken();
      if (!token) return;
      await updateTask(taskId, { title: newTitle }, token);
      setEditingGoalId(null);
      onMutate?.();
    } catch {
      setEditingGoalId(null);
    }
  }, [getToken, onMutate]);

  if (isLoading) {
    return (
      <div className="card-clean overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <div className="shimmer h-4 w-16 rounded" />
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <div className="shimmer h-4 w-4 rounded-none" />
              <div className="flex-1 space-y-1">
                <div className="shimmer h-3.5 w-3/4 rounded" />
              </div>
              <div className="shimmer h-6 w-6 rounded-none" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Sort all tasks by status, then by date (for counting & summary stats)
  const sortedTasks = [...tasks].sort((a, b) => {
    const byStatus = statusOrder(a.status) - statusOrder(b.status);
    if (byStatus !== 0) return byStatus;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  // Build hierarchy with progress from sorted tasks (used in tree mode)
  const hierarchy = buildHierarchyWithProgress(sortedTasks);

  // Sort top-level entries by their task's status ordering
  hierarchy.sort((a, b) => {
    const byStatus = statusOrder(a.task.status) - statusOrder(b.task.status);
    if (byStatus !== 0) return byStatus;
    return new Date(b.task.updatedAt).getTime() - new Date(a.task.updatedAt).getTime();
  });

  const active = tasks.filter((task) => task.status === "active").length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const waitingOnFounder = tasks.filter((task) => task.status === "waiting_on_founder").length;
  const waitingOnDependency = tasks.filter((task) => task.status === "waiting_on_dependency").length;
  const done = tasks.filter((task) => task.status === "done").length;
  const paused = tasks.filter((task) => task.status === "paused").length;

  // For tree mode, use hierarchy; for list mode, use flat sortedTasks grouped by status
  const treePreview = expanded ? hierarchy : hierarchy.slice(0, 6);
  const listPreview = expanded ? sortedTasks : sortedTasks.slice(0, 12);
  const totalCount = viewMode === "tree" ? hierarchy.length : sortedTasks.length;
  const previewLimit = viewMode === "tree" ? 6 : 12;

  return (
    <div className="card-clean overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Circle className="h-3.5 w-3.5 text-accent-orange" />
        <span className="section-label">
          Tasks
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>
            {active} active
            {queued > 0 ? ` · ${queued} queued` : ""}
            {waitingOnFounder > 0 ? ` · ${waitingOnFounder} waiting` : ""}
            {waitingOnDependency > 0 ? ` · ${waitingOnDependency} dep` : ""}
            {done > 0 ? ` · ${done} done` : ""}
            {paused > 0 ? ` · ${paused} paused` : ""}
          </span>
          <div className="flex items-center rounded-none border border-border overflow-hidden ml-1">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium transition-colors ${
                viewMode === "list"
                  ? "bg-accent-orange/10 text-accent-orange"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
              title="List view"
              aria-label="List view"
            >
              <List className="h-4 w-4" />
              <span>List</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("tree")}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium transition-colors ${
                viewMode === "tree"
                  ? "bg-accent-orange/10 text-accent-orange"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
              title="Tree view"
              aria-label="Tree view"
            >
              <GitBranch className="h-4 w-4" />
              <span>Tree</span>
            </button>
          </div>
        </span>
      </div>

      {tasks.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground">No founder-visible work right now.</p>
        </div>
      ) : viewMode === "list" ? (
        <>
          <div className="divide-y divide-border">
            {listPreview.map((task, index) => {
              const previous = index > 0 ? listPreview[index - 1] : null;
              const showSectionHeader = !previous || previous.status !== task.status;

              return (
                <div key={task.id}>
                  {showSectionHeader && (
                    <div className="px-4 py-1.5 bg-secondary/30">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${taskStatusMeta(task.status).color}`}>
                        {statusHeading(task.status)}
                        <span className="ml-1.5 text-muted-foreground font-normal">
                          {sortedTasks.filter((t) => t.status === task.status).length}
                        </span>
                      </span>
                    </div>
                  )}
                  <TaskRow
                    task={task}
                    expanded={selectedId === task.id}
                    onToggle={() => setSelectedId((current) => (current === task.id ? null : task.id))}
                    onTaskAction={onTaskAction}
                  />
                </div>
              );
            })}
          </div>

          {totalCount > previewLimit && (
            <button
              onClick={() => setExpanded((current) => !current)}
              className="flex w-full items-center justify-center gap-2 border-t border-border px-4 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/30 hover:text-foreground"
            >
              {expanded ? "Show less" : `Show ${totalCount - previewLimit} more`}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="divide-y divide-border">
            {treePreview.map((entry, index) => {
              const previous = index > 0 ? treePreview[index - 1] : null;
              const showSectionHeader = !previous || previous.task.status !== entry.task.status;
              const isGoal = entry.children.length > 0;
              const goalExpanded = expandedGoals.has(entry.task.id);

              return (
                <div key={entry.task.id}>
                  {showSectionHeader && (
                    <div className="px-4 py-1.5 bg-secondary/30">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${taskStatusMeta(entry.task.status).color}`}>
                        {statusHeading(entry.task.status)}
                        <span className="ml-1.5 text-muted-foreground font-normal">
                          {hierarchy.filter((e) => e.task.status === entry.task.status).length}
                        </span>
                      </span>
                    </div>
                  )}

                  {isGoal ? (
                    <>
                      <ParentGoalHeader
                        task={entry.task}
                        childCount={entry.children.length}
                        progress={entry.progress}
                        isExpanded={goalExpanded}
                        onToggle={() => toggleGoal(entry.task.id)}
                        isEditing={editingGoalId === entry.task.id}
                        onStartEdit={() => setEditingGoalId(entry.task.id)}
                        onSaveEdit={(newTitle) => handleSaveGoalTitle(entry.task.id, newTitle)}
                        onCancelEdit={() => setEditingGoalId(null)}
                      />
                      {goalExpanded && (
                        <div className="border-l-2 border-accent-orange/20 ml-6">
                          {entry.children.map((child) => (
                            <TaskRow
                              key={child.id}
                              task={child}
                              expanded={selectedId === child.id}
                              onToggle={() => setSelectedId((current) => (current === child.id ? null : child.id))}
                              onTaskAction={onTaskAction}
                              breadcrumbTrail={selectedId === child.id ? getBreadcrumbTrail(child.id, tasks) : undefined}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <TaskRow
                      task={entry.task}
                      expanded={selectedId === entry.task.id}
                      onToggle={() => setSelectedId((current) => (current === entry.task.id ? null : entry.task.id))}
                      onTaskAction={onTaskAction}
                      isEditing={editingGoalId === entry.task.id}
                      onStartEdit={() => setEditingGoalId(entry.task.id)}
                      onSaveEdit={(newTitle) => handleSaveGoalTitle(entry.task.id, newTitle)}
                      onCancelEdit={() => setEditingGoalId(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {totalCount > previewLimit && (
            <button
              onClick={() => setExpanded((current) => !current)}
              className="flex w-full items-center justify-center gap-2 border-t border-border px-4 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/30 hover:text-foreground"
            >
              {expanded ? "Show less" : `Show ${totalCount - previewLimit} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
