# Workflow Diagnosis: Why Agents Don't Converge

## Current Workflow

```
Cron fires → Agent wakes → Reads execution contract, inbox, tasks →
Does ~3 min of work → Writes outbox → Sleeps → Cron fires → Repeat
```

This looks like a work loop, but it has no **convergence property**. There is nothing in the system that makes iteration N+1 closer to "done" than iteration N.

---

## Problem 1: No Goal Decomposition

The CEO gets a company idea ("ghostwriting service for founders") and is told to create an execution contract. The execution contract is a JSON blob, not a structured goal tree. There is no mechanism to break the idea into a machine-readable plan:

```
Goal: Launch ghostwriting service
├── Milestone 1: Landing page live
│   ├── Task: Design homepage (Frontend Dev)       [depends on: copy]
│   ├── Task: Write copy (CMO)                     [depends on: nothing]
│   └── Task: Deploy to domain (CTO)               [depends on: homepage]
├── Milestone 2: Voice capture system
│   ├── Task: Build intake form (Backend Dev)      [depends on: nothing]
│   └── Task: Build processing pipeline (Backend)  [depends on: intake form]
└── Milestone 3: First paying client
    ├── Task: Cold outreach campaign (CMO)          [depends on: landing page]
    └── Task: Demo meeting script (CEO)             [depends on: outreach]
```

Instead, the CEO writes `plan.md` (a markdown document) and agents read it on each wake. The plan has no structure the supervisor can track, no completion criteria, no dependency ordering. The system cannot answer "what percentage of the plan is done" because the plan is not machine-readable.

**Result:** The supervisor has no idea what "done" looks like. It just keeps waking agents on a timer.

---

## Problem 2: Turns Are Too Short and Context-Hostile

Each agent gets **3 minutes and 5 inference rounds**. Building a landing page takes continuous work: reading the plan, scaffolding files, writing HTML/CSS, iterating on design.

Instead, the agent gets 3 minutes, creates maybe one file, goes to sleep. Next wake: re-reads the entire execution contract, inbox, task list, and all outbox messages (spending 30-60 seconds just on context), then gets roughly 2 minutes of actual work.

The ratio of **context loading to productive work** is poor. On a 3-minute turn, an agent might spend 40% re-reading things it already knew. Session resumption helps (conversation persists), but the orchestration context (inbox, tasks, contract) is rebuilt from scratch every turn.

**Result:** Agents spend most of their time re-orienting instead of building.

---

## Problem 3: Communication Is Chat, Not Coordination

Agents communicate by writing messages: "Hey CTO, I finished the copy, can you deploy?" This is Slack, not project management.

- **No acknowledgment** — sender does not know if the message was read
- **No blocking** — CTO cannot say "I am blocked on Frontend finishing the homepage"
- **No completion signal** — when CTO finishes, CEO does not get notified
- **No dependency graph** — "deploy" depends on "homepage done" depends on "copy written," but this is implicit in chat messages, not explicit in the system

The task system exists in D1 but it is decorative. Tasks are created but not enforced, tracked, or used for scheduling. The scheduler wakes agents on timers, not on "your dependency was just completed."

**Result:** Agents work in isolation, unaware of each other's progress or blockers.

---

## Problem 4: Agents Wake on Clocks, Not on Events

The cron system wakes every agent every 3-5 minutes. This is polling.

What happens today:

```
Frontend Dev finishes homepage → goes to sleep
3 minutes pass → CTO wakes → reads inbox → maybe sees a message → maybe acts on it
3 more minutes pass → CEO wakes → re-reads everything → wonders why nothing is deployed
```

What should happen:

```
Frontend Dev finishes homepage →
  Event: "task X completed" →
  Supervisor checks: "what depends on task X?" →
  CTO needs to deploy → wake CTO with "task X is done, deploy now"
```

Clock-based waking means agents have no sense of urgency or sequencing. Everything happens at the speed of the cron interval, regardless of whether it is urgent.

**Result:** The system moves at cron speed, not work speed. Dependencies that could resolve in seconds wait for the next timer tick.

---

## Problem 5: Work Output Does Not Connect to Reality

Agents write files to `/workspace`. A landing page is an `index.html` file sitting in a directory. Marketing copy is a markdown file. A "cold outreach campaign" is a plan document.

None of this is connected to the real world:

- The landing page is not deployed anywhere
- The outreach emails are not sent
- The product is not accessible to customers
- There is no analytics, no user feedback, no revenue signal

The workspace is a sandbox that simulates work without producing real outcomes. The agents cannot tell if they are succeeding because there is no feedback from reality.

**Result:** Agents produce artifacts that look like work but have no impact. The system cannot distinguish productive work from busywork.

---

## Problem 6: No Progress Measurement, No Convergence

The supervisor tracks:

- Credits spent (input metric, not output)
- Turns completed (activity metric, not progress)
- Files created (volume metric, not quality)

It does not track:

- Goals achieved
- Milestones completed
- Blockers resolved
- Dependencies satisfied

Without a progress signal, the system cannot self-correct. If agents are going in circles (congratulating each other, rewriting the same plan, creating celebration messages), nothing in the architecture detects or prevents it. "Going in circles" and "making progress" are indistinguishable to the supervisor: turns completed, credits spent, files modified.

**Result:** No feedback loop. The system burns credits without knowing whether it is converging or diverging.

---

## Problem 7: Every Agent Is an Island

Despite having roles, agents do not have a shared understanding of "the current state of the project." Each agent wakes up, reads its own inbox, reads the shared execution contract, and decides what to do independently.

Missing:

- Shared kanban board that agents mutually update
- Status sync ("CTO is currently working on deployment, do not touch those files")
- Handoff protocol ("I am done with my part, here is exactly what you need to continue")

The execution contract is the closest thing to shared state, but it is written by the CEO and read-only for everyone else. If the CTO discovers the architecture needs to change, it cannot update the contract. It can only send a message to the CEO, who might read it 3-5 minutes later.

**Result:** Agents work from stale or incomplete context, leading to conflicts and redundant work.

---

## What the Workflow Should Look Like

```
Company created
  → CEO decomposes goal into milestone tree (machine-readable, stored in D1)
  → Each milestone has tasks with dependencies, owners, acceptance criteria

Supervisor runs the workflow:
  → Find tasks whose dependencies are all satisfied
  → Wake the assigned agent with focused task context (not the whole company state)
  → Agent works until task is complete (longer turns, 10-15 min)
  → Agent marks task done, submits artifact
  → Supervisor validates artifact against acceptance criteria
  → Supervisor checks: what depends on this completed task?
  → Wake next task owners with "your dependency is resolved, go"
  → Repeat until milestone is done
  → CEO reviews milestone, decomposes the next one

Progress is measurable:
  → 3/12 tasks complete, 2 in progress, 7 blocked
  → Milestone 1 done, Milestone 2 at 40%
  → Estimated credits to complete: ~200
  → Time since last progress: 4 minutes (healthy) vs 45 minutes (stalled)
```

## Key Differences From Current System

| Dimension | Current | Target |
|-----------|---------|--------|
| **Scheduling** | Clock-based (cron every 3-5 min) | Task-based (wake when dependency resolves) |
| **Goal structure** | Unstructured markdown plan | Machine-readable milestone/task tree in D1 |
| **Dependencies** | Implicit in chat messages | Explicit in task graph, enforced by supervisor |
| **Turn length** | 3 min / 5 inference rounds | 10-15 min / task completion or budget cap |
| **Context per turn** | Everything (contract, inbox, all tasks) | Focused: just the assigned task + its inputs |
| **Completion** | Timer expires, agent sleeps | Agent declares task done, supervisor validates |
| **Progress signal** | Credits spent, files created | Tasks completed, milestones achieved |
| **Stall detection** | None | Supervisor detects tasks stuck beyond time/credit budget |
| **Communication** | Free-form outbox messages | Structured task handoffs with artifacts |
| **Real-world output** | Files in /workspace (sandbox) | Deployments, emails, live URLs (connected to reality) |
