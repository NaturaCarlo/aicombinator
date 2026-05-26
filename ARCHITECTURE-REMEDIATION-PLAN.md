# Architecture Remediation And Pre-Launch Design Plan

Last updated: 2026-03-22

Related:
- [STATUS-CONTRACT.md](/Users/CEF/Projects/automaton/STATUS-CONTRACT.md)
- [SUPERVISOR-SPEC.md](/Users/CEF/Projects/automaton/SUPERVISOR-SPEC.md)
- [SUPERVISOR-SPEC-GAPS.md](/Users/CEF/Projects/automaton/SUPERVISOR-SPEC-GAPS.md)

## Purpose

This is the execution plan for the next major cleanup pass.

It combines:
- the architecture fixes we already identified
- the founder-state simplification work already started
- the new pre-launch Opus 4.6 cofounder flow

The goal is not just to fix visible bugs.
The goal is to make the system:
- more truthful
- more autonomous
- easier for the founder to understand
- harder to regress

## End State

When this plan is complete:
- a founder can shape a company through a high-quality Opus 4.6 pre-launch session
- that session produces a detailed company spec strong enough for long autonomous execution
- launch no longer feels like a thin form followed by blind provisioning
- the company page is driven by one canonical founder-state projection
- CEO chat and the founder screen are grounded in the same truth
- founder-facing statuses match the simplified contract in [STATUS-CONTRACT.md](/Users/CEF/Projects/automaton/STATUS-CONTRACT.md)
- the credit model is understandable and does not let one company invisibly starve another
- the most failure-prone orchestration code is broken into smaller, clearer modules

## Product Principles

These principles govern the work below.

### 1. Founder-facing truth must be simple

The founder should not have to parse orchestration internals.

The founder-facing contract remains:
- company: `running`, `paused`, `failed`
- agents: `free`, `working`, `paused`
- tasks: `active`, `queued`, `waiting on founder`, `waiting on dependency`, `done`, `paused`

### 2. Internal complexity may exist, but it must not leak

Retries, planner failures, cancellations, and recovery states can exist internally.
They must not appear as the founder's mental model.

### 3. CEO chat is a real control surface

The CEO chat must:
- answer what is happening now
- explain why something is idle or blocked
- accept direction and reprioritization
- translate founder intent into operational work

It must not:
- invent a parallel truth source
- answer from stale internal context
- drift semantically from the company page

### 4. Pre-launch quality is worth more than shallow speed

A better company brief before launch is cheaper than 40 bad autonomous turns after launch.

### 5. Opus should feel like a cofounder/mentor

Pre-launch Opus should not feel like a generic chatbot.
It should:
- challenge weak assumptions gently
- offer multiple good options often
- reduce founder effort
- help the founder think better without demanding too much from them

## Execution Discipline

This is how the work gets done without drifting or forgetting.

### Single source of truth

This file is the master execution order.
Each track should be marked:
- `pending`
- `in_progress`
- `done`
- `blocked`

### One active seam at a time

Only one architecture seam should be in flight at once.
No jumping between credits, chat, launch, and scheduler split in the same half-finished patch.

### Definition of done before code

Each track below includes acceptance criteria.
A track is not done because the code “looks right.”
It is done when its acceptance criteria pass.

### Delete after cutover

Whenever a new path replaces an old one:
- switch the main surface to the new path
- verify it
- delete the obsolete heuristics and fallback code

Do not leave two competing founder-facing systems in place.

### Stable checkpoints

After each completed track:
- typecheck Worker
- typecheck Supervisor
- build Dashboard if touched
- deploy only if the slice is coherent
- append a short worklog note

### Worklog rule

Every checkpoint should record:
- what changed
- what was verified
- what is still risky
- what the next track is

## Master Track List

The tracks below are in execution order.

### Track 1: Pre-Launch Venture Design Flow

Status: `done`

#### Goal

Replace the thin launch form with a structured Opus 4.6 venture-shaping session that produces a detailed, founder-approved company spec before provisioning begins.

#### Why first

This has the highest user-visible leverage.
It improves:
- launch quality
- company autonomy
- mission quality
- CEO bootstrap quality
- founder trust

#### Product requirements

Before a company exists, the founder enters a `launch session`.
This is not provisioning yet.

Opus 4.6 should:
- act like a thoughtful cofounder/mentor
- proactively offer multiple options whenever useful
- ask only the highest-leverage follow-up questions
- steadily compress ambiguity into an executable company brief

#### Interaction modes

The founder can choose:
- `Quick`
  - 2 to 3 turns
  - for already-clear ideas
- `Standard`
  - 5 to 7 turns
  - default
- `Deep`
  - 8 to 12 turns
  - for shaping a company from a rough intuition

#### Visible live blueprint

The launch UI should maintain a live structured blueprint while the conversation evolves.

Suggested sections:
- concept
- target customer
- painful problem
- first sellable offer
- why this wins now
- business model
- distribution wedge
- founder constraints
- autonomy boundaries
- non-goals
- open questions
- first milestone
- autonomy confidence

#### Multiple-options rule

Whenever possible, Opus should present 2 to 4 choices instead of asking the founder to invent from scratch.

Examples:
- customer segment options
- wedge options
- pricing options
- first-milestone options
- distribution options
- positioning variants

#### Final artifacts

The pre-launch flow must produce:
- `launch_brief.json`
  - structured machine-readable operating brief
- `company_spec.md`
  - detailed markdown spec for bootstrap and later reference
- `mission.md`
  - manifesto-quality mission document, not a thin blurb
- `first_milestone.md`
  - concrete first milestone and workstreams
- `autonomy_contract.md`
  - what the CEO/team may decide alone
  - what still requires founder input
  - account/setup tasks the founder must eventually handle

#### Launch-readiness gate

Provisioning may start only when the brief is ready.

Readiness requires:
- understandable company concept
- identifiable initial customer
- clear first offer
- plausible initial distribution wedge
- founder constraints recorded
- autonomy boundaries defined
- no unresolved critical ambiguity

#### Architecture changes

Add a launch-session layer before company creation:
- Worker storage for launch sessions and messages
- Worker routes for launch-session chat and launch-brief updates
- Dashboard launch UI redesign
- Structured pre-launch Opus prompt and output parser

The company should not be created until the founder explicitly launches from a ready session.

#### Likely file seams

- [worker/src/routes/companies.ts](/Users/CEF/Projects/automaton/worker/src/routes/companies.ts)
- new `worker/src/routes/launch-sessions.ts`
- [worker/src/provisioning/config-builder.ts](/Users/CEF/Projects/automaton/worker/src/provisioning/config-builder.ts)
- [dashboard/src/components/launch-form.tsx](/Users/CEF/Projects/automaton/dashboard/src/components/launch-form.tsx)
- new `dashboard/src/components/launch/*`

#### Acceptance criteria

- no company row is created during venture shaping
- the founder can complete a launch session without thinking from scratch on every step
- Opus frequently offers structured options
- the resulting company spec is detailed enough to bootstrap a company without raw-goal ambiguity
- the CEO bootstrap consumes the structured brief, not a raw text idea

### Track 2: Unify Launch Bootstrap With Steady-State Runtime

Status: `done`

#### Goal

Make launch the early phase of the normal company lifecycle, not a special parallel logic universe.

#### Changes

- company creation consumes `launch_brief.json`
- CEO bootstrap reads the structured brief directly
- mission/spec docs come from pre-launch artifacts, not ad hoc regeneration
- launch progress is derived from real runtime milestones, not separate invented gates

#### Acceptance criteria

- provisioning uses the same truth model as normal company runtime
- no duplicate “launch-only” state machine remains for core execution semantics

### Track 3: Fix The Credit Model

Status: `done`

#### Goal

Keep the account-wide wallet if desired, but stop invisible inter-company starvation.

#### Problems today

- reservations are keyed by `user_id`
- one company can block another without clear founder explanation
- the founder cannot reason about per-company budget pressure

#### Target behavior

The founder should understand:
- total account credits
- credits currently reserved
- which company is consuming or holding budget
- why a specific company is waiting

#### Preferred approach

Move to one of these:
- explicit per-company budget allocation
- fair-share reservation scheduler over the shared wallet

Default preference:
- keep account-wide wallet
- add per-company budget caps and reservation visibility

#### Acceptance criteria

- one company cannot silently starve another
- the founder-state payload explains budget contention clearly
- companies that are runnable do not appear arbitrarily stuck because another company is hoarding reservations

### Track 4: Turn Founder-State Into A Direct Projector

Status: `done`

#### Goal

Make founder-state canonical in implementation, not just in intent.

#### Problems today

[worker/src/routes/founder-state.ts](/Users/CEF/Projects/automaton/worker/src/routes/founder-state.ts) still composes legacy read routes internally.

That means it inherits:
- their fallback logic
- their output shape
- their hidden assumptions
- their future regressions

#### Changes

- extract shared low-level data fetchers
- build founder-state directly from those fetchers
- stop calling route handlers from inside founder-state
- demote legacy read routes to secondary/debug use

#### Acceptance criteria

- founder-state no longer depends on route-to-route composition
- company page and CEO chat both consume the direct projector
- old read routes are clearly secondary, not canonical

### Track 5: Delete Remaining Founder-Surface Heuristics

Status: `done`

#### Goal

Remove legacy dashboard code that still derives founder semantics from raw runtime rows.

#### Current leftovers

- [dashboard/src/components/company/live-execution.ts](/Users/CEF/Projects/automaton/dashboard/src/components/company/live-execution.ts)
- [dashboard/src/components/company/execution-summary.tsx](/Users/CEF/Projects/automaton/dashboard/src/components/company/execution-summary.tsx)
- [dashboard/src/components/company/task-board.tsx](/Users/CEF/Projects/automaton/dashboard/src/components/company/task-board.tsx)

#### Changes

- switch any remaining founder path to founder-state
- delete obsolete interpretation helpers
- remove duplicate task/agent bucket logic

#### Acceptance criteria

- the main founder UX has one semantic engine only
- raw task/agent rows are not reinterpreted differently elsewhere on the main company page

### Track 6: Collapse Approvals Fully Into Waiting-On-Founder Tasks

Status: `done`

#### Goal

Eliminate approvals as a separate founder-facing concept.

#### Changes

- approvals remain internal if needed
- founder only sees `waiting on founder` tasks
- these tasks expose structured actions:
  - approve
  - reject
  - provide info
  - connect account
  - upload credential

#### Acceptance criteria

- no separate founder approvals surface remains
- every founder-input need appears as a task in the founder-state payload

### Track 7: Make CEO Chat Strictly Trustworthy

Status: `done`

#### Goal

Keep CEO chat as a powerful control surface, but guarantee that it speaks from canonical truth.

#### Changes

- add post-reply validation for operational claims
- validate answers against founder-state before returning them
- if an answer conflicts with live state, force revision or replace with grounded fallback
- add first-class conversation semantics instead of treating chat as a generic activity-log side effect

#### Acceptance criteria

- CEO cannot claim active work that founder-state says is not active
- CEO cannot claim blocked work is running
- chat history remains consistent across reloads and restarts
- founder can steer priorities and ask for grounded explanations at any time

### Track 8: Complete The Internal Status Cleanup

Status: `done`

#### Goal

Reduce internal status sprawl and translations.

#### Changes

- remove/demote legacy internal states that are no longer needed
- align Supervisor/Worker types to [STATUS-CONTRACT.md](/Users/CEF/Projects/automaton/STATUS-CONTRACT.md)
- keep richer internal states only where genuinely necessary for orchestration

#### Acceptance criteria

- fewer translation layers between internal runtime and founder-state
- legacy states like `todo`, `sleeping`, `completed`, `free` are removed or isolated from normal execution paths

### Track 9: Version And Enforce The Worker-Supervisor Contract

Status: `done`

#### Goal

Make deploys safer by formalizing the JSON contract between Worker and Supervisor.

#### Changes

- define shared payload schemas
- validate inbound/outbound payloads
- add contract versioning
- fail loudly on incompatible shapes

#### Acceptance criteria

- shape mismatches are caught immediately
- deploys do not silently break because one side changed a payload

### Track 10: Split Scheduler

Status: `done`

#### Goal

Reduce the regression blast radius of [supervisor/src/scheduler.ts](/Users/CEF/Projects/automaton/supervisor/src/scheduler.ts).

#### Important rule

Do not start here.
Split the scheduler only after the surrounding contracts are cleaner.

#### Target modules

- lifecycle
- CEO turns
- founder messaging
- event queue
- milestone progression
- founder-input handling

#### Acceptance criteria

- scheduler core becomes a thinner coordinator
- each extracted module has a single concern and testable inputs/outputs

### Track 11: Harden Deploy And Config Management

Status: `done`

#### Goal

Reduce VM/config deploy fragility.

#### Changes

- preserve the remote environment safely
- reduce manual mutable state on the VM
- make rollback safer
- add more explicit deployment health checks

#### Acceptance criteria

- normal deploys cannot wipe critical env/config by accident
- restart failures are easier to diagnose and recover

## Overnight Execution Order

This is the exact order to run the work.

1. Pre-launch venture design flow
2. Launch/runtime unification
3. Credit model
4. Founder-state direct projector
5. Delete legacy founder heuristics
6. Collapse approvals into waiting-on-founder tasks
7. CEO chat validation and first-class conversation model

## Worklog

### Checkpoint 2026-03-22 01

Changed:
- built the new pre-launch `launch session` layer with Opus 4.6 and structured launch artifacts
- wired the dashboard launch flow to use the new cofounder-style session instead of the thin direct-launch form
- promoted `genesis_prompt` / structured founder brief into the supervisor bootstrap path

Verified:
- Worker typecheck passed
- Supervisor typecheck passed
- Dashboard typecheck/build passed

Still risky:
- not deployed yet
- D1 migration `012_launch_sessions.sql` still needs to be applied live

Next:
- cut founder-state off legacy route composition

### Checkpoint 2026-03-22 02

Changed:
- founder-state now builds from shared fetchers instead of calling legacy Worker route handlers
- deleted the unused legacy founder heuristic components:
  - `dashboard/src/components/company/live-execution.ts`
  - `dashboard/src/components/company/execution-summary.tsx`
  - `dashboard/src/components/company/task-board.tsx`
- CEO chat now post-validates replies against founder-state and replaces inconsistent operational answers with a grounded fallback
- credit reservations are now tracked per company in supervisor local state, instead of only as a single account-wide reserved total

Verified:
- Worker typecheck passed
- Supervisor typecheck passed
- Dashboard typecheck passed

Still risky:
- live deploy and migration still pending
- the credit-model change needs live observation under multi-company contention
- founder chat now has deterministic validation/fallback, but not yet a first-class conversation table

Next:
- deploy Worker, Dashboard, and supervisor
- apply launch-session D1 migration
- continue with approval collapse and conversation-model cleanup

### Checkpoint 2026-03-22 03

Changed:
- deployed the launch-session flow, founder-state direct projector, grounded CEO chat, and first-class founder conversation storage live
- tightened founder-facing status cleanup on the company dashboard and removed more secondary-path legacy state leakage
- added internal contract version headers across Worker↔supervisor calls, with mismatch rejection and transition-safe compatibility for missing headers
- extracted scheduler prompt/founder-reply composition into `supervisor/src/scheduler-prompts.ts`, shrinking `scheduler.ts` and reducing its prompt-construction blast radius

Verified:
- Worker typecheck passed
- Supervisor typecheck passed
- Dashboard typecheck/build passed
- Worker deployed live
- Dashboard deployed live
- Supervisor deployed to the VM and health check passed
- D1 now contains `launch_sessions`, `launch_session_messages`, and `founder_conversations`

Live result:
- Worker version `a71cf06a-f3f3-452f-8599-2ca5267ddcdc`
- Dashboard version `b0a8f773-75a0-4474-ae62-071878b2fbad`
- Supervisor VM health: `ok`

Remaining risk:
- the credit model is fairer, but still not the final explicit per-company budgeting model
- internal status cleanup is not fully complete across admin/showcase/secondary surfaces
- the Worker↔supervisor contract is versioned now, but payload schema validation is still lighter than it should be
- `scheduler.ts` is smaller in responsibility, but still too large overall

Next:
- continue Track 3 by making shared-wallet contention founder-visible and easier to reason about
- continue Track 8 by removing more legacy state assumptions from secondary surfaces
- continue Track 9 by tightening payload-shape validation on the most important internal routes

### Checkpoint 2026-03-22 04

Changed:
- made shared-wallet reservation pressure founder-visible through the canonical founder-state payload and sidebar metrics card
- removed the last founder-facing `approval` naming leak by renaming waiting-on-founder task actions to generic founder-input actions
- filtered the founder portfolio/company switcher path down to `running`, `paused`, and `failed` companies only
- added lightweight runtime payload parsers for the most important Worker↔supervisor contracts:
  - supervisor company status
  - supervisor launch status
  - supervisor provision payload
  - supervisor founder-message payload
- hardened deploy scripts further with explicit `.env` presence checks, longer health polling, and automatic journal output on restart failure

Verified:
- Worker typecheck passed
- Supervisor typecheck passed
- Dashboard build passed

Still risky:
- `scheduler.ts` is still the main remaining oversized module
- some legacy status vocabulary still exists in admin/showcase/internal-only surfaces, but it is now isolated from normal founder execution paths

Next:
- deploy this slice live
- continue Track 10 by extracting more lifecycle/observability logic out of `scheduler.ts`

### Checkpoint 2026-03-22 05

Changed:
- completed the remaining scheduler split work by extracting three focused supervisor modules:
  - [supervisor/src/scheduler-documents.ts](/Users/CEF/Projects/automaton/supervisor/src/scheduler-documents.ts)
  - [supervisor/src/scheduler-status.ts](/Users/CEF/Projects/automaton/supervisor/src/scheduler-status.ts)
  - [supervisor/src/scheduler-founder.ts](/Users/CEF/Projects/automaton/supervisor/src/scheduler-founder.ts)
- added [supervisor/src/scheduler-helpers.ts](/Users/CEF/Projects/automaton/supervisor/src/scheduler-helpers.ts) for shared JSON/runtime helpers
- reduced [supervisor/src/scheduler.ts](/Users/CEF/Projects/automaton/supervisor/src/scheduler.ts) from about `2721` lines to about `2085`
- moved document/materialization logic, founder fallback/prompt-building, and status/activity projection out of the coordinator

Verified:
- Worker typecheck passed
- Supervisor typecheck passed
- Supervisor build passed
- Dashboard build passed
- Worker live health check passed
- Dashboard launch page returned 200
- Supervisor VM health check passed after deploy

Still risky:
- the scheduler is materially smaller now, but it still owns lifecycle/event-queue/pause-resume orchestration in one class
- old admin/showcase/debug paths still exist, even though the main founder path is now much cleaner

Next:
- deploy the supervisor split live
- verify Worker, dashboard, and supervisor health
- treat the architecture cleanup pass as complete, with future work shifting from contract cleanup to iterative simplification and runtime hardening

### Checkpoint 2026-03-24 01

Changed:
- moved launch-session assistant-turn state out of KV/message-content prefixes and into a durable D1 table: `launch_session_turns`
- added a compatibility backfill path so older launch sessions are normalized into the new turn-state model on read
- stopped using placeholder message content as the canonical source of `pending` / `processing` / `error`
- added route-level launch-session tests that cover create, background completion, error, and retry flows against an in-memory SQLite-backed D1 shim
- fixed a real conversation-order bug where founder/assistant messages created at the same timestamp could sort incorrectly

Verified:
- Worker typecheck passed
- Dashboard build passed
- full unit suite passed
- Worker deployed live
- remote D1 now contains `launch_session_turns`

Live result:
- Worker version `d98cb392-0159-4ece-a129-42342c347fcc`

Remaining risk:
- Cloudflare's migration ledger is still out of sync with the repo history, so `wrangler d1 migrations apply` is not yet a trustworthy one-shot deploy primitive
- launch quality was still limited by the turn contract itself, even after the persistence cleanup

Next:
- tighten the Opus turn contract so founder steering is reflected in the working brief before each new model turn

### Checkpoint 2026-03-24 02

Changed:
- added deterministic projection of founder steering into the launch-session working brief before each Opus turn
- added compact recent-turn context to the launch prompt so the model sees both founder replies and recent assistant context instead of only a founder-only summary
- tightened the system prompt to default toward `current thesis -> concrete options -> one unresolved decision`, which should reduce repeated broad questions
- added unit coverage for the new brief-projection behavior

Verified:
- Worker typecheck passed
- Dashboard build passed
- targeted launch-session tests passed
- full unit suite passed
- Worker deployed live
- Worker health check passed

Live result:
- Worker version `5ef49d32-f222-498d-838f-de8d02b2fbf4`

Remaining risk:
- launch-session latency still needs better live measurement than the current latest-turn metadata alone
- the dashboard launch studio still needs more auth-backed end-to-end runtime validation, not just local test coverage

Next:
- add deeper live observability around launch-session provider latency and failure modes
- keep tightening the launch studio UX and launch-to-runtime handoff
8. Internal status cleanup
9. Contract versioning
10. Scheduler split
11. Deploy/config hardening

## Verification Rules

For every track:
- `cd /Users/CEF/Projects/automaton/worker && npx tsc --noEmit -p tsconfig.json` if Worker changed
- `cd /Users/CEF/Projects/automaton/supervisor && npx tsc --noEmit` if Supervisor changed
- `cd /Users/CEF/Projects/automaton/dashboard && npm run build` if Dashboard changed

For risky runtime tracks:
- deploy only after the slice is coherent
- verify Worker health
- verify Supervisor health
- verify the exact founder path that was changed

## Worklog Template

For each checkpoint, append:

```md
### Checkpoint YYYY-MM-DD HH:MM PT
- Track:
- Changes:
- Verification:
- Live result:
- Remaining risk:
- Next:
```

## What Should Not Need Founder Input

After this plan, the founder should not have to constantly rescue the system from ambiguity.

The system should be able to operate for long stretches from the detailed company spec alone.

The founder may still be needed for:
- account creation
- credential provisioning
- legal/compliance decisions
- irreversible spending or platform commitments
- major strategic pivots

Everything else should default toward autonomous execution.

## Immediate Next Step

Start with Track 1:
- design the launch-session data model
- design the Opus 4.6 cofounder prompt contract
- redesign the launch page around conversation plus live blueprint
- define the final launch brief schema that provisioning will consume
