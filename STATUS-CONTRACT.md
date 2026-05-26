# Status Contract

Last updated: 2026-03-19

## Purpose

This document defines:
- the founder-facing status model
- the internal runtime status model
- the rules that map internal state to founder-visible state

The goal is to stop the product from exposing low-level orchestration states directly to the founder.

## Core principle

There are two different layers of state:

1. Internal runtime state
   - used for scheduling, retries, recovery, sync, and debugging
2. Founder-facing state
   - used for the company dashboard, launch flow, CEO chat context, and control surfaces

The founder-facing layer is the product contract.
The internal layer may be richer, but it must never leak through directly.

## Founder-facing company states

The founder should only ever see:
- `running`
- `paused`
- `failed`

Important rules:
- `provisioning`, `planning`, and `awaiting_funding` are background lifecycle states and must never render the normal company dashboard
- `dead` must never be shown to the founder
- `sleeping` must not exist on the founder surface

### Company visibility rules

- A company is visible in the normal dashboard only if it is:
  - `running`
  - `paused`
  - `failed`
- A company in `provisioning`, `planning`, or `awaiting_funding` remains in launch/background flows only

## Founder-facing agent states

The founder should only ever see:
- `free`
- `working`
- `paused`

Important rules:
- `paused` is only valid when the company itself is paused
- `error` must never be shown to the founder
- `terminated` must never be shown to the founder
- `assigned`, `idle`, `offline`, `sleeping`, and `running` are not founder-facing states

### Agent mapping rules

- If company state is `paused`, all visible agents must render as `paused`
- If an agent is actively executing a task, render `working`
- Otherwise, render `free`

An agent does not have a distinct founder-facing “assigned” state.
If a task is assigned and ready, the founder should understand that from the task list, not from a separate agent state.

## Founder-facing task states

The founder should only ever see:
- `active`
- `queued`
- `waiting on founder`
- `waiting on dependency`
- `done`
- `paused`

Important rules:
- `failed` must never be shown to the founder
- `cancelled` must never be shown to the founder
- `pending` must never be shown to the founder
- `ready` must never be shown to the founder
- `blocked` must never be shown to the founder as a raw status

### Task mapping rules

- `active`
  - the task is currently being worked on
  - its owner agent must render as `working`

- `queued`
  - the task exists
  - it is eligible to run
  - but its owner is currently occupied with another task

- `waiting on founder`
  - the task cannot proceed until the founder provides input, approves, rejects, or supplies credentials/data

- `waiting on dependency`
  - the task cannot proceed because an upstream task or prerequisite is not complete

- `done`
  - the task is complete and founder-visible as completed work

- `paused`
  - the company is paused, so runnable work is temporarily paused

### Founder-facing task invariants

- A task cannot be `queued` if its owner is free and the company is running
- A task cannot be `active` unless its owner is `working`
- If the company is `paused`, founder-visible open tasks should render as `paused`
- A founder-visible task should never surface low-level recovery states directly

## Founder-facing approvals

There is no separate founder-facing approval object.

Approvals are represented as tasks in `waiting on founder`, with structured action controls such as:
- approve / reject
- provide required information
- approve with note
- reject with note

Internal approval records may still exist for orchestration, but they must not appear as a parallel concept in the founder product.

## Founder-facing milestones

Milestones are internal for now.

Rules:
- milestones are not shown to the founder
- milestone state may influence task visibility and execution
- the founder should understand progress through tasks, docs, links, and CEO explanations instead

## Founder-facing launch states

The founder may see launch/provisioning stages only in the launch flow, not in the company dashboard.

Allowed launch-flow states include:
- creating workspace
- creating CEO
- CEO planning
- activating team
- delegating tasks
- founder briefing
- finalizing
- ready
- failed

Once the founder enters the actual company dashboard, the company state model takes over:
- `running`
- `paused`
- `failed`

## CEO chat contract

The CEO chat is a real founder control surface.

It must support:
- getting live, grounded answers about what is happening now
- asking why work is blocked or idle
- steering priorities
- assigning new direction
- clarifying tradeoffs

It must not become a competing truth source.

### CEO chat grounding rules

CEO replies must be grounded in canonical founder state:
- current company state
- current task buckets
- current visible team state
- current credit availability and reservation pressure
- current founder-waiting items

If the internal system has a recoverable failure:
- the CEO should recover it without exposing raw internal failure statuses
- the founder should continue seeing only founder-facing task states
- if retries exceed the internal limit, the CEO may surface a founder-facing `waiting on founder` task to request help

## Internal runtime states

These may exist internally and be used for orchestration, retries, and recovery.

### Internal company states

Allowed internally:
- `awaiting_funding`
- `provisioning`
- `planning`
- `running`
- `paused`
- `failed`
- `dead`

Internal-only / not founder-facing:
- `awaiting_funding`
- `provisioning`
- `planning`
- `dead`

Not part of the desired runtime model:
- `completed`
- `sleeping`

These should be removed or demoted over time.

### Internal agent states

Allowed internally:
- `idle`
- `working`
- `paused`
- `error`
- `terminated`
- `pending_approval`

Internal-only / not founder-facing:
- `idle`
- `error`
- `terminated`
- `pending_approval`

Legacy states to remove or demote:
- `running`
- `sleeping`
- `offline`
- `free`

### Internal task states

Allowed internally:
- `pending`
- `ready`
- `in_progress`
- `blocked`
- `done`
- `cancelled`
- `failed`

Internal-only / not founder-facing:
- `pending`
- `ready`
- `blocked`
- `cancelled`
- `failed`

Legacy status to remove:
- `todo`

### Internal approval states

Allowed internally:
- `pending`
- `approved`
- `rejected`

Founder-facing treatment:
- never shown directly
- always projected into a task that is `waiting on founder`

## Recovery rules

If work breaks internally:
- the system should retry and recover without founder-visible failure states
- the founder should continue seeing:
  - `queued`
  - `waiting on dependency`
  - `waiting on founder`
  - `active`
  - `paused`
  - `done`

If recovery exceeds the configured retry budget:
- create or update a founder-visible task in `waiting on founder`
- explain what input is needed
- do not surface raw `failed` / `cancelled` internals directly

## Mapping summary

### Agent projection

- internal `working` -> founder `working`
- internal `paused` -> founder `paused` if company is paused
- internal `idle` -> founder `free`
- internal `pending_approval` -> founder `free`
- internal `error` -> founder `free` unless CEO has created a founder-waiting task
- internal `terminated` -> hidden

### Task projection

- internal `in_progress` -> founder `active`
- internal `ready` with busy owner -> founder `queued`
- internal `ready` with free owner -> should immediately become `active`
- internal `pending` -> founder `waiting on dependency`
- internal `blocked` with founder-required reason -> founder `waiting on founder`
- internal `blocked` otherwise -> founder `waiting on dependency`
- internal `done` -> founder `done`
- internal open task while company is paused -> founder `paused`
- internal `failed` / `cancelled` -> not shown directly; absorbed into retry/recovery or founder-waiting task

## Non-negotiable invariants

These should hold everywhere:

1. The founder must never see impossible combinations like:
   - agent `working` with no active task
   - task `queued` when its owner is free and the company is running
   - company `paused` with active tasks

2. The founder must never see raw internal churn such as:
   - `pending`
   - `ready`
   - `failed`
   - `cancelled`
   - `terminated`
   - `error`

3. CEO chat must reflect the same founder-state projection used by the dashboard.

4. The company dashboard must only render for:
   - `running`
   - `paused`
   - `failed`

## Cleanup implications

This contract implies the following cleanup:

1. Build one canonical founder-state projection from internal runtime state
2. Make the main company screen consume only that projection
3. Remove frontend heuristics that currently infer founder meaning from raw rows
4. Hide or absorb internal recovery states before they reach the founder
5. Ground CEO chat in the same founder-state projection
