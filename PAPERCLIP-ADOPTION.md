# Paperclip Pattern Adoption — Proposal

**Context:** Paperclip (github.com/paperclipai/paperclip) is an open-source control plane for AI agent companies. After evaluating it against AI Combinator's architecture, we identified four patterns worth adopting. This document specifies what to implement, what to skip, and why.

**For the evaluating agent:** Read `ARCHITECTURE.md` for our full system spec, `STATUS.md` for current implementation status (all 9 phases complete), and `worker/src/types.ts` for the current D1 schema types.

---

## 1. Atomic Task Checkout

### What Paperclip Does

When an agent wants to work on a task, it calls `POST /issues/:id/checkout`. The server executes a single SQL UPDATE with a WHERE clause that checks both the expected status AND that no other agent owns the task:

```sql
UPDATE issues
SET assignee_agent_id = ?, status = 'in_progress', started_at = datetime('now')
WHERE id = ?
  AND status IN ('todo', 'backlog')
  AND (assignee_agent_id IS NULL OR assignee_agent_id = ?)
```

If the row isn't updated (another agent claimed it first), the server returns 409 Conflict with the current owner. No application-level locks, no race conditions.

### What We Have Now

Our `tasks` table has `owner_agent_id` and `status`, but no checkout semantics. Any agent can update any task's `owner_agent_id` via `PATCH /api/tasks/:id`. Two agents could simultaneously claim the same task and the last write wins silently. There is no conflict detection.

### What to Implement

**Database change:** Add two columns to the `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN checked_out_at TEXT;
ALTER TABLE tasks ADD COLUMN checkout_run_id TEXT;
```

`checked_out_at` records when the task was claimed. `checkout_run_id` ties the checkout to a specific agent invocation (heartbeat run), so we can detect stale checkouts if an agent crashes mid-work.

**New API endpoint:** `POST /api/companies/:companyId/tasks/:taskId/checkout`

Request body:
```json
{
  "agent_id": "agent_abc",
  "run_id": "run_xyz"
}
```

Handler logic:
```sql
UPDATE tasks
SET owner_agent_id = ?,
    status = 'in_progress',
    checked_out_at = datetime('now'),
    checkout_run_id = ?,
    updated_at = datetime('now')
WHERE id = ?
  AND company_id = ?
  AND status IN ('todo', 'blocked')
  AND (owner_agent_id IS NULL OR owner_agent_id = ?)
```

If `changes === 0`, query the current task state and return 409 with:
```json
{
  "error": "Task already checked out",
  "current_owner": "agent_def",
  "current_status": "in_progress"
}
```

**Release endpoint:** `POST /api/companies/:companyId/tasks/:taskId/release`

For when an agent can't finish and wants to relinquish the task:
```sql
UPDATE tasks
SET owner_agent_id = NULL,
    status = 'todo',
    checked_out_at = NULL,
    checkout_run_id = NULL,
    updated_at = datetime('now')
WHERE id = ?
  AND company_id = ?
  AND owner_agent_id = ?
```

Only the owning agent can release. Prevents one agent from stealing another's work.

**Stale checkout detection:** In the supervisor's cron loop (already runs every 60 seconds), add a check:

```sql
SELECT id, owner_agent_id, checked_out_at
FROM tasks
WHERE status = 'in_progress'
  AND checked_out_at < datetime('now', '-30 minutes')
```

Tasks checked out more than 30 minutes ago with no completion are likely stale (agent crashed or timed out). The supervisor releases them back to `todo` and logs an activity event.

**Supervisor tool exposure:** Agents need to call checkout/release. Add these as MCP tools or direct API calls from the agent's context:
- `checkout_task(task_id)` — claims the task atomically
- `release_task(task_id)` — gives it back
- `complete_task(task_id, artifact?)` — marks done, clears checkout, records artifact

### Why This Matters

Without atomic checkout, two agents can work on the same task simultaneously. Agent A spends 15 credits building an API, Agent B spends 15 credits building the same API differently. One gets overwritten. 30 credits wasted. With 5,000 credits/month, that's a meaningful loss.

The SQL WHERE clause approach is the simplest correct solution — no distributed locks, no Redis, no application-level mutexes. D1/SQLite handles the atomicity.

### Why Not Just Use Paperclip's Implementation

Paperclip's checkout is tied to their `issues` table which has different columns, status values, and relationships than our `tasks` table. Their checkout also ties into their heartbeat_runs system which we've replaced with our own wakeup_requests and session tracking. The pattern is right; the implementation needs to fit our schema.

---

## 2. Goal Ancestry in Agent Context

### What Paperclip Does

When an agent receives a task, Paperclip's "fat context" mode includes the full goal chain:

```
Company Goal: "Build a SaaS that helps restaurants manage reservations"
  → Project: "MVP Backend"
    → Milestone: "Core API"
      → Task: "Implement the POST /reservations endpoint"
```

The agent sees WHY the task exists, not just WHAT to do. This improves reasoning quality because the agent can make better decisions when it understands the strategic context.

### What We Have Now

Our `tasks` table has `parent_task_id` for hierarchy, but when the supervisor wakes an agent, it only passes the immediate task details. The agent doesn't know the parent task, the company goal, or how this task fits into the bigger picture.

Our `companies` table has a `goal` field. Our `goals` table exists with `parent_id` for hierarchy. Our `projects` table links goals to issues. But none of this context flows into the agent's prompt at wake time.

### What to Implement

**No schema changes needed.** The tables already exist. This is a prompt engineering change in the supervisor's agent invoker.

**When the supervisor wakes an agent with a task**, build a goal ancestry string:

```typescript
async function buildGoalAncestry(
  d1: D1Client,
  companyId: string,
  taskId: string
): Promise<string> {
  // Get the task
  const task = await d1.getTask(taskId);
  if (!task) return "";

  const parts: string[] = [];

  // Get the company goal
  const company = await d1.getCompany(companyId);
  if (company?.goal) {
    parts.push(`Company Goal: ${company.goal}`);
  }

  // Walk up the task parent chain
  const chain: Array<{ title: string; status: string }> = [];
  let current = task;
  while (current.parent_task_id) {
    const parent = await d1.getTask(current.parent_task_id);
    if (!parent) break;
    chain.unshift({ title: parent.title, status: parent.status });
    current = parent;
  }

  for (const ancestor of chain) {
    parts.push(`  → Parent Task: ${ancestor.title} [${ancestor.status}]`);
  }

  parts.push(`  → Current Task: ${task.title}`);
  if (task.description) {
    parts.push(`    ${task.description}`);
  }

  return parts.join("\n");
}
```

**Inject into the agent's system prompt or wake prompt:**

```
## Current Context

${goalAncestry}

## Your Assignment

${taskDetails}
```

**Also include sibling tasks** so the agent knows what else is happening in parallel:

```typescript
async function getSiblingTasks(d1: D1Client, task: Task): Promise<Task[]> {
  if (!task.parent_task_id) return [];
  return d1.listTasks({
    companyId: task.company_id,
    parentTaskId: task.parent_task_id,
    excludeId: task.id,
  });
}
```

This produces context like:

```
Company Goal: Build a SaaS that helps restaurants manage reservations
  → Parent Task: Build the core reservation API [in_progress]
  → Current Task: Implement POST /reservations endpoint
    Create an endpoint that accepts a reservation request with date, time,
    party size, and contact info. Validate against restaurant hours.
  → Sibling Tasks:
    - GET /reservations — list reservations with filters [done ✓]
    - DELETE /reservations/:id — cancel a reservation [todo]
    - PATCH /reservations/:id — modify a reservation [todo]
```

### Why This Matters

LLMs perform significantly better when they understand purpose. An agent told "Implement POST /reservations" will make different (worse) decisions than one told "You're building a restaurant SaaS, the GET endpoint is already done, and you need to build the POST endpoint that's consistent with it." The quality improvement is free — it costs zero additional credits since the context is tiny compared to the agent's system prompt.

### Why Not Use Paperclip's Deeper Hierarchy

Paperclip has Initiative → Project → Milestone → Issue, four levels. We have companies.goal → tasks with parent_task_id, effectively two levels with unlimited nesting. Adding Initiative/Project/Milestone as first-class entities would mean new tables, new API routes, new dashboard UI, and changes to how agents create work items. The complexity isn't justified yet. Walking the parent chain achieves 90% of the benefit.

If we find agents need more structured planning (and they might — "build the landing page" is too vague without a project plan), we can promote our existing `projects` and `goals` tables into the ancestry chain without schema changes.

---

## 3. Tasks as the Primary Communication Channel

### What Paperclip Does

Paperclip has NO messaging system between agents. Zero. All agent coordination happens through the task tree:

- **Delegation** = creating a task and assigning it to another agent
- **Status updates** = updating task status and adding comments
- **Questions** = commenting on a task asking for clarification
- **Coordination** = reading sibling task statuses before starting work
- **Escalation** = creating a task assigned to a manager

The audit trail is the work itself. No separate Slack-like channel, no relay, no message bus.

### What We Have Now

We have three communication systems:

1. **Agent Relay** (Phase 6) — push-based channels (#all-hands, #engineering, #marketing, etc.) via @agent-relay/sdk. Agents send messages through channels, supervisor wakes target agents.

2. **agent_messages table** (legacy, migration 002) — D1 table with from/to/body/status. Polling-based. Partially deprecated.

3. **Tasks** (Phase 1) — structured work items. Agents can create and update tasks but don't use them for communication yet.

### What to Implement

**Do NOT remove Agent Relay.** It's already built and it serves a purpose Paperclip's model doesn't handle: real-time, unstructured communication. When the CEO wants to broadcast "Strategy change: we're pivoting to enterprise," that's not a task — it's an announcement. Relay handles this.

**But make tasks the PRIMARY coordination mechanism.** Relay becomes the secondary channel for announcements and unstructured discussion. The majority of agent-to-agent coordination should flow through tasks.

**Add task comments to D1:**

```sql
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_task_comments_task ON task_comments (task_id, created_at);
```

**Add task comment API routes:**

- `GET /api/companies/:companyId/tasks/:taskId/comments` — list comments
- `POST /api/companies/:companyId/tasks/:taskId/comments` — add comment

**Expose task operations as primary agent tools.** When agents are invoked via Claude Code SDK, their system prompt should emphasize task-based coordination:

```
## How You Coordinate With Other Agents

Your primary coordination mechanism is the task system:

- To delegate work: create_task(title, description, assignee_agent_id)
- To ask a question about a task: comment_on_task(task_id, body)
- To report progress: update_task(task_id, { status, artifact })
- To block on another agent: update_task(task_id, { status: 'blocked', blocked_on: 'Waiting for auth middleware from CTO' })

Use relay messages only for announcements, urgent requests, or unstructured discussion.
Do NOT use relay messages to assign work — create a task instead.
```

**Wire task creation to supervisor events.** When an agent creates a task assigned to another agent, the supervisor should wake the target agent with the task context (including goal ancestry from proposal #2). This replaces the relay for task assignment:

```typescript
// In supervisor, after task creation via agent tool call:
if (newTask.owner_agent_id && newTask.owner_agent_id !== currentAgentId) {
  const ancestry = await buildGoalAncestry(d1, companyId, newTask.id);
  await this.wakeAgent(companyId, newTask.owner_agent_id,
    `New task assigned to you:\n\n${ancestry}\n\nTask: ${newTask.title}\n${newTask.description || ""}`
  );
}
```

**Wire task comments to supervisor events.** When an agent comments on a task owned by another agent, wake that agent:

```typescript
if (task.owner_agent_id && comment.author_agent_id !== task.owner_agent_id) {
  await this.wakeAgent(companyId, task.owner_agent_id,
    `Comment on your task "${task.title}" from ${commentAuthorName}:\n\n${comment.body}`
  );
}
```

### Why This Matters

**Audit trail.** When coordination happens through relay messages, reconstructing "what happened" requires reading a stream of chat messages across multiple channels. When coordination happens through tasks, every decision, delegation, and status change is attached to a work item. The dashboard can show: "CTO created this task → assigned to Backend Dev → Backend Dev blocked on auth → CTO unblocked it → Backend Dev completed it with artifact /src/api/." That's a story, not a log dump.

**Credit efficiency.** Relay messages wake agents with unstructured text ("Hey, can you build the API?"). The agent then has to reason about what to do, maybe query for more context, maybe ask clarifying questions — burning credits. Task assignments wake agents with structured context (title, description, goal ancestry, sibling tasks). The agent can start working immediately.

**Dashboard value.** The task board (already built in Phase 7) becomes the real-time view of company progress. Every task tells the user what's happening, who's doing it, and what's blocked. This is more valuable than an activity feed of relay messages.

### Why Keep Relay At All

Relay handles three things tasks don't:

1. **Broadcasts.** CEO announcing a strategy change to all agents. Not a task.
2. **Cross-provider communication.** Non-Anthropic agents (GPT-4o-mini specialists) spawned via relay.codex.spawn() communicate natively through relay. They don't have Claude Code SDK and can't call our task API directly.
3. **Urgent interrupts.** "Stop what you're doing, there's a critical bug" is better as a relay message than a task — it needs to interrupt the agent's current work, not queue behind existing tasks.

The relay becomes the exception, not the rule. Most agent-to-agent coordination flows through tasks.

---

## 4. Agent Configuration Versioning

### What Paperclip Does

Agent configurations (system prompt, tools, model, parameters) are versioned. When you change an agent's config, the old version is preserved. If the new config causes problems, you can rollback to a previous version. Every heartbeat run records which config version was active.

### What We Have Now

Our `agents` table has `adapter_config` and `runtime_config` as JSON columns. Changes overwrite the previous value. There is no history. If we change a blueprint's system prompt and it makes the agent worse, we can't see what the previous prompt was or revert to it.

### What to Implement

**New table:**

```sql
CREATE TABLE IF NOT EXISTS agent_config_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,               -- JSON: full agent configuration snapshot
  system_prompt TEXT,                  -- snapshot of system prompt at this version
  model_tier TEXT,
  changed_by TEXT NOT NULL,           -- 'user', 'ceo', 'system', agent_id
  change_reason TEXT,
  active INTEGER NOT NULL DEFAULT 1,  -- is this the current version?
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_agent_config_version
  ON agent_config_versions (agent_id, version);
CREATE INDEX idx_agent_config_active
  ON agent_config_versions (agent_id, active);
```

**On agent config change**, create a new version row, deactivate the previous one:

```typescript
async function updateAgentConfig(
  agentId: string,
  newConfig: Partial<AgentConfig>,
  changedBy: string,
  reason?: string,
): Promise<void> {
  const currentVersion = await db.prepare(
    "SELECT version FROM agent_config_versions WHERE agent_id = ? AND active = 1"
  ).bind(agentId).first<{ version: number }>();

  const nextVersion = (currentVersion?.version ?? 0) + 1;

  // Deactivate current
  await db.prepare(
    "UPDATE agent_config_versions SET active = 0 WHERE agent_id = ? AND active = 1"
  ).bind(agentId).run();

  // Insert new version
  await db.prepare(
    `INSERT INTO agent_config_versions
     (id, agent_id, company_id, version, config, system_prompt, model_tier, changed_by, change_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    generateId(), agentId, companyId, nextVersion,
    JSON.stringify(newConfig), newConfig.systemPrompt, newConfig.modelTier,
    changedBy, reason
  ).run();
}
```

**Rollback endpoint:** `POST /api/agents/:id/config/rollback`

```json
{ "to_version": 3 }
```

Creates a new version (e.g., v6) with the contents of v3. Does not delete intermediate versions — the history is immutable.

**Link runs to config versions.** When the supervisor invokes an agent, record the config version in the heartbeat run:

```sql
ALTER TABLE heartbeat_runs ADD COLUMN config_version INTEGER;
```

This lets us correlate agent performance with config changes: "After switching to v4 system prompt, task completion rate dropped from 80% to 40%."

**Dashboard UI (future).** A config history panel on the agent detail page showing version timeline, diffs between versions, and a rollback button. Not needed for launch but valuable for debugging.

### Why This Matters

AI agent behavior is fragile. A small change to a system prompt can dramatically alter output quality. Without versioning, debugging is guesswork: "Was the agent always this bad, or did something change?" With versioning, you can see exactly what changed and when, and revert if needed.

This is especially important because agents can modify their own configurations (the CEO can write new system prompts for custom agents). If an agent-written prompt is bad, the user needs to be able to revert to the previous human-written version.

### Why Not Go Further (Paperclip's Full Config System)

Paperclip has company-level config versioning (not just agent-level) and ties config versions to a formal approval flow. For us, agent-level versioning is sufficient. Company-level config (policies, budget limits) changes rarely and is tracked by the audit log. Adding a full config approval workflow adds complexity without proportional value at our stage.

---

## What We Explicitly Skip

### Paperclip's PostgreSQL Requirement

**Skip.** Our entire stack runs on Cloudflare D1 (SQLite). Switching to PostgreSQL would mean:
- Running a PostgreSQL instance on the VM alongside the supervisor
- Migrating all Worker routes to talk to PostgreSQL instead of D1
- Losing Cloudflare's global edge for database reads
- Maintaining two databases or abandoning D1 entirely

The D1 schema already handles everything we need. SQLite's single-writer model actually helps with atomic checkout (no concurrent write conflicts possible).

### Paperclip's Heartbeat Polling Model

**Skip.** Paperclip agents check in every 30+ seconds asking "is there work?" Each check-in is potentially an LLM inference call that burns credits. Our event-driven model wakes agents only when there's actual work. With 5 agents on 30-second heartbeats, Paperclip burns ~14,400 check-ins/day. Ours burns zero when idle.

Paperclip's model makes sense for their use case (self-hosted, operator pays infra costs directly). It doesn't make sense for ours (SaaS, users pay per credit, idle burn destroys unit economics).

### Paperclip's "No Messaging" Dogma

**Skip (partially).** Paperclip's stance that ALL communication must flow through tasks is principled but too rigid for us. Announcements, urgent interrupts, and cross-provider agent communication need a real-time channel. We adopt "tasks as primary" but keep Agent Relay as secondary.

### Paperclip's Adapter Abstraction

**Skip.** Paperclip's adapter system (process adapter, HTTP adapter, pluggable custom adapters) is designed for heterogeneous environments where you might have Python agents, Node agents, and HTTP webhook agents all in one company. We have a simpler runtime model: Claude Code SDK for primary agents, relay.codex.spawn() for non-Anthropic agents. A generic adapter system adds abstraction without solving a problem we have.

### Using Paperclip as a Dependency

**Skip.** Installing Paperclip as a library or running it as a sidecar would mean:
- PostgreSQL dependency (see above)
- Duplicate schema (Paperclip's tables + our tables)
- Two API surfaces (Paperclip's Hono API + our Worker API)
- Maintaining compatibility across Paperclip version updates
- Adapting our billing/credit system to work alongside Paperclip's budget system

The patterns are worth adopting. The dependency is not.

---

## Implementation Priority

If implementing these, the recommended order:

1. **Atomic Task Checkout** — Highest impact. Prevents wasted credits from duplicate work. Small change: 2 columns + 3 endpoints + stale checkout cron.

2. **Task Comments + Task-Based Coordination** — Second highest. New table + 2 endpoints + supervisor event wiring + agent prompt changes. Improves audit trails and credit efficiency.

3. **Goal Ancestry in Agent Context** — Cheapest to implement (prompt engineering only, no schema changes). Improves agent reasoning quality for free.

4. **Config Versioning** — Lowest urgency. Valuable for debugging but not needed until agents are actively running and we're tuning prompts. New table + version management logic + rollback endpoint.

---

## Summary

| Proposal | Schema Change | New Endpoints | Effort | Impact |
|----------|--------------|---------------|--------|--------|
| Atomic Task Checkout | 2 columns on tasks | 3 (checkout, release, complete) | Small | High — prevents credit waste |
| Goal Ancestry | None | None | Tiny | Medium — better agent reasoning |
| Tasks as Primary Comms | 1 new table (task_comments) | 2 (list, create comments) + supervisor wiring | Medium | High — better audit trail, fewer relay credits |
| Config Versioning | 1 new table + 1 column on heartbeat_runs | 2 (history, rollback) | Medium | Medium — debugging, rollback capability |
