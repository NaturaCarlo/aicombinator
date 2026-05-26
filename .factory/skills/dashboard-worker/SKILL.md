---
name: dashboard-worker
description: Frontend-only worker for CSS, theme, component, and UI bug fix tasks in the dashboard package.
---

# Dashboard Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill
- CSS and theme changes (globals.css, component styles, color tokens)
- Component modifications and new UI components
- UI bug fixes (layout, styling, responsiveness)
- Sidebar fixes, navigation styling
- Design system work (typography, spacing, color palette)
- Any task scoped entirely to the `dashboard/` package

## Required Skills
None.

## Work Procedure

1. **Understand the feature description** — Read the handoff carefully. Identify every file likely to change.

2. **TDD — Write component tests first**
   - Create or update test files in `dashboard/` using Vitest.
   - Tests should assert the expected behavior or visual output of the component/style change.
   - Run `npx vitest run` from the dashboard directory to confirm the new tests fail (red phase).

3. **Implement the change**
   - For theme work: Update `globals.css`, component-level styles, and remove any old/hardcoded color references.
   - For component work: Edit or create components, ensuring consistent use of design tokens.
   - For bug fixes: Reproduce via test first, then fix.

4. **Run tests (green phase)**
   ```bash
   cd /Users/CEF/Projects/automaton/dashboard && npx vitest run
   ```
   All tests must pass. Fix any failures before proceeding.

5. **Build verification**
   ```bash
   npm run build --prefix /Users/CEF/Projects/automaton/dashboard
   ```
   The build must succeed with zero errors. Warnings should be noted but are acceptable.

6. **Describe visual changes** — If the change affects what the user sees, write a brief plain-English description of the visual difference (before → after).

7. **Prepare handoff** — Collect:
   - List of files changed
   - Test results (pass/fail counts)
   - Build output (success or relevant error lines)
   - Description of any visual changes

## Example Handoff

```json
{
  "worker_type": "dashboard-worker",
  "status": "complete",
  "files_changed": [
    "dashboard/src/app/globals.css",
    "dashboard/src/components/Sidebar.tsx",
    "dashboard/src/components/__tests__/Sidebar.test.tsx"
  ],
  "test_results": {
    "total": 14,
    "passed": 14,
    "failed": 0,
    "command": "npx vitest run"
  },
  "build_output": {
    "success": true,
    "command": "npm run build --prefix dashboard"
  },
  "visual_changes": "Sidebar now uses the new indigo-600 accent color instead of hardcoded #3b82f6. Active nav item has a subtle left border indicator.",
  "notes": ""
}
```

## When to Return to Orchestrator
- All tests pass **and** the build succeeds — return `status: complete`.
- Tests or build fail after 2 fix attempts — return `status: blocked` with error details.
- The task requires changes outside `dashboard/` (e.g., API routes, worker logic) — return `status: blocked` and recommend `fullstack-worker`.
