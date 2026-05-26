---
name: fullstack-worker
description: Fullstack worker for tasks spanning dashboard, worker API, and supervisor packages.
---

# Fullstack Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill
- Model expansion (adding/modifying ModelTier, MODEL_MAP, MODEL_MULTIPLIERS)
- System prompt changes (supervisor adapter, worker agent route, dashboard UI)
- API route changes that require coordinated dashboard + worker updates
- Type definitions shared across packages
- Any task that touches 2 or more of: `dashboard/`, `worker/`, `supervisor/`

## Required Skills
None.

## Work Procedure

1. **Understand the feature description** — Read the handoff carefully. Map every change to its package (`dashboard`, `worker`, `supervisor`).

2. **Identify shared types** — Check for type definitions (e.g., `ModelTier`, API request/response shapes) that must stay consistent across packages. List them.

3. **TDD — Write tests first**
   - For API routes: Write request/response tests in the worker package.
   - For supervisor logic: Write unit tests for adapter and orchestration changes.
   - For dashboard: Write component tests for any new UI.
   - Run `npx vitest run` from the repo root to confirm new tests fail (red phase).

4. **Implement across packages — types first**
   - Update shared type definitions first (enums, interfaces, maps).
   - For model expansion: Update `ModelTier`, `MODEL_MAP`, and `MODEL_MULTIPLIERS` in **every** location across all packages.
   - For system prompt changes: Update the supervisor adapter, worker agent route, and dashboard UI in that order.
   - Ensure API contracts (request/response shapes) are consistent between caller and callee.

5. **Run tests (green phase)**
   ```bash
   cd /Users/CEF/Projects/automaton && npx vitest run
   ```
   All tests must pass across all packages.

6. **Typecheck**
   ```bash
   cd /Users/CEF/Projects/automaton && npx tsc --noEmit
   ```
   Zero type errors allowed. Fix any inconsistencies between packages.

7. **Prepare handoff** — Collect:
   - All packages modified
   - API contract changes (new/modified endpoints, request/response shapes)
   - Test results (pass/fail counts)
   - Typecheck results
   - Any migration or deployment notes

## Example Handoff

```json
{
  "worker_type": "fullstack-worker",
  "status": "complete",
  "packages_modified": ["dashboard", "worker", "supervisor"],
  "files_changed": [
    "dashboard/src/types/models.ts",
    "dashboard/src/components/ModelSelector.tsx",
    "dashboard/src/components/__tests__/ModelSelector.test.tsx",
    "worker/src/routes/agent.ts",
    "worker/src/types/models.ts",
    "worker/src/__tests__/agent.test.ts",
    "supervisor/src/adapter.ts",
    "supervisor/src/types.ts",
    "supervisor/src/__tests__/adapter.test.ts"
  ],
  "api_contract_changes": [
    {
      "endpoint": "POST /api/agent/chat",
      "change": "Added 'model_tier' field to request body (enum: 'fast' | 'standard' | 'premium')"
    }
  ],
  "test_results": {
    "total": 42,
    "passed": 42,
    "failed": 0,
    "command": "npx vitest run"
  },
  "typecheck": {
    "success": true,
    "command": "npx tsc --noEmit"
  },
  "notes": "MODEL_MULTIPLIERS updated in 3 files. D1 migration needed for new model_tier column — deploy-test-worker should run db:migrate."
}
```

## When to Return to Orchestrator
- All tests pass **and** typecheck succeeds — return `status: complete`.
- Tests or typecheck fail after 2 fix attempts — return `status: blocked` with error details.
- A required package is missing dependencies or has config issues — return `status: blocked` with specifics.
- The task only touches `dashboard/` — return `status: redirected` and recommend `dashboard-worker`.
