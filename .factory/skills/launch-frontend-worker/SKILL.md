---
name: launch-frontend-worker
description: Frontend worker for fixing bugs in the dashboard package's launch flow components and state management.
---

# Launch Frontend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill
- Bug fixes in `dashboard/src/components/launch-form.tsx`
- Bug fixes in `dashboard/src/components/launch/launch-session-view.tsx`
- Bug fixes in `dashboard/src/components/launch/launch-runtime.ts`
- Bug fixes in `dashboard/src/lib/api.ts` (SSE/streaming related)
- Changes to streaming state management, stall recovery, auto-scroll, rendering performance
- Any task scoped to the `dashboard/` package related to launch flow

## Required Skills
None.

## Work Procedure

1. **Read the feature description carefully.** Identify the specific bug, the root cause, and the expected fix approach. Read the relevant source files.

2. **Read `.factory/library/architecture.md`** for launch flow architecture context.

3. **TDD — Write failing tests first.**
   - Create or update test files in `tests/unit/` following existing patterns.
   - Tests must cover: the bug's reproduction case, the fixed behavior, and edge cases.
   - Use existing test patterns from `tests/unit/launch-*.test.ts` for reference.
   - Run `cd /Users/CEF/Projects/automaton && npx vitest run` to confirm new tests fail (red phase).

4. **Implement the fix.**
   - Make minimal, targeted changes.
   - For React state fixes: ensure cleanup functions properly reset all state.
   - For performance fixes: use React.memo, throttle/debounce, or batching as appropriate.
   - For AbortController fixes: ensure abort is called in ALL cleanup paths (unmount, restart, back navigation).
   - For SWR fixes: verify the config change doesn't break other SWR hooks.

5. **Run tests (green phase).**
   ```bash
   cd /Users/CEF/Projects/automaton && npx vitest run
   ```
   ALL tests must pass.

6. **Lint and build the dashboard.**
   ```bash
   cd /Users/CEF/Projects/automaton/dashboard && npm run lint
   cd /Users/CEF/Projects/automaton/dashboard && npm run build
   ```
   Both must succeed with zero errors.

7. **Verify edge cases.** For each edge case in `expectedBehavior`, confirm test coverage.

8. **Prepare handoff.**

## Example Handoff

```json
{
  "salientSummary": "Fixed stale streaming content leaking across session restarts by adding setStreamingContent(null) in handleRestartLaunchSession and the streaming effect cleanup function. Added 4 tests covering: restart clears content, cleanup clears content, restart during active stream, new session starts clean. All 1665 tests pass, lint clean, build succeeds.",
  "whatWasImplemented": "In launch-form.tsx: added setStreamingContent(null) to handleRestartLaunchSession (line 248) before calling startLaunchSession. Added setStreamingContent(null) to the streaming effect's return cleanup function (line 235). Both changes ensure no stale tokens leak into a new session.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "cd /Users/CEF/Projects/automaton && npx vitest run", "exitCode": 0, "observation": "1665 tests passed" },
      { "command": "cd /Users/CEF/Projects/automaton/dashboard && npm run lint", "exitCode": 0, "observation": "0 errors, 34 warnings (pre-existing)" },
      { "command": "cd /Users/CEF/Projects/automaton/dashboard && npm run build", "exitCode": 0, "observation": "Build succeeded" }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/unit/launch-streaming-cleanup.test.ts",
        "cases": [
          { "name": "restart clears streamingContent before starting new session", "verifies": "No stale content leak" },
          { "name": "effect cleanup clears streamingContent on unmount", "verifies": "No stale content on remount" },
          { "name": "restart during active SSE stream aborts and clears", "verifies": "Mid-stream restart safety" },
          { "name": "new session after restart has empty streamingContent", "verifies": "Clean slate" }
        ]
      }
    ],
    "coverage": "4 new tests. Baseline: 1661 → 1665."
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- The bug requires changes to the worker (backend) package — return and recommend `launch-backend-worker`
- Tests reveal that the fix needs a corresponding backend change (e.g., toResponse changes)
- Requirements are ambiguous — the expected behavior is unclear
- Build fails due to type errors that trace back to shared types
