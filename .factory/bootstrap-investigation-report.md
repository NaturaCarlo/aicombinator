# Supervisor Bootstrap Investigation Report

## 1. Exact Bootstrap Sequence (Step by Step)

### Provisioning Flow
1. **API call** → `POST /companies/:id/provision` → `scheduler.provision_company(payload)`
2. **Fetch company data** from D1 via `sync_manager.fetch_company(payload.id)` (or normalize from payload)
3. **Scope check** — if `scopeUserId` is set, verify company belongs to the user
4. **Upsert company** in SQLite with state `"provisioning"`
5. **Create Docker container** via `container_manager.create()` which:
   - Creates workspace directories: `<companyDir>/workspace/.agent/`, `src/`, `docs/`, `assets/`
   - Generates `docker-compose.yml`
   - Builds and starts the container
6. **Upsert company again** with `workspace_dir` and `container_id`
7. **Activate CEO agent** — `task_manager.activate_agent(company_id, "ceo")` creates the CEO agent row from blueprint
8. **Init credits** — `credit_manager.init_company_credits()`
9. **Fire-and-forget** — `void this.start_planning(normalized).catch(...)` — starts planning in background

### Planning Flow (`start_planning`)
Location: `scheduler.ts:242`

1. **Update state** → `"planning"` in SQLite + enqueue D1 sync
2. **Ensure CEO exists** — `activate_agent(company_id, "ceo")` again (idempotent)
3. **Get CEO agent row** — `task_manager.get_ceo(company_id)`

4. **Turn 1: Mission (fast)** — `invoke_ceo_turn()` with:
   - `maxInferenceRoundsPerTurn: 1`
   - `maxToolCallsPerTurn: 0`
   - `turnTimeoutMs: 90_000` (90 seconds)
   - `system_prompt_override`: mission system prompt
   - `skip_response_processing: true`
   - Prompt: mission prompt (see Section 2)

5. **Parse mission** — `parse_mission_output(missionResult.output)` extracts JSON `{ mission: "..." }`
   - Fallback: `derive_fallback_mission(company)` — uses genesis_prompt, goal, or company name
6. **Materialize mission** — writes `docs/mission.md` and other early files to workspace

7. **Turn 2: Full day plan (slow)** — `invoke_ceo_turn()` with:
   - `maxInferenceRoundsPerTurn: 12`
   - `maxToolCallsPerTurn: 40`
   - `turnTimeoutMs: 1000 * 60 * 8` (8 minutes)
   - `system_prompt_override`: initial planning system prompt
   - `skip_response_processing: true`
   - Prompt: planning prompt with mission context (see Section 2)

8. **Process plan** — `process_initial_plan(company_id, result.output)` (see Section 3)

---

## 2. CEO Prompts

### Turn 1: Mission System Prompt
```
You are the CEO of <company.name>.

This is the mission-writing turn. Your only job is to write the company mission.
Founder operating brief: <founderBriefText(company)>
Return one compact JSON object with a single key 'mission', with no prose outside the JSON and no tool use.
The mission should read like a compact markdown manifesto, not a slogan.
It must define what the company does, for whom, why it matters, and how decisions should be made.
Do not include a plan, milestones, tasks, or agent lists.
Do not invent traction, metrics, leads, or revenue.
```

### Turn 1: Mission User Prompt
```
Current date: <date> (<timezone>)

# Company Mission

Founder operating brief:
<founderBriefText(company)>

Return exactly one JSON object and nothing else.
Do not use tools.
Do not write files.

The object must have this shape:
{
  "mission": "140-260 word markdown manifesto"
}

Rules:
- The mission must define what the company does, for whom, why it matters, and how the team should decide what to do next.
- Use markdown with sections: # Mission, ## Founder Direction, ## What We Are Building First, ## Operating Principles.
- Write it as a compact, grounded manifesto — not a slogan or tagline.
- Do not invent traction, leads, meetings, or revenue.
- Do not include a plan, milestones, or tasks — just the mission.
```

### Turn 2: Planning System Prompt
```
You are the CEO of <company.name>.

This is the initial bootstrap turn for a new company.
Founder operating brief: <founderBriefText(company)>
Your job is to make one fast, high-quality planning decision.

Preferred path: do not use tools. Return one JSON object in your final response with top-level keys mission and plan.
The mission should be a compact markdown manifesto, not a tagline.
Fallback path: if direct JSON output fails, write /workspace/docs/mission.md and /workspace/.agent/plan.json.
Also create /workspace/CLAUDE.md with shared project context (conventions, file layout, founder preferences — not tech stack). Under 60 lines.
Do not create any other files besides these.
Do not browse widely or over-research.
Do not write placeholder strategy docs.

You are optimizing for founder momentum:
- all teams working in parallel from the start
- milestones organized by team/workstream, not sequential phases
- clear task ownership with every hired agent kept busy
- concrete deliverables with follow-up implementation, not just specs

You choose which founding agents should work based on the actual plan needs.
Available founding agents: <list of non-CEO blueprints>.

Match team composition to plan needs — include every agent the plan requires, but do not activate agents with no tasks.
Avoid planning tasks whose only output is internal analysis.
Never invent traction, metrics, leads, or revenue.
Every task must name real files and include verifiable acceptance criteria.
If a founder-facing page is part of the first milestone, use /workspace/site/index.html and /workspace/site/ assets only.
Do not create any task that depends on external hosting or a deploy URL file.
```

### Turn 2: Planning User Prompt
```
Current date: <date> (<timezone>)

# Initial Planning

This is a new company. Create a comprehensive day-long execution plan.

Founder operating brief:
<founderBriefText(company)>

# Company Mission (already written)

<mission text from Turn 1>

The mission above is already saved. Do not rewrite it. Use it as context for planning.

Preferred path: return a single JSON object in your final response with this shape:
{
  "mission": "mission text",
  "plan": { "milestones": [...], "agents_needed": [...] }
}
Fallback path: if direct JSON output fails, write /workspace/docs/mission.md and /workspace/.agent/plan.json.

After writing the plan, create /workspace/CLAUDE.md — a shared context file loaded by every agent on every turn.
Include: conventions, file layout decisions, and any founder preferences. Do not include tech stack — the CTO owns that.
Keep it under 60 lines. This is the only file agents share automatically, so make it count.

# Scheduling Rules
- ALL milestones start at the same time and run IN PARALLEL.
[... detailed scheduling and scope rules ...]

# Acceptance Criteria Types
[... file_exists, file_not_empty, etc. ...]

# Planning Rules
1. Each milestone = one team's workstream. All milestones run in parallel.
[... 7 numbered rules ...]
```

---

## 3. process_initial_plan() — Plan Processing Logic

Location: `scheduler.ts:303`

**Priority chain (try each, fall through on failure):**

1. **Parse direct JSON output** — `parse_initial_plan_output(direct_output)` looks for JSON with `{ mission, plan: { milestones, agents_needed } }`
   - If valid JSON + passes `validate_plan()` → `finalize_initial_plan()` → done
   - If valid JSON but fails validation → try **fallback plan** (`build_fallback_initial_plan()`)
   - If fallback validates → use fallback + finalize → done

2. **Check workspace file** — `/workspace/.agent/plan.json`
   - If file doesn't exist → try **fallback plan** → if validates, finalize; else → `escalate_planning_failure()`
   - If file exists but invalid JSON → try **fallback plan** → if validates, finalize; else → `retry_planning()`
   - If file exists, valid JSON, but fails validation → try **fallback plan** → if validates, finalize; else → `retry_planning()`

3. **Success path** — `finalize_initial_plan()`:
   - `materialize_initial_company_files()` — writes mission.md, plan.json, CLAUDE.md to workspace
   - `task_manager.ingest_plan()` — creates milestones, tasks, agents in DB
   - `planning_failures.delete(company_id)`
   - `schedule(company_id)` — transitions company to `"running"` and starts dispatching

---

## 4. Timeout Configurations

| Turn | maxInferenceRounds | maxToolCalls | Timeout |
|------|-------------------|--------------|---------|
| Turn 1 (Mission) | 1 | 0 | 90s |
| Turn 2 (Plan) | 12 | 40 | 8 min |
| Retry planning | 12 | 40 | 8 min |

**Default turn limits** (for non-planning CEO turns):
- `maxCreditsPerTurn: 500,000`
- `maxTokensInput: 200,000`
- `maxTokensOutput: 64,000`
- `maxToolCallsPerTurn: 200`
- `maxInferenceRoundsPerTurn: 50`
- `turnTimeoutMs: 3,600,000` (1 hour)

**Default session limits:**
- `maxTurnsPerSession: 200`
- `maxSessionDurationMs: 8 hours`
- `maxCreditsPerSession: 50,000,000`

---

## 5. Failure Modes & Handling

### 5a. Credit exhaustion during Turn 1 or Turn 2
- `invoke_ceo_turn()` checks credits before running
- If `missionResult.aborted && error === "Credits exhausted"` → **silent return** (company stays in "planning" forever)
- If `result.aborted && error === "Credits exhausted"` on Turn 2 → same **silent return**
- **BUG**: No escalation or state change when credits run out during planning. Company stuck.

### 5b. Turn timeout
- `claude-code.ts` uses `Promise.race([runClaudeCode(...), this.timeout(limits.turnTimeoutMs)])`
- Timeout throws an error → caught in `invoke()` → returns `{ success: false, error: "Agent turn timed out after Xms" }`
- In `invoke_ceo_turn_reserved()` the error result is logged but `start_planning` continues to `process_initial_plan()`
- Turn 2 timeout → `result.output` will be empty/partial → `process_initial_plan` tries fallback plan → likely succeeds

### 5c. Planning validation failure
- `retry_planning()` is called with error messages
- Increments `planning_failures` counter (in-memory Map)
- After 3 failures → `escalate_planning_failure()` → state set to `"failed"` + CEO message

### 5d. Claude Code SDK error
- All errors caught in `claude-code.ts invoke()` → returns `{ success: false, error: message }`
- `invoke_ceo_turn_reserved()` logs the turn and continues
- If Turn 2 errors → `process_initial_plan` gets null/empty output → tries fallback plan

---

## 6. The `resume_company` Bug

**Location**: `scheduler.ts:2122-2163`

```typescript
async resume_company(company_id: string): Promise<void> {
  const milestone_count = ...;
  const task_count = ...;
  const resumed_state = milestone_count === 0 && task_count === 0 ? "planning" : "running";
  // ...
  if (resumed_state === "running") {
    this.activate_pending_milestone_tasks(company_id);
    void this.schedule(company_id).catch(...);
  }
  // ⚠️ NO ELSE BRANCH — when resumed_state === "planning", schedule() is NOT called
}
```

**Bug**: When a company resumes with 0 milestones and 0 tasks, it gets `state = "planning"` but `schedule()` is **never called**. The company will be stuck in "planning" state indefinitely because:

- `schedule()` for a company in "planning" state would check for 0 tasks/milestones and re-trigger `start_planning()`
- Without `schedule()`, nothing re-triggers planning
- The only way to recover: restart the supervisor (startup code calls `schedule()` for all active companies)

**Fix**: Add an else branch:
```typescript
if (resumed_state === "running") {
  this.activate_pending_milestone_tasks(company_id);
  void this.schedule(company_id).catch(...);
} else {
  // Planning state — trigger start_planning via schedule()
  void this.schedule(company_id).catch(...);
}
```

Or simpler: always call `schedule()` regardless.

---

## 7. The `planning_failures` Counter Issue

**Location**: `scheduler.ts:146`
```typescript
private readonly planning_failures = new Map<string, number>();
```

**Issue**: This is an **in-memory Map**, not persisted to SQLite. On supervisor restart:
- The counter resets to 0
- If planning was failing (1 or 2 prior attempts), the counter is lost
- This means up to 5 more retries after restart (3 fresh + 2 that were "lost")
- **Not necessarily a bug** — restarting gives a fresh chance. But it means:
  - A company can fail planning 3 times, supervisor restarts, then fails 3 more times → 6 total attempts before "failed"
  - On resume, the counter is 0 even if previous attempts failed (this is fine since resume is intentional)

**However**, combined with the `resume_company` bug: if you resume a company in planning state:
1. `planning_failures` is 0 (fresh process or simply never incremented for this company)
2. But `schedule()` is never called → planning never retries
3. Deadlock.

---

## 8. Fallback Plan Analysis

**Location**: `scheduler-prompts.ts:107-248` — `buildFallbackInitialPlan()`

The fallback plan is a **hardcoded, deterministic plan** that creates:
- **3 milestones**: "Marketing & Content" (5 tasks for CMO), "Engineering" (3 tasks for frontend-dev + CTO), "Quality Assurance" (2 tasks for QA)
- **agents_needed**: `["cmo", "cto", "frontend-dev", "qa-tester"]`
- All tasks have `acceptance_criteria` with `file_exists` or `file_not_empty`
- Cross-milestone dependencies (QA depends on Engineering)

**Why the fallback should work**: It's a static document that was presumably tested. `validate_plan()` should pass since it has proper structure, valid agent names, and valid acceptance criteria.

**Why it MIGHT fail**:
1. If `validate_plan()` has evolved to require something the fallback doesn't provide
2. If any of the referenced blueprint IDs (`cmo`, `cto`, `frontend-dev`, `qa-tester`) have been removed from `FOUNDING_BLUEPRINTS`
3. If the validation requires the `depends_on` task titles to exactly match and there's a case sensitivity issue

**Recommendation**: Add a unit test that runs `validate_plan()` on the fallback plan output.

---

## 9. The startup schedule() Calls

**Location**: `index.ts:247-250`
```typescript
for (const company of active_companies) {
  scheduler.activate_pending_milestone_tasks(company.id);
  await scheduler.schedule(company.id);
}
```

This iterates over companies with `state IN ('planning', 'running')`. For companies in "planning" state, `schedule()` will:
- Check if 0 tasks + 0 real milestones → re-trigger `start_planning()`

This is the **only recovery mechanism** for stuck planning companies. If a company enters "planning" state via `resume_company` and the supervisor doesn't restart, it stays stuck.

Additionally, stuck "provisioning" companies are recovered at `index.ts:261-273` — the startup code explicitly calls `start_planning()` for them.

---

## 10. Claude Code SDK Configuration

### Model Used for CEO
- Blueprint `modelTier: "sonnet-4-6"` → maps to `"anthropic/claude-sonnet-4.6"` via `MODEL_MAP`
- This is an Anthropic model → routed through **Claude Code SDK** (not OpenRouter)

### LLM Proxy Architecture
- Claude Code SDK is configured with:
  ```
  ANTHROPIC_API_KEY: <internalApiKey>
  ANTHROPIC_AUTH_TOKEN: <internalApiKey>
  ANTHROPIC_BASE_URL: http://localhost:<PORT>/llm-proxy
  ```
- The LLM proxy (`llm-proxy.ts`) fetches provider config from the worker API (`/api/supervisor/llm-config`)
- Provider can be `"anthropic"` (direct to api.anthropic.com) or `"openrouter"` (to openrouter.ai/api)
- **Config is cached** after first fetch (`cachedConfig`)

### Potential Issues
1. **ANTHROPIC_API_KEY not set**: `build_config()` uses `optional_env("ANTHROPIC_API_KEY", "")` — empty string is fine for the LLM proxy flow since the actual key comes from the worker's `/llm-config` endpoint
2. **Worker API unreachable**: If `WORKER_API_URL` fails, `fetchProviderConfig` throws → LLM proxy returns 500 → Claude Code SDK fails → Turn fails
3. **InternalApiKey mismatch**: If the internal API key doesn't match between supervisor and worker, LLM proxy auth fails
4. **Claude Code SDK process errors**: The SDK spawns a child process. The `executable` is set to `process.execPath` (node). Under systemd, PATH may not include Claude Code dependencies.

### Workspace Path
- Host path: `/srv/aicombinator/companies/<company_id>/workspace`
- The adapter rewrites `/workspace` references in prompts to the actual host path via `rewriteWorkspacePaths()`
- Claude Code SDK `cwd` is set to `workspaceDir` (the actual host path)

---

## 11. Deploy & Restart

### Deploy script (`deploy/deploy.sh`)
- **Remote deploy**: Build locally → rsync to VM staging dir → copy to `/srv/aicombinator/supervisor/` → `npm ci --omit=dev` → `sudo systemctl restart aicombinator-supervisor`
- **Local deploy**: `git pull` → `npm ci --omit=dev` → `npm run build` → `docker build` agent container → `systemctl restart`
- Health check: polls `http://localhost:8787/health` up to 20 times (2s intervals = 40s)

### How to Test Bootstrap Locally vs on VM

**Locally**:
1. Set environment variables (WORKER_API_URL, INTERNAL_API_KEY, ANTHROPIC_API_KEY, etc.)
2. Use `SKIP_DOCKER=true` to skip Docker container creation
3. Set `COMPANIES_DIR` to a local temp directory
4. Run `npm run build && node dist/index.js`
5. Call `POST /companies/:id/provision` with appropriate payload

**On VM**:
1. SSH into 203.0.113.10
2. Check supervisor logs: `sudo journalctl -u aicombinator-supervisor -f`
3. Check health: `curl http://localhost:8787/health`
4. Check company state: `curl -H "x-internal-api-key: <key>" http://localhost:8787/companies`
5. To force re-plan: `POST /companies/:id/resume`

---

## 12. Summary of All Issues Found

### Critical Bugs

| # | Issue | Severity | Description |
|---|-------|----------|-------------|
| 1 | **resume_company doesn't call schedule() for planning state** | HIGH | Companies resumed into "planning" state are stuck forever until supervisor restart |
| 2 | **Silent credit exhaustion during planning** | HIGH | If credits run out during Turn 1 or Turn 2, `start_planning()` silently returns. Company stays in "planning" with no escalation or state change |

### Design Concerns

| # | Issue | Severity | Description |
|---|-------|----------|-------------|
| 3 | **planning_failures is in-memory** | MEDIUM | Counter resets on restart, allowing extra retries. Combined with bug #1, resume never increments the counter anyway |
| 4 | **Turn 2 timeout behavior** | LOW | 8-minute timeout → SDK might produce partial output. Fallback plan should catch this, but if fallback validation also fails, it enters retry loop |
| 5 | **LLM proxy config caching** | LOW | `cachedConfig` is never invalidated. If the API key rotates, supervisor needs restart |

### Recommendations

1. **Fix resume_company** — Always call `schedule(company_id)` regardless of `resumed_state`, or add explicit `start_planning()` call for "planning" state
2. **Handle credit exhaustion in planning** — When credits are exhausted during planning, either transition to `"paused"` or `"failed"` state instead of silent return
3. **Persist planning_failures** — Store retry count in SQLite (`companies` table or separate table) so it survives restarts
4. **Add logging for planning completion** — Log when Turn 1 and Turn 2 complete with timing, output length, and success/failure
5. **Test fallback plan** — Add a unit test that ensures `buildFallbackInitialPlan()` always passes `validate_plan()`
6. **Add /companies/:id/replan endpoint** — Allow forcing re-planning without going through resume
