# Simplification & Bug Fix Plan

## Phase 1: Critical Bugs (Safety-First)

These are bugs that cause incorrect behavior in production right now.

### 1.1 CEO session shared across all companies
**Severity:** Critical
**File:** `supervisor/src/agent-invoker.ts` (lines 85, 176, 249, 724-740)
**Bug:** The invoker's `sessions` Map is keyed by `agent.id`. But CEO agents across different companies can share session state (turnCount, creditsSpent, startedAt) because the session lookup uses `options?.sessionKey ?? agent.id`. For user-facing CEO turns, `scheduler.ts` line 949 uses `${ceo.id}:founder-chat` as the session key, but for non-user-facing turns it uses `ceo.id`. If two companies have CEOs with different IDs (they do), this is fine per-company — but the `sessions` Map grows unbounded and is never pruned.
**Fix:**
- Add `pruneStaleSessions()` that removes entries older than `maxSessionDurationMs` — call it at the start of each `invoke()`.
- Add `clearCompanySessions(companyId)` for use during company teardown.

### 1.2 Signal file TOCTOU race
**Severity:** High
**File:** `supervisor/src/agent-runner.ts` (lines 835-849)
**Bug:** `existsSync(done_path)` then `readFileSync(done_path)` — file can be deleted between the two calls, crashing the turn with ENOENT.
**Fix:** Replace with single `try { readFileSync() } catch { /* no signal */ }` — remove the `existsSync` guard.

### 1.3 CEO chat "Thinking" spinner hangs forever
**Severity:** High
**File:** `dashboard/src/components/company/ceo-chat-panel.tsx` (lines 265-269, 409-418)
**Bug:** If `status === "pending"` and `ceoReply` is empty, the chat shows "Thinking..." with no timeout. If the supervisor times out silently or the SSE connection drops, the user sees an infinite spinner.
**Fix:** In `flattenHistory()`, add a timestamp check: if a "thinking" entry is older than 60 seconds, change its status to `"error"` with text "Response timed out — try sending your message again."

### 1.4 Sync queue not idempotent on crash recovery
**Severity:** High
**File:** `supervisor/src/sync.ts` (lines 474-475)
**Bug:** After `push_to_d1(item)` succeeds, `delete_sync_item(item.id)` runs separately. If supervisor crashes between these, the item replays on restart. For state upserts this is safe (idempotent), but credit deductions could double-charge.
**Fix:** Add a `last_pushed_at` column to `sync_queue`. Set it before push. On restart, skip items with `last_pushed_at` within last 60 seconds for credit_deduction type. For upserts, replaying is harmless.

### 1.5 Credit grant/deduct race condition
**Severity:** High
**File:** `worker/src/utils/credits.ts` (lines 19-102)
**Bug:** `grantCredits()` and `deductCredits()` both read-then-write the balance. Concurrent calls (Stripe webhook granting + supervisor deducting) can overwrite each other.
**Fix:** Replace read+compute+write pattern with atomic SQL:
```sql
UPDATE credit_balances SET balance = balance + ? WHERE user_id = ?
UPDATE credit_balances SET balance = MAX(0, balance - ?) WHERE user_id = ?
```

---

## Phase 2: Simplify the Chat Pipeline

The CEO chat has two independent grounding/fallback systems that can disagree. Remove the worker-side one.

### 2.1 Remove worker-side reply validation and grounding
**Files:**
- `worker/src/routes/webhooks.ts` (lines 717-883)
**What to remove:**
- `validateFounderReplyAgainstState()` (line 717) — regex-based reply validation
- `buildGroundedFounderReply()` (line 805) — worker-side fallback generator
- `finalizeFounderReply()` (line 869) — orchestrator that chooses between original and fallback
- All `listTaskSnippets()`, `countFounderTasks()` helper functions

**What to keep:**
- Supervisor-side `prepare_founder_reply()` + `build_grounded_founder_fallback()` — this is the single source of truth for reply quality

**Change in `handleChatWithCeoStream()` and `handleChatWithCeo()`:**
- Replace `finalizeFounderReply(body.message, reply, founderState)` with just `{ reply, grounded: false }`.
- The supervisor already guarantees a non-empty, grounded reply.

**Result:** ~170 lines of duplicate grounding logic removed. One system instead of two.

### 2.2 Remove resolveFounderChatSnapshot from chat endpoints
**File:** `worker/src/routes/webhooks.ts` (lines 885-930)
**Currently:** Both chat endpoints call `resolveFounderChatSnapshot()` which makes 5+ D1 queries to build a snapshot, then passes it to the supervisor. The supervisor ALSO builds its own context via `gather_ceo_context()`.
**Fix:** The supervisor already has full state. Stop sending `founder_state` from the worker. Remove `resolveFounderChatSnapshot()` from chat handlers. Pass `founder_state: null` to supervisor.
**Caveat:** Keep it for the fallback path only (when supervisor returns empty), but since Phase 1 fixes ensure the supervisor never returns empty, this becomes dead code.

---

## Phase 3: Kill Signal File Pattern

Signal files are unreliable. Agents forget to write them, causing 12+ retries and task blocking. Make acceptance criteria the primary completion mechanism.

### 3.1 Make acceptance criteria the primary task completion check
**File:** `supervisor/src/agent-runner.ts`
**Current flow:** After each agent turn → check for `task_done.json` → if not found, increment no-signal counter → after 12 turns, block task.
**New flow:** After each agent turn:
1. Check acceptance criteria first (file_exists, file_not_empty, etc.)
2. If ALL criteria pass → mark task done (no signal file needed)
3. If signal file exists → also accept (backward compat, but criteria still validated)
4. If neither → standard retry logic (but reduce from 12 to 6 turns since criteria check is reliable)

**Changes:**
- Move the acceptance criteria check from the "auto-completion fallback" position to the primary check position (before signal file check)
- Remove the requirement for agents to write signal files from all blueprint system prompts
- Keep signal file reading as a secondary input (agent can declare done + provide artifact/summary via signal)

### 3.2 Simplify agent system prompts
**File:** `supervisor/src/blueprints.ts`
**Change:** Remove instructions about writing `task_done.json` and `task_blocked.json` from all agent system prompts. Instead, tell agents: "When you've completed the work described in the acceptance criteria, you're done. The system will automatically detect completion."
**Keep:** `task_blocked.json` — agents should still be able to signal that they're stuck (with a reason). This is harder to detect automatically.

### 3.3 Add `command_succeeds` criterion type
**File:** `supervisor/src/agent-runner.ts`
**Currently:** `check_criterion()` supports `file_exists`, `file_not_empty`, `file_contains`, `directory_exists`.
**Add:** `command_succeeds` — run a shell command in the workspace; if exit code 0, criterion passes. This enables richer acceptance criteria like "npm test passes" or "curl localhost:3000 returns 200".

---

## Phase 4: Dead Code Removal

### 4.1 Dashboard — delete unused UI animation components
**Directory:** `dashboard/src/components/ui/`
**Delete these files (987 lines total):**
- `globe.tsx`
- `marquee.tsx`
- `sparkles-text.tsx`
- `animated-beam.tsx`
- `border-beam.tsx`
- `magic-card.tsx`
- `animated-grid-pattern.tsx`
- `number-ticker.tsx`
- `shimmer-button.tsx`

### 4.2 Dashboard — delete orphaned pages
**Directory:** `dashboard/src/app/(app)/company/[id]/`
**Delete these page directories:**
- `agents/` — agent list shown inline in home tab
- `org-chart/` — never linked
- `issues/` — replaced by tasks in home tab
- `goals/` — never linked
- `projects/` — never linked
- `approvals/` — approvals shown inline in home tab
- `costs/` — costs shown inline in home tab

### 4.3 Dashboard — remove dead API functions and types
**File:** `dashboard/src/lib/api.ts`
**Remove:** `listIssues`, `getIssue`, `listIssueComments`, `createIssueComment`, `listGoals`, `updateGoal`, `listProjects`, `updateProject`, `listApprovals`, `getApproval`, `approveApproval`, `rejectApproval`, `createApprovalComment`, `listBlueprints`
**File:** `dashboard/src/lib/types.ts`
**Remove:** `IssueStatus`, `IssuePriority`, `Issue`, `IssueComment`, `Goal`, `Project`, `ApprovalType`, `ApprovalStatus`, `Approval`, `ApprovalComment` (if no remaining imports after API cleanup)

### 4.4 Dashboard — remove unused hooks
**Check and remove if unused:** `use-issues.ts`, `use-goals.ts`, `use-projects.ts` in `dashboard/src/hooks/`

### 4.5 Worker — delete dead integrations and tables
**Delete file:** `worker/src/integrations/browserbase-fn.ts` — never imported
**Mark for future removal (requires migration):**
- `agent_task_sessions` table — never written to
- `policies` and `policy_counters` tables — never enforced
- Related routes in `worker/src/index.ts`

### 4.6 Worker — remove dead routes
**File:** `worker/src/index.ts`
**Remove route handlers for:**
- `/api/companies/:id/goals` (GET, POST)
- `/api/goals/:id` (GET, PATCH)
- `/api/companies/:id/projects` (GET, POST)
- `/api/projects/:id` (GET, PATCH)
- `/api/companies/:id/issues` (GET, POST) — keep only if supervisor still syncs
- `/api/issues/:id` (GET, PATCH)
- `/api/issues/:id/comments` (GET, POST)
- `/api/issues/:id/checkout`, `/api/issues/:id/release`

**Also remove:** corresponding handler files in `worker/src/routes/` (goals.ts, projects.ts, issues.ts)

---

## Phase 5: Unify Data Model

### 5.1 Remove the issues table, keep only tasks
**Current state:** Worker has both `issues` and `tasks` tables. Supervisor has its own `tasks` table. `syncTasksFromIssues()` copies issues into tasks on every founder-state poll.
**Fix:**
- Remove `issues`, `issue_comments` tables (D1 migration)
- Remove `syncTasksFromIssues()` from `worker/src/routes/realtime.ts`
- Supervisor's tasks table is authoritative; synced to D1 via sync queue
- Dashboard reads only from D1 `tasks` table (already does via founder-state)
- Remove all issue-related worker routes, API functions, types, and components

### 5.2 Remove goals and projects tables
**Current state:** These are scaffolding — no agent ever creates goals or projects. The supervisor doesn't know about them.
**Fix:**
- D1 migration to drop `goals`, `projects` tables
- Remove worker routes and handler files
- Remove dashboard pages, API functions, types, hooks

### 5.3 Remove policies system
**Current state:** `policies` and `policy_counters` tables exist with default rows but no enforcement code.
**Fix:** D1 migration to drop both tables. Remove any references.

### 5.4 Clean up agent_messages
**Current state:** `agent_messages` table exists but inter-agent messaging goes through Agent Relay, not D1. The table is only used for founder chat history (mirrored as `messages` in supervisor SQLite).
**Fix:** Rename to `ceo_messages` or merge into `founder_conversations` to avoid confusion. Or just leave it if the rename is more work than it's worth.

---

## Phase 6: Reliability & Performance

### 6.1 Supervisor session persistence
**File:** `supervisor/src/agent-invoker.ts`
**Bug:** Sessions are in-memory only. Supervisor restart loses all session state.
**Fix:** Store `sessions` Map in supervisor SQLite. On restart, reload. On each session update, write through.
**Schema:**
```sql
CREATE TABLE agent_sessions (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT,
  turn_count INTEGER DEFAULT 0,
  credits_spent REAL DEFAULT 0,
  started_at INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 6.2 Reduce founder-state polling overhead
**File:** `worker/src/routes/founder-state.ts`
**Current:** 8-15 D1 queries per poll, every 5-15 seconds.
**Fix:**
- Cache the full founder-state response in KV with 3-second TTL
- On cache hit, return immediately
- On cache miss, build fresh and write to KV
- Lazy personalization should be `waitUntil()` (background), not blocking

### 6.3 Reduce CEO chat polling
**File:** `dashboard/src/components/company/ceo-chat-panel.tsx` (line 69)
**Current:** SWR refreshes chat history every 2.5 seconds.
**Fix:** Increase to 10 seconds. The SSE stream already handles real-time updates. The 2.5s poll is redundant when SSE is connected.

### 6.4 Add thinking timeout to chat UI
**File:** `dashboard/src/components/company/ceo-chat-panel.tsx`
**Fix:** In `flattenHistory()`, if a "thinking" or "streaming" entry has `time` older than 90 seconds, flip it to error with message "This response timed out. Try sending your message again."

---

## Phase 7: Reduce Worker Router Complexity

### 7.1 Migrate from regex routing to Hono
**File:** `worker/src/index.ts` (900+ lines, 84 regex routes)
**Current:** Every route is a regex match block with manual method checks.
**Fix:** Migrate to Hono (already used by supervisor). This gives:
- Type-safe route params
- Method-based handlers (`app.get()`, `app.post()`)
- Middleware chains (auth, CORS, error handling)
- ~60% reduction in routing code

**Approach:** Incremental — migrate one route group at a time (billing first, then companies, then supervisor, etc.)

---

## Implementation Order

| Phase | Effort | Risk | Dependencies |
|-------|--------|------|-------------|
| 1. Critical Bugs | 1-2 days | Low (fixes only) | None |
| 4. Dead Code Removal | 1 day | Low (deletions only) | None |
| 2. Simplify Chat Pipeline | 0.5 days | Medium (behavior change) | Phase 1 |
| 3. Kill Signal File Pattern | 1-2 days | Medium (agent behavior change) | None |
| 5. Unify Data Model | 1-2 days | Medium (migrations) | Phase 4 |
| 6. Reliability & Performance | 1-2 days | Low | Phases 1-2 |
| 7. Worker Router Migration | 2-3 days | Medium (large refactor) | Phase 5 |

**Phases 1 and 4 can run in parallel** since they touch different files. Phase 2 depends on Phase 1 (chat fixes must land first). Phases 3 and 5 are independent. Phase 7 is optional and can be done incrementally over time.
