You are implementing the Supervisor V2 for the AI Combinator platform.
This is a rewrite of supervisor/src/ — not a refactor of the existing code.

# Specs

Read and follow these two documents as your source of truth:
- SUPERVISOR-SPEC.md — core supervisor architecture
- SUPERVISOR-SPEC-GAPS.md — founder docs, telemetry mirror, dedicated VM routing

Implement them line by line. Do not invent features not in the specs.
Do not skip sections. If something is ambiguous, follow the pseudocode exactly.

# Codebase Context

- supervisor/ — Node.js + TypeScript, runs on a Linux VM
- worker/ — Cloudflare Worker (DO NOT MODIFY — it's the other side of the API)
- dashboard/ — Next.js frontend (DO NOT MODIFY)
- The supervisor uses: better-sqlite3, Hono (HTTP), @anthropic-ai/claude-code SDK

# Files to Keep (carry over from current codebase)

- supervisor/src/agent-invoker.ts — Claude Code SDK integration (works fine, adapt interface)
- supervisor/src/blueprints.ts — agent blueprint definitions (keep as-is)
- supervisor/src/container-manager.ts — Docker lifecycle (keep as-is)

# Files to Create (Section 14 of SUPERVISOR-SPEC.md)

Build in this order — each file should compile before moving to the next:

1. supervisor/src/types.ts — all types, interfaces, enums from both specs
2. supervisor/src/db.ts — SQLite wrapper, schema from Section 2.1 (including telemetry_mirror)
3. supervisor/src/credit-manager.ts — local balance, deduction, exhaustion, sync (Section 9)
4. supervisor/src/task-manager.ts — task CRUD, plan validation, plan ingestion, acceptance criteria (Sections 4, 2.2, 2.3)
5. supervisor/src/stall-detector.ts — check_stalls(), handle_stall(), escalation (Section 6)
6. supervisor/src/sync.ts — D1 sync with exponential backoff retry (Section 10)
7. supervisor/src/agent-runner.ts — build_task_prompt(), build_system_prompt(), wake_agent(), signal file handling, on_agent_turn_finished() (Sections 3.4, 3.5, 3.7, 17)
8. supervisor/src/scheduler.ts — schedule(), on_task_completed(), dependency resolution, milestone advancement, CEO event queue, invoke_ceo_turn(), plan updates (Sections 3, 5, 8)
9. supervisor/src/cron.ts — cron task scheduling, daily update requests (Section 13, Gaps Section 1.4)
10. supervisor/src/api.ts — Hono HTTP routes for Worker calls (Section 3.7 of Gaps spec for endpoint list)
11. supervisor/src/index.ts — entry point, config, startup sequence (Section 16), shutdown

# Implementation Rules

- Use the schema SQL from Section 2.1 verbatim for migrations
- Every function in the pseudocode maps to a real function — same name, same logic
- Signal files go to /workspace/.agent/{agent_id}/ (per-agent directories)
- CEO files go to /workspace/.agent/ (plan.json, plan_update.json, approval_request.json)
- The CEO is NOT a task-based agent — it has its own turn flow (invoke_ceo_turn, Section 8.1.1)
- schedule() is the heartbeat — call it after any event that changes task readiness
- wake_agent() is fire-and-forget async — multiple agents work concurrently
- Node.js single-threaded event loop prevents SQLite data races
- All dates in PT (America/Los_Angeles) for founder-facing content
- Telemetry mirror is read-only locally — only accepts pushes from Worker
- Credit balance is the ONLY budget gate — no per-task limits

# CRITICAL: Do NOT Run the Product

DO NOT start the supervisor process, boot Docker containers, invoke Claude Code SDK,
call the Worker API, or make any HTTP requests to external services. These actions
spend real money (API tokens, cloud compute) and must not happen during implementation.

Verification is strictly limited to:
- Type checking: cd supervisor && npx tsc --noEmit
- Building: cd supervisor && npm run build
- Reading existing code for reference
- Running unit tests if you write them (pure logic tests only — no network, no SDK calls)

Do NOT run: npm start, node dist/index.js, curl to any API, or any command that
would start the supervisor or invoke agents. If a test requires mocking the Claude
Code SDK or hitting a real endpoint, skip it.

# Verification

After each file, run: cd supervisor && npx tsc --noEmit
After all files, run: cd supervisor && npm run build
Fix all type errors before moving to the next file.

# What Done Looks Like

- All 11 files compile with zero type errors
- npm run build succeeds
- The code faithfully implements every section of both specs
- No runtime testing — build verification only
