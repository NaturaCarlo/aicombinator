# Credit System Fix Plan

_Last updated: 2026-03-17_

## Bug Status

### Bug 1: Per-agent cost attribution lost on bootstrap (96 vs 73 problem)
**Status: PARTIALLY FIXED**
- 1a: `cost_events` no longer requires `mirroredAgentId` — uses fallback `body.agentId`. **FIXED.**
- 1b: Bootstrap still deletes all non-credit-deduction sync items (`sync.ts:99`). If agent creation syncs are pending when supervisor restarts, those agent records never reach D1. Credit deductions that reference those agents will have `mirroredAgentId = null` on the worker side — but now the fallback `body.agentId` is used, so cost_events still get recorded with the correct agent_id. **Effectively mitigated.**

### Bug 2: Deduction skipped when company not running
**Status: FIXED**
Worker now always calls `deductCredits()` regardless of company state. The company state check only pauses the agent — it does NOT early-return before deduction. (`supervisor.ts:2560-2579`)

### Bug 3: Failed D1 deductions silently pruned
**Status: FIXED**
`prune_dead_sync_items()` now excludes `credit_deduction` items (`WHERE table_name != 'credit_deduction'`). Failed deductions survive indefinitely. (`db.ts:641-650`)

Additionally, `deductCredits()` no longer throws on insufficient balance — it clamps to available balance and records the clamped amount with metadata. (`credits.ts:67-68`)

### Bug 4: Flat pricing across all models
**Status: FIXED**
Pricing table now has differentiated per-model rates:
- Opus: 0.7/3.5 per 1K tokens
- Sonnet: 0.42/2.1
- Haiku: 0.14/0.7
- GPT-4o Mini: 0.02/0.08

### Bug 5: UI inconsistencies in credit display
**Status: FIXED**
- `compact-metrics.tsx` uses proper labels (no more "cr")
- `metrics-summary.tsx` uses `formatCredits()` which returns "X credits" format
- Shared `formatCredits()` utility in `lib/credits.ts`

### Bug 6: Dead code — `sync_credits` batch method
**Status: FIXED**
`sync_credits()` has been completely removed from the codebase.

---

## Remaining Issues

### Bug 7 (NEW): In-flight turns drain credits after company pause
**Where**: `supervisor/src/agent-runner.ts`, `supervisor/src/scheduler.ts`, `supervisor/src/cron.ts`
**Root cause**: Pausing a company is an eventual state transition, not an atomic kill switch. Multiple gaps:

**7a — No pre-flight pause check in `wake_agent()`**
`agent-runner.ts` `wake_agent()` does not check if the company is paused before reserving credits and invoking the agent. A turn can start after the company is already paused in the DB.

**7b — Completed turns always charge regardless of pause state**
The `pause_aborted` check only zeroes out credits if the turn BOTH errored AND was aborted:
```typescript
const pause_aborted = Boolean(
  result.error && result.aborted &&
  this.task_manager.get_company(task.company_id)?.state === "paused"
);
const billed_credits = pause_aborted ? 0 : credits;
```
A turn that finishes successfully during/after pause still pays full price. This applies to all three execution paths: agent-runner, scheduler (CEO turns), and cron.

**7c — Cron tasks can fire during pause window**
`cron.ts` `run_tick()` queries `WHERE state = 'running'` but a cron invocation started before the pause completes normally and settles credits.

**7d — Multiple concurrent agents drain past zero**
`settle_reserved_credits()` triggers `pause_all_companies()` when balance hits 0, but other in-flight agents complete their turns and settle credits before seeing the pause. Each deduction happens in its own SQLite transaction, so N agents finishing simultaneously = N deductions, potentially draining well past zero.

**Impact**: Credits drain to 0 even after user explicitly pauses. This is what happened to Eliza's company.

**Fix plan:**

Step 7.1 — Add pause guard to `wake_agent()` and `invoke_cron()`
Before reserving credits, check company state. If paused/terminated, skip invocation:
```typescript
const company = this.task_manager.get_company(task.company_id);
if (!company || company.state !== 'running') return;
```

Step 7.2 — Zero-bill completed turns if company paused during execution
Change the `pause_aborted` logic to also cover non-error completions:
```typescript
const company_paused = this.task_manager.get_company(task.company_id)?.state === "paused";
const billed_credits = company_paused ? 0 : credits;
```
This means: if the company is paused by the time the turn finishes (regardless of how it finished), don't charge. The turn's work still happened but the user explicitly asked to stop spending.

Step 7.3 — Propagate abort signal faster
When `pause_all_companies()` fires (from credit exhaustion or manual pause), immediately abort all in-flight agent invocations via their AbortControllers. The scheduler already tracks these in `active_ceo_abort_controllers` and the agent-runner tracks them too. Ensure abort propagates to the Claude SDK `AbortSignal` to actually stop the API call mid-stream.

Step 7.4 — Cap concurrent in-flight deductions
In `settle_reserved_credits()`, after deducting, check if balance is already 0 from a concurrent settlement. If so, release remaining reserved credits for all other in-flight turns without charging:
```typescript
if (next_balance <= 0) {
  this.pause_all_companies(user_id);
  this.release_all_reserved(user_id);  // Cancel other in-flight reservations
}
```

---

### Bug 1b (LOW): Bootstrap sync deletion could lose non-credit data
**Where**: `supervisor/src/sync.ts:99`
**Status**: Low priority — the cost_events fallback mitigates the credit impact, but other sync types (agent status, task status) could still be lost on restart.
**Impact**: Cosmetic — agent/task states in D1 may be stale after restart until next sync cycle catches up.

---

## Execution Order

```
Bug 7 (pause drain)  →  Bug 1b (bootstrap sync, low priority)
```

Bug 7 is the only remaining critical issue — it causes real credit loss and is what the user just experienced. Everything else has been fixed.

---

## Future: Per-Agent Model Selection

When this feature is added, the only new work is:
1. **UI**: Model picker per agent in company settings (dropdown on each agent row)
2. **API**: `PATCH /api/companies/:id/agents/:agentId` with `{ modelTier }` field
3. **Supervisor sync**: Pick up model changes on next bootstrap or via real-time push
4. **Pricing display**: Show per-agent estimated daily cost based on their model tier

The credit calculation pipeline already handles this — `calculate_turn_credits(agent.model_tier, tokenUsage)` reads the agent's model, and the pricing table is already model-aware. No further changes needed in the deduction flow.
