# Supervisor V2 Code Review

**Date:** 2026-03-11
**Reviewer:** Claude (Opus 4)
**Codebase:** `supervisor/src/` (11 TypeScript files)

---

## CRITICAL (5 findings)

| # | File:Line | Issue | Impact |
|---|-----------|-------|--------|
| 1 | `agent-invoker.ts:525-531` | **Timeout promise timer leak** — `Promise.race([runClaudeCode(), timeout()])` never cancels the losing timer. After every successful agent turn, the orphaned `setTimeout` fires and rejects a promise nobody is listening to → unhandled rejection → **supervisor crashes**. Default `turnTimeoutMs` = 3,600,000ms (1 hour), so every successful turn schedules a delayed crash 1 hour later. | Every successful agent turn crashes the supervisor after the timeout period. |
| 2 | `agent-runner.ts:652-656` | **`invoke()` exception leaves agent permanently stuck** — No try/catch around `this.invoker.invoke()`. If the SDK throws (network error, AbortError), the agent stays `working`, abort controller leaks from the Map, task stays `in_progress` with no turn log entry. No recovery path except supervisor restart. | Agent permanently deadlocked on any SDK-level exception. |
| 3 | `agent-runner.ts:627` | **Signal file bad JSON crashes turn flow** — `parse_json` (raw `JSON.parse`) on `task_done.json`/`task_blocked.json`. Malformed JSON from an agent kills `check_agent_signals`, exception propagates to `wake_agent` which has no catch, leaving agent in `working` state. Signal file is already deleted by `rmSync` before the parse. | Agent stuck forever if it writes invalid JSON signal. |
| 4 | `db.ts:308-315` | **Dead sync items never pruned** — `prune_dead_sync_items()` compares ISO timestamps (`2026-03-10T14:30:00.000Z`) against SQLite `datetime()` output (`2026-03-10 14:30:00`). The `T` character (ASCII 84) is greater than space (ASCII 32), so ISO strings always sort "greater" than the `datetime()` result. The condition `created_at < datetime('now', '-24 hours')` is **never true**. `sync_queue` grows unbounded. | Unbounded table growth; eventual performance degradation and disk exhaustion. |
| 5 | `sync.ts:176-199` | **Bootstrap doesn't reset `working` agents to `idle`** — Spec Section 16 step 4b requires resetting working agents after restart. Agents restored from D1 with `status = 'working'` stay working permanently — no SDK process is running, and the scheduler skips them. Note: `index.ts:80-105` has `reset_working_agents()` in `hydrate_active_companies()` called after bootstrap, but if bootstrap inserts agents after hydration runs, the reset is missed. | Agents permanently stuck after restart if bootstrap ordering is wrong. |

## MEDIUM (13 findings)

| # | File:Line | Issue |
|---|-----------|-------|
| 6 | `container-manager.ts:271` | **Shell injection in `execInContainer`** — `` `docker exec ${name} ${command}` `` uses string interpolation without escaping. If `command` contains shell metacharacters, arbitrary commands execute on the host. |
| 7 | `agent-runner.ts:628,636` | **Signal file deleted before task_id validation** — `rmSync` runs before `payload.task_id === task.id` check. On mismatch, signal is permanently destroyed and never processed for the correct task. |
| 8 | `scheduler.ts:1510-1526` | **CEO messages not synced to D1** — `insert_ceo_message()` writes to local SQLite but never calls `enqueue_sync("messages", ...)`. Dashboard users never see CEO responses until a full re-bootstrap. |
| 9 | `stall-detector.ts:50-61` | **`no_tool_calls` SQL semantics deviate from spec** — Time filter in WHERE clause instead of HAVING. Spec intent: find agents with 2+ zero-tool-call turns *ever*, where the most recent is within 30 minutes. Code: find agents with 2+ zero-tool-call turns *within* the last 30 minutes only. Misses spread-out chatty agents. |
| 10 | `stall-detector.ts:110-113` | **Stall escalation doesn't mark task `failed`** — Spec Section 6.3 says: mark task failed, then notify CEO. Code only calls `escalate_to_ceo()` without setting `status = 'failed'`. Task stays `in_progress`, stall re-fires every check cycle, CEO gets spammed. |
| 11 | `task-manager.ts:164-209` | **`activate_agent` returns terminated agents** — `find_agent_by_blueprint()` returns any agent with that blueprint regardless of status. If a blueprint was deactivated (`terminated`) then reactivated, the terminated agent is returned. Tasks assigned to it never execute. |
| 12 | `credit-manager.ts:194-215` | **`apply_credit_purchase` resumes companies even when balance still negative** — Purchase of 5 credits with balance at -100 → new balance -95. Code calls `resume_paused_companies()` anyway. Brief resume→re-pause flicker, spurious sync events, potential for a few turns to execute on negative balance. |
| 13 | `cron.ts:82` | **Fire-and-forget `void this.invoke_cron()` can crash supervisor** — `invoke_cron` is async and can throw (e.g., company has no workspace). `void` discards the promise → unhandled rejection → process crash via the exception handler. |
| 14 | `sync.ts:577-578` | **Unknown `table_name` silently dropped** — `push_to_d1` default case returns without logging. Caller deletes the sync item. If a new table_name is enqueued but the switch isn't updated, data is permanently lost with no warning. |
| 15 | `sync.ts:539-542` | **Approvals always POST, no PATCH fallback** — Unlike agents/tasks/milestones which use PATCH-then-POST, approvals always POST. If approval already exists remotely, this fails or creates duplicates. Same issue for `cron_tasks` (lines 544-552). |
| 16 | `api.ts:96+` | **JSON parse errors unhandled on most endpoints** — `c.req.json()` without `.catch()` on user message, approval resolve, credit purchase, telemetry mirror, and workspace import routes. Malformed request body throws unhandled exception. |
| 17 | `blueprints.ts:826-831` | **`applyModelPolicy` silently overrides all agent model tiers** — Forces CEO to `opus`, all others to `sonnet`. Any blueprint using `haiku` for cost savings is silently upgraded with no visibility to users. |
| 18 | `scheduler.ts:654-658` | **CEO sync enqueues stale `status: "working"`** — Sync item with `status: "working"` is enqueued during the turn, but the `finally` block then sets the real status (`idle`/`paused`) and enqueues another sync. D1 briefly sees the agent as working after the turn finishes. |

## LOW (15 findings)

| # | File | Issue |
|---|------|-------|
| 19 | `agent-runner.ts:447` | `.filter(Boolean)` in CEO system prompt removes intentional blank lines used for paragraph spacing |
| 20 | `agent-runner.ts:56-64` | `workspace_path()` function is dead code — duplicated as `workspaceToHostPath` in task-manager.ts |
| 21 | `agent-runner.ts:1094` | `lower.includes("pending")` rejects any founder document containing the word "pending" in body text |
| 22 | `agent-runner.ts:1058` | Unused `created` variable in `get_founder_documents` daily update loop |
| 23 | `stall-detector.ts:153-168` | `long_running` case block missing `return` statement — currently last case but fragile for future additions |
| 24 | `stall-detector.ts:19-83` | Same task can appear in both `no_progress` and `long_running` stalls simultaneously, causing double intervention |
| 25 | `db.ts:11-21` | Missing index on `companies(user_id)` — affects credit lookups and pause/resume queries |
| 26 | `db.ts:26-38` | Missing index on `agents(company_id)` — affects scheduling and bootstrap queries |
| 27 | `db.ts:144-154` | Missing index on `cron_tasks(company_id)` — affects cron scheduling |
| 28 | `sync.ts:468-474` | Founder chat bootstrap limited to 50 entries — older conversation history lost on restart |
| 29 | `sync.ts:560-564` | `telemetry` push case contradicts spec — telemetry_mirror is documented as read-only locally |
| 30 | `task-manager.ts:605-610` | `command_succeeds` criterion has no timeout — `execFileSync` can block supervisor indefinitely |
| 31 | `task-manager.ts:66-78` | `walkFiles` traverses entire workspace including node_modules — extremely slow on Node.js projects |
| 32 | `task-manager.ts:187-207` | `title` and `department` fields computed in `activate_agent` but not included in INSERT statement |
| 33 | `credit-manager.ts:252-284` | Batched credit sync loses per-deduction context — only first deduction's company_id/agent_id/description preserved |

## PRIORITY FIX ORDER

**Immediate — blocks production:**

1. **#1 (Timer leak)** — Every successful agent turn crashes the supervisor after the timeout period. Fix: store the timer ID and clear it when the SDK resolves first, or use `AbortController` to cancel the timeout.
2. **#2 (invoke() exception)** — Wrap `this.invoker.invoke()` in try/catch. On error: delete abort controller, reset agent to `idle`, log error to `turn_log`, call `on_agent_turn_finished` with synthetic error result.
3. **#3 (Signal JSON crash)** — Replace `parse_json` with `parse_json_with_error` (already exists) in `check_agent_signals`. Return `null` on parse failure instead of crashing.
4. **#4 (Prune mismatch)** — Change `prune_dead_sync_items` to use `? <= ?` with `isoNow()` as parameter instead of `datetime('now', '-24 hours')`, or normalize timestamp format.
5. **#5 (Working agents)** — Verify `reset_working_agents` runs after bootstrap completes for all companies. If ordering is uncertain, add explicit reset inside `bootstrapFromRemote()`.

**Before real traffic:**

6. **#8 (CEO messages)** — Add `enqueue_sync("messages", id, "upsert", message)` to `insert_ceo_message`.
7. **#11 (Terminated agents)** — Add `AND status != 'terminated'` to `find_agent_by_blueprint` query.
8. **#13 (Cron fire-and-forget)** — Replace `void this.invoke_cron()` with `this.invoke_cron().catch(err => console.error(...))`.
9. **#16 (API parse errors)** — Add `.catch()` or try/catch to JSON parsing on all API endpoints.

## VERDICT

The core loop (plan → assign → execute → validate → advance) works correctly. Credit management, error recovery with circuit breaker, stall detection, D1 sync, and bootstrap recovery are all solid. The most dangerous finding is **#1 (timeout timer leak)** — a new issue that would crash the supervisor after every successful agent turn. The remaining criticals (#2-#5) are known patterns. With the 5 critical fixes applied, the supervisor is production-ready for early-stage usage.
