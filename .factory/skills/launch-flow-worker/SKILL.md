---
name: launch-flow-worker
description: Worker for launch conversation flow changes spanning dashboard and worker packages (streaming, option buttons, auto-launch, design).
---

# Launch Flow Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill
- Launch conversation streaming (SSE implementation in worker + dashboard consumption)
- Launch option button behavior (click handling, disabled state, auto-launch)
- Launch UI design improvements (button sizing, typography, progress indicators)
- Any task that touches both `dashboard/src/components/launch*` and `worker/src/routes/launch-sessions.ts`

## Required Skills
None.

## Work Procedure

1. **Understand the feature** — Read the feature description. Map changes to their packages (dashboard, worker, or both).

2. **Read affected code** — Before writing anything, read the current state of every file you'll modify. The launch flow is spread across:
   - Dashboard: `src/components/launch-form.tsx`, `src/components/launch/launch-session-view.tsx`, `src/components/launch/launch-idea-step.tsx`, `src/components/launch/launch-progress.tsx`, `src/lib/api.ts`
   - Worker: `src/routes/launch-sessions.ts`

3. **TDD — Write tests first**
   - For worker API changes: Write tests in `tests/unit/` using Vitest
   - For dashboard component changes: Write tests alongside components
   - Run `cd /Users/CEF/Projects/automaton && npx vitest run` to confirm new tests fail (red phase)

4. **Implement the change**
   - For SSE: Implement the server-side SSE endpoint in the worker first, then update the dashboard to consume it
   - For UI changes: Follow the existing design system (sharp corners, accent-orange #FF6600, dark theme)
   - For option button behavior: Update click handlers in launch-form.tsx and launch-session-view.tsx
   - Never add rounded corners (`rounded-*` classes). Always use `rounded-none`.

5. **Run tests (green phase)**
   ```bash
   cd /Users/CEF/Projects/automaton && npx vitest run
   ```

6. **TypeScript and lint**
   ```bash
   cd /Users/CEF/Projects/automaton/dashboard && npm run lint
   cd /Users/CEF/Projects/automaton/dashboard && npm run build
   ```

7. **Prepare handoff** — Collect files changed, test results, build results.

## Example Handoff

```json
{
  "salientSummary": "Added SSE streaming endpoint for launch sessions in worker, updated dashboard launch-session-view to consume SSE stream and render tokens incrementally. Option buttons now enabled immediately when stream completes. Added 8 tests, all 1064 pass.",
  "whatWasImplemented": "Worker: Added GET /api/launch-sessions/:id/stream SSE endpoint that streams assistant turn output as text/event-stream. Dashboard: Replaced polling useEffect with EventSource connection in launch-form.tsx, added streaming state management, updated launch-session-view.tsx to render partial content during stream. Option buttons enabled on stream 'done' event instead of waiting for poll cycle.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "cd /Users/CEF/Projects/automaton && npx vitest run", "exitCode": 0, "observation": "1064 tests pass across 53 files" },
      { "command": "cd /Users/CEF/Projects/automaton/dashboard && npm run build", "exitCode": 0, "observation": "Build succeeds" },
      { "command": "cd /Users/CEF/Projects/automaton/dashboard && npm run lint", "exitCode": 0, "observation": "34 warnings, 0 errors" }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      { "file": "tests/unit/launch-session-streaming.test.ts", "cases": [{ "name": "SSE endpoint streams turn output", "verifies": "Streaming response format" }] }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator
- Worker API route changes require D1 migration — return with migration details
- SSE requires Cloudflare Workers compatibility verification — return if compatibility issues found
- If the launch flow interacts with supervisor (e.g., provisioning), scope only to dashboard+worker changes
