---
name: launch-backend-worker
description: Backend worker for fixing bugs in the worker package's launch session routes and provisioning logic.
---

# Launch Backend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill
- Bug fixes in `worker/src/routes/launch-sessions.ts`
- Bug fixes in `worker/src/provisioning/launch-session.ts`
- Changes to SSE event emission, turn lifecycle, or launch status logic
- Changes to `toResponse()`, `completePendingAssistantTurn`, `repairAbandonedProcessingTurns`
- Any task scoped to the `worker/` package related to launch flow

## Required Skills
None.

## Work Procedure

1. **Read the feature description carefully.** Identify the specific bug, the root cause, and the expected fix approach. Read the relevant source files to understand current behavior.

2. **Read `.factory/library/architecture.md`** for launch flow architecture context.

3. **TDD — Write failing tests first.**
   - Create or update test files in `tests/unit/` following existing patterns.
   - Tests must cover: the bug's reproduction case, the fixed behavior, and edge cases mentioned in the feature description.
   - Run `cd /Users/CEF/Projects/automaton && npx vitest run` to confirm new tests fail (red phase).

4. **Implement the fix.**
   - Make minimal, targeted changes to fix the bug.
   - Follow existing code patterns (D1 batch operations, SSE event format, error handling).
   - Do NOT change function signatures unless required — these may be called from many places.
   - When modifying `toResponse()`, ensure both REST and SSE code paths still work.
   - When modifying turn lifecycle code, trace all callers to verify no regressions.

5. **Run tests (green phase).**
   ```bash
   cd /Users/CEF/Projects/automaton && npx vitest run
   ```
   ALL tests must pass. Fix any failures.

6. **Typecheck the worker package.**
   ```bash
   cd /Users/CEF/Projects/automaton/worker && npx tsc --noEmit
   ```

7. **Verify edge cases.** For each edge case in the feature's `expectedBehavior`, confirm there's a test covering it. If not, add one.

8. **Prepare handoff.**

## Example Handoff

```json
{
  "salientSummary": "Fixed PROCESSING_STALE_MS (35s→100s) to exceed MODEL_TIMEOUT_MS (90s), and added optimistic concurrency check to completePendingAssistantTurn using D1 conditional UPDATE. Wrote 6 tests covering: stale timeout > model timeout, concurrent completion rejection, single-worker completion success, partial failure rollback. All 1667 tests pass, worker typecheck clean.",
  "whatWasImplemented": "Increased PROCESSING_STALE_MS from 35000 to 100000 in launch-sessions.ts. Added version/claim_id column check to completePendingAssistantTurn's D1 UPDATE statement (WHERE status = 'processing' AND claim_id = ?). Second worker attempting completion now gets zero rows affected and logs a warning instead of overwriting.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "cd /Users/CEF/Projects/automaton && npx vitest run", "exitCode": 0, "observation": "1667 tests passed across 102 files" },
      { "command": "cd /Users/CEF/Projects/automaton/worker && npx tsc --noEmit", "exitCode": 0, "observation": "Zero type errors" }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/unit/launch-turn-race-fix.test.ts",
        "cases": [
          { "name": "PROCESSING_STALE_MS exceeds MODEL_TIMEOUT_MS", "verifies": "Config constant relationship" },
          { "name": "concurrent completePendingAssistantTurn: first succeeds, second rejected", "verifies": "Optimistic concurrency" },
          { "name": "single worker completes turn successfully", "verifies": "Happy path still works" }
        ]
      }
    ],
    "coverage": "6 new tests added. Baseline: 1661 → 1667 passing."
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- The bug requires changes to the dashboard (frontend) package — return and recommend `launch-frontend-worker`
- The fix requires a D1 migration (schema change) — return since schema changes are off-limits
- Tests reveal a deeper issue that requires architectural changes beyond the bug fix scope
- Requirements are ambiguous — the expected behavior is unclear from the feature description
