---
name: supervisor-worker
description: Worker for supervisor-only changes including scheduler, planning flow, and resilience fixes.
---

# Supervisor Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill
- Supervisor scheduler changes (planning flow, scheduling logic, company lifecycle)
- Supervisor resilience improvements (error handling, state management, persistence)
- Supervisor unit tests
- Any task scoped to `supervisor/src/` and `tests/unit/`

## Required Skills
None.

## Work Procedure

1. **Understand the feature** — Read the feature description. Identify exactly which files and functions will change.

2. **Read the affected code** — Before writing any code, read the current state of every function you'll modify. Understand the surrounding context, callers, and data flow.

3. **TDD — Write tests first**
   - Create or update test files in `tests/unit/` using Vitest
   - Tests should assert the expected behavior after the fix
   - Run `cd /Users/CEF/Projects/automaton && npx vitest run` to confirm new tests fail (red phase)
   - For scheduler tests, mock the database (this.db) and external calls

4. **Implement the change**
   - Make minimal, targeted changes to fix the specific issue
   - Do NOT refactor unrelated code
   - Follow existing patterns (SQLite queries, sync enqueue, logging format)
   - For logging: use `console.log(\`[scheduler] ...\`)` format
   - For SQLite changes: add columns via ALTER TABLE in the migration/init path, not a separate migration file

5. **Run tests (green phase)**
   ```bash
   cd /Users/CEF/Projects/automaton && npx vitest run
   ```
   All tests must pass. Fix any failures.

6. **TypeScript check**
   ```bash
   cd /Users/CEF/Projects/automaton/supervisor && npx tsc --noEmit
   ```
   Zero errors.

7. **Prepare handoff** — Collect files changed, test results, typecheck results.

## Example Handoff

```json
{
  "salientSummary": "Increased Turn 2 maxInferenceRoundsPerTurn from 12 to 25 in start_planning(), added 8 structured log lines across planning flow (Turn 1/2 completion, process_initial_plan steps, retry/escalation), and added a unit test for fallback plan validation. All 1055 tests pass, typecheck clean.",
  "whatWasImplemented": "In scheduler.ts start_planning(): changed Turn 2 turn_limits_override.maxInferenceRoundsPerTurn from 12 to 25. Added console.log lines at: start_planning entry, Turn 1 complete (timing + chars), Turn 2 complete (timing + chars + subtype), process_initial_plan entry, JSON parse result, workspace file check, validation result, fallback activation, finalize complete, retry_planning entry with attempt count, escalate_planning_failure entry. In tests/unit/: added supervisor-fallback-plan-validation.test.ts with 1 test that runs buildFallbackInitialPlan through validate_plan.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "cd /Users/CEF/Projects/automaton && npx vitest run", "exitCode": 0, "observation": "1055 tests passed across 50 files"},
      {"command": "cd /Users/CEF/Projects/automaton/supervisor && npx tsc --noEmit", "exitCode": 0, "observation": "TypeScript compilation succeeded"}
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {"file": "tests/unit/supervisor-fallback-plan-validation.test.ts", "cases": [{"name": "fallback plan passes validate_plan", "verifies": "buildFallbackInitialPlan output is valid"}]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- All tests pass and typecheck succeeds — return complete
- Tests or typecheck fail after 2 fix attempts — return blocked with error details
- The fix requires changes outside `supervisor/src/` or `tests/unit/` — return blocked
