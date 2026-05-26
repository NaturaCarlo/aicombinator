import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getAllBlueprints, getBlueprint, getAllSpecialistBlueprints, ENGINEERING_SUPERPOWERS, QA_SUPERPOWERS } from "./blueprints.js";
import { SupervisorDb, isoNow } from "./db.js";
import type { AgentInvoker } from "./agent-invoker.js";
import {
  calculate_turn_credit_reservation,
  calculate_turn_credits,
  CreditManager,
  fit_turn_limits_to_available_credits,
} from "./credit-manager.js";
import { TaskManager, humanize_criterion, humanize_criteria } from "./task-manager.js";
import type {
  AcceptanceCriterion,
  AgentRow,
  AgentTurnResult,
  CEOEventType,
  CompanyRow,
  CriterionValidationResult,
  SubtaskRequestPayload,
  TaskRow,
  TaskSignal,
  TelemetryMirrorRow,
  VerifiedTelemetrySummary,
} from "./types.js";
import { getReportTarget } from "./routing.js";

export interface AgentRunnerCallbacks {
  on_task_completed: (task_id: string) => Promise<void> | void;
  notify_ceo: (
    company_id: string,
    event_type: CEOEventType,
    payload: Record<string, unknown>,
  ) => Promise<void> | void;
  /** Notify a manager agent (e.g. CTO) of a status event instead of the CEO. */
  notify_manager: (
    company_id: string,
    manager_blueprint_id: string,
    event_type: CEOEventType,
    payload: Record<string, unknown>,
  ) => Promise<void> | void;
  /** Process a subtask request from a delegating agent (e.g. CTO). */
  process_subtask_request: (
    company_id: string,
    sender_agent: AgentRow,
    request: SubtaskRequestPayload,
  ) => Promise<void> | void;
  pause_company: (company_id: string) => Promise<void> | void;
  pause_company_missing_workspace: (company_id: string) => Promise<void> | void;
  schedule: (company_id: string) => Promise<void> | void;
}

interface TaskDonePayload {
  task_id: string;
  artifact: string;
  summary: string;
}

interface TaskBlockedPayload {
  task_id: string;
  reason: string;
}

function parse_json<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function parse_json_array<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function workspace_path(workspace_dir: string, target: string): string {
  if (target === "/workspace") {
    return workspace_dir;
  }
  if (target.startsWith("/workspace/")) {
    return join(workspace_dir, target.slice("/workspace/".length));
  }
  return target;
}

function list_workspace_files(root: string, base: string = root): string[] {
  if (!existsSync(root)) return [];
  const entries: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".agent") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...list_workspace_files(full, base));
      continue;
    }
    if (entry.isFile()) {
      entries.push(relative(base, full));
    }
  }
  return entries.sort();
}

function fingerprint_workspace(workspace_dir: string): string {
  const files = list_workspace_files(workspace_dir);
  const fingerprints: string[] = [];
  for (const relPath of files) {
    try {
      const st = statSync(join(workspace_dir, relPath));
      fingerprints.push(`${relPath}:${st.size}:${st.mtimeMs}`);
    } catch {
      continue;
    }
  }
  return fingerprints.join("|");
}

function count_words(text: string): number {
  const normalized = text
    .replace(/[#*_`>\-\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return 0;
  return normalized.split(" ").length;
}

const FOUNDER_METRIC_KEYWORDS = [
  /\blead(s)?\b/i,
  /\bpipeline\b/i,
  /\brevenue\b/i,
  /\bmrr\b/i,
  /\barr\b/i,
  /\bsubscription(s)?\b/i,
  /\bcustomer(s)?\b/i,
  /\bclient(s)?\b/i,
  /\bdemo(s)?\b/i,
  /\bcall(s)?\b/i,
  /\boutbound\b/i,
  /\bresponse rate\b/i,
  /\bopen rate\b/i,
  /\bctr\b/i,
  /\bcpc\b/i,
  /\bcac\b/i,
  /\broas\b/i,
  /\bconversion(s)?\b/i,
  /\bmessage(s)? sent\b/i,
  /\bpositive response(s)?\b/i,
  /\bpayment capability\b/i,
  /\btrial(s)?\b/i,
  /\bbooked\b/i,
  /\bsigned\b/i,
];

const FOUNDER_UNVERIFIED_CLAIM_PHRASES = [
  /exceeds all projections/i,
  /product-market fit/i,
  /\bhot lead(s)?\b/i,
  /\brevenue impact\b/i,
  /\brevenue pipeline\b/i,
  /\bdiscovery call(s)? booked\b/i,
  /\bpilot client(s)? signed\b/i,
  /\bmessages sent\b/i,
  /\bpositive response(s)?\b/i,
  /\bresponse rate\b/i,
];

const FOUNDER_NUMERIC_CLAIM_PATTERN =
  /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kmb])?|\b\d+(?:[.,]\d+)?(?:\s?[kmb])?\b|>\s?\d+(?:[.,]\d+)?%|\b\d+\s*\/\s*\d+\b|\b\d+\s*-\s*\d+\b|\b\d+\s*(?:day|days|week|weeks|month|months|year|years|hour|hours|hr|hrs|mo)\b|%)/i;

function contains_ungrounded_commercial_claims(raw: string): boolean {
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const normalized = line.trim();
    if (!normalized) continue;
    if (FOUNDER_UNVERIFIED_CLAIM_PHRASES.some((pattern) => pattern.test(normalized))) {
      return true;
    }
    const hasMetricKeyword = FOUNDER_METRIC_KEYWORDS.some((pattern) => pattern.test(normalized));
    if (hasMetricKeyword && FOUNDER_NUMERIC_CLAIM_PATTERN.test(normalized)) {
      return true;
    }
  }
  return false;
}

export function format_blueprint_pool(): string {
  return getAllBlueprints()
    .map((blueprint) => `- ${blueprint.id}: ${blueprint.title}`)
    .join("\n");
}

export function format_blueprint_pool_with_ids_and_descriptions(): string {
  return getAllBlueprints()
    .map((blueprint) => `- ${blueprint.id}: ${blueprint.title} — ${blueprint.description}`)
    .join("\n");
}

export function format_specialist_blueprint_list(): string {
  return getAllSpecialistBlueprints()
    .map((bp) => `- ${bp.id}: ${bp.description}`)
    .join("\n");
}

export interface CEOContextInput {
  company: CompanyRow;
  milestones: Array<{ id: string; title: string; status: string; sort_order: number; tasks_done: number; tasks_total: number }>;
  active_tasks: Array<{ id: string; title: string; status: string; owner_agent_id: string | null; blocked_reason: string | null; artifact: string | null }>;
  recent_completions: Array<{ id: string; title: string; artifact: string | null; completed_at: string | null }>;
  cancelled_tasks: Array<{ id: string; title: string; owner_agent_id: string | null }>;
  agents: Array<{ id: string; name: string; role: string; title?: string | null; status: string; current_task_id: string | null; source?: string }>;
  credit_balance: number;
  credit_burn_rate_per_hour: number;
}

export function build_ceo_context_block(ctx: CEOContextInput): string {
  const parts: string[] = [];
  parts.push("# Current Company State");
  parts.push("");
  parts.push(`Company: ${ctx.company.name}`);
  parts.push(`Goal: ${ctx.company.genesis_prompt ?? ctx.company.goal ?? "No goal provided"}`);
  parts.push(`State: ${ctx.company.state}`);
  parts.push(`Credits: ${ctx.credit_balance} remaining (burn rate: ${ctx.credit_burn_rate_per_hour.toFixed(1)}/hour)`);
  if (ctx.credit_balance > 0 && ctx.credit_burn_rate_per_hour > 0) {
    const hours_remaining = ctx.credit_balance / ctx.credit_burn_rate_per_hour;
    parts.push(`Estimated runway: ${hours_remaining.toFixed(1)} hours`);
  }

  parts.push("");
  parts.push("## Milestones");
  if (ctx.milestones.length === 0) {
    parts.push("- none");
  } else {
    for (const m of ctx.milestones) {
      parts.push(`- [${m.id}] "${m.title}" — ${m.status} (${m.tasks_done}/${m.tasks_total} tasks done)`);
    }
  }

  parts.push("");
  parts.push("## Active Tasks");
  if (ctx.active_tasks.length === 0) {
    parts.push("- none");
  } else {
    for (const t of ctx.active_tasks) {
      const owner = ctx.agents.find((a) => a.id === t.owner_agent_id);
      parts.push(`- [${t.id}] "${t.title}" (${owner?.name ?? "unassigned"}) — ${t.status}`);
      if (t.blocked_reason) parts.push(`  Blocked: ${t.blocked_reason}`);
      if (t.artifact) parts.push(`  Artifact: ${t.artifact}`);
    }
  }

  parts.push("");
  parts.push("## Recently Completed");
  if (ctx.recent_completions.length === 0) {
    parts.push("- none");
  } else {
    for (const t of ctx.recent_completions) {
      parts.push(`- [${t.id}] "${t.title}" → ${t.artifact ?? "no artifact"}`);
    }
  }

  if (ctx.cancelled_tasks.length > 0) {
    parts.push("");
    parts.push("## Cancelled / Failed Tasks");
    for (const t of ctx.cancelled_tasks) {
      const owner = ctx.agents.find((a) => a.id === t.owner_agent_id);
      parts.push(`- [${t.id}] "${t.title}" (${owner?.name ?? "unassigned"}) — cancelled`);
    }
  }

  parts.push("");
  parts.push("## Agents");
  for (const a of ctx.agents) {
    const roleLabel = a.title ? `${a.title} (${a.role})` : a.role;
    const sourceLabel = a.source && a.source !== "internal" ? ` [${a.source}]` : "";
    parts.push(`- ${a.name} — ${roleLabel}${sourceLabel}: ${a.status}${a.current_task_id ? ` — working on ${a.current_task_id}` : ""}`);
  }

  // Workspace listing is in the system prompt — not repeated here to save tokens.

  return parts.join("\n");
}

export function compute_day_number(company: CompanyRow, now: Date = new Date()): number {
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(company.created_at));
  const current = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const createdDate = new Date(`${created}T00:00:00Z`);
  const currentDate = new Date(`${current}T00:00:00Z`);
  const diffDays = Math.floor((currentDate.getTime() - createdDate.getTime()) / 86_400_000);
  return diffDays + 1;
}

export function build_ceo_date_header(company: CompanyRow, now: Date = new Date()): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).format(now);
  return `Current date: ${formatted} (Pacific Time) — Day ${compute_day_number(company, now)}`;
}

function format_pt_iso_date(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function build_pt_date_variants(pt_iso_date: string): string[] {
  const match = pt_iso_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [pt_iso_date];
  const [, year, month, day] = match;
  const pt_midnight = new Date(`${pt_iso_date}T00:00:00Z`);
  const long = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(pt_midnight);
  const long_padded = `${long.replace(/,\s+\d{4}$/, "")?.replace(/\b(\d)\b/, `0${Number(day)}`)}, ${year}`;
  return [pt_iso_date, `${year}-${month}-${day}`, long, long_padded];
}

function normalize_explicit_date(raw: string): string | null {
  const iso_match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso_match) {
    return iso_match[0];
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function document_has_expected_date(content: string, expected_pt_date: string): boolean {
  const lower = content.toLowerCase();
  const explicit_dates = new Set<string>();
  const iso_matches = content.match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? [];
  for (const match of iso_matches) {
    const normalized = normalize_explicit_date(match);
    if (normalized) explicit_dates.add(normalized);
  }
  const long_matches = content.match(
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b/g,
  ) ?? [];
  for (const match of long_matches) {
    const normalized = normalize_explicit_date(match);
    if (normalized) explicit_dates.add(normalized);
  }
  if (explicit_dates.size > 0) {
    return explicit_dates.size === 1 && explicit_dates.has(expected_pt_date);
  }
  return build_pt_date_variants(expected_pt_date).some((variant) => lower.includes(variant.toLowerCase()));
}

function document_has_expected_day_number(content: string, expected_day_number: number): boolean {
  const matches = [...content.matchAll(/\bday\s+(\d{1,3})\b/gi)];
  if (matches.length === 0) {
    return true;
  }
  return matches.every((match) => Number(match[1]) === expected_day_number);
}

function aggregate_telemetry(rows: TelemetryMirrorRow[]): VerifiedTelemetrySummary {
  const summary: VerifiedTelemetrySummary = {
    outreach: { total: 0, sent: 0, replied: 0 },
    leads: { total: 0, new: 0, qualified: 0 },
    meetings: { total: 0, scheduled: 0, completed: 0 },
    revenue: { events: 0, paidCount: 0, paidCents: 0 },
  };

  for (const row of rows) {
    switch (row.kind) {
      case "outreach":
        summary.outreach.total += 1;
        if (row.status === "sent") summary.outreach.sent += 1;
        if (row.status === "replied") summary.outreach.replied += 1;
        break;
      case "lead":
        summary.leads.total += 1;
        if (row.status === "new") summary.leads.new += 1;
        if (row.status === "qualified") summary.leads.qualified += 1;
        break;
      case "meeting":
        summary.meetings.total += 1;
        if (row.status === "scheduled") summary.meetings.scheduled += 1;
        if (row.status === "completed") summary.meetings.completed += 1;
        break;
      case "revenue":
        summary.revenue.events += 1;
        if (row.status === "paid") {
          summary.revenue.paidCount += 1;
          summary.revenue.paidCents += row.amount_cents ?? 0;
        }
        break;
    }
  }

  return summary;
}

function strip_markdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extract_summary(output: string | undefined, fallback_task_title: string): string {
  const stripped = strip_markdown(output ?? "");
  if (!stripped) {
    return `Working on ${fallback_task_title}`;
  }
  const sentence = stripped.split(/(?<=[.!?])\s+/)[0] ?? stripped;
  return sentence.slice(0, 120);
}

export function build_ceo_telemetry_section(rows: TelemetryMirrorRow[]): string {
  const summary = aggregate_telemetry(rows);
  if (
    summary.outreach.total === 0
    && summary.leads.total === 0
    && summary.meetings.total === 0
    && summary.revenue.events === 0
  ) {
    return "";
  }

  const parts = ["# Verified Commercial Metrics (provider-backed)"];
  if (summary.outreach.total > 0) {
    parts.push(`Outreach: ${summary.outreach.sent} sent, ${summary.outreach.replied} replied`);
  }
  if (summary.leads.total > 0) {
    parts.push(`Leads: ${summary.leads.new} new, ${summary.leads.qualified} qualified`);
  }
  if (summary.meetings.total > 0) {
    parts.push(
      `Meetings: ${summary.meetings.scheduled} scheduled, ${summary.meetings.completed} completed`,
    );
  }
  if (summary.revenue.events > 0) {
    parts.push(
      `Revenue: $${(summary.revenue.paidCents / 100).toFixed(2)} (${summary.revenue.paidCount} payments)`,
    );
  }
  parts.push("", "These numbers come from verified provider integrations.");
  parts.push("Do not invent or extrapolate beyond what is shown here.");
  return parts.join("\n");
}

export function build_workspace_listing(workspace_dir: string | null): string {
  if (!workspace_dir) return "Workspace: not provisioned yet.";
  const files = list_workspace_files(workspace_dir);
  if (files.length === 0) return "Workspace: empty (no files created yet).";
  // Cap the listing to avoid blowing up context on large workspaces
  const MAX_FILES = 80;
  const truncated = files.length > MAX_FILES;
  const listed = files.slice(0, MAX_FILES).map((f) => `  ${f}`).join("\n");
  const suffix = truncated ? `\n  ... and ${files.length - MAX_FILES} more files` : "";
  return `Workspace files (/workspace/):\n${listed}${suffix}`;
}

export function build_system_prompt(
  agent: AgentRow,
  company: CompanyRow,
  telemetry_rows: TelemetryMirrorRow[] = [],
): string {
  if (agent.blueprint_id === "ceo" || agent.role === "ceo") {
    return [
      `You are the CEO of ${company.name}.`,
      `Company goal: ${company.genesis_prompt ?? company.goal ?? "No goal provided"}`,
      `Company state: ${company.state}`,
      "",
      build_ceo_date_header(company),
      "",

      // ── Identity ──────────────────────────────────────────────
      "# Who You Are",
      "",
      "You are an AI CEO agent. You run inside an automated company alongside a team",
      "of specialist AI agents. You do not write code, design pages, send emails, or",
      "do implementation work. You plan, coordinate, adapt the plan, and communicate",
      "with the founder.",
      "",

      // ── System Architecture ───────────────────────────────────
      "# The System You Operate In",
      "",
      "This is the architecture of the system you live inside. Understanding it is",
      "critical — your effectiveness depends on working with this system, not against it.",
      "",
      "## Supervisor",
      "The supervisor is a deterministic program (not an AI). It manages the entire",
      "lifecycle: provisioning companies, scheduling agent turns, checking acceptance",
      "criteria, advancing milestones, handling credits, and waking you when decisions",
      "are needed. You do not control the supervisor — you communicate with it by",
      "writing structured JSON files to /workspace/.agent/.",
      "",
      "## Agents",
      "Each agent is an independent AI process invoked by the supervisor via the Claude",
      "Code SDK. Agents share a workspace filesystem (/workspace/) but cannot see each",
      "other, cannot see the plan, and cannot see the database. They receive a task",
      "prompt describing exactly what to do and what acceptance criteria to meet. When",
      "done, the supervisor automatically checks whether the acceptance criteria are met.",
      "",
      "Every agent works on exactly one task at a time. An agent cannot start a new",
      "task until the supervisor assigns one.",
      "",
      "## Task Lifecycle",
      "pending → ready → in_progress → done | blocked | failed",
      "",
      "- pending: task exists but its milestone is not yet active, or dependencies are unmet",
      "- ready: all dependencies satisfied, waiting for an idle agent to be assigned",
      "- in_progress: agent is actively working on it",
      "- done: acceptance criteria passed (automatically checked by supervisor)",
      "- blocked: agent declared a blocker, or a system check failed",
      "- failed: agent errored out after retries",
      "",
      "## Milestones",
      "Milestones are sequential. The supervisor activates the next milestone only after",
      "ALL tasks in the current milestone are done. Within a milestone, tasks with no",
      "dependencies start in parallel.",
      "",
      "A milestone with status 'done' means all its non-cancelled tasks are complete.",
      "Do NOT cancel tasks in done milestones or try to 'fix' them.",
      "If you need new work after all milestones are done, create a NEW milestone via add_milestones in plan_update.json, then add tasks to it.",
      "When adding tasks via add_tasks, ALWAYS include milestone_id.",
      "",
      "## Credits",
      "Every agent turn costs credits. Credits are reserved before a turn and settled",
      "after. When credits hit zero the company pauses — all agents stop. You should",
      "be aware of credit constraints when planning scope.",
      "",
      "## Workspace",
      "All agents share /workspace/. This is the only persistent filesystem. Anything",
      "an agent builds, it writes here. Anything you need to inspect, read from here.",
      "The .agent/ subdirectory is reserved for system files and is not visible in",
      "workspace listings.",
      "",

      // ── Communication Protocol ────────────────────────────────
      "# How You Communicate",
      "",
      "## With the supervisor — JSON files",
      "You write structured JSON files. The supervisor reads and acts on them.",
      "",
      "### /workspace/.agent/plan.json",
      "Used ONLY during initial planning (your first turn after company provisioning).",
      "The planning prompt will tell you the exact format. Do not write this file on",
      "any other turn.",
      "",
      "### /workspace/.agent/plan_update.json",
      "Used whenever the plan needs to change: add tasks, cancel tasks, add milestones,",
      "reassign work, activate/deactivate agents. All fields are optional — include",
      "only what needs to change.",
      "",
      "Available fields:",
      '  goal: "new company goal (only if direction is changing)"',
      '  add_milestones: [{title, description, tasks: [{title, description, assigned_to, depends_on, acceptance_criteria}]}]',
      '  cancel_milestones: ["milestone_id", ...]',
      '  add_tasks: [{title, description, assigned_to, depends_on, acceptance_criteria, milestone_id?}]',
      '  cancel_tasks: ["task_id", ...]',
      '  update_tasks: [{id, title?, description?, assigned_to?, depends_on?, acceptance_criteria?}]',
      '  activate_agents: ["blueprint_id", ...]',
      '  deactivate_agents: ["agent_id", ...]',
      "",
      "To reference a newly-added task in depends_on, use NEW_<snake_case_title>.",
      "",
      "### /workspace/.agent/approval_request.json",
      "Used ONLY when you cannot resolve a blocker through replanning. Escalates to",
      "the founder for a decision.",
      '  {type: "purchase_service"|"domain_purchase"|"tool_access"|"other",',
      '   description: "what you need and why",',
      '   related_task_id: "task_id"}',
      "",
      "### /workspace/.agent/create_automation_request.json",
      "Used when the founder asks you to create a recurring automation (scheduled task).",
      "Write this file to create one or more automations that the supervisor will",
      "register and execute on the specified schedule.",
      '  [{title: "Human-readable name for the automation",',
      '    description: "What this automation does",',
      '    schedule: "cron expression (e.g. 0 9 * * * for daily at 9am)",',
      '    prompt: "The instruction to execute each time it fires"}]',
      "A single JSON array. The supervisor creates each automation in the database.",
      "",
      "## With the founder — natural language",
      "When you are woken for a founder message, respond in natural language. The",
      "supervisor captures your response and shows it in the dashboard chat. Be concise,",
      "specific, and grounded in what actually exists in /workspace/.",
      "",
      "## Agent completion and blockers",
      "The supervisor automatically detects task completion by checking acceptance",
      "criteria after each agent turn. Agents can also write a blocker file if stuck.",
      "You will be woken if intervention is needed.",
      "",

      // ── Founder Documents ─────────────────────────────────────
      "# Founder-Facing Documents",
      "",
      "You maintain one document. The supervisor validates its word count and freshness.",
      "If it fails validation, you will be woken to fix it.",
      "",
      "## /workspace/docs/mission.md",
      "30-80 words. One paragraph. What the company does, for whom, and why it matters.",
      "Written once during initial planning. Update only if the founder changes direction.",
      "",
      "The daily update (/workspace/docs/daily-update-{YYYY-MM-DD}.md) is written",
      "automatically by the scheduler at the end of each day. You will be prompted to",
      "write it when the time comes — do NOT write it proactively during regular turns.",
      "",
      "Rules for all founder documents:",
      "- State only what is verifiable in /workspace/ or in the task/milestone status",
      "- Never invent metrics, leads, revenue, or traction",
      "- Never claim progress that is not backed by completed tasks or existing files",
      "- If no commercial telemetry exists, say so plainly",
      "",
      "",
      // ── Shared Context Document ─────────────────────────────────
      "# Shared Context — /workspace/CLAUDE.md",
      "",
      "This file is automatically loaded by every agent on every turn. It is the single",
      "source of shared project context. You create it during initial planning and update",
      "it when important decisions are made.",
      "",
      "## What goes in CLAUDE.md",
      "- Founder preferences expressed in chat (e.g. 'founder prefers weekly updates')",
      "- File/directory conventions (e.g. 'all pages in /workspace/site/')",
      "- Key decisions and why they were made",
      "- Anything an agent starting a new task should know without asking",
      "",
      "## What does NOT go in CLAUDE.md",
      "- Task lists or milestone status (the supervisor tracks those)",
      "- Full architecture docs (those live in /workspace/docs/)",
      "- Temporary notes or debugging context",
      "",
      "## When to update CLAUDE.md",
      "- During initial planning: create it with stack decisions and conventions",
      "- After founder messages that express preferences or change direction",
      "- After milestone reviews if new conventions emerged",
      "- Keep it concise — under 60 lines. It is loaded every turn, so brevity matters.",
      "",

      // ── When You Wake ─────────────────────────────────────────
      "# When You Get Woken Up",
      "",
      "The supervisor wakes you for specific events. Each turn prompt tells you why:",
      "",
      "- Initial planning: break the company goal into milestones and tasks",
      "- Founder message: respond and optionally update the plan",
      "- Task blocked: an agent is stuck — replan or escalate",
      "- Task failed: an agent errored out after retries — reassign or decompose",
      "- Milestone completed: review deliverables and confirm the next milestone",
      "- Unassigned task: a task has no agent — assign one",
      "- Document revision: a founder doc failed word-count or freshness checks — fix it",
      "",
      "Every turn prompt includes the current company context: milestones, tasks, agents,",
      "and workspace state. Use that context, not your memory of previous turns.",
      "",

      // ── Team & Hierarchy ─────────────────────────────────────────
      "# Your Team & Delegation Hierarchy",
      "",
      "You can assign tasks to CTO and CMO only. You do NOT assign tasks directly to",
      "individual contributors (frontend-dev, backend-dev, qa-tester).",
      "",
      "The CTO manages the engineering team independently. When you assign a task to the",
      "CTO, the CTO can create subtasks and delegate to: frontend-dev, backend-dev, qa-tester.",
      "You are notified when the CTO creates subtasks, but you do not approve them.",
      "",
      "If an engineering task fails or is blocked, the CTO is notified first. The CTO will",
      "attempt to replan or reassign. If the CTO cannot resolve it, the CTO declares a",
      "blocker which escalates to you.",
      "",
      "Available agents (full pool):",
      "",
      format_blueprint_pool_with_ids_and_descriptions(),
      "",
      "Your direct reports: cto, cmo",
      "",

      // ── Specialist Agents ─────────────────────────────────────
      "# Specialist Agents",
      "",
      "Beyond the founding team, you can hire specialist agents when the company needs",
      "specific expertise that the founding team does not cover.",
      "",
      "Available specialists:",
      format_specialist_blueprint_list(),
      "",
      "To hire a specialist, include their blueprint ID in your plan_update.json:",
      '  { "activate_agents": ["seo-specialist"] }',
      "",
      "Hire specialists when:",
      "- The company is building a web presence and needs SEO optimization",
      "- Tasks involve content marketing, landing pages, or organic search",
      "- The company needs competitive analysis or keyword strategy",
      "- The founder asks for SEO-related work and no SEO specialist is on the team",
      "",
      "Specialists auto-maintain themselves with daily ecosystem scans. Once hired,",
      "they stay on the team and improve over time.",
      "",

      // ── Workspace Snapshot ────────────────────────────────────
      build_workspace_listing(company.workspace_dir),
      "",

      // ── Telemetry ─────────────────────────────────────────────
      build_ceo_telemetry_section(telemetry_rows),

      // ── Constraints ───────────────────────────────────────────
      "",
      "# Constraints",
      "",
      "- You plan and coordinate. You do NOT write code, design pages, or send emails.",
      "- Agents can only do what their acceptance criteria check for — make criteria specific and verifiable.",
      "- Every task MUST have at least one acceptance criterion with type file_exists, file_not_empty, or directory_exists.",
      "- When you are unsure what to do, add a small exploratory task assigned to the right specialist.",
      "- The founder is the boss. If they want something changed, change it.",
      "- Do not invent metrics or commercial outcomes. Use only verified telemetry data.",
      "- Do not claim progress that is not backed by done tasks or existing workspace files.",
      "- Do not reference agent IDs outside your team list.",
      "- Be efficient — every CEO turn costs credits. Make decisions, don't deliberate.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const base = [
    `You are ${agent.name}, the ${agent.title ?? agent.role} at ${company.name}.`,
    "",
    "# How This System Works",
    "",
    "You are an AI agent in an automated company. A supervisor assigns you tasks",
    "one at a time. You do the work, then signal that you're done. You do not",
    "decide what to work on — the supervisor tells you.",
    "",
    "# What You Receive",
    "",
    "Each time you wake up, you get a prompt describing:",
    "- Your assigned task (title, description)",
    "- Acceptance criteria (what must be true when you're done)",
    "- Input artifacts from completed tasks you depend on",
    "- Context if this is a continuation of previous work",
    "",
    "# Task Completion",
    "",
    "The system automatically detects when your task is complete by checking the",
    "acceptance criteria after each turn. Focus on meeting all the criteria listed",
    "in your task prompt — you do not need to write any completion signal.",
    "",
    "# How to Signal a Blocker",
    "",
    "If you cannot complete your task because something is missing, write this file:",
    `/workspace/.agent/${agent.id}/task_blocked.json`,
    "",
    "{",
    '  "task_id": "<the task ID from your prompt>",',
    '  "reason": "<specific explanation of what is blocking you>"',
    "}",
    "",
    "# Rules",
    "",
    "1. Work ONLY on the task described in your prompt. Do not do other work.",
    "2. Write real files to /workspace/. Your work must be tangible.",
    "3. Check the acceptance criteria before declaring done — the supervisor will verify them automatically.",
    "4. If you need something from another agent, do NOT try to message them.",
    "   Declare a blocker and the CEO will handle coordination.",
    "5. Your conversation persists between turns — if you're continuing work,",
    "   you have context from your previous turns.",
    "6. Be efficient. Produce the deliverable, verify it meets criteria, signal done.",
    "7. Do not claim outreach results, leads, meetings, or revenue in your output.",
    "   Commercial metrics are tracked automatically by provider integrations.",
    "   You cannot create them.",
  ].join("\n");

  const blueprint = agent.blueprint_id ? getBlueprint(agent.blueprint_id) : undefined;
  const prompt = blueprint ? `${base}\n\n${blueprint.systemPrompt}` : base;

  // Inject superpowers methodology for engineering agents
  if (blueprint?.department === "engineering") {
    const superpowers = blueprint.id === "qa-tester" ? QA_SUPERPOWERS : ENGINEERING_SUPERPOWERS;
    return `${prompt}\n\n${superpowers}`;
  }

  return prompt;
}

export interface AgentSkillRow {
  skill_slug: string;
  name: string;
  description: string;
  instructions: string;
}

const DESIGN_TASK_PATTERN = /\b(landing\s*page|website|(?<!api\s)(?<!api-)ui\b|design|frontend|page\s+layout|layout\s+design|homepage|web\s+page)\b/i;

/** Returns true when a task likely involves visual / UI / design work. */
export function task_involves_design(task: { title: string; description: string | null }): boolean {
  const text = `${task.title} ${task.description ?? ""}`;
  return DESIGN_TASK_PATTERN.test(text);
}

/**
 * Extract key design tokens from a DESIGN.md file for inlining into task prompts.
 * Returns a compact summary (~2000 tokens) with color palette, typography, button/card
 * styles, spacing scale, and landing page composition patterns.
 */
function extract_design_summary(designContent: string): string | null {
  if (!designContent || designContent.length < 100) return null;

  const sections: string[] = [];

  // Extract color palette section (§2)
  const colorMatch = designContent.match(/## 2\. Color Palette & Roles\s*\n([\s\S]*?)(?=\n---|\n## 3\.)/);
  if (colorMatch) {
    sections.push("## Color Palette");
    // Extract hex colors and names compactly
    const colorLines = colorMatch[1]
      .split("\n")
      .filter((line) => line.includes("`#") || line.startsWith("- **"))
      .map((line) => line.trim())
      .join("\n");
    sections.push(colorLines);
  }

  // Extract typography section (§3) — compact version
  const typoMatch = designContent.match(/## 3\. Typography Rules\s*\n([\s\S]*?)(?=\n---|\n## 4\.)/);
  if (typoMatch) {
    sections.push("## Typography");
    // Extract font stack and hierarchy table
    const fontStackMatch = typoMatch[1].match(/### Font Stack\s*\n([\s\S]*?)(?=\n###|\n\|)/);
    if (fontStackMatch) {
      sections.push(fontStackMatch[1].trim());
    }
    const tableMatch = typoMatch[1].match(/\| Role[\s\S]*?(?=\n\n|\n---|\n##)/);
    if (tableMatch) {
      sections.push(tableMatch[0].trim());
    }
  }

  // Extract component stylings section (§4) — buttons and cards
  const compMatch = designContent.match(/## 4\. Component Stylings\s*\n([\s\S]*?)(?=\n---|\n## 5\.)/);
  if (compMatch) {
    sections.push("## Component Styles");
    sections.push(compMatch[1].trim());
  }

  // Extract spacing scale from layout section (§5)
  const layoutMatch = designContent.match(/### Spacing Scale[^\n]*\n([^\n]+)/);
  if (layoutMatch) {
    sections.push("## Spacing Scale");
    sections.push(layoutMatch[1].trim());
  }

  // Extract landing page composition patterns (§8) if present
  const landingMatch = designContent.match(/## 8\. Landing Page Composition Patterns\s*\n([\s\S]*?)(?=\n---|\n## \d|\s*$)/);
  if (landingMatch) {
    sections.push("## Landing Page Composition Patterns");
    sections.push(landingMatch[1].trim());
  }

  if (sections.length === 0) return null;

  return sections.join("\n\n");
}

export function build_task_prompt(
  agent: AgentRow,
  task: TaskRow,
  task_manager: TaskManager,
  workspace_dir: string,
  skills?: AgentSkillRow[],
): string {
  const parts: string[] = [];
  const acceptance_criteria = parse_json_array<CriterionValidationResult["criterion"]>(task.acceptance_criteria);
  const depends_on = parse_json_array<string>(task.depends_on);
  const dependency_tasks = depends_on
    .map((dep_id) => task_manager.get_task(dep_id))
    .filter((dep): dep is TaskRow => Boolean(dep));
  const milestone = task_manager.get_milestones(task.company_id).find((row) => row.id === task.milestone_id);

  parts.push("# Your Task");
  parts.push(`**${task.title}**`);
  if (task.description) parts.push(task.description);
  parts.push(`Task ID: ${task.id}`);
  parts.push(`Agent ID: ${agent.id}`);

  // Show who created this task (matters for status routing, especially QA)
  if (task.created_by) {
    const creator = task_manager.get_agent(task.created_by);
    if (creator && creator.blueprint_id) {
      parts.push(`Assigned by: ${creator.name} (${creator.blueprint_id})`);
    }
  }

  // Goal ancestry: inject parent task context so the agent understands
  // how this task fits into the larger goal hierarchy
  if (task.parent_task_id) {
    const ancestry: Array<{ title: string; description: string | null }> = [];
    let current_parent_id: string | null = task.parent_task_id;
    const visited = new Set<string>();
    while (current_parent_id && !visited.has(current_parent_id)) {
      visited.add(current_parent_id);
      const parent = task_manager.get_task(current_parent_id);
      if (!parent) break;
      ancestry.unshift({ title: parent.title, description: parent.description });
      current_parent_id = parent.parent_task_id;
    }
    if (ancestry.length > 0) {
      parts.push("# Goal Ancestry");
      parts.push("This task is part of a larger goal hierarchy:");
      for (const [index, ancestor] of ancestry.entries()) {
        const indent = "  ".repeat(index);
        parts.push(`${indent}→ **${ancestor.title}**${ancestor.description ? `: ${ancestor.description}` : ""}`);
      }
      parts.push("");
      parts.push("Keep this broader context in mind while working on your task.");
    }
  }

  parts.push("# When You Are Done");
  parts.push("Your task is complete when ALL of the following are true:");
  for (const criterion of acceptance_criteria) {
    parts.push(`- ${humanize_criterion(criterion)}`);
  }

  if (dependency_tasks.length > 0) {
    parts.push("# Available Inputs (from dependencies)");
    for (const dep of dependency_tasks) {
      parts.push(`- **${dep.title}**: ${dep.artifact ?? "No artifact recorded"}`);
    }
  }

  if (milestone && milestone.sort_order > 0) {
    const previous = task_manager
      .get_milestones(task.company_id)
      .filter((row) => row.status === "done" && row.sort_order < milestone.sort_order)
      .flatMap((row) => task_manager.get_tasks(task.company_id).filter((task_row) => task_row.milestone_id === row.id))
      .filter((row) => row.status === "done" && row.artifact);
    if (previous.length > 0) {
      parts.push("# Artifacts from Previous Milestones");
      for (const prev of previous) {
        parts.push(`- **${prev.title}**: ${prev.artifact}`);
      }
    }
  }

  if (task.turns_spent > 0) {
    parts.push("# Context");
    parts.push(`This is turn ${task.turns_spent + 1} for this task.`);
    parts.push("Continue where you left off. Your previous conversation is preserved.");
  }

  // Inject skill instructions for this agent
  if (skills && skills.length > 0) {
    parts.push("# Agent Skills");
    parts.push("You have the following skills available. Apply them as relevant to your task:");
    for (const skill of skills) {
      parts.push(`## Skill: ${skill.name}`);
      if (skill.description) {
        parts.push(skill.description);
      }
      if (skill.instructions) {
        parts.push(skill.instructions);
      }
    }
  }

  // Inject DESIGN.md content when the task involves UI/design work
  if (task_involves_design(task)) {
    const designPath = join(workspace_dir, "docs", "DESIGN.md");
    let designInlined = false;
    try {
      if (existsSync(designPath)) {
        const designContent = readFileSync(designPath, "utf8");
        const summary = extract_design_summary(designContent);
        if (summary) {
          parts.push("# Design System");
          parts.push("The following design system is MANDATORY for all visual output. Apply these styles exactly — do not invent your own colors, fonts, or component styles.");
          parts.push(summary);
          designInlined = true;
        }
      }
    } catch {
      // File read error — fall through to generic instruction
    }
    if (!designInlined) {
      parts.push("# Design System");
      parts.push("Read docs/DESIGN.md for the design system. All visual output must follow these guidelines. The DESIGN.md contains the color palette, typography, component styles, layout principles, and responsive behavior for this company.");
    }
  }

  parts.push("# Important");
  parts.push("The system automatically detects task completion by checking the acceptance criteria above after each turn. Focus on meeting all criteria.");
  parts.push(`If you are blocked and cannot proceed, write /workspace/.agent/${agent.id}/task_blocked.json with:`);
  parts.push(`{"task_id":"${task.id}","reason":"<what is blocking you>"}`);
  parts.push("Do not work on anything other than this task.");

  return parts.join("\n\n").replaceAll(workspace_dir, "/workspace");
}

export interface AgentSignals {
  task_signal: TaskSignal | null;
  subtask_request: SubtaskRequestPayload | null;
}

export function check_agent_signals(
  workspace_dir: string,
  agent: AgentRow,
  task: TaskRow,
): AgentSignals {
  const signal_dir = join(workspace_dir, ".agent", agent.id);
  const done_path = join(signal_dir, "task_done.json");
  const blocked_path = join(signal_dir, "task_blocked.json");
  const subtask_path = join(signal_dir, "subtask_request.json");

  let task_signal: TaskSignal | null = null;
  let subtask_request: SubtaskRequestPayload | null = null;

  try {
    const raw = readFileSync(done_path, "utf8");
    const payload = parse_json<TaskDonePayload>(raw);
    rmSync(done_path, { force: true });
    if (payload.task_id === task.id) {
      task_signal = { type: "done", payload };
    }
  } catch {
    // Signal file doesn't exist or is unreadable — not an error
  }

  if (!task_signal) {
    try {
      const raw = readFileSync(blocked_path, "utf8");
      const payload = parse_json<TaskBlockedPayload>(raw);
      rmSync(blocked_path, { force: true });
      if (payload.task_id === task.id) {
        task_signal = { type: "blocked", payload };
      }
    } catch {
      // Signal file doesn't exist or is unreadable — not an error
    }
  }

  try {
    const raw = readFileSync(subtask_path, "utf8");
    subtask_request = parse_json<SubtaskRequestPayload>(raw);
    rmSync(subtask_path, { force: true });
  } catch {
    // No subtask request — not an error
  }

  return { task_signal, subtask_request };
}

export class AgentRunner {
  private readonly active_abort_controllers = new Map<string, AbortController>();
  private readonly pending_retry_timers = new Map<string, NodeJS.Timeout>();
  /** Cooldown tracker: maps "company_id:doc_path" → timestamp of last document_revision event */
  private readonly last_doc_revision_at = new Map<string, number>();
  private static readonly DOC_REVISION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

  constructor(
    private readonly db: SupervisorDb,
    private readonly task_manager: TaskManager,
    private readonly credit_manager: CreditManager,
    private readonly invoker: AgentInvoker,
    private readonly callbacks: AgentRunnerCallbacks,
  ) {}

  /** Returns true if an active invocation (abort controller) exists for the given agent. */
  has_active_invocation(agent_id: string): boolean {
    return this.active_abort_controllers.has(agent_id);
  }

  /** Remove the abort controller for an agent (used by watchdog after force-aborting). */
  clear_abort_controller(agent_id: string): void {
    this.active_abort_controllers.delete(agent_id);
  }

  async wake_agent(agent: AgentRow, task: TaskRow, override_prompt: string | null = null): Promise<void> {
    // Guard: prevent double invocation if agent is already working
    const fresh_agent = this.task_manager.get_agent(agent.id);
    if (fresh_agent?.status === "working") {
      console.warn(`[agent-runner] Skipping wake_agent for ${agent.id}: already working`);
      return;
    }
    // Guard: prevent concurrent invocations via abort controller presence
    if (this.active_abort_controllers.has(agent.id)) {
      console.warn(`[agent-runner] Skipping wake_agent for ${agent.id}: active invocation in progress`);
      return;
    }

    const company = this.task_manager.get_company(task.company_id);
    // Guard: don't start new turns if company is paused or terminated
    if (company && company.state !== "running" && company.state !== "planning") {
      console.warn(`[agent-runner] Skipping wake_agent for ${agent.id}: company ${task.company_id} is ${company.state}`);
      return;
    }
    if (!company?.workspace_dir) {
      throw new Error(`Company ${task.company_id} has no workspace_dir`);
    }
    if (!existsSync(company.workspace_dir)) {
      console.error(`[agent-runner] Workspace missing for company ${task.company_id}: ${company.workspace_dir}`);
      await this.callbacks.pause_company_missing_workspace(task.company_id);
      return;
    }
    const base_turn_limits = this.invoker.getTurnLimits(agent);
    const available_credits = this.credit_manager.get_balance(company.user_id);
    const turn_limits = fit_turn_limits_to_available_credits(agent.model_tier, base_turn_limits, available_credits);
    const reserved_credits = calculate_turn_credit_reservation(agent.model_tier, turn_limits);
    if (!this.credit_manager.reserve_credits(company.user_id, reserved_credits, company.id)) {
      const total_balance = this.credit_manager.get_total_balance(company.user_id);
      if (total_balance <= 0) {
        await this.callbacks.pause_company(task.company_id);
      } else {
        console.warn(
          `[agent-runner] Skipping wake_agent for ${agent.id}: ${reserved_credits} credits unavailable right now (total=${total_balance}, available=${this.credit_manager.get_balance(company.user_id)})`,
        );
      }
      return;
    }
    const existing_retry = this.pending_retry_timers.get(agent.id);
    if (existing_retry) {
      clearTimeout(existing_retry);
      this.pending_retry_timers.delete(agent.id);
    }

    const workspace_dir = company.workspace_dir;
    mkdirSync(join(workspace_dir, ".agent", agent.id), { recursive: true });

    this.db.run(
      `
        UPDATE tasks
        SET status = 'in_progress',
            started_at = COALESCE(started_at, ?)
        WHERE id = ?
      `,
      [isoNow(), task.id],
    );
    const wake_at = isoNow();
    this.db.run(
      `
        UPDATE agents
        SET status = 'working',
            current_task_id = ?,
            last_wake_at = ?
        WHERE id = ?
      `,
      [task.id, wake_at, agent.id],
    );
    this.db.enqueue_sync("tasks", task.id, "upsert", { status: "in_progress", started_at: wake_at });
    this.db.enqueue_sync("agents", agent.id, "upsert", { status: "working", current_task_id: task.id, last_wake_at: wake_at });

    const abort_controller = new AbortController();
    let reservation_settled = false;
    try {
      const before = fingerprint_workspace(workspace_dir);
      const agent_skills = this.db.all<AgentSkillRow>(
        `SELECT skill_slug, name, description, instructions FROM agent_skills WHERE agent_id = ?`,
        [agent.id],
      );
      const prompt = override_prompt ?? build_task_prompt(agent, task, this.task_manager, workspace_dir, agent_skills);
      this.active_abort_controllers.set(agent.id, abort_controller);
      const result = await this.invoker.invoke(agent, prompt, workspace_dir, {
        systemPromptOverride: build_system_prompt(agent, company, this.get_telemetry_rows(company.id)),
        abortController: abort_controller,
        turnLimits: turn_limits,
      });
      const after = fingerprint_workspace(workspace_dir);
      const artifact_changed = before !== after ? 1 : 0;
      const output_summary = extract_summary(result.output, task.title);
      const company_paused = this.task_manager.get_company(task.company_id)?.state === "paused";
      const credits = calculate_turn_credits(agent.model_tier, result.tokenUsage);
      const billed_credits = company_paused ? 0 : credits;
      const charged_credits = this.credit_manager.settle_reserved_credits(
        company.user_id,
        reserved_credits,
        billed_credits,
        {
          company_id: company.id,
          agent_id: agent.id,
          model_tier: agent.model_tier,
          description: task.title,
        },
      );
      reservation_settled = true;
      this.invoker.recordSessionCredits(agent.id, charged_credits);

      this.db.run(
        `
          INSERT INTO turn_log (
            company_id, agent_id, task_id, input_tokens, output_tokens, credits_spent,
            tool_call_count, artifact_changed, agent_declared_done, output_summary,
            error, duration_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          company.id,
          agent.id,
          task.id,
          result.tokenUsage.inputTokens,
          result.tokenUsage.outputTokens,
          charged_credits,
          result.toolCallCount,
          artifact_changed,
          0,
          output_summary,
          result.error ?? null,
          result.durationMs,
          isoNow(),
        ],
      );
      const turn_log_id = this.db.get<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;

      this.db.run(
        `
          UPDATE tasks
          SET credits_spent = credits_spent + ?,
              turns_spent = turns_spent + 1
          WHERE id = ?
        `,
        [charged_credits, task.id],
      );
      this.db.run(
        `
          UPDATE agents
          SET total_credits = total_credits + ?,
              session_id = COALESCE(?, session_id)
          WHERE id = ?
        `,
        [charged_credits, result.sessionId ?? null, agent.id],
      );
      this.db.enqueue_sync("turn_log", String(turn_log_id), "upsert", {
        company_id: company.id,
        agent_id: agent.id,
        task_id: task.id,
        output_summary,
        credits_spent: charged_credits,
        input_tokens: result.tokenUsage.inputTokens,
        output_tokens: result.tokenUsage.outputTokens,
        tool_call_count: result.toolCallCount,
        artifact_changed,
        error: result.error ?? null,
        duration_ms: result.durationMs,
        created_at: isoNow(),
      });
      this.db.enqueue_sync("tasks", task.id, "upsert", {
        credits_spent: (this.task_manager.get_task(task.id)?.credits_spent ?? task.credits_spent) + charged_credits,
        turns_spent: (this.task_manager.get_task(task.id)?.turns_spent ?? task.turns_spent) + 1,
      });
      this.db.enqueue_sync("agents", agent.id, "upsert", {
        total_credits: (this.task_manager.get_agent(agent.id)?.total_credits ?? agent.total_credits) + charged_credits,
        session_id: result.sessionId ?? agent.session_id,
      });

      const signals = check_agent_signals(workspace_dir, agent, task);

      // Process subtask delegation request (e.g. CTO creating tasks for engineers)
      if (signals.subtask_request) {
        await this.callbacks.process_subtask_request(task.company_id, agent, signals.subtask_request);
      }

      // Record sleep time for dashboard visibility
      const sleep_at = isoNow();
      this.db.run(`UPDATE agents SET last_sleep_at = ? WHERE id = ?`, [sleep_at, agent.id]);
      this.db.enqueue_sync("agents", agent.id, "upsert", { last_sleep_at: sleep_at });

      // Release the abort controller BEFORE post-turn processing.
      // on_agent_turn_finished may trigger CEO turns (notify_ceo → invoke_ceo_turn)
      // which can take up to 1 hour. Without this, the agent is blocked by its own
      // stale abort controller during that entire time.
      this.active_abort_controllers.delete(agent.id);

      await this.on_agent_turn_finished(agent.id, task.id, result, signals.task_signal);
    } catch (err) {
      // Reset agent to idle so it doesn't get permanently stuck in 'working'
      this.db.run(
        `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
        [agent.id],
      );
      this.db.enqueue_sync("agents", agent.id, "upsert", {
        status: "idle",
        current_task_id: null,
      });
      console.error(`[agent-runner] wake_agent failed for agent ${agent.id} on task ${task.id}:`, err);
      throw err;
    } finally {
      this.active_abort_controllers.delete(agent.id);
      if (!reservation_settled) {
        this.credit_manager.release_reserved_credits(company.user_id, reserved_credits, company.id);
      }
    }
  }

  abort_agent_turn(agent_id: string): void {
    this.active_abort_controllers.get(agent_id)?.abort();
    const pending_retry = this.pending_retry_timers.get(agent_id);
    if (pending_retry) {
      clearTimeout(pending_retry);
      this.pending_retry_timers.delete(agent_id);
    }
  }

  abort_all_turns(): void {
    for (const agent_id of this.active_abort_controllers.keys()) {
      this.active_abort_controllers.get(agent_id)?.abort();
    }
    for (const timer of this.pending_retry_timers.values()) {
      clearTimeout(timer);
    }
    this.pending_retry_timers.clear();
  }

  async on_agent_turn_finished(
    agent_id: string,
    task_id: string,
    result: AgentTurnResult,
    signal: TaskSignal | null,
  ): Promise<void> {
    const task = this.task_manager.get_task(task_id);
    const agent = this.task_manager.get_agent(agent_id);
    if (!task || !agent) {
      return;
    }

    if (result.error) {
      const company = this.task_manager.get_company(task.company_id);
      if (result.aborted && company?.state === "paused") {
        this.db.run(`UPDATE agents SET status = 'paused' WHERE id = ?`, [agent_id]);
        this.db.enqueue_sync("agents", agent_id, "upsert", { status: "paused" });
        return;
      }

      const consecutive_failures = this.count_consecutive_task_failures(task_id);
      if (consecutive_failures <= 2 && company?.state === "running") {
        const retry_delay_ms = 30_000 * 2 ** (consecutive_failures - 1);
        const retry_reason = `Automatic retry ${consecutive_failures}/2 in ${Math.round(retry_delay_ms / 1000)}s: ${result.error}`;
        this.db.run(
          `UPDATE tasks SET status = 'blocked', blocked_reason = ? WHERE id = ?`,
          [retry_reason, task_id],
        );
        this.db.run(
          `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
          [agent_id],
        );
        this.db.enqueue_sync("tasks", task_id, "upsert", {
          status: "blocked",
          blocked_reason: retry_reason,
        });
        this.db.enqueue_sync("agents", agent_id, "upsert", {
          status: "idle",
          current_task_id: null,
        });

        const retry_prompt = [
          "# Retry Required",
          "",
          `Your last attempt failed with: ${result.error}`,
          "Retry this task with a smaller, safer step.",
          "Focus on producing the required workspace artifact or a clear blocker signal.",
          "Do not restate the whole plan. Change files and move the task forward.",
        ].join("\n");

        const existing_retry = this.pending_retry_timers.get(agent_id);
        if (existing_retry) {
          clearTimeout(existing_retry);
        }
        const timer = setTimeout(() => {
          this.pending_retry_timers.delete(agent_id);
          const latest_task = this.task_manager.get_task(task_id);
          const latest_agent = this.task_manager.get_agent(agent_id);
          const latest_company = this.task_manager.get_company(task.company_id);
          if (!latest_task || !latest_agent || !latest_company) return;
          if (latest_company.state !== "running") return;
          if (latest_agent.status !== "idle") return;
          if (latest_task.status !== "blocked") return;
          void this.wake_agent(latest_agent, latest_task, retry_prompt);
        }, retry_delay_ms);
        this.pending_retry_timers.set(agent_id, timer);
        return;
      }

      this.db.run(
        `UPDATE tasks SET status = 'failed', blocked_reason = ? WHERE id = ?`,
        [result.error, task_id],
      );
      this.db.run(
        `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
        [agent_id],
      );
      this.db.enqueue_sync("tasks", task_id, "upsert", {
        status: "failed",
        blocked_reason: result.error,
      });
      this.db.enqueue_sync("agents", agent_id, "upsert", {
        status: "idle",
        current_task_id: null,
      });
      // Route status to the agent's manager per the hierarchy, falling back to CEO
      const fail_report_target = agent.blueprint_id ? getReportTarget(agent.blueprint_id) : undefined;
      if (fail_report_target) {
        await this.callbacks.notify_manager(task.company_id, fail_report_target, "task_failed", {
          task_id,
          task_title: task.title,
          reason: result.error,
        });
      } else {
        await this.callbacks.notify_ceo(task.company_id, "task_failed", {
          task_id,
          task_title: task.title,
          reason: result.error,
        });
      }
      return;
    }

    // Primary completion check: acceptance criteria (most reliable)
    const company_for_ac = this.task_manager.get_company(task.company_id);
    if (company_for_ac?.workspace_dir) {
      const ws = company_for_ac.workspace_dir;
      const criteria = parse_acceptance_criteria(task.acceptance_criteria);
      if (criteria.length > 0 && criteria.every((c) => check_criterion(ws, c))) {
        const artifact = signal?.type === "done" ? signal.payload.artifact : find_criterion_artifact(criteria, ws);
        console.log(`[agent-runner] Completing task ${task_id} — all acceptance criteria met`);
        this.db.run(`UPDATE tasks SET artifact = ? WHERE id = ?`, [artifact, task_id]);
        this.db.enqueue_sync("tasks", task_id, "upsert", { artifact });
        this.db.run(
          `UPDATE turn_log SET agent_declared_done = 1
           WHERE agent_id = ? AND task_id = ?
             AND id = (SELECT id FROM turn_log WHERE agent_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1)`,
          [agent_id, task_id, agent_id, task_id],
        );
        try {
          await this.callbacks.on_task_completed(task_id);
        } catch (err) {
          console.error(`[agent-runner] on_task_completed failed for task ${task_id}, resetting agent ${agent_id} to idle:`, err);
          this.db.run(`UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`, [agent_id]);
          this.db.enqueue_sync("agents", agent_id, "upsert", { status: "idle", current_task_id: null });
        }
        return;
      }
    }

    // Secondary: signal file (backward compat — agent explicitly declared done)
    if (signal?.type === "done") {
      this.db.run(`UPDATE tasks SET artifact = ? WHERE id = ?`, [signal.payload.artifact, task_id]);
      this.db.enqueue_sync("tasks", task_id, "upsert", { artifact: signal.payload.artifact });
      this.db.run(
        `UPDATE turn_log SET agent_declared_done = 1
         WHERE agent_id = ? AND task_id = ?
           AND id = (SELECT id FROM turn_log WHERE agent_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1)`,
        [agent_id, task_id, agent_id, task_id],
      );
      try {
        await this.callbacks.on_task_completed(task_id);
      } catch (err) {
        console.error(`[agent-runner] on_task_completed failed for task ${task_id}, resetting agent ${agent_id} to idle:`, err);
        this.db.run(`UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`, [agent_id]);
        this.db.enqueue_sync("agents", agent_id, "upsert", { status: "idle", current_task_id: null });
      }
      return;
    }

    if (signal?.type === "blocked") {
      this.db.run(
        `UPDATE tasks SET status = 'blocked', blocked_reason = ? WHERE id = ?`,
        [signal.payload.reason, task_id],
      );
      this.db.run(
        `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
        [agent_id],
      );
      this.db.enqueue_sync("tasks", task_id, "upsert", {
        status: "blocked",
        blocked_reason: signal.payload.reason,
      });
      this.db.enqueue_sync("agents", agent_id, "upsert", {
        status: "idle",
        current_task_id: null,
      });
      // Route blocker to the agent's manager per the hierarchy, falling back to CEO
      const block_report_target = agent.blueprint_id ? getReportTarget(agent.blueprint_id) : undefined;
      if (block_report_target) {
        await this.callbacks.notify_manager(task.company_id, block_report_target, "task_blocked", {
          task_id,
          task_title: task.title,
          reason: signal.payload.reason,
        });
      } else {
        await this.callbacks.notify_ceo(task.company_id, "task_blocked", {
          task_id,
          task_title: task.title,
          reason: signal.payload.reason,
        });
      }
      return;
    }

    // No completion detected — auto-retry with a tighter limit since criteria check is reliable
    const MAX_TOTAL_TURNS_BEFORE_BLOCK = 6;
    const total_turns = task.turns_spent ?? 0;
    if (total_turns >= MAX_TOTAL_TURNS_BEFORE_BLOCK) {
      const block_reason = `This task has used ${total_turns} turns without completing. It likely needs to be broken into smaller pieces or has a real blocker that should be escalated.`;
      this.db.run(
        `UPDATE tasks SET status = 'blocked', blocked_reason = ? WHERE id = ?`,
        [block_reason, task_id],
      );
      this.db.run(
        `UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`,
        [agent_id],
      );
      this.db.enqueue_sync("tasks", task_id, "upsert", {
        status: "blocked",
        blocked_reason: block_reason,
      });
      this.db.enqueue_sync("agents", agent_id, "upsert", {
        status: "idle",
        current_task_id: null,
      });
      const report_target = agent.blueprint_id ? getReportTarget(agent.blueprint_id) : undefined;
      if (report_target) {
        await this.callbacks.notify_manager(task.company_id, report_target, "task_blocked", {
          task_id,
          task_title: task.title,
          reason: block_reason,
        });
      } else {
        await this.callbacks.notify_ceo(task.company_id, "task_blocked", {
          task_id,
          task_title: task.title,
          reason: block_reason,
        });
      }
      return;
    }
    // Otherwise, auto-retry: just let the agent go again on next schedule.

    const company = this.task_manager.get_company(task.company_id);
    if (!company) return;
    const balance = this.credit_manager.get_balance(company.user_id);
    if (balance <= 0) {
      await this.callbacks.pause_company(task.company_id);
      return;
    }

    this.db.run(`UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?`, [agent_id]);
    this.db.enqueue_sync("agents", agent_id, "upsert", { status: "idle", current_task_id: null });
    await this.callbacks.schedule(task.company_id);
  }

  private count_consecutive_task_failures(task_id: string): number {
    const turns = this.db.all<{ error: string | null }>(
      `
        SELECT error
        FROM turn_log
        WHERE task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 5
      `,
      [task_id],
    );
    let count = 0;
    for (const turn of turns) {
      if (!turn.error) break;
      count += 1;
    }
    return count;
  }

  /** Count consecutive turns where agent finished without writing a signal file (no done, no blocked, no error). */
  private count_consecutive_no_signal_turns(task_id: string): number {
    const turns = this.db.all<{ error: string | null; agent_declared_done: number }>(
      `
        SELECT error, agent_declared_done
        FROM turn_log
        WHERE task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 5
      `,
      [task_id],
    );
    let count = 0;
    for (const turn of turns) {
      // A turn with no error and no done signal = no-signal turn
      if (turn.error || turn.agent_declared_done) break;
      count += 1;
    }
    return count;
  }

  get_telemetry_rows(company_id: string): TelemetryMirrorRow[] {
    return this.db.all<TelemetryMirrorRow>(
      `
        SELECT *
        FROM telemetry_mirror
        WHERE company_id = ?
          AND verification_level IN ('system_verified', 'evidence_attached')
        ORDER BY occurred_at DESC
      `,
      [company_id],
    );
  }

  check_document_budgets(company_id: string): void {
    const company = this.task_manager.get_company(company_id);
    if (!company?.workspace_dir) return;

    const now = new Date();
    const today_pt = format_pt_iso_date(now);
    const today_day_number = compute_day_number(company, now);

    const checks = [
      // min=25 aligned with CEO system prompt ("30-80 words"), with slight tolerance
      { path: "docs/mission.md", min: 25, max: 320, max_age_days: undefined, expected_pt_date: undefined, expected_day_number: undefined },
      { path: `docs/daily-update-${today_pt}.md`, min: 40, max: 140, max_age_days: 1, expected_pt_date: today_pt, expected_day_number: today_day_number },
    ];

    for (const check of checks) {
      const full = join(company.workspace_dir, check.path);
      if (!existsSync(full)) continue;
      const content = readFileSync(full, "utf8");
      const words = count_words(strip_markdown(content));
      const ready = this.is_document_ready(
        content,
        check.min,
        check.max,
        full,
        check.max_age_days,
        check.expected_pt_date,
        check.expected_day_number,
      );
      if (!ready) {
        // Cooldown: skip if a document_revision was already fired for this doc recently
        const cooldown_key = `${company_id}:${check.path}`;
        const last_fired = this.last_doc_revision_at.get(cooldown_key) ?? 0;
        if (Date.now() - last_fired < AgentRunner.DOC_REVISION_COOLDOWN_MS) {
          continue;
        }
        this.last_doc_revision_at.set(cooldown_key, Date.now());
        void this.callbacks.notify_ceo(company_id, "document_revision", {
          path: check.path,
          word_count: words,
          min: check.min,
          max: check.max,
        });
      }
    }
  }

  get_founder_documents(company_id: string): Array<{ type: string; title: string; content: string; path: string; date?: string; created_at?: string }> {
    const company = this.task_manager.get_company(company_id);
    if (!company?.workspace_dir) return [];
    const docs: Array<{ type: string; title: string; content: string; path: string; date?: string; created_at?: string }> = [];
    const workspace = company.workspace_dir;

    const missionPath = join(workspace, "docs", "mission.md");
    if (existsSync(missionPath)) {
      const mission = readFileSync(missionPath, "utf8");
      // Mission is the founder's own idea — skip commercial-claims filter (only check word count)
      const missionWords = count_words(strip_markdown(mission));
      if (mission.trim() && !mission.toLowerCase().startsWith("pending") && missionWords >= 25 && missionWords <= 360) {
        docs.push({
          type: "mission",
          title: "Mission",
          content: mission,
          path: "docs/mission.md",
          created_at: statSync(missionPath).mtime.toISOString(),
        });
      }
    }

    const planPath = join(workspace, "docs", "plan.md");
    if (existsSync(planPath)) {
      const plan = readFileSync(planPath, "utf8");
      const planWords = count_words(strip_markdown(plan));
      if (plan.trim() && !plan.toLowerCase().startsWith("pending") && planWords >= 20) {
        docs.push({
          type: "plan",
          title: "Current Plan",
          content: plan,
          path: "docs/plan.md",
          created_at: statSync(planPath).mtime.toISOString(),
        });
      }
    }

    for (let day_offset = 0; day_offset < 7; day_offset += 1) {
      const date = new Date(Date.now() - day_offset * 86_400_000);
      const ptDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
      const updatePath = join(workspace, "docs", `daily-update-${ptDate}.md`);
      if (!existsSync(updatePath)) continue;
      const update = readFileSync(updatePath, "utf8");
      const file_day_number = compute_day_number(company, date);
      if (!this.is_document_ready(update, 40, 140, updatePath, undefined, ptDate, file_day_number)) continue;
      docs.push({
        type: "daily_update",
        title: `Daily Executive Brief — Day ${file_day_number}`,
        content: update,
        path: updatePath,
        date: ptDate,
        created_at: statSync(updatePath).mtime.toISOString(),
      });
    }

    // Surface any additional agent-created docs (e.g. positioning.md, qa reports)
    const knownFiles = new Set(["mission.md", "plan.md", "executive-brief.md", "goal.md", "execution-contract.json", "DESIGN.md"]);
    const docsDir = join(workspace, "docs");
    if (existsSync(docsDir)) {
      for (const entry of readdirSync(docsDir)) {
        if (!entry.endsWith(".md") && !entry.endsWith(".txt")) continue;
        if (knownFiles.has(entry)) continue;
        if (entry.startsWith("daily-update-")) continue;
        const filePath = join(docsDir, entry);
        const content = readFileSync(filePath, "utf8").trim();
        if (!content || content.length < 20) continue;
        const title = entry
          .replace(/\.(md|txt)$/, "")
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        docs.push({
          type: "document",
          title,
          content,
          path: `docs/${entry}`,
          created_at: statSync(filePath).mtime.toISOString(),
        });
      }
    }

    return docs;
  }

  private is_document_ready(
    content: string,
    min_words: number,
    max_words: number,
    file_path?: string,
    max_age_days?: number,
    expected_pt_date?: string,
    expected_day_number?: number,
  ): boolean {
    const lower = content.toLowerCase();
    if (!content.trim()) return false;
    if (lower.includes("pending ceo brief") || lower.startsWith("pending")) return false;
    if (contains_ungrounded_commercial_claims(content)) return false;
    const words = count_words(strip_markdown(content));
    if (words < min_words || words > max_words) return false;

    // Date freshness check: reject documents older than max_age_days
    if (file_path && max_age_days !== undefined) {
      try {
        const stat = statSync(file_path);
        const age_ms = Date.now() - stat.mtimeMs;
        if (age_ms > max_age_days * 86_400_000) return false;
      } catch {
        // If stat fails, skip freshness check
      }
    }

    if (expected_pt_date && !document_has_expected_date(content, expected_pt_date)) {
      return false;
    }
    if (
      expected_day_number !== undefined
      && !document_has_expected_day_number(content, expected_day_number)
    ) {
      return false;
    }

    return true;
  }
}

// ── Acceptance criteria auto-validation ────────────────────────────────

function parse_acceptance_criteria(raw: string | AcceptanceCriterion[]): AcceptanceCriterion[] {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function check_criterion(workspace_dir: string, criterion: AcceptanceCriterion): boolean {
  switch (criterion.type) {
    case "file_exists": {
      const full = workspace_path(workspace_dir, criterion.path);
      return existsSync(full);
    }
    case "file_not_empty": {
      const full = workspace_path(workspace_dir, criterion.path);
      try {
        const stat = statSync(full);
        return stat.size > 0;
      } catch {
        return false;
      }
    }
    case "directory_exists": {
      const full = workspace_path(workspace_dir, criterion.path);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    }
    case "file_contains": {
      const full = workspace_path(workspace_dir, criterion.path);
      try {
        const content = readFileSync(full, "utf8");
        return content.includes(criterion.substring);
      } catch {
        return false;
      }
    }
    case "file_count_gte": {
      try {
        const matches = list_workspace_files(workspace_dir)
          .filter((f) => f.match(criterion.glob.replace(/\*/g, ".*")));
        return matches.length >= criterion.min;
      } catch {
        return false;
      }
    }
    case "command_succeeds": {
      try {
        execSync(criterion.command, {
          cwd: workspace_dir,
          timeout: 30_000,
          stdio: "pipe",
        });
        return true;
      } catch {
        return false;
      }
    }
    // custom cannot be auto-validated
    default:
      return false;
  }
}

function find_criterion_artifact(criteria: AcceptanceCriterion[], workspace_dir: string): string | null {
  for (const c of criteria) {
    if ((c.type === "file_exists" || c.type === "file_not_empty") && c.path) {
      const full = workspace_path(workspace_dir, c.path);
      if (existsSync(full)) return full;
    }
  }
  return null;
}
