# AI Combinator — System Overview

## What This Document Covers

1. **Current Functionality** — What the system does today, how all the pieces work
2. **Desired Workflow** — What the system should do when the architecture is fully realized
3. **Diagnosis** — Every identified problem, from fundamental workflow flaws to operational bugs

---

# Part 1: Current Functionality

## What AI Combinator Is

AI Combinator is a platform where users create autonomous AI companies. Each company is staffed by a team of AI agents (CEO, CTO, CMO, and specialists) that operate autonomously — writing code, sending emails, browsing the web, running marketing campaigns, deploying websites. The user acts as the "board of directors": they set the vision, approve key decisions, and fund the company with credits. The agents do everything else.

The key differentiator from competitors (e.g., Polsia) is that the **full agent team** is exposed, not just a single CEO. Users see every agent's activity, can message any agent, and observe the entire organization working in real time.

## Architecture

The system has three layers:

```
┌──────────────────────────────────────────────────────┐
│ CLOUDFLARE WORKER (api.example.com)             │
│                                                        │
│ • REST API for dashboard ↔ agents                     │
│ • Clerk auth middleware (JWT verification)             │
│ • D1 database (SQLite — all persistent state)          │
│ • Stripe webhook handler                               │
│ • Subdomain routing for company websites               │
└───────────────────────┬──────────────────────────────┘
                        │ HTTP via Cloudflare Tunnel
                        ▼
┌──────────────────────────────────────────────────────┐
│ SHARED VM (Hetzner, 203.0.113.10)                    │
│                                                        │
│ ┌──────────────────────────────────────────────────┐  │
│ │ SUPERVISOR (Node.js, no LLM, zero credit cost)   │  │
│ │                                                    │  │
│ │ • Event listener (messages, email, cron, relay)   │  │
│ │ • Agent lifecycle (wake, sleep, pause, kill)       │  │
│ │ • Credit tracking and enforcement                  │  │
│ │ • Docker container management                      │  │
│ │ • Agent Relay client for inter-agent comms         │  │
│ └──────────────────────────────────────────────────┘  │
│                                                        │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
│ │ Container:   │ │ Container:   │ │ Container:   │   │
│ │ Company A    │ │ Company B    │ │ Company C    │   │
│ │ /workspace/  │ │ /workspace/  │ │ /workspace/  │   │
│ └──────────────┘ └──────────────┘ └──────────────┘   │
└──────────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────┐
│ NEXT.JS DASHBOARD (example.com)                 │
│                                                        │
│ • Company page with agent activity, tasks, docs        │
│ • CEO chat panel                                       │
│ • Billing page (Stripe checkout, credit history)       │
│ • Company launch wizard                                │
│ • SSR on Cloudflare Workers via OpenNext                │
└──────────────────────────────────────────────────────┘
```

### Cloudflare Worker (API Layer)

The Worker serves as the API gateway and data layer. It handles:

- **Authentication**: Clerk JWT verification on all protected routes
- **Database**: D1 (SQLite) is the single source of truth — companies, agents, tasks, credits, subscriptions, policies, cron tasks (31 tables)
- **Billing**: Stripe integration for subscriptions ($50/month), one-time credit purchases, and auto-refill
- **Supervisor proxy**: Routes agent actions (wake, pause, message) to the supervisor on the VM via Cloudflare Tunnel
- **Subdomain routing**: `*.example.com` serves company public websites from their workspace
- **Real-time data**: SSE endpoint for live status, burn rate calculation, task CRUD

Worker API routes fall into categories:
- `/api/companies/*` — CRUD, status, activity
- `/api/agents/*` — list, wake, pause, messages
- `/api/billing/*` — checkout, portal, status, auto-refill, buy-credits
- `/api/supervisor/*` — 14 internal endpoints for supervisor ↔ D1 communication (authenticated by `X-Supervisor-Key`)
- `/api/webhooks/stripe` — 5 Stripe event handlers
- `/api/companies/:id/tasks` — task CRUD
- `/api/companies/:id/burn-rate` — credit burn rate from cost_events
- `/api/companies/:id/status/stream` — SSE endpoint

### Supervisor (Agent Orchestration)

The supervisor is a Node.js process running on the shared VM. It is the brain of the operation but never calls an LLM itself — it only dispatches events to agents. This is the design decision that prevents idle credit burn.

**Core file**: `supervisor/src/supervisor.ts` (~7,000 lines — the largest file in the project)

The supervisor handles:

**Event dispatch** — 8 event types, each triggering different agent behavior:
- `user_message` — user sends chat → wake CEO
- `email_received` — email arrives → wake appropriate agent
- `cron_tick` — scheduled task fires → wake assigned agent
- `relay_message` — agent-to-agent communication → wake target
- `approval_resolved` — user approves/rejects → resume blocked agent
- `webhook` — external event → wake configured agent
- `credits_exhausted` — balance hits 0 → pause all agents
- `credits_purchased` — credits added → resume paused agents

**Agent invocation** — via Claude Code SDK (`@anthropic-ai/claude-code`):
```typescript
const conversation = query({
  prompt: normalizedPrompt,
  options: {
    model: "sonnet",
    customSystemPrompt,
    cwd: workspaceDir,
    maxTurns: limits.maxInferenceRoundsPerTurn,
    permissionMode: "bypassPermissions",
    resume: existingSession?.sessionId,  // conversation persistence
  },
});
```

**Credit enforcement** — checks balance before every agent wake, deducts after each turn based on actual token usage:
- Sonnet: 0.3 credits / 1K input tokens, 1.5 credits / 1K output tokens
- Haiku: 0.025 credits / 1K input, 0.125 credits / 1K output
- Minimum 1 credit per turn, max 50 credits/turn (CEO) or 20 (specialist)

**Cron checking** — every 30 seconds, checks all enabled cron tasks and wakes agents whose schedules are due

**Outbox parsing** — after each agent turn, reads `/workspace/.agent/outbox/{agentId}.json` to find messages the agent wants to send to other agents. Routes messages and wakes recipients.

**Workspace fingerprinting** — before/after each turn, hashes workspace files to detect whether the agent actually produced artifacts. Role-specific requirements (e.g., CTO must create code files).

**Session persistence** — tracks Claude Code session IDs per agent, resumes conversations across turns so agents don't lose context.

**Sycophancy detection** — `formsContentFreePairLoop()` detects when two agents exchange 3+ content-free messages (congratulations, acknowledgments) and breaks the loop.

**Workspace domain locking** — `acquireWorkspaceDomainLock()` prevents two agents from writing to the same workspace directory simultaneously.

### Container Isolation

Each company runs in a Docker container on the shared VM:
- Filesystem isolation: only the company's `/workspace/` is mounted
- Resource limits: 2 CPU / 2GB RAM per container
- Non-root execution: agents run as `node` user
- MCP servers mounted read-only at `/mcp/{name}` (email, browser, finance, domain, social)

Container lifecycle managed by `supervisor/src/container-manager.ts` — create, start, stop, destroy, discover existing.

### Agent Blueprints

20 pre-built agent configurations in `supervisor/src/blueprints.ts`:

| Department | Agents | Model |
|-----------|--------|-------|
| Core (always activated) | CEO, CTO, CMO | sonnet |
| Engineering | Frontend Dev, Backend Dev, Fullstack Dev, DevOps, QA Tester | sonnet/haiku |
| Marketing | Reddit Marketer, Twitter Marketer, Cold Emailer, SEO Writer, Ad Buyer, Content Writer | haiku |
| Sales | Lead Researcher, Outbound Caller | haiku |
| Operations | API Keys Agent, Account Buyer, Bookkeeper, Designer | haiku |

Each blueprint specifies: system prompt, skills, workflows, MCP server requirements, relay channels, model tier, estimated credits/day.

### Inter-Agent Communication

Two mechanisms:

**1. Outbox files** (primary, current):
Agents write JSON to `/workspace/.agent/outbox/{agentId}.json` with messages for other agents. The supervisor reads these after each turn, resolves recipients (fuzzy matching on id, name, role, blueprint_id, title with alias generation), and wakes the targets.

**2. Agent Relay** (secondary, for cross-provider):
The `@agent-relay/sdk` provides push-based channels (#all-hands, #leadership, #engineering, #marketing, #status, #escalations). Primarily used for non-Anthropic agents (GPT-4o-mini via relay's codex spawner). Claude agents receive relay messages as wake events.

### CEO Org-Building

When a company is provisioned:
1. Core team created automatically (CEO, CTO, CMO)
2. CEO woken with setup prompt containing company goal + available agent pool with credit costs
3. CEO analyzes goal, selects agents, writes hiring plan to `/workspace/docs/plan.md`
4. CEO writes hire requests to `/workspace/.agent/hire-requests.json`
5. Supervisor activates requested agents from blueprints

### Credit System & Billing

**Business model:**
- Free tier: 1,000 credits (one-time), 1 company
- Paid tier: $50/month, 5,000 credits/month, up to 3 companies
- 1 credit = $0.007 internal cost, $0.01 user price, ~30% margin
- Credits shared across all companies under one account

**Billing flow:**
- Stripe Checkout for subscriptions
- Stripe Customer Portal for management
- Auto-refill: when balance drops below threshold, charges stored payment method
- Webhook handlers for: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `payment_intent.succeeded`

**Credit tracking:**
- `credit_balances` table: denormalized balance per user
- `credit_events` table: append-only ledger (grants, deductions, refills)
- `cost_events` table: per-turn cost breakdown by agent
- Supervisor reads balance from D1 before every agent wake
- Deducts after each turn based on actual token usage

### Dashboard

Next.js application on Cloudflare Workers:

- **Company page** (`/company/[id]`):
  - Agent Activity Feed — live view of what each agent is doing (running/idle/paused/error)
  - Attention Needed — pending approvals and escalation documents
  - Compact Metrics — budget bar, credit usage, cost-by-agent breakdown
  - CEO Chat — direct messaging with the CEO agent
  - Home Tab — tasks, documents, links, campaigns, products
  - Admin sections — agent config, genesis prompt, thinking state, purchases
- **Billing page** (`/billing`): subscription status, credit packs, auto-refill, credit history
- **Launch page**: company creation wizard (name, description, goal)
- **Dashboard page** (`/dashboard`): list of user's companies

### VM Infrastructure

- **Hetzner VM** at 203.0.113.10
- **Cloudflare Tunnel** via `cloudflared` routes traffic from Worker to supervisor (no public ports)
- **systemd service** (`aicombinator-supervisor`) manages the supervisor process
- **Docker** containers per company, shared `aicombinator` network
- **Directory structure**: `/srv/aicombinator/{supervisor, companies/{id}/workspace, mcp-servers, logs}`

### D1 Schema (31 Tables)

Key tables:
- `companies` — id, user_id, name, slug, state, goal, custom_domain, container_id
- `agents` — id, company_id, blueprint_id, name, role, status, model_tier, reports_to, department
- `credit_balances` — user_id, balance
- `credit_events` — append-only ledger
- `tasks` — id, company_id, title, status, owner_agent_id, blocked_on, artifact
- `approvals` — id, company_id, type, requested_by, status, payload
- `subscriptions` — user_id, stripe_subscription_id, auto_refill config
- `cron_tasks` — company_id, agent_id, schedule (cron expression), prompt
- `policies` — action, condition, enforcement (15 default policies seeded)
- `activity_log` — per-turn agent activity records

### Runtime Limits

**Per-turn:**
- Timeout: 5 minutes (CTO: 10 minutes)
- Max 10 tool calls per turn
- Max 3 inference rounds per turn (5 for CEO)
- Max 50 credits per turn (20 for specialists)

**Per-session:**
- Max 20 turns per session
- Max 30 minutes duration
- Max 200 credits per session

**Container resources:**
- 2 CPU / 2GB RAM limit per container
- 0.5 CPU / 512MB reserved

### Policy System

15 default policies enforced by the supervisor:
- 2 hard denies: `drop_table`, `rm_rf`
- 6 require approval: purchases, domains, API keys, custom agents, card topups >$50, payments >$10
- 2 require manager: port exposure, pool hiring by specialists
- 3 rate limits: email 50/hr + 200/day, account creation 5/day
- 2 audit logs: file deletion, account creation

### Project Size

~48,300 lines of TypeScript across 172 files:
- `supervisor/` — ~13,000 lines (supervisor.ts alone is ~7,000)
- `worker/` — ~9,000 lines
- `dashboard/` — ~26,000 lines

---

# Part 2: Desired Workflow

## The Target Architecture

The system described in ARCHITECTURE.md envisions an **event-driven, task-based** workflow where agents converge toward defined goals. Here is what full realization looks like:

### Company Lifecycle

```
User creates company with a goal
  → System provisions: subdomain, email, container, relay namespace, 1000 credits
  → CEO agent activates
  → CEO analyzes goal, builds org chart from blueprint pool
  → CEO decomposes goal into milestone tree (machine-readable, stored in D1)
  → Each milestone has tasks with dependencies, owners, acceptance criteria
```

### Task-Driven Scheduling

```
Supervisor runs the workflow:
  → Find tasks whose dependencies are all satisfied
  → Wake the assigned agent with focused task context (not the whole company state)
  → Agent works until task is complete (10-15 min turns)
  → Agent marks task done, submits artifact
  → Supervisor validates artifact against acceptance criteria
  → Supervisor checks: what depends on this completed task?
  → Wake next task owners with "your dependency is resolved, go"
  → Repeat until milestone is done
  → CEO reviews milestone, decomposes the next one
```

### Structured Communication

Instead of free-form chat messages, agents communicate through structured task handoffs:

```
Backend Dev completes "Design database schema"
  → Marks task done, artifact: /workspace/docs/schema.sql
  → Supervisor checks dependency graph
  → "Build REST endpoints" depends on schema → now unblocked
  → Wake Backend Dev with: "Schema is done at /workspace/docs/schema.sql. Build the endpoints."
```

### Measurable Progress

```
Progress is always quantifiable:
  → 3/12 tasks complete, 2 in progress, 7 blocked
  → Milestone 1 done, Milestone 2 at 40%
  → Estimated credits to complete: ~200
  → Time since last progress: 4 minutes (healthy) vs 45 minutes (stalled)
```

### Stall Detection

The supervisor actively monitors for stalls:
- Tasks stuck beyond their credit/time budget
- Agents producing turns with no artifact changes
- Sycophancy loops (agents congratulating each other instead of working)
- Circular dependencies in the task graph

When a stall is detected, the supervisor escalates to the CEO, and if the CEO can't resolve it, escalates to the user via the Attention Needed panel.

### Connection to Reality

Agents don't just write files — they produce real-world outcomes:
- Landing pages are deployed to `company.example.com` (subdomain routing already works)
- Emails are sent via AgentMail (MCP server)
- Websites are deployed to custom domains (Cloudflare for SaaS)
- Social media posts go live (Twitter, Reddit MCP servers)
- Analytics feed back into agent decisions

### Policy-Gated Actions

Sensitive actions require approval before execution:
- Purchases, domain registration, API key provisioning → user approval via Attention Needed
- Port exposure, specialist hiring → manager approval
- Email, account creation → rate-limited
- Destructive commands → denied

### Auto-Scaling Infrastructure

As the platform grows:
- Shared VM hosts free-tier and early paid users
- Paid subscribers ($50/month) get dedicated VMs (Hetzner API provisioning)
- Multi-VM sharding when shared VM hits capacity
- Geographic distribution for latency

### The Key Differences

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

---

# Part 3: Diagnosis

## Fundamental Workflow Problems

These are architectural issues that prevent the system from converging on goals, regardless of bug fixes.

### Problem 1: No Goal Decomposition

The CEO gets a company idea ("ghostwriting service for founders") and writes `plan.md` — a markdown document. This plan has no structure the supervisor can track, no completion criteria, no dependency ordering.

```
What the CEO produces:
  plan.md → "Step 1: Build landing page. Step 2: Set up email..."

What the system needs:
  Goal: Launch ghostwriting service
  ├── Milestone 1: Landing page live
  │   ├── Task: Write copy (CMO)              [depends on: nothing]
  │   ├── Task: Design homepage (Frontend Dev) [depends on: copy]
  │   └── Task: Deploy to domain (CTO)         [depends on: homepage]
  └── Milestone 2: First paying client
      └── Task: Cold outreach (CMO)            [depends on: landing page]
```

The system cannot answer "what percentage of the plan is done" because the plan is not machine-readable. The D1 `tasks` table exists but is **decorative** — tasks are created but not enforced, tracked, or used for scheduling.

**Impact:** The supervisor has no idea what "done" looks like. It just keeps waking agents on a timer.

### Problem 2: Turns Are Too Short and Context-Hostile

Each agent gets **3 minutes and 5 inference rounds** (3 for most agents). Building a landing page takes continuous work: reading the plan, scaffolding files, writing HTML/CSS, iterating on design.

Instead, the agent gets 3 minutes, creates maybe one file, goes to sleep. Next wake: re-reads the entire execution contract, inbox, task list, and all outbox messages (spending 30-60 seconds just on context), then gets roughly 2 minutes of actual work.

The ratio of **context loading to productive work** is approximately 40/60 on a 3-minute turn. Session resumption (Claude Code SDK `resume`) helps because the conversation persists, but the orchestration context (inbox, tasks, contract) is rebuilt from scratch every turn.

**Impact:** Agents spend most of their time re-orienting instead of building.

### Problem 3: Communication Is Chat, Not Coordination

Agents communicate by writing outbox messages: "Hey CTO, I finished the copy, can you deploy?" This is Slack, not project management.

- **No acknowledgment** — sender doesn't know if the message was read
- **No blocking** — CTO cannot declare "I am blocked on Frontend finishing the homepage"
- **No completion signal** — when CTO finishes, CEO doesn't get notified
- **No dependency graph** — "deploy" depends on "homepage done" depends on "copy written" but this is implicit in chat messages, not explicit in the system

The scheduler wakes agents on timers, not on "your dependency was just completed."

**Impact:** Agents work in isolation, unaware of each other's progress or blockers.

### Problem 4: Agents Wake on Clocks, Not on Events

The cron system wakes every agent every 3-5 minutes. This is polling.

```
What happens today:
  Frontend Dev finishes homepage → goes to sleep
  3 minutes pass → CTO wakes → reads inbox → maybe sees a message → maybe acts on it
  3 more minutes pass → CEO wakes → re-reads everything → wonders why nothing is deployed

What should happen:
  Frontend Dev finishes homepage →
    Event: "task X completed" →
    Supervisor checks: "what depends on task X?" →
    CTO needs to deploy → wake CTO with "task X is done, deploy now"
```

Clock-based waking means agents have no sense of urgency or sequencing. Everything happens at the speed of the cron interval, regardless of whether it's urgent. Dependencies that could resolve in seconds wait for the next timer tick.

**Impact:** The system moves at cron speed, not work speed.

### Problem 5: Work Output Does Not Connect to Reality

Agents write files to `/workspace`. A landing page is an `index.html` file sitting in a directory. Marketing copy is a markdown file. A "cold outreach campaign" is a plan document.

None of this is connected to the real world:
- The landing page is not deployed anywhere accessible
- The outreach emails are not actually sent
- The product is not accessible to customers
- There is no analytics, no user feedback, no revenue signal

The MCP servers exist (email, browser, domain) but the agents don't reliably use them to connect their work to reality. The workspace is a sandbox that simulates work without producing real outcomes.

**Impact:** Agents produce artifacts that look like work but have no impact. The system cannot distinguish productive work from busywork.

### Problem 6: No Progress Measurement, No Convergence

The supervisor tracks:
- Credits spent (input metric, not output)
- Turns completed (activity metric, not progress)
- Files created (volume metric, not quality)

It does not track:
- Goals achieved
- Milestones completed
- Blockers resolved
- Dependencies satisfied

Without a progress signal, the system cannot self-correct. If agents are going in circles (congratulating each other, rewriting the same plan, creating celebration messages), nothing in the architecture detects or prevents it. "Going in circles" and "making progress" are indistinguishable to the supervisor.

**Impact:** No feedback loop. The system burns credits without knowing whether it is converging or diverging.

### Problem 7: Every Agent Is an Island

Despite having roles, agents do not have a shared understanding of "the current state of the project." Each agent wakes up, reads its own inbox, reads the shared execution contract, and decides what to do independently.

Missing:
- Shared kanban board that agents mutually update
- Status sync ("CTO is currently working on deployment, do not touch those files")
- Handoff protocol ("I am done with my part, here is exactly what you need to continue")

The execution contract is written by the CEO and effectively read-only for everyone else. If the CTO discovers the architecture needs to change, it can only send a message to the CEO, who might read it 3-5 minutes later.

**Impact:** Agents work from stale or incomplete context, leading to conflicts and redundant work.

---

## Operational Issues (Bugs and Gaps)

These are concrete implementation problems discovered through production audits.

### Fixed Issues (7/10)

These were identified in earlier audits and have been resolved:

1. **Sycophancy feedback loop** — Agents exchanged endless congratulation messages. **Fixed:** `formsContentFreePairLoop()` detects 3+ content-free message pairs and breaks the loop. `isContentFreeOutboxMessage()` identifies empty congratulations. Burst limiter prevents rapid-fire messaging.

2. **Credits never deducted** — `deductAfterTurn` was called but the Worker endpoint was dead code. **Fixed:** `recordCostEvent()` now called after every deduction. Credits actually decrement.

3. **Workspace artifact failures** — ~18% of turns produced no files. **Fixed:** "FIRST REQUIREMENT" added to agent prompts requiring concrete workspace output.

4. **Broken recipient resolution** — CTO wrote "api_keys" but blueprint_id is "api-keys-agent". **Fixed:** `buildAgentRecipientRoster()` generates multiple aliases per agent (id, name, role, blueprint_id, title).

5. **Retry double-charging** — When an agent turn was retried, both the original and retry were charged. **Fixed:** `internalRetryTokenUsage` tracked separately, only the final result is charged.

6. **Founder chat silently triggers paid work** — User messages to CEO burned credits without warning. **Fixed:** "Will consume credits" logged transparently.

7. **Workspace locking** — Two agents could write to the same workspace simultaneously. **Fixed:** `acquireWorkspaceDomainLock()` provides mutex.

### Partially Fixed Issues (2/10)

8. **Cron wakes with no backoff** — Agents wake every 3-5 minutes even when idle for hours. **Partially fixed:** Some backoff logic added, but the fundamental clock-based scheduling remains (see Problem 4).

9. **CEO doesn't direct anything** — CEO was supposed to coordinate, but in practice just sends status updates. **Partially fixed:** CEO prompt improved, but structural enforcement of CEO authority over task assignment is still missing.

### Unfixed Issues (1/10)

10. **Cron pass timeout** — When a cron check takes too long, it silently drops. No retry, no logging. Still unfixed.

### New Issues Found in Latest Audit

11. **Worker 1101 errors** — Supervisor logs show HTML error pages from `api.example.com` instead of JSON responses. Cloudflare Worker exceptions cause silent sync failures between supervisor and D1.

12. **Task mirror 404s** — `Mirror queued for task:X → 404: Task not found`. Supervisor local state has tasks that don't exist in D1. State drift between supervisor cache and D1.

13. **Cache rebuilds with 0 companies** — On supervisor restart, cache sometimes rebuilds with zero companies even though companies exist in D1. Likely a timing issue with D1 API availability at startup.

14. **Agent crash loops drain credits** — When the Anthropic API key is out of credits, every agent wakes, crashes in ~3 seconds with "Claude Code process exited with code 1", gets charged 1 internal credit (the minimum), and retries. Balance drops rapidly doing zero useful work.

15. **No VM provisioning for paid users** — Database fields exist (`runtime_tier`, `dedicated_vm_status`, `dedicated_vm_id`, `dedicated_vm_ip`) but there is NO Hetzner API integration code. When a user pays $50/month, `dedicated_vm_status` is set to "pending" but nothing ever provisions a VM.

16. **No global rate limiting on wake** — `handleWakeAgent()` in the Worker has no rate limiting. A malicious or buggy client could wake agents continuously, burning credits.

### Supervisor God File

`supervisor/src/supervisor.ts` is ~7,000 lines — a single file containing agent scheduling, prompt building, outbox parsing, workspace fingerprinting, credit deduction, cron checking, relay handling, lock management, retry logic, event routing, and more. This makes the code difficult to maintain, debug, and test. It should be split into focused modules.

---

## Summary

The system's **infrastructure is solid** — the three-layer architecture (Worker + Supervisor + VM), Docker isolation, credit system, Stripe billing, Claude Code SDK integration, and dashboard are all functional. The 8 implementation phases (0-8) delivered a complete system.

The system's **workflow is broken** — agents run but don't converge. The 7 fundamental problems (no goal decomposition, short turns, chat-not-coordination, clock scheduling, no reality connection, no progress measurement, isolated agents) mean the system burns credits without reliably producing outcomes.

The path forward is not more bug fixes but **architectural evolution**: replace clock-based scheduling with task-dependency-based scheduling, replace unstructured plans with machine-readable goal trees, replace chat with structured handoffs, and connect agent output to real-world deployment. The infrastructure to support this (D1 tasks table, MCP servers, subdomain routing, Agent Relay) already exists — it just needs to be wired into the supervisor's scheduling loop.
