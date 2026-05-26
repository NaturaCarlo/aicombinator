# Supervisor V2 — Technical Specification

## Purpose

This document specifies the scheduling algorithm, data structures, and operational rules for the new supervisor. It is not a vision document — it is a blueprint that can be implemented line by line.

---

## 1. Core Principle

The supervisor has one job: **advance tasks through a dependency graph until milestones are complete.**

It does not decide what to work on (agents do that within their assigned task). It does not generate plans (the CEO does that). It does not communicate between agents (structured handoffs do that). It resolves dependencies, wakes agents, validates results, and detects stalls.

---

## 2. Data Model

### 2.1 Local SQLite Schema

The VM owns all operational state in a local SQLite database. This is the source of truth for everything that happens during agent execution.

```sql
------------------------------------------------------------
-- COMPANIES
------------------------------------------------------------
CREATE TABLE companies (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  goal          TEXT,
  state         TEXT NOT NULL DEFAULT 'provisioning',
    -- provisioning: container being created
    -- planning: CEO is decomposing the goal
    -- running: tasks are being executed
    -- paused: credits exhausted or user-paused
    -- completed: all milestones done
    -- failed: unrecoverable error
  container_id  TEXT,
  workspace_dir TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

------------------------------------------------------------
-- AGENTS
------------------------------------------------------------
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  blueprint_id    TEXT,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  model_tier      TEXT NOT NULL DEFAULT 'sonnet',
  status          TEXT NOT NULL DEFAULT 'idle',
    -- idle: waiting for work
    -- working: executing a task turn
    -- paused: company paused or credit limit
    -- terminated: deactivated
  session_id      TEXT,           -- Claude Code session ID for resume
  current_task_id TEXT REFERENCES tasks(id),
  total_credits   REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

------------------------------------------------------------
-- MILESTONES
------------------------------------------------------------
CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  title       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL,  -- execution sequence
  status      TEXT NOT NULL DEFAULT 'pending',
    -- pending: not started, previous milestone incomplete
    -- active: tasks are being worked on
    -- done: all tasks completed
    -- cancelled: removed by CEO plan update
    -- failed: unrecoverable, escalated to user
  created_by  TEXT NOT NULL,     -- agent ID (usually CEO)
  created_at  TEXT NOT NULL,
  completed_at TEXT
);

------------------------------------------------------------
-- TASKS (core data structure)
------------------------------------------------------------
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  milestone_id        TEXT NOT NULL REFERENCES milestones(id),
  title               TEXT NOT NULL,
  description         TEXT,          -- detailed work requirements
  acceptance_criteria TEXT NOT NULL,  -- JSON array of checkable criteria
  depends_on          TEXT NOT NULL DEFAULT '[]',  -- JSON array of task IDs
  owner_agent_id      TEXT REFERENCES agents(id),
  status              TEXT NOT NULL DEFAULT 'pending',
    -- pending: dependencies not satisfied
    -- ready: all dependencies done, waiting for agent
    -- in_progress: agent has been woken and is actively working
    -- blocked: agent declared a blocker, waiting for CEO replan
    -- done: completed and validated
    -- cancelled: removed by CEO plan update
    -- failed: unresolvable (agent declared blocked, CEO couldn't fix)
  blocked_reason      TEXT,          -- free text if agent declares blocker
  artifact            TEXT,          -- file path or URL of deliverable
  credits_spent       REAL NOT NULL DEFAULT 0,  -- tracked for reporting, NOT for limits
  turns_spent         INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT
);

CREATE INDEX idx_tasks_status ON tasks(company_id, status);
CREATE INDEX idx_tasks_milestone ON tasks(milestone_id, status);
CREATE INDEX idx_tasks_owner ON tasks(owner_agent_id, status);

------------------------------------------------------------
-- CREDIT BALANCES (local working copy)
------------------------------------------------------------
CREATE TABLE credit_balances (
  user_id        TEXT PRIMARY KEY,
  balance        REAL NOT NULL DEFAULT 0,
  last_synced_at TEXT NOT NULL
);

------------------------------------------------------------
-- TURN LOG (for stall detection and auditing)
------------------------------------------------------------
CREATE TABLE turn_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  task_id         TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  credits_spent   REAL NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  artifact_changed BOOLEAN NOT NULL DEFAULT 0,
  agent_declared_done BOOLEAN NOT NULL DEFAULT 0,
  output_summary  TEXT,
  error           TEXT,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_turn_log_task ON turn_log(task_id, created_at);

------------------------------------------------------------
-- CEO EVENT QUEUE (holds events when CEO is busy)
------------------------------------------------------------
CREATE TABLE ceo_event_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  event_type TEXT NOT NULL,     -- 'user_message', 'task_blocked', 'milestone_review',
                                -- 'task_failed', 'no_agent_assigned'
  payload    TEXT NOT NULL,     -- JSON (event-specific data)
  delivered  BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ceo_events_pending ON ceo_event_queue(company_id, delivered, created_at);

------------------------------------------------------------
-- MESSAGES (CEO ↔ user chat, synced to dashboard)
------------------------------------------------------------
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  agent_id   TEXT,              -- NULL for user messages
  role       TEXT NOT NULL,     -- 'user', 'ceo'
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_messages_company ON messages(company_id, created_at);

------------------------------------------------------------
-- CRON TASKS (recurring work, see Section 13)
------------------------------------------------------------
CREATE TABLE cron_tasks (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  schedule    TEXT NOT NULL,        -- cron expression
  prompt      TEXT NOT NULL,
  enabled     BOOLEAN DEFAULT 1,
  last_run_at TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

------------------------------------------------------------
-- APPROVALS (CEO-created requests for user input)
------------------------------------------------------------
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  type            TEXT NOT NULL,        -- 'purchase_service', 'external_signup', 'strategic_decision', etc.
  description     TEXT NOT NULL,
  related_task_id TEXT REFERENCES tasks(id),
  status          TEXT NOT NULL DEFAULT 'pending',
    -- pending: waiting for user response
    -- approved: user approved
    -- rejected: user rejected
  resolved_at     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_approvals_pending ON approvals(company_id, status);

------------------------------------------------------------
-- TELEMETRY MIRROR (pushed from Worker, read-only locally)
-- See SUPERVISOR-SPEC-GAPS.md Section 2.8 for full details.
------------------------------------------------------------
CREATE TABLE telemetry_mirror (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  kind               TEXT NOT NULL,        -- 'outreach', 'lead', 'meeting', 'revenue'
  status             TEXT NOT NULL,
  source             TEXT NOT NULL,
  source_event_id    TEXT NOT NULL,
  verification_level TEXT NOT NULL,
  subject_name       TEXT,
  subject_email      TEXT,
  amount_cents       INTEGER,
  currency           TEXT,
  occurred_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_telemetry_mirror_company
  ON telemetry_mirror(company_id, kind, occurred_at DESC);

------------------------------------------------------------
-- SYNC QUEUE (outbound to D1)
------------------------------------------------------------
CREATE TABLE sync_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name      TEXT NOT NULL,     -- 'tasks', 'agents', 'milestones', etc.
  record_id       TEXT NOT NULL,
  operation       TEXT NOT NULL,     -- 'upsert', 'delete'
  payload         TEXT NOT NULL,     -- JSON
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL,     -- ISO timestamp, initially = created_at
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_sync_pending ON sync_queue(next_attempt_at)
  WHERE attempts < max_attempts;
```

### 2.2 Acceptance Criteria Format

Each task's `acceptance_criteria` is a JSON array of checkable assertions:

```json
[
  {"type": "file_exists", "path": "/workspace/src/index.html"},
  {"type": "file_contains", "path": "/workspace/src/index.html", "substring": "<html"},
  {"type": "file_not_empty", "path": "/workspace/docs/copy.md"},
  {"type": "command_succeeds", "command": "cd /workspace && npm test"},
  {"type": "file_count_gte", "glob": "/workspace/src/**/*.ts", "min": 3}
]
```

Supported criterion types:

| Type | Fields | Passes when |
|------|--------|-------------|
| `file_exists` | `path` | File exists at path |
| `file_not_empty` | `path` | File exists and has >0 bytes |
| `file_contains` | `path`, `substring` | File contains the substring |
| `file_count_gte` | `glob`, `min` | Glob matches >= min files |
| `command_succeeds` | `command` | Command exits with code 0 |
| `directory_exists` | `path` | Directory exists |
| `custom` | `description` | Always passes (manual/CEO validation) |

The supervisor runs these checks automatically when an agent declares a task done. No LLM needed — pure filesystem checks.

### 2.3 Depends-on Format

`depends_on` is a JSON array of task IDs:

```json
["task_abc123", "task_def456"]
```

A task transitions from `pending` to `ready` when **every** task ID in its `depends_on` array has status `done`.

---

## 3. The Scheduling Algorithm

### 3.1 Event-Driven Loop

Core scheduling is event-driven — agents are woken by task dependency resolution, not timers. Two subsystems use timers: D1 sync (every 30s) and cron tasks (Section 13). These are background housekeeping, not the scheduling engine.

The supervisor reacts to events:

```
EVENTS:
  task_completed(task_id)
  agent_turn_finished(agent_id, task_id, result)
  company_provisioned(company_id)
  ceo_plan_received(company_id, plan)
  user_message(company_id, agent_id, text)
  credits_purchased(user_id, amount)
  credits_exhausted(user_id)
  approval_resolved(company_id, approval_id, decision)
  stall_detected(company_id, task_id)
```

### 3.2 Core Scheduling Function

Called after any event that might change task readiness:

```
function schedule(company_id):
  if company.state != 'running': return

  // 1. Find tasks that need an agent woken
  //    Two cases:
  //    a) 'ready' tasks — newly unblocked, waiting for first assignment
  //    b) 'in_progress' tasks whose agent is 'idle' — agent finished a turn
  //       but didn't complete the task, needs another turn
  schedulable_tasks = SELECT t.* FROM tasks t
    LEFT JOIN agents a ON t.owner_agent_id = a.id
    WHERE t.company_id = ?
    AND (
      t.status = 'ready'
      OR (t.status = 'in_progress' AND a.status = 'idle')
    )
    ORDER BY milestone.sort_order ASC, t.created_at ASC

  for task in schedulable_tasks:
    agent = get_agent(task.owner_agent_id)

    // 2. Skip if agent is already working (on a different task)
    if agent.status == 'working': continue

    // 3. Check credits
    balance = get_balance(company.user_id)
    if balance <= 0:
      pause_company(company_id)
      return

    // 4. Wake the agent
    wake_agent(agent, task)
```

### 3.3 Task Completion Flow

When an agent declares a task done:

```
function on_task_completed(task_id):
  task = get_task(task_id)

  // 1. Validate acceptance criteria
  results = validate_criteria(task.acceptance_criteria, task.workspace_dir)

  if all results pass:
    // 2. Mark done
    UPDATE tasks SET status = 'done', completed_at = now() WHERE id = task_id
    UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = task.owner_agent_id

    // 3. Resolve dependencies
    dependents = SELECT * FROM tasks
      WHERE company_id = task.company_id
      AND json_array_contains(depends_on, task_id)
      AND status = 'pending'

    for dependent in dependents:
      all_deps = json_parse(dependent.depends_on)
      all_done = all tasks in all_deps have status 'done'
      if all_done:
        UPDATE tasks SET status = 'ready' WHERE id = dependent.id

    // 4. Check milestone completion
    //    A milestone is complete when no tasks remain in an active state.
    //    'done' and 'cancelled' are both terminal — only count non-terminal statuses.
    remaining = SELECT count(*) FROM tasks
      WHERE milestone_id = task.milestone_id
      AND status NOT IN ('done', 'cancelled')
    if remaining == 0:
      UPDATE milestones SET status = 'done', completed_at = now()
        WHERE id = task.milestone_id
      advance_to_next_milestone(task.company_id)

    // 5. Schedule newly-ready tasks
    schedule(task.company_id)

    // 6. Queue sync to D1
    enqueue_sync('tasks', task_id, 'upsert')

  else:
    // Criteria failed — tell the agent what failed and let it retry
    failures = results.filter(r => !r.passed)
    agent = get_agent(task.owner_agent_id)

    // Build a focused retry prompt listing exactly what didn't pass
    feedback_prompt = "# Acceptance Criteria Not Met\n\n"
    feedback_prompt += "You declared this task done, but the following checks failed:\n\n"
    for f in failures:
      feedback_prompt += f"- ❌ {humanize_criterion(f.criterion)}: {f.reason}\n"
    feedback_prompt += "\nFix these issues and write task_done.json again when ready."

    // Agent stays on the same task. Task stays in_progress.
    // Reset agent to idle so schedule() can re-wake it with the feedback prompt.
    UPDATE agents SET status = 'idle' WHERE id = agent.id
    wake_agent(agent, task, override_prompt=feedback_prompt)
```

### 3.4 Agent Turn Flow

```
function wake_agent(agent, task, override_prompt=null):
  // 1. Update state
  UPDATE tasks SET status = 'in_progress', started_at = coalesce(started_at, now())
    WHERE id = task.id
  UPDATE agents SET status = 'working', current_task_id = task.id
    WHERE id = agent.id

  // 2. Build task-focused prompt (or use override for feedback/stall retries)
  prompt = override_prompt ?? build_task_prompt(agent, task)

  // 3. Invoke via Claude Code SDK
  result = invoke_claude_code(
    agent       = agent,
    prompt      = prompt,
    cwd         = company.workspace_dir,
    max_turns   = 50,                    -- inference rounds (safety valve, not work constraint)
    timeout_ms  = 3_600_000,             -- 60 minutes (safety valve)
    session_id  = agent.session_id       -- resume previous conversation
  )

  // 4. Record turn and extract activity summary
  //    The output_summary is what the dashboard shows in the Agent Activity Feed.
  //    Extract the first meaningful line from the agent's output text.
  output_summary = extract_summary(result.output, task.title)
  //    extract_summary logic:
  //      - If result.output is non-empty, take the first sentence (up to 120 chars)
  //      - If result.output is empty, use "Working on {task.title}"
  //      - Strip markdown formatting

  INSERT INTO turn_log (..., output_summary) VALUES (..., output_summary)
  UPDATE tasks SET credits_spent = credits_spent + result.credits,
                   turns_spent = turns_spent + 1
  UPDATE agents SET total_credits = total_credits + result.credits,
                    session_id = result.session_id
  deduct_credits(company.user_id, result.credits)

  // Sync the activity to D1 so the dashboard can display it
  enqueue_sync('turn_log', turn_log_id, 'upsert')

  // 5. Check signal files (this is how agents communicate results)
  signal = check_agent_signals(agent, task)
  //    check_agent_signals reads:
  //      /workspace/.agent/{agent.id}/task_done.json → returns {type: 'done', ...}
  //      /workspace/.agent/{agent.id}/task_blocked.json → returns {type: 'blocked', ...}
  //      nothing found → returns null
  //    Deletes the signal file after reading it.

  // 6. Process result
  on_agent_turn_finished(agent.id, task.id, result, signal)

function on_agent_turn_finished(agent_id, task_id, result, signal):
  task = get_task(task_id)

  if result.error:
    // SDK returned an error (timeout, abort, crash)
    // Log the error, set agent to 'idle' state, leave task in_progress
    // The next schedule() call will retry the task automatically.
    // Stall detection catches recurring failures (3+ turns no progress).
    INSERT INTO turn_log (..., error) VALUES (..., result.error)
    UPDATE agents SET status = 'idle' WHERE id = agent_id
    schedule(task.company_id)
    return

  // Check signal file results
  if signal and signal.type == 'done':
    // Agent declared task complete — validate and resolve
    UPDATE tasks SET artifact = signal.artifact WHERE id = task_id
    on_task_completed(task_id)
    return

  if signal and signal.type == 'blocked':
    // Agent declared a blocker — mark blocked, notify CEO
    // The CEO will decide whether to replan, add a new task, or escalate to the user
    UPDATE tasks SET status = 'blocked', blocked_reason = signal.reason WHERE id = task_id
    UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = agent_id
    notify_ceo(task.company_id, 'task_blocked', {
      task_id: task_id,
      task_title: task.title,
      reason: signal.reason
    })
    return

  // Check company-level credits (the ONLY budget gate)
  balance = get_balance(company.user_id)
  if balance <= 0:
    pause_company(task.company_id)
    return

  // Agent didn't finish — schedule another turn for the same task
  // No per-task budget limit. Work continues as long as the user has credits.
  UPDATE agents SET status = 'idle' WHERE id = agent_id
  schedule(task.company_id)
  // schedule() will see the task is still in_progress with an idle agent
  // and wake the agent again
```

Note on re-scheduling: when an agent finishes a turn without completing the task, the agent goes idle and `schedule()` picks it back up. The task stays `in_progress`. The agent resumes with its previous session context (Claude Code SDK `resume`), so it doesn't lose what it was doing.

### 3.4.1 Concurrency Model

The supervisor is single-threaded Node.js. Multiple agents can work **simultaneously** — each `invoke_claude_code()` call is an async operation. The supervisor fires off agent turns without awaiting all of them sequentially:

```
// In schedule(), for each ready task:
wake_agent(agent, task)  // this is fire-and-forget (returns a Promise)
// The supervisor does NOT await each turn — it starts all ready agents concurrently

// When an agent's turn finishes, its Promise resolves and the callback
// (on_agent_turn_finished) runs in the Node.js event loop. Since Node.js
// is single-threaded, these callbacks execute one at a time — no data races
// on SQLite. But they can interleave:

// Timeline:
//   t=0:  schedule() wakes Agent A and Agent B (two concurrent turns)
//   t=5m: Agent A finishes → on_agent_turn_finished(A) runs
//         → resolves deps, calls schedule() → wakes Agent C
//   t=7m: Agent B finishes → on_agent_turn_finished(B) runs
//         → resolves deps, calls schedule() → wakes Agent D
```

This is safe because:
- SQLite operations within each callback are synchronous (no interleaving mid-query)
- Agent status is checked before waking (`if agent.status == 'working': continue`)
- `schedule()` is re-entrant — calling it multiple times just re-evaluates what's ready
- The CEO event queue serializes CEO wakes (only one CEO turn at a time)

### 3.5 Task Prompt Construction

This is what the agent sees when woken. It is focused — no inbox, no company-wide state, no other agents' messages.

```
function build_task_prompt(agent, task):
  parts = []

  // 1. Task assignment
  parts.push("# Your Task")
  parts.push(f"**{task.title}**")
  parts.push(task.description)
  parts.push(f"Task ID: {task.id}")
  parts.push(f"Agent ID: {agent.id}")

  // 2. Acceptance criteria (agent knows what "done" means)
  parts.push("# When You Are Done")
  parts.push("Your task is complete when ALL of the following are true:")
  for criterion in json_parse(task.acceptance_criteria):
    parts.push(f"- {humanize_criterion(criterion)}")

  // 3. Input artifacts from completed dependencies
  deps = get_tasks(json_parse(task.depends_on))
  if deps.length > 0:
    parts.push("# Available Inputs (from dependencies)")
    for dep in deps:
      parts.push(f"- **{dep.title}**: {dep.artifact}")

  // 3b. Artifacts from previous milestones (cross-milestone visibility)
  milestone = get_milestone(task.milestone_id)
  if milestone.sort_order > 0:
    prev_done_tasks = SELECT * FROM tasks
      WHERE company_id = task.company_id
      AND milestone_id IN (
        SELECT id FROM milestones WHERE company_id = task.company_id
        AND status = 'done' AND sort_order < milestone.sort_order
      )
      AND status = 'done' AND artifact IS NOT NULL
    if prev_done_tasks.length > 0:
      parts.push("# Artifacts from Previous Milestones")
      for pt in prev_done_tasks:
        parts.push(f"- **{pt.title}**: {pt.artifact}")

  // 4. Continuation context (if this is not the first turn)
  if task.turns_spent > 0:
    parts.push("# Context")
    parts.push(f"This is turn {task.turns_spent + 1} for this task.")
    parts.push("Continue where you left off. Your previous conversation is preserved.")

  // 5. Completion instruction
  parts.push("# Important")
  parts.push("When you have completed this task, write the file TASK_DONE to /workspace/.agent/" + agent.id + "/task_done.json with:")
  parts.push('{"task_id": "' + task.id + '", "artifact": "<path or URL>", "summary": "<what you did>"}')
  parts.push("If you are blocked and cannot proceed, write /workspace/.agent/" + agent.id + "/task_blocked.json with:")
  parts.push('{"task_id": "' + task.id + '", "reason": "<what is blocking you>"}')
  parts.push("Do not work on anything other than this task.")

  return parts.join("\n\n")
```

### 3.6 CEO Prompt Helpers

Every prompt sent to the CEO includes task and milestone IDs so the CEO can reference them in `plan_update.json`:

```
function format_task_list_with_ids(tasks):
  lines = []
  for task in tasks:
    agent = get_agent(task.owner_agent_id)
    agent_name = agent.name if agent else "unassigned"
    lines.push(f"- [{task.id}] \"{task.title}\" ({agent_name}) — {task.status}")
    if task.blocked_reason:
      lines.push(f"  Blocked: {task.blocked_reason}")
    if task.artifact:
      lines.push(f"  Artifact: {task.artifact}")
  return lines.join("\n")

function format_milestone_list(milestones):
  lines = []
  for ms in milestones:
    task_counts = get_task_counts_by_status(ms.id)
    lines.push(f"- [{ms.id}] \"{ms.title}\" — {ms.status} ({task_counts.done}/{task_counts.total} tasks done)")
  return lines.join("\n")
```

The CEO sees IDs like `[task_abc123]` and `[milestone_m01]` in every prompt, so it can use them directly in `cancel_tasks`, `update_tasks`, `cancel_milestones`, etc.

### 3.7 How the Agent Signals Completion

The agent writes a signal file. The supervisor checks for it after each turn.

**Task done:**
```json
// /workspace/.agent/{agent_id}/task_done.json
{
  "task_id": "task_abc123",
  "artifact": "/workspace/src/index.html",
  "summary": "Built the landing page with responsive design, hero section, and CTA."
}
```

**Task blocked:**
```json
// /workspace/.agent/{agent_id}/task_blocked.json
{
  "task_id": "task_abc123",
  "reason": "Need Twitter API credentials. The API Keys Agent needs to provision them."
}
```

Signal files are **per-agent** — each agent writes to its own directory (`/workspace/.agent/{agent_id}/`). This prevents collisions when multiple agents work simultaneously and finish around the same time.

After each worker agent turn, the supervisor:
1. Checks for `/workspace/.agent/{agent_id}/task_done.json` — if found, runs acceptance criteria
2. Checks for `/workspace/.agent/{agent_id}/task_blocked.json` — if found, marks task blocked and notifies CEO
3. Deletes the signal file after processing

Worker agents can only signal `done` or `blocked`. They cannot escalate to the user directly — only the CEO can do that (see Section 8.7).

This is simpler and more reliable than parsing agent text output.

---

## 4. Goal Decomposition

### 4.1 CEO Planning Phase

When a company is provisioned, the supervisor enters `planning` state and wakes the CEO with a structured prompt:

```
function start_planning(company):
  UPDATE companies SET state = 'planning' WHERE id = company.id
  ceo = get_ceo(company.id)

  prompt = build_planning_prompt(company)
  invoke_ceo_turn(company.id, ceo, prompt)
  // invoke_ceo_turn calls process_ceo_response, which calls schedule()
  // But during 'planning' state, schedule() returns early (state != 'running').
  // Instead, we check for plan.json after the CEO turn:
  process_initial_plan(company.id)

function process_initial_plan(company_id):
  workspace = get_workspace_dir(company_id)
  plan_path = f"{workspace}/.agent/plan.json"

  if not file_exists(plan_path):
    // CEO didn't write a plan — retry (up to 3 attempts)
    escalate_planning_failure(company_id)
    return

  plan = read_json(plan_path)
  delete_file(plan_path)

  errors = validate_plan(company_id, plan)
  if errors.length > 0:
    // Wake CEO with errors and ask for correction
    retry_planning(company_id, errors)
    return

  ingest_plan(company_id, plan)
  // ingest_plan sets state to 'running' and calls schedule()
```

### 4.2 CEO Planning Prompt

```
# Your Role

You are the CEO of {company.name}. Your goal: {company.goal}

# Your Task

Break this goal into milestones and tasks. Write a structured plan to:
/workspace/.agent/plan.json

# Plan Format

```json
{
  "milestones": [
    {
      "title": "string — name of the milestone",
      "description": "string — what 'done' looks like for this milestone",
      "tasks": [
        {
          "title": "string — specific, actionable task name",
          "description": "string — detailed requirements",
          "assigned_to": "string — agent blueprint ID (e.g., 'cto', 'frontend-dev', 'cmo')",
          "depends_on": ["string — titles of tasks THIS task depends on (within this milestone)"],
          "acceptance_criteria": [
            {"type": "file_exists", "path": "/workspace/..."},
            {"type": "file_contains", "path": "/workspace/...", "substring": "..."}
          ]
        }
      ]
    }
  ],
  "agents_needed": ["string — blueprint IDs of agents to activate"]
}
```

# Rules

1. Milestones are sequential — milestone 2 starts after milestone 1 is complete.
2. Tasks within a milestone can run in parallel if they don't depend on each other.
3. Every task MUST have at least one acceptance criterion with type "file_exists" or "file_not_empty".
4. depends_on references task titles within the SAME milestone only.
5. assigned_to must be a valid blueprint ID from the available pool.
6. The first milestone should produce something visible (landing page, MVP, demo).
7. Keep tasks focused — one clear deliverable per task, not sprawling multi-step work.

# Available Agent Pool

{format_blueprint_pool(available_blueprints)}
```

### 4.3 Plan Validation

After the CEO writes `plan.json`, the supervisor validates it:

```
function validate_plan(company_id, plan):
  errors = []

  // Structure
  if !plan.milestones or plan.milestones.length == 0:
    errors.push("No milestones defined")

  for milestone in plan.milestones:
    if !milestone.tasks or milestone.tasks.length == 0:
      errors.push(f"Milestone '{milestone.title}' has no tasks")

    task_titles = set()
    for task in milestone.tasks:
      // Uniqueness
      if task.title in task_titles:
        errors.push(f"Duplicate task title: {task.title}")
      task_titles.add(task.title)

      // Valid assignee
      if !is_valid_blueprint(task.assigned_to):
        errors.push(f"Unknown agent: {task.assigned_to}")

      // Acceptance criteria
      if !task.acceptance_criteria or len(task.acceptance_criteria) == 0:
        errors.push(f"Task '{task.title}' has no acceptance criteria")
      has_file_check = any(c.type in ['file_exists', 'file_not_empty'] for c in task.acceptance_criteria)
      if !has_file_check:
        errors.push(f"Task '{task.title}' needs at least one file-based criterion")

      // Dependency references
      for dep in task.depends_on:
        if dep not in task_titles and dep != task.title:
          // dep might reference a task defined later — collect and check after
          pass

    // Circular dependency check
    if has_cycle(milestone.tasks):
      errors.push(f"Milestone '{milestone.title}' has circular dependencies")

  return errors
```

If validation fails, the supervisor wakes the CEO with the error list and asks for a corrected plan. After 3 failed attempts, the supervisor escalates to the user.

### 4.4 Plan Ingestion

Once validated, the plan is inserted into the local database:

```
function ingest_plan(company_id, plan):
  // 1. Activate requested agents
  for blueprint_id in plan.agents_needed:
    activate_agent(company_id, blueprint_id)

  // 2. Create milestones and tasks
  for i, milestone in enumerate(plan.milestones):
    m_id = generate_id()
    INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by)
      VALUES (m_id, company_id, milestone.title, milestone.description, i, 'pending', ceo_agent_id)

    // Map task titles to IDs (for dependency resolution)
    title_to_id = {}

    for task in milestone.tasks:
      t_id = generate_id()
      title_to_id[task.title] = t_id

    for task in milestone.tasks:
      t_id = title_to_id[task.title]
      dep_ids = [title_to_id[dep] for dep in task.depends_on]
      agent_id = find_agent_by_blueprint(company_id, task.assigned_to)

      INSERT INTO tasks (
        id, company_id, milestone_id, title, description,
        acceptance_criteria, depends_on, owner_agent_id,
        status, created_by
      ) VALUES (
        t_id, company_id, m_id, task.title, task.description,
        json(task.acceptance_criteria), json(dep_ids), agent_id,
        'pending', ceo_agent_id
      )

  // 3. Activate first milestone
  first_milestone = get_first_milestone(company_id)
  UPDATE milestones SET status = 'active' WHERE id = first_milestone.id

  // 4. Mark root tasks as ready
  UPDATE tasks SET status = 'ready'
    WHERE milestone_id = first_milestone.id
    AND depends_on = '[]'

  // 5. Start scheduling
  UPDATE companies SET state = 'running' WHERE id = company_id
  schedule(company_id)
```

---

## 5. Milestone Advancement

### 5.1 Sequential Milestones

Milestones execute in order. When all tasks in milestone N are `done`, the supervisor:

```
function advance_to_next_milestone(company_id):
  current = SELECT * FROM milestones
    WHERE company_id = ? AND status = 'active'

  next = SELECT * FROM milestones
    WHERE company_id = ? AND status = 'pending'
    ORDER BY sort_order ASC LIMIT 1

  if next:
    UPDATE milestones SET status = 'active' WHERE id = next.id

    // DO NOT mark root tasks as ready yet.
    // First, give the CEO a chance to review and adjust the next milestone.
    // Tasks stay 'pending' until the CEO review completes.
    // Use notify_ceo (not a direct call) — CEO might be busy with another event.
    notify_ceo(company_id, 'milestone_review', {
      completed_milestone_id: current.id,
      next_milestone_id: next.id
    })
    // After CEO review, process_ceo_response() calls activate_pending_milestone_tasks()
    // and schedule(). Root tasks in the next milestone get marked 'ready' at that point.

function activate_milestone_tasks(company_id, milestone_id):
  // Called after CEO milestone review completes (or if CEO makes no changes)
  UPDATE tasks SET status = 'ready'
    WHERE milestone_id = milestone_id
    AND depends_on = '[]'
    AND status = 'pending'
  schedule(company_id)

  else:
    // All milestones done
    UPDATE companies SET state = 'completed' WHERE id = company_id
    notify_user(company_id, "All milestones complete!")
```

### 5.2 CEO Milestone Review

Between milestones, the CEO gets a review turn:

```
# Milestone Completed: {completed_milestone.title} [{completed_milestone.id}]

Tasks completed:
{for task in completed_tasks:}
- [{task.id}] "{task.title}" — {task.artifact} ({task.credits_spent} credits)

# Next Milestone: {next_milestone.title} [{next_milestone.id}]

Tasks in next milestone:
{format_task_list_with_ids(next_milestone_tasks)}

Review the completed work and the next milestone's tasks.
If adjustments are needed, write changes to /workspace/.agent/plan_update.json
(same format as always — add_tasks, cancel_tasks, update_tasks, etc.).
Use the IDs shown in brackets when referencing tasks or milestones.

If no changes needed, don't write the file.
```

---

## 6. Stall Detection

### 6.1 What Counts as a Stall

A task is stalled when it consumes turns without progress. There are no per-task budget limits — the only budget gate is the company-level credit balance. Stall detection is purely behavioral:

```
function check_stalls(company_id):
  stalls = []

  // 1. Tasks in_progress with no artifact change for 3+ consecutive turns
  stuck_tasks = SELECT t.* FROM tasks t
    WHERE t.company_id = ? AND t.status = 'in_progress'
    AND t.turns_spent >= 3
    AND (
      SELECT count(*) FROM turn_log tl
      WHERE tl.task_id = t.id AND tl.artifact_changed = 1
      ORDER BY tl.created_at DESC LIMIT 3
    ) == 0

  for task in stuck_tasks:
    stalls.push({type: 'no_progress', task: task})

  // 2. Agent producing only text, no tool calls for 2+ turns
  //    (talking/planning instead of acting)
  chatty_agents = SELECT agent_id, task_id FROM turn_log
    WHERE company_id = ?
    AND tool_call_count == 0
    GROUP BY agent_id, task_id
    HAVING count(*) >= 2
    AND max(created_at) > datetime('now', '-30 minutes')

  for row in chatty_agents:
    stalls.push({type: 'no_tool_calls', agent_id: row.agent_id, task_id: row.task_id})

  // 3. Task in_progress for an unusually long time (>10 turns)
  //    Not a hard failure — just a signal to check in
  long_running = SELECT * FROM tasks
    WHERE company_id = ? AND status = 'in_progress'
    AND turns_spent > 10

  for task in long_running:
    stalls.push({type: 'long_running', task: task})

  return stalls
```

### 6.2 Stall Response

```
function handle_stall(stall):
  match stall.type:
    case 'no_progress':
      // Give agent one focused retry
      prompt = f"""
      You have spent {stall.task.turns_spent} turns on "{stall.task.title}"
      without producing the required output.

      The acceptance criteria are:
      {humanize_criteria(stall.task.acceptance_criteria)}

      Either:
      1. Complete the task now, or
      2. Write /workspace/.agent/{your_agent_id}/task_blocked.json explaining why you cannot.
      """
      wake_agent(stall.task.owner_agent_id, stall.task, override_prompt=prompt)

    case 'no_tool_calls':
      // Agent is just talking, not doing — force it to act
      prompt = f"""
      You have been reasoning without using tools. Your task requires producing files.
      Use your tools now to create the required artifacts. Do not plan further — act.
      """
      wake_agent(stall.agent_id, get_task(stall.task_id), override_prompt=prompt)

    case 'long_running':
      // Not a failure — just check if agent is actually making progress
      // Run acceptance criteria to see how close it is
      criteria = json_parse(stall.task.acceptance_criteria)
      results = validate_criteria(criteria, workspace_dir)
      pct_met = count(passed) / count(total)
      if pct_met > 0:
        // Making progress, just slow — let it continue
        log(f"Task {stall.task.id} at {pct_met*100}% after {stall.task.turns_spent} turns")
      else:
        // 10+ turns, 0% criteria met — escalate
        escalate_to_ceo(stall.task, 'no_criteria_met_after_many_turns')
```

### 6.3 Escalation Chain

If a stall persists after the intervention:

```
Turn N:   Stall detected → focused retry prompt
Turn N+1: Still stalled → mark task 'failed'
          → CEO woken with: "Task [task_id] 'title' failed. Replan or reassign."
            (includes full task/milestone ID table so CEO can write plan_update.json)
          → CEO can: reassign, break into smaller tasks, or mark as skippable
Turn N+2: CEO can't resolve → escalate to user via Attention Needed
```

### 6.4 Stall Check Frequency

Run `check_stalls(company_id)` after every 3rd agent turn for that company. Not a timer — triggered by turn completions. No idle cost.

---

## 7. Turn Configuration

### 7.1 Per-Turn Limits

These are safety valves, not work constraints. An agent should be able to finish most tasks in a single turn. The limits exist only to catch infinite loops or runaway processes.

```
Turn limits (applied to each Claude Code invocation):
  max_inference_rounds: 50        -- Claude Code internal tool→think cycles
  timeout_ms:          3,600,000  -- 60 minutes
  max_tool_calls:      200        -- total tool invocations per turn
```

**Why so high:** Building a full landing page (scaffold, write HTML/CSS/JS, iterate on design, test) can legitimately take 30-60 minutes of continuous Claude Code work with dozens of tool calls. The current 3-minute / 5-round limits are why agents can't finish anything. The goal is: **one task, one turn** whenever possible. The agent works until it's done or declares itself blocked.

If the Claude Code SDK finishes naturally (agent stops generating), the turn ends regardless of time remaining. These limits only kick in if something goes wrong.

**The only real budget gate is credits.** If the user runs out of credits, everything pauses. As long as credits remain, agents work uninterrupted.

### 7.2 No Per-Task Limits

There are no per-task credit budgets or turn limits. A task takes as long as it takes. The user's credit balance is the only constraint.

Stall detection (Section 6) catches tasks that aren't making progress — but it does so by checking behavioral signals (no artifact changes, no tool calls), not by imposing arbitrary budgets.

### 7.3 Role-Based Model Selection

```
CEO:          sonnet    -- strategic reasoning, plan generation
CTO:          sonnet    -- complex coding, architecture
CMO:          sonnet    -- strategy, campaign design
Frontend Dev: sonnet    -- coding
Backend Dev:  sonnet    -- coding
All others:   haiku     -- routine tasks, lower cost
```

---

## 8. User Interactions

The user is the board of directors. They can steer the company at any time — ask questions, give feedback, change direction, or order a full pivot. The CEO is the interrupt handler for all user communication.

### 8.1 User Messages to CEO

User messages always go to the CEO (even if the user clicks on another agent in the dashboard, the CEO processes it first — the CEO decides whether to relay context to the relevant agent via a plan update).

```
function on_user_message(company_id, text):
  ceo = get_ceo(company_id)

  // Store the user's message for the dashboard chat history
  msg_id = generate_id()
  INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
    VALUES (msg_id, company_id, NULL, 'user', text, now())
  enqueue_sync('messages', msg_id, 'upsert')

  // If CEO is mid-turn, queue the message — don't interrupt
  if ceo.status == 'working':
    INSERT INTO ceo_event_queue (company_id, event_type, payload, created_at)
      VALUES (company_id, 'user_message', json({text: text}), now())
    return

  // If another agent is working on a task, that's fine — CEO handles
  // user messages independently. Other agents keep working.

  // Build context for the CEO
  company = get_company(company_id)
  milestones = get_milestones(company_id)
  active_tasks = get_tasks(company_id, status IN ('in_progress', 'ready', 'blocked'))
  recent_completions = get_tasks(company_id, status = 'done', ORDER BY completed_at DESC LIMIT 5)

  prompt = f"""
  # Message from the Founder

  "{text}"

  # Current Company State

  Company: {company.name}
  Goal: {company.goal}
  State: {company.state}

  Milestones:
  {format_milestone_list(milestones)}

  Active tasks:
  {format_task_list_with_ids(active_tasks)}

  Recently completed:
  {format_task_list_with_ids(recent_completions)}

  # How to Respond

  Respond to the founder. If anything about the plan needs to change — whether
  it's tweaking one task or rebuilding the entire roadmap — write your changes to:
  /workspace/.agent/plan_update.json

  You can do ANY combination of the following in a single update:

  {
    "goal": "new company goal (only if direction is changing)",
    "add_milestones": [...],
    "cancel_milestones": ["milestone_id", ...],
    "add_tasks": [...],
    "cancel_tasks": ["task_id", ...],
    "update_tasks": [{"id": "task_id", "description": "...", ...}],
    "activate_agents": ["blueprint_id", ...],
    "deactivate_agents": ["agent_id", ...]
  }

  All fields are optional. Include only what needs to change.
  To reference a newly-added task in depends_on, use NEW_<snake_case_title>.
  If no plan changes are needed (just answering a question), don't write the file.

  Always respond to the founder with a clear summary of what you understood and
  what you're changing (if anything).
  """

  invoke_ceo_turn(company_id, ceo, prompt, is_user_facing=true)
```

### 8.1.1 CEO Turn Flow

The CEO is not a task-based agent. It does not go through `wake_agent()` or `on_agent_turn_finished()`. It has its own turn flow:

```
function invoke_ceo_turn(company_id, ceo, prompt, is_user_facing=false):
  // 1. Mark CEO as working (prevents concurrent CEO turns)
  UPDATE agents SET status = 'working' WHERE id = ceo.id

  // 2. Invoke via Claude Code SDK
  result = invoke_claude_code(
    agent       = ceo,
    prompt      = prompt,
    cwd         = company.workspace_dir,
    max_turns   = 50,
    timeout_ms  = 3_600_000,
    session_id  = ceo.session_id
  )

  // 3. Record turn (for credit tracking and activity)
  output_summary = extract_summary(result.output, "CEO coordination")
  INSERT INTO turn_log (company_id, agent_id, task_id, ..., output_summary)
    VALUES (company_id, ceo.id, NULL, ..., output_summary)
  UPDATE agents SET total_credits = total_credits + result.credits,
                    session_id = result.session_id
  deduct_credits(company.user_id, result.credits)
  enqueue_sync('turn_log', turn_log_id, 'upsert')

  // 4. Process CEO-specific output (skip during planning — handled by process_initial_plan)
  company = get_company(company_id)
  if company.state != 'planning':
    process_ceo_response(company_id, result, is_user_facing)

  // 5. Check for CEO signal files (approval requests to the user)
  check_ceo_signals(company_id, ceo)

  // 6. Mark CEO as idle
  UPDATE agents SET status = 'idle' WHERE id = ceo.id

  // 7. Drain event queue (deliver any events that arrived while CEO was working)
  drain_ceo_event_queue(company_id)

function check_ceo_signals(company_id, ceo):
  workspace = get_workspace_dir(company_id)
  approval_path = f"{workspace}/.agent/approval_request.json"

  if file_exists(approval_path):
    request = read_json(approval_path)
    delete_file(approval_path)

    // Create approval record and surface in dashboard Attention Needed
    create_approval(company_id, request)
    enqueue_sync('approvals', approval.id, 'upsert')

    // Store the CEO's turn output as a user-facing message so the user
    // sees the CEO's explanation in chat alongside the approval request
    if result.output:
      msg_id = generate_id()
      INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
        VALUES (msg_id, company_id, ceo.id, 'ceo', result.output, now())
      enqueue_sync('messages', msg_id, 'upsert')
```

### 8.2 Processing CEO Response to User Message

One path. The supervisor reads `plan_update.json` if it exists and applies whatever changes the CEO wrote. Small tweak or full pivot — same mechanism, same code.

```
function process_ceo_response(company_id, result, is_user_facing=false):
  ceo = get_ceo(company_id)
  workspace = get_workspace_dir(company_id)
  update_path = f"{workspace}/.agent/plan_update.json"

  // 1. Store the CEO's response IF this was triggered by a user message.
  //    Internal events (blocked tasks, milestone reviews) are NOT chat messages —
  //    they would clutter the user's chat with internal coordination noise.
  //    The 'is_user_facing' flag is passed by the caller (true for user messages,
  //    false for blocked tasks, milestone reviews, etc.).
  if result.output and is_user_facing:
    msg_id = generate_id()
    INSERT INTO messages (id, company_id, agent_id, role, content, created_at)
      VALUES (msg_id, company_id, ceo.id, 'ceo', result.output, now())
    enqueue_sync('messages', msg_id, 'upsert')

  // 2. Check for plan changes
  if not file_exists(update_path):
    // CEO just answered the question or reviewed a milestone with no changes.
    // If there's a newly-active milestone with pending tasks, activate them now.
    activate_pending_milestone_tasks(company_id)
    schedule(company_id)
    return

  update = read_json(update_path)
  delete_file(update_path)
  apply_plan_update(company_id, update)
  // apply_plan_update calls resolve_all_dependencies() and schedule() at the end,
  // which will also activate any pending milestone tasks that are now ready.

function activate_pending_milestone_tasks(company_id):
  // Find any active milestones where root tasks are still pending (not yet activated)
  active_milestones = SELECT id FROM milestones
    WHERE company_id = ? AND status = 'active'
  for ms_id in active_milestones:
    UPDATE tasks SET status = 'ready'
      WHERE milestone_id = ms_id AND depends_on = '[]' AND status = 'pending'
```

### 8.3 Applying Plan Updates

All changes — from tweaking one task to rebuilding the whole roadmap — go through this single function:

```
function apply_plan_update(company_id, update):
  // 1. Update company goal if changed
  if update.goal:
    UPDATE companies SET goal = update.goal WHERE id = company_id

  // 2. Cancel tasks (aborts agents working on them)
  if update.cancel_tasks:
    for task_id in update.cancel_tasks:
      task = get_task(task_id)
      if task.status == 'in_progress':
        agent = get_agent(task.owner_agent_id)
        if agent.status == 'working':
          // abort_agent_turn signals the AbortController associated with
          // the agent's active Claude Code SDK invocation. The SDK will
          // stop the conversation cleanly. The agent's session is preserved
          // so it can be resumed for a different task later.
          abort_agent_turn(agent.id)  // → abortControllers.get(agent.id).abort()
        UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = agent.id
      UPDATE tasks SET status = 'cancelled' WHERE id = task_id

  // 3. Cancel milestones (cancels all their non-done tasks too)
  if update.cancel_milestones:
    for milestone_id in update.cancel_milestones:
      UPDATE milestones SET status = 'cancelled' WHERE id = milestone_id
      // Cancel all non-completed tasks in this milestone
      tasks_to_cancel = SELECT id FROM tasks
        WHERE milestone_id = ? AND status NOT IN ('done', 'cancelled')
      for task_id in tasks_to_cancel:
        // Same abort logic as above
        cancel_task(task_id)

  // 4. Add new milestones
  if update.add_milestones:
    max_order = SELECT max(sort_order) FROM milestones WHERE company_id = ?
    for i, milestone in enumerate(update.add_milestones):
      m_id = generate_id()
      INSERT INTO milestones (id, company_id, title, description, sort_order, status, created_by)
        VALUES (m_id, company_id, milestone.title, milestone.description,
                max_order + 1 + i, 'pending', ceo_agent_id)
      // Insert tasks for this milestone (same as ingest_plan)
      insert_milestone_tasks(m_id, milestone.tasks, company_id)

  // 5. Add new tasks (to existing milestones)
  //    Track title→ID mapping so update_tasks can reference new tasks via NEW_ prefix
  new_task_ids = {}  // maps "NEW_<snake_case_title>" → actual generated ID
  if update.add_tasks:
    for task_def in update.add_tasks:
      real_id = validate_and_insert_task(company_id, task_def)
      temp_key = "NEW_" + snake_case(task_def.title)
      new_task_ids[temp_key] = real_id

  // 6. Update existing tasks
  //    Resolve any NEW_ references in depends_on to real IDs
  if update.update_tasks:
    for task_update in update.update_tasks:
      if task_update.depends_on:
        task_update.depends_on = [
          new_task_ids[dep] if dep.startswith("NEW_") else dep
          for dep in task_update.depends_on
        ]
      apply_task_update(task_update)  // description, assignment, dependencies, etc.

  // 7. Activate new agents
  if update.activate_agents:
    for blueprint_id in update.activate_agents:
      activate_agent(company_id, blueprint_id)

  // 8. Deactivate agents
  if update.deactivate_agents:
    for agent_id in update.deactivate_agents:
      deactivate_agent(company_id, agent_id)

  // 9. Re-resolve all dependencies (some may have changed)
  resolve_all_dependencies(company_id)

  // 10. Schedule
  schedule(company_id)
```

The CEO doesn't think about "is this a small change or a big one." It just writes what needs to change. If it cancels everything and adds new milestones, that's a pivot. If it adds one task, that's a tweak. The supervisor processes it identically.

### 8.4 CEO Event Queue Processing

The CEO gets woken for many reasons: user messages, blocked tasks, milestone reviews, task failures. If the CEO is mid-turn when an event occurs, the event is queued. After every CEO turn, the supervisor drains the queue.

```
function notify_ceo(company_id, event_type, payload):
  ceo = get_ceo(company_id)

  if ceo.status == 'working':
    // CEO is busy — queue for later (will be drained after CEO's current turn)
    INSERT INTO ceo_event_queue (company_id, event_type, payload, created_at)
      VALUES (company_id, event_type, json(payload), now())
    return

  // CEO is idle — deliver immediately
  deliver_ceo_event(company_id, {event_type, payload})

function drain_ceo_event_queue(company_id):
  events = SELECT * FROM ceo_event_queue
    WHERE company_id = ? AND delivered = 0
    ORDER BY created_at ASC

  if events.length == 0: return

  // Group user messages together, process other events individually
  user_msgs = events.filter(e => e.event_type == 'user_message')
  other_events = events.filter(e => e.event_type != 'user_message')

  // Deliver user messages first (founder messages are highest priority)
  if user_msgs.length > 0:
    combined = user_msgs.map(e => f"[{e.created_at}] {json_parse(e.payload).text}").join("\n\n")
    UPDATE ceo_event_queue SET delivered = 1 WHERE id IN (user_msg_ids)
    deliver_queued_user_messages(company_id, combined)
    return  // CEO will process remaining events on next drain

  // No user messages — deliver the next non-user event
  if other_events.length > 0:
    event = other_events[0]
    UPDATE ceo_event_queue SET delivered = 1 WHERE id = event.id
    deliver_ceo_event(company_id, event)
    // Only deliver ONE event per drain. The CEO turn for this event will trigger
    // another drain via invoke_ceo_turn step 6, which handles the rest.

function deliver_queued_user_messages(company_id, combined_text):
  // Same as on_user_message but WITHOUT storing messages (already stored on arrival)
  ceo = get_ceo(company_id)
  company = get_company(company_id)
  milestones = get_milestones(company_id)
  active_tasks = get_tasks(company_id, status IN ('in_progress', 'ready', 'blocked'))
  recent_completions = get_tasks(company_id, status = 'done', ORDER BY completed_at DESC LIMIT 5)

  prompt = build_ceo_user_message_prompt(combined_text, company, milestones, active_tasks, recent_completions)
  invoke_ceo_turn(company_id, ceo, prompt, is_user_facing=true)

function deliver_ceo_event(company_id, event):
  ceo = get_ceo(company_id)
  match event.event_type:
    case 'task_blocked':
      prompt = build_ceo_blocked_task_prompt(company_id, event.payload)
      invoke_ceo_turn(company_id, ceo, prompt)
    case 'milestone_review':
      prompt = build_ceo_milestone_review_prompt(company_id, event.payload)
      invoke_ceo_turn(company_id, ceo, prompt)
    case 'task_failed':
      prompt = build_ceo_task_failed_prompt(company_id, event.payload)
      invoke_ceo_turn(company_id, ceo, prompt)
    case 'no_agent_assigned':
      prompt = build_ceo_unassigned_task_prompt(company_id, event.payload)
      invoke_ceo_turn(company_id, ceo, prompt)
```

The queue is drained in step 6 of `invoke_ceo_turn()` (Section 8.1.1) — after every CEO turn completes, before the function returns.

### 8.5 User Messages to Non-CEO Agents

If the dashboard allows messaging specific agents (not just CEO), the message is still routed through the CEO for coordination:

```
function on_user_message_to_agent(company_id, target_agent_id, text):
  target = get_agent(target_agent_id)

  // Route through CEO with context about who the message is for
  augmented_text = f"[Message intended for {target.name} ({target.role})]: {text}"
  on_user_message(company_id, augmented_text)

  // CEO decides: answer directly, relay via plan update, or ignore
```

This prevents users from creating chaos by directly commanding individual agents outside the task structure. The CEO maintains coherence.

### 8.7 Approvals

Only the CEO can request user approval. Worker agents cannot escalate to the user directly — they declare blockers via `task_blocked.json`, and the CEO decides whether to resolve it internally (replan, add tasks) or escalate to the user.

**Flow:**

1. Agent encounters something it can't do (needs API keys, budget approval, unclear requirements)
2. Agent writes `/workspace/.agent/{agent_id}/task_blocked.json` with the reason
3. Supervisor marks task blocked, notifies CEO
4. CEO evaluates the blocker. If it requires user input, CEO writes `/workspace/.agent/approval_request.json`:
```json
{
  "type": "purchase_service",
  "description": "Twitter API access ($99/month) needed for cold outreach campaign",
  "related_task_id": "task_456"
}
```
5. Supervisor detects the signal (see `check_ceo_signals` in Section 8.1.1), creates approval record, stores CEO's explanation as a user-facing chat message, surfaces in dashboard Attention Needed
6. User approves/rejects in dashboard
7. Worker pushes resolution to supervisor

The approval resolution handler:

```
function on_approval_resolved(company_id, approval_id, decision):
  approval = get_approval(approval_id)
  task = get_task(approval.related_task_id)

  if decision == 'approved':
    // Unblock the task and re-wake the agent with the approval result
    agent = get_agent(task.owner_agent_id)
    UPDATE tasks SET status = 'in_progress', blocked_reason = NULL WHERE id = task.id
    prompt = f"Your blocker has been resolved. The founder APPROVED: {approval.description}\nContinue your task."
    wake_agent(agent, task, override_prompt=prompt)
  else:
    // Rejected — notify CEO to replan (task stays blocked)
    notify_ceo(company_id, 'task_blocked', {
      task_id: task.id,
      task_title: task.title,
      reason: 'Founder rejected: ' + approval.description
    })
```

**Why CEO-only:** The CEO is the single point of contact between agents and the user. This prevents N agents from independently spamming the user with approval requests. The CEO can batch, prioritize, and contextualize requests — "We need Twitter API access for the marketing campaign" is more useful to the user than a raw agent blocker message.

**V1 Limitation — soft enforcement only.** Agents run via Claude Code SDK with `permissionMode: "bypassPermissions"` and have unrestricted bash/file/network access. The approval mechanism relies on agents self-policing via their system prompt — an agent is *told* to declare blockers for purchases, but nothing technically prevents it from running `curl` to buy something directly. MCP servers provide hard boundaries for specific integrations (email, browser), but raw bash is unrestricted. This is acceptable for V1 because:
- Agents operate in isolated Docker containers (blast radius is contained)
- The credit system limits total spend (agents can't spend more than the user's balance)
- System prompts from blueprints are controlled by us, not user-authored
- Future versions can add a `disallowedTools` list or sandboxed bash wrapper

---

## 9. Credit Management

### 9.1 Local Balance

The VM maintains a local credit balance per user. This is the working copy decremented in real-time.

```
function deduct_credits(user_id, amount):
  UPDATE credit_balances SET balance = balance - amount WHERE user_id = ?
  balance = get_balance(user_id)

  if balance <= 0:
    pause_all_companies(user_id)
    // pause_all_companies sets company state to 'paused' and all idle agents
    // to 'paused'. Agents that are currently 'working' are NOT aborted — they
    // finish their current turn naturally. When their turn ends, on_agent_turn_finished
    // checks the credit balance, sees it's <= 0, and calls pause_company again
    // (which is idempotent). This means at most one extra turn of credit overrun,
    // which is acceptable — the alternative (aborting mid-turn) wastes the work done.
    enqueue_sync('credit_exhausted', user_id)

  // Queue sync to D1
  enqueue_sync('credit_deduction', user_id, amount)
```

### 9.2 Credit Sync

Every 30 seconds, push accumulated deductions to D1:

```
function sync_credits():
  pending = SELECT * FROM sync_queue WHERE table_name = 'credit_deduction' AND synced = 0
  if pending.length == 0: return

  // Batch into one API call
  total_by_user = group_and_sum(pending, 'record_id', 'payload.amount')

  for user_id, total in total_by_user:
    POST to Worker API: /api/supervisor/credits/{user_id}/deduct
      body: {amount: total, company_id, agent_id, description}

  UPDATE sync_queue SET synced = 1 WHERE id IN (pending.ids)
```

### 9.3 Credit Initialization

When a company is provisioned, the supervisor fetches the current balance from D1 and stores locally:

```
function init_company_credits(company_id, user_id):
  response = GET Worker API: /api/supervisor/credits/{user_id}
  INSERT OR REPLACE INTO credit_balances (user_id, balance, last_synced_at)
    VALUES (user_id, response.balance, now())
```

### 9.4 Credit Purchase Notification

When D1 receives a credit purchase (Stripe webhook), the Worker pushes to the supervisor:

```
Worker → POST supervisor: /credits/purchased
  body: {user_id, amount}

Supervisor:
  UPDATE credit_balances SET balance = balance + amount WHERE user_id = ?
  resume_paused_companies(user_id)
```

---

## 10. D1 Sync

### 10.1 What Syncs

| Data | Direction | Frequency | Trigger |
|------|-----------|-----------|---------|
| Credit deductions | VM → D1 | Every 30s | Batched |
| Task status changes | VM → D1 | On change | Immediate (enqueued) |
| Milestone status | VM → D1 | On change | Immediate |
| Agent status | VM → D1 | On change | Immediate |
| Chat messages | VM → D1 | On change | Immediate |
| Activity log | VM → D1 | Every 30s | Batched |
| Turn log summaries | VM → D1 | Every 60s | Batched |
| User messages | D1 → VM | Push | Webhook/tunnel |
| Credit purchases | D1 → VM | Push | Webhook |
| Approval resolutions | D1 → VM | Push | Webhook |

### 10.2 Sync Resilience

```
function run_sync_cycle():
  pending = SELECT * FROM sync_queue
    WHERE attempts < max_attempts
    AND next_attempt_at <= now()
    ORDER BY created_at ASC LIMIT 100

  for item in pending:
    try:
      push_to_d1(item)
      DELETE FROM sync_queue WHERE id = item.id
    catch error:
      // Exponential backoff: 5s, 25s, 125s, 625s, 3125s
      next_delay_s = 5 ** (item.attempts + 1)
      UPDATE sync_queue SET
        attempts = attempts + 1,
        last_error = error.message,
        next_attempt_at = datetime('now', f'+{next_delay_s} seconds')
      WHERE id = item.id

  // Prune dead items (exceeded max_attempts) after 24h
  DELETE FROM sync_queue
    WHERE attempts >= max_attempts
    AND created_at < datetime('now', '-24 hours')
```

If the Worker/D1 is unreachable, items back off exponentially instead of retrying every cycle (avoids poison-queue hammering). After `max_attempts` (5), items stop retrying but are kept for 24h for debugging. Agents never block on sync.

---

## 11. Handling Edge Cases

### 11.1 Agent Produces No Signal File

If the agent finishes a turn without writing `task_done.json` or `task_blocked.json`:
- Assume the agent is still working
- Increment `turns_spent`
- Check stall conditions (behavioral — no artifact changes, no tool calls)
- Check company credit balance — if credits remain, schedule another turn
- Re-schedule for another turn

### 11.2 Circular Dependencies

Detected at plan validation time. `has_cycle()` does a topological sort — if it fails, the plan is rejected. The CEO is asked to fix the dependency graph.

### 11.3 Agent Assigned to Multiple Tasks

An agent can only work on one task at a time (`current_task_id`). If multiple tasks are ready and assigned to the same agent, the scheduler picks the one from the earliest milestone (lowest `sort_order`).

### 11.4 Task With No Assigned Agent

If `owner_agent_id` is NULL or the agent is terminated:
- Mark task as `blocked` with reason "No agent assigned"
- Wake CEO: "Task X has no assigned agent. Assign someone."

### 11.5 CEO Task Failures

If the CEO's planning task itself fails (bad JSON, validation errors, 3 retries exhausted):
- Escalate directly to the user: "Your company's CEO couldn't create a valid plan. Would you like to provide more specific goals?"

### 11.6 Supervisor Restart

See Section 16 (Startup Sequence) for the full procedure. Key property: no state is lost. SQLite persists all operational state, Claude Code SDK sessions persist on disk. Working agents are reset to idle, in_progress tasks are left as-is, and `schedule()` re-wakes them.

### 11.7 Company With No Remaining Tasks

If all tasks are done or failed and no milestones remain:
- If all milestones are `done`: company state → `completed`
- If any milestone is `failed`: wake CEO to replan the failed milestone
- If CEO can't fix it: company state → `failed`, notify user

---

## 12. Inter-Agent Communication

### 12.1 No Direct Chat

Agents do NOT send free-form messages to each other. The current outbox system is eliminated. All coordination happens through the task dependency graph:

- "I need CTO to do X" → Create a task assigned to CTO with appropriate dependencies
- "I'm done, CTO can proceed" → Mark task done, supervisor resolves dependencies, wakes CTO
- "I need info from CMO" → This should be a task dependency. If it wasn't in the plan, the agent declares a blocker and the CEO replans.

**This is a deliberate architectural break from the current system.** The live supervisor uses structured outbox messaging (`outbox.ts`) for task delegation, workflow stages, QA/release handoffs, approvals, and management controls. V2 replaces ALL of these with:

| Current (outbox) | V2 replacement |
|-------------------|----------------|
| Agent-to-agent task delegation | Task dependencies in the plan — CEO assigns via `plan_update.json` |
| Workflow stages (draft → review → publish) | Sequential tasks with dependency chains |
| QA/release handoffs | QA task depends on build task, release task depends on QA task |
| Approval requests | Agent declares blocker → CEO writes `approval_request.json` |
| Management controls (CEO → agent instructions) | CEO updates task descriptions via `update_tasks` in `plan_update.json` |

The tradeoff: the outbox allowed real-time, ad-hoc coordination between agents. The dependency graph requires all coordination to be pre-planned or routed through the CEO. This adds latency when agents discover unexpected needs (CEO must be woken to replan), but eliminates the convergence problems documented in `WORKFLOW-DIAGNOSIS.md` — agents going in circles, redundant communication, no progress tracking on chat-based handoffs.

This is a rewrite of the coordination layer, not a refactor. The outbox code (`outbox.ts`, relay messaging in `supervisor.ts`) is not carried over.

### 12.2 CEO as Replanner

When an agent discovers that the plan needs adjustment (unexpected blocker, new requirement):

1. Agent writes `/workspace/.agent/{agent_id}/task_blocked.json` with the reason
2. Supervisor marks task as `blocked`
3. Supervisor calls `notify_ceo(company_id, 'task_blocked', {task_id, reason})`
   - If CEO is idle, delivers immediately: "Task [id] 'title' is blocked: {reason}. Update the plan."
   - If CEO is busy, event is queued and delivered after the current CEO turn completes
4. CEO writes `/workspace/.agent/plan_update.json` with task additions/removals/changes
5. Supervisor validates and applies the update
6. Dependencies re-resolve, scheduling continues

### 12.3 Plan Update Format

The CEO uses the same unified `plan_update.json` format for all changes (see Section 8.3). Example for unblocking an agent that needs API credentials:

```json
{
  "add_tasks": [
    {
      "milestone_id": "milestone_123",
      "title": "Provision Twitter API credentials",
      "description": "Get Twitter API access for the marketing agent",
      "assigned_to": "api-keys-agent",
      "depends_on": [],
      "acceptance_criteria": [
        {"type": "file_exists", "path": "/workspace/.credentials/twitter.json"}
      ]
    }
  ],
  "update_tasks": [
    {
      "id": "task_456",
      "depends_on": ["task_123", "NEW_provision_twitter_api_credentials"]
    }
  ]
```

The `NEW_provision_twitter_api_credentials` reference is resolved by the supervisor to the real task ID after the new task is inserted (see Section 8.3, step 5-6).

---

## 13. Cron Tasks (Ongoing Work)

Some work doesn't fit the milestone/dependency model — it's recurring: check email, post to social media, monitor analytics.

### 13.1 Cron as Separate Track

Cron tasks run independently of the milestone system. They don't block milestone progress. Schema is in Section 2.1.

### 13.2 Cron Scheduling Rule

Cron tasks yield to milestone tasks. The core `schedule()` function (Section 3.2) handles milestone tasks. After milestone scheduling, it calls `schedule_cron_tasks()`:

```
// Called at the end of schedule() after all milestone tasks have been dispatched
function schedule_cron_tasks(company_id):
  idle_agents = get_idle_agents(company_id)
  if idle_agents.length == 0: return  // all agents busy with milestone work

  due_crons = get_due_cron_tasks(company_id)
  for cron in due_crons:
    agent = find_agent(cron.agent_id)
    if agent.status == 'idle':
      invoke_cron(agent, cron)
```

Cron tasks are second-class citizens. Milestone work always takes priority.

---

## 14. File Structure

```
supervisor/src/
├── index.ts                 -- entry point, config, startup, shutdown
├── db.ts                    -- local SQLite wrapper (open, migrate, query helpers)
├── scheduler.ts             -- THE core: schedule(), on_task_completed(), dependency resolution
├── task-manager.ts          -- task CRUD, plan ingestion, validation, acceptance criteria checks
├── agent-runner.ts          -- build_task_prompt(), wake_agent(), process turn results
├── agent-invoker.ts         -- Claude Code SDK integration (keep existing, works fine)
├── credit-manager.ts        -- local balance, deduction, exhaustion, sync
├── stall-detector.ts        -- check_stalls(), handle_stall(), escalation chain
├── container-manager.ts     -- Docker lifecycle (keep existing, works fine)
├── sync.ts                  -- D1 sync cycle, queue processing
├── api.ts                   -- Hono HTTP API for Worker calls
├── cron.ts                  -- cron task scheduling, separate from milestone tasks
├── types.ts                 -- all types, interfaces, enums
└── blueprints.ts            -- agent blueprints (keep existing)
```

Total: 14 files. The 7,000-line god file becomes 6 focused modules (scheduler, task-manager, agent-runner, credit-manager, stall-detector, sync) averaging 300-600 lines each.

---

## 15. Progress Reporting

### 15.1 Metrics Available to Dashboard

```json
{
  "company_id": "...",
  "state": "running",
  "milestones": {
    "total": 3,
    "done": 1,
    "active": 1,
    "pending": 1
  },
  "tasks": {
    "total": 12,
    "done": 5,
    "in_progress": 2,
    "ready": 1,
    "pending": 3,
    "failed": 1,
    "blocked": 0
  },
  "credits": {
    "balance": 3420,
    "spent_total": 1580,
    "spent_24h": 340,
    "burn_rate_per_hour": 14.2,
    "estimated_hours_remaining": 240.8
  },
  "health": {
    "last_task_completed_at": "2026-03-10T14:32:00Z",
    "minutes_since_progress": 8,
    "stalled_tasks": 0,
    "failed_tasks": 1
  },
  "agents": {
    "total": 6,
    "working": 2,
    "idle": 3,
    "paused": 1
  }
}
```

### 15.2 Agent Activity Feed Data

The dashboard's Agent Activity Feed shows what each agent is doing right now. This data comes from the `turn_log` and `agents` tables:

```
function get_agent_activity(company_id):
  agents = get_agents(company_id)
  activity = []

  for agent in agents:
    latest_turn = SELECT output_summary, created_at FROM turn_log
      WHERE agent_id = agent.id ORDER BY created_at DESC LIMIT 1

    current_task = get_task(agent.current_task_id) if agent.current_task_id else null

    activity.push({
      agent_id: agent.id,
      agent_name: agent.name,
      agent_role: agent.role,
      status: agent.status,
      current_task: current_task.title if current_task else null,
      last_activity: latest_turn.output_summary if latest_turn else null,
      last_active_at: latest_turn.created_at if latest_turn else agent.created_at
    })

  return activity sorted by: working first, then by last_active_at desc
```

This is everything the dashboard needs. The current dashboard components (Agent Activity Feed, Compact Metrics, Task Board) can consume this directly.

### 15.3 Health Thresholds

```
minutes_since_progress:
  < 15: healthy (green)
  15-60: slow (amber)
  > 60: stalled (red) — investigate

stalled_tasks > 0: always amber
failed_tasks > 2: red — company may need user intervention

estimated_hours_remaining < 2: red — credits running low
```

---

## 16. Startup Sequence

```
1. Load config from environment variables
2. Open/create local SQLite database, run migrations
3. Discover existing Docker containers
4. For each company in local DB with state 'running' or 'planning':
   a. Verify container is running (restart if needed)
   b. Reset any 'working' agents to 'idle' (interrupted by supervisor restart)
   c. Leave 'in_progress' tasks as-is (schedule() handles them — wakes idle agents)
   d. Init credit balance from D1 (one-time fetch)
   e. Populate telemetry_mirror from D1 (one-time fetch, see SUPERVISOR-SPEC-GAPS.md §2.8)
5. Start sync cycle (every 30s)
6. Start Hono HTTP server
7. Run schedule() for every active company
8. Ready.
```

---

## 17. Agent System Prompts

The supervisor passes a `customSystemPrompt` to every Claude Code invocation. This is how agents know what tools they have. The system prompt is **persistent** — it's included in every turn, not just the first one. The per-turn `prompt` (the user message) changes each time, but the system prompt is constant.

### 17.1 CEO System Prompt

This is the complete system prompt for the CEO agent. It teaches the CEO everything it can do.

```
You are the CEO of {company.name}.
Company goal: {company.goal}

You are an AI agent running inside an automated company. You work with a team
of specialist agents (CTO, CMO, developers, marketers, etc.) who each handle
their assigned tasks. You don't do the work yourself — you plan, coordinate,
and adapt.

# How This System Works

You operate inside a task-driven system. A supervisor (not an AI — a program)
manages the workflow:
- You create plans with milestones and tasks
- The supervisor assigns tasks to agents and wakes them
- When an agent finishes a task, the supervisor checks its work and moves to the next task
- When something goes wrong, the supervisor wakes you to fix the plan

You communicate with the supervisor by writing JSON files. You communicate with
the founder (the human who created this company) by responding in natural language.

# Your Tools

## 1. Create the initial plan
Write to: /workspace/.agent/plan.json

When the company is first created, you receive the goal and must break it down
into milestones and tasks.

Format:
{
  "milestones": [
    {
      "title": "Landing page live",
      "description": "A public website at the company subdomain with homepage, about, and contact",
      "tasks": [
        {
          "title": "Write homepage copy",
          "description": "Write compelling copy for the landing page: headline, subheadline, value props, CTA",
          "assigned_to": "cmo",
          "depends_on": [],
          "acceptance_criteria": [
            {"type": "file_not_empty", "path": "/workspace/content/homepage.md"}
          ]
        },
        {
          "title": "Build the landing page",
          "description": "Create index.html with the homepage copy, responsive design, clean layout",
          "assigned_to": "frontend-dev",
          "depends_on": ["Write homepage copy"],
          "acceptance_criteria": [
            {"type": "file_exists", "path": "/workspace/public/index.html"},
            {"type": "file_contains", "path": "/workspace/public/index.html", "substring": "<html"}
          ]
        }
      ]
    }
  ],
  "agents_needed": ["cmo", "frontend-dev", "cto"]
}

Rules:
- Milestones are sequential (milestone 2 starts after milestone 1 completes)
- Tasks within a milestone can run in parallel if they don't depend on each other
- depends_on references task TITLES within the same milestone
- assigned_to is a blueprint ID (see Available Agents below)
- Every task needs at least one acceptance_criteria with type "file_exists" or "file_not_empty"
- Keep tasks focused — one deliverable per task

## 2. Update the plan
Write to: /workspace/.agent/plan_update.json

Use this whenever you need to change anything about the current plan — whether
the founder asked for a change, an agent is blocked, or you realize the plan
needs adjustment. All fields are optional. Include only what needs to change.

Format:
{
  "goal": "new company goal (only if the direction is changing)",
  "add_milestones": [
    {
      "title": "...",
      "description": "...",
      "tasks": [...]
    }
  ],
  "cancel_milestones": ["milestone_id_1", "milestone_id_2"],
  "add_tasks": [
    {
      "milestone_id": "milestone_123",
      "title": "...",
      "description": "...",
      "assigned_to": "blueprint-id",
      "depends_on": [],
      "acceptance_criteria": [...]
    }
  ],
  "cancel_tasks": ["task_id_1", "task_id_2"],
  "update_tasks": [
    {
      "id": "task_id",
      "description": "updated description",
      "assigned_to": "different-agent",
      "depends_on": ["other_task_id"]
    }
  ],
  "activate_agents": ["blueprint-id-1"],
  "deactivate_agents": ["agent-id-1"]
}

Use this for everything:
- Founder says "change the color scheme" → update_tasks on the design task
- Founder says "pivot to mobile app" → cancel current milestones, add new ones
- Agent is blocked on API credentials → add_tasks for provisioning, update dependencies
- Milestone done and next one needs tweaks → update_tasks or add_tasks

Referencing new tasks: If you add a task and want an existing task to depend on it
in the same update, use `NEW_<snake_case_title>` as the temporary ID:

{
  "add_tasks": [{"title": "Provision Twitter API", ...}],
  "update_tasks": [{"id": "task_456", "depends_on": ["task_123", "NEW_provision_twitter_api"]}]
}

The supervisor resolves `NEW_` references to real IDs after inserting the new tasks.

## 3. Request user approval
Write to: /workspace/.agent/approval_request.json

When you decide that a blocker requires the founder's approval (e.g., a purchase,
an external account signup, a strategic decision), write this file:

{
  "type": "purchase_service",
  "description": "Twitter API access ($99/month) needed for cold outreach",
  "related_task_id": "task_456"
}

The supervisor will surface this to the founder in the dashboard. You'll be
woken when they approve or reject it.

Only use this when YOU cannot resolve the blocker through replanning. If you
can fix it by adding tasks or reassigning work, use plan_update.json instead.

## 4. Signal files (used by other agents, not you)

Other agents communicate with the supervisor through signal files:
- /workspace/.agent/{agent_id}/task_done.json — agent declares its task complete
- /workspace/.agent/{agent_id}/task_blocked.json — agent declares it's stuck

You don't write these. The supervisor wakes you when an agent is blocked
so you can decide what to do: replan (plan_update.json) or escalate to the
founder (approval_request.json).

# When You Get Woken Up

The supervisor wakes you for specific reasons. The prompt will tell you why:
- "Create the initial plan" → Write plan.json
- "Message from the founder: ..." → Respond and optionally write plan_update.json
- "Task X is blocked: ..." → Replan via plan_update.json, or escalate via approval_request.json
- "Milestone completed: ..." → Review and optionally adjust the next milestone
- "Task X failed after N turns" → Write plan_update.json to reassign or break it down
- "Founder rejected: ..." → An approval was rejected, replan the blocked task

# Available Agents

{format_blueprint_pool_with_ids_and_descriptions}

# Important

- You plan and coordinate. You do NOT write code, design pages, or send emails.
- Every agent works on exactly one task at a time.
- Agents can only do what their acceptance criteria check for — be specific.
- If you're unsure what to do, write a plan_update.json that adds a small
  exploratory task assigned to the right specialist.
- The founder is the boss. If they want something changed, change it.
```

### 17.2 Worker Agent System Prompt

This is the system prompt for all non-CEO agents (CTO, CMO, Frontend Dev, etc.). The per-agent blueprint prompt is appended after this base.

```
You are {agent.name}, the {agent.role} at {company.name}.

# How This System Works

You are an AI agent in an automated company. A supervisor assigns you tasks
one at a time. You do the work, then signal that you're done. You do not
decide what to work on — the supervisor tells you.

# What You Receive

Each time you wake up, you get a prompt describing:
- Your assigned task (title, description)
- Acceptance criteria (what must be true when you're done)
- Input artifacts from completed tasks you depend on
- Context if this is a continuation of previous work

# How to Signal Completion

When you have finished your task, write this file:
/workspace/.agent/{your_agent_id}/task_done.json

{
  "task_id": "<the task ID from your prompt>",
  "artifact": "<path to your main deliverable, e.g. /workspace/src/index.html>",
  "summary": "<one sentence: what you built/wrote/did>"
}

Your agent ID is provided in each task prompt. Use it in the path.

# How to Signal a Blocker

If you cannot complete your task because something is missing (API key,
dependency not available, unclear requirements, etc.), write this file:
/workspace/.agent/{your_agent_id}/task_blocked.json

{
  "task_id": "<the task ID from your prompt>",
  "reason": "<specific explanation of what's blocking you>"
}

The CEO will be notified and will update the plan to resolve your blocker.

# Rules

1. Work ONLY on the task described in your prompt. Do not do other work.
2. Write real files to /workspace/. Your work must be tangible.
3. Check the acceptance criteria before declaring done — the supervisor
   will verify them automatically.
4. If you need something from another agent, do NOT try to message them.
   Declare a blocker and the CEO will handle coordination.
5. Your conversation persists between turns — if you're continuing work,
   you have context from your previous turns.
6. Be efficient. Produce the deliverable, verify it meets criteria, signal done.
```

Then the agent's **blueprint-specific prompt** is appended. For example, the CTO blueprint adds:

```
# Your Specialty

You are the CTO. You handle:
- System architecture decisions
- Code review and technical standards
- Complex coding tasks (backend, infrastructure, databases)
- Technical documentation

You write code in /workspace/src/ and documentation in /workspace/docs/.
You use TypeScript/Node.js unless the task specifies otherwise.
```

### 17.3 How Prompts Are Assembled

```
function build_system_prompt(agent):
  if agent.role == 'ceo':
    return CEO_SYSTEM_PROMPT
      .replace('{company.name}', company.name)
      .replace('{company.goal}', company.goal)
      .replace('{format_blueprint_pool_with_ids_and_descriptions}', format_pool())

  else:
    base = WORKER_AGENT_SYSTEM_PROMPT
      .replace('{agent.name}', agent.name)
      .replace('{agent.role}', agent.role)
      .replace('{company.name}', company.name)

    blueprint = get_blueprint(agent.blueprint_id)
    return base + "\n\n" + blueprint.specialtyPrompt
```

The **system prompt** is passed as `customSystemPrompt` to Claude Code SDK — it persists across session resumptions. The **task prompt** is passed as `prompt` — it changes each turn.

```
invoke_claude_code({
  prompt: build_task_prompt(agent, task),          // changes per turn
  options: {
    customSystemPrompt: build_system_prompt(agent), // constant
    cwd: workspace_dir,
    resume: agent.session_id,
    ...
  }
})
```

---

## 18. What This Spec Does NOT Cover

- **Agent Relay integration** — deferred. Structured task handoffs replace free-form relay messages. Relay can be re-added later for real-time notifications.
- **Custom agent creation** — deferred. CEO can only hire from the blueprint pool for now.
- **Dedicated VM provisioning** — deferred. All companies run on the shared VM.
- **MCP server configuration** — kept as-is. Agents have access to email, browser, etc. through existing MCP mounts.
- **Hard policy enforcement** — V1 uses soft enforcement (system prompt instructions + MCP boundaries). Agents self-police on purchases and external actions. Hard enforcement (tool allowlists, sandboxed bash) deferred to V2.
- **Dashboard changes** — minimal. The data shape changes slightly but existing components handle it.
- **Worker API changes** — minimal. A few new proxy routes, some endpoints read from VM instead of D1.
