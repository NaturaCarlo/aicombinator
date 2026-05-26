# AI Combinator — Session Handoff & Status

**Last updated:** 2026-03-06
**Current state:** All 9 phases (0–8) complete. Ready for production deployment.

---

## What We Are Building

AI Combinator is being rebuilt from a Durable Objects architecture to a **VM + Supervisor** architecture. Full spec is in `ARCHITECTURE.md`. The key change: agents run as Claude Code SDK instances inside Docker containers on a shared VM, managed by an event-driven supervisor (zero idle credit burn). The Cloudflare Worker stays as the API layer and dashboard host.

**Business model:** Free tier (1000 credits, 1 company) + Paid ($50/month, 5000 credits, up to 3 companies). 1 credit = $0.007 internal cost, $0.01 user price, ~30% margin.

---

## Completed Phases

### Phase 0: Cleanup ✅

Removed all Durable Object and standalone runtime code from the repo.

**Deleted:**
- `src/` — standalone Node.js agent runtime (~50 files)
- `dist/` — compiled output
- `browserbase-fn/` — serverless browser function
- `packages/cli/` — CLI package
- `scripts/` — old VPS deploy scripts
- `worker/src/agent-do.ts` — 40KB Durable Object class
- `worker/src/tools.ts`, `inference.ts`, `prompts.ts` — DO-only modules

**Cleaned:**
- Root `package.json` — stripped all src-related exports, bin, dependencies
- Root `tsconfig.json` — removed src references
- `wrangler.toml` — removed DO binding, added v2 delete-class migration
- `worker/src/types.ts` — removed `AGENT` from Env interface
- `worker/src/index.ts` — removed AgentDO import/export
- `worker/src/routes/agents.ts` — replaced 4 DO stub.fetch blocks with no-op comments
- `worker/src/routes/company-status.ts` — removed DO query blocks
- `worker/src/routes/webhooks.ts` — removed DO routing, chat returns 503
- `worker/src/routes/agent-messages.ts` — removed DO wake calls, KV returns null
- `worker/src/routes/admin.ts` — removed DO config sync blocks

**Repo now contains only:**
- `dashboard/` — Next.js frontend (Cloudflare Workers, example.com)
- `worker/` — Cloudflare Worker API (api.example.com)
- `ARCHITECTURE.md` — full system spec
- `CLAUDE.md` — project instructions (includes moo sound)
- `.sounds/moo.mp3` — task completion sound

### Phase 1: D1 Schema Extension ✅

Added all database tables needed by the new architecture.

**Migration file:** `worker/migrations/004_credit_billing_tasks.sql`

**New tables (7):**

| Table | Purpose |
|-------|---------|
| `credit_balances` | Denormalized balance per user (PK: user_id) |
| `credit_events` | Append-only credit ledger (grants, deductions, refills) |
| `subscriptions` | Stripe subscription state + auto-refill config |
| `tasks` | Structured agent work items with status, artifacts, blocking |
| `policies` | Rules engine gating sensitive actions |
| `policy_counters` | Rate limit tracking per agent/action/time-window |
| `cron_tasks` | Scheduled recurring agent work (cron expressions) |

**Extended existing tables:**
- `companies` += `goal`, `custom_domain`, `container_id`
- `agents` += `blueprint_id`, `model_tier` (default 'haiku'), `total_credits_consumed`, `last_wake_at`, `last_sleep_at`, `department`
- `users` += `plan` (default 'free'), `max_companies` (default 1)

**Default policies seeded (15):**
- 2 hard denies: `drop_table`, `rm_rf`
- 6 require_approval: purchases, domains, API keys, custom agents, card topups >$50, payments >$10
- 2 require_manager: port exposure, pool hiring by specialists
- 3 rate_limit: email 50/hr + 200/day, account creation 5/day
- 2 log_only: file deletion, account creation audit

**TypeScript types updated:** `worker/src/types.ts` — added `CreditBalanceRow`, `CreditEventRow`, `SubscriptionRow`, `TaskRow`, `PolicyRow`, `PolicyCounterRow`, `CronTaskRow`, `ModelTier`, plus extended `CompanyRow`, `AgentRow`, `UserRow`.

**Applied to production D1:** database `agentmarket` (replace-with-d1-database-id), 31 tables total.

### Phase 2: Stripe Billing Integration ✅

Full Stripe billing system: subscriptions, credit purchases, auto-refill, webhooks.

**New files (4):**

| File | Purpose |
|------|---------|
| `worker/src/utils/credits.ts` | Credit ledger helpers: `grantCredits`, `deductCredits`, `getBalance`, `getCreditHistory`, `checkAutoRefill`, `CreditError` |
| `worker/src/routes/billing.ts` | 5 billing API routes (checkout, portal, status, auto-refill, buy-credits) |
| `worker/src/routes/stripe-webhooks.ts` | Stripe webhook handler with signature verification |
| `dashboard/src/app/(app)/billing/page.tsx` | Full billing dashboard page |

**Worker API routes added (6):**

| Route | Handler |
|-------|---------|
| `POST /api/billing/checkout` | Creates Stripe Checkout Session for $50/month Pro subscription |
| `POST /api/billing/portal` | Creates Stripe Customer Portal session for subscription management |
| `GET /api/billing/status` | Returns subscription info, credit balance, auto-refill config, credit history |
| `PATCH /api/billing/auto-refill` | Updates auto-refill threshold/amount/enabled |
| `POST /api/billing/buy-credits` | One-time credit purchase via Stripe Checkout (100-50,000 credits) |
| `POST /api/webhooks/stripe` | Handles 5 Stripe webhook events with HMAC-SHA256 signature verification |

**Stripe webhook events handled:**
- `checkout.session.completed` → activates subscription, grants 5,000 credits, updates user plan
- `invoice.paid` → monthly renewal, grants 5,000 credits (skips initial invoice)
- `invoice.payment_failed` → marks subscription as `past_due`
- `customer.subscription.deleted` → downgrades to free, resets max_companies to 1
- `payment_intent.succeeded` → adds purchased credits (manual buy or auto-refill)

**Credit system features:**
- Atomic ledger: every mutation creates a `credit_event` row and updates `credit_balances`
- `deductCredits` throws `CreditError` if insufficient balance
- `checkAutoRefill` creates off-session Stripe PaymentIntent when balance < threshold
- History endpoint with pagination

**Dashboard billing page (`/billing`):**
- Credit balance display with dollar value
- Subscription status card with upgrade/manage buttons
- 4 credit pack purchase options (500/1,000/2,500/5,000)
- Auto-refill toggle (paid subscribers only)
- Credit history timeline with +/- indicators

**Config updates:**
- `worker/src/types.ts` — added `STRIPE_WEBHOOK_SECRET` to Env interface
- `worker/wrangler.toml` — added `STRIPE_WEBHOOK_SECRET` to secrets list
- `dashboard/src/lib/types.ts` — added `BillingStatus`, `CreditEvent` types
- `dashboard/src/lib/api.ts` — added 5 billing API functions
- `dashboard/src/hooks/use-billing.ts` — SWR hook for billing status
- `dashboard/src/components/shared/page-shell.tsx` — added "Billing" nav item
- `worker/src/index.ts` — wired all 6 new routes

**Before deploying — manual Stripe setup needed:**
1. Set up webhook endpoint in Stripe dashboard → `https://api.example.com/api/webhooks/stripe`
2. Run: `wrangler secret put STRIPE_WEBHOOK_SECRET` (from Stripe dashboard signing secret)
3. Optionally create a Stripe Customer Portal configuration in the Stripe dashboard

**Both worker and dashboard pass `tsc --noEmit` type checking.**

### Phase 3: Supervisor Core ✅

Event-driven Node.js supervisor that manages agent lifecycles, dispatches events, enforces credits, and invokes agents via the Claude Code SDK.

**New directory:** `supervisor/` at repo root (8 source files)

| File | Purpose |
|------|---------|
| `supervisor/src/types.ts` | All supervisor types: `SupervisorConfig`, `SupervisorEvent` (8 event types), `SupervisorCache`, `AgentTurnResult`, `TurnLimits`, `ROLE_LIMITS` |
| `supervisor/src/d1-client.ts` | D1 access via Worker API — all reads/writes go through `${WORKER_API_URL}/api/supervisor/*` authenticated by `X-Supervisor-Key` header |
| `supervisor/src/cache.ts` | In-memory cache manager — fast refresh every 5s (companies, agents, credits), slow refresh every 60s (cron tasks) |
| `supervisor/src/credits.ts` | Credit enforcement — `checkCreditsBeforeWake` (direct D1 read), `calculateCredits` (per-model-tier cost), `deductAfterTurn` (caps at maxCreditsPerTurn) |
| `supervisor/src/agent-invoker.ts` | Agent invocation via Claude Code SDK `query()` — builds system prompts, enforces turn limits, tracks tool call counts, handles timeouts |
| `supervisor/src/supervisor.ts` | Core Supervisor class — event dispatcher for 8 event types, `wakeAgent()` flow (check credits → invoke → deduct → check exhaustion), cron checker with `cron-parser` |
| `supervisor/src/api.ts` | Hono HTTP API for Worker to call — auth middleware, routes for message, status, pause/resume, provision/destroy (stubs), generic event dispatch |
| `supervisor/src/index.ts` | Entry point — loads config from env vars, creates Supervisor, starts Hono server, graceful shutdown on SIGINT/SIGTERM |

**Event types handled (8):**
- `user_message` — Creator sends message to agent → wake CEO
- `email_received` — Email arrives at agent's inbox → wake target agent
- `cron_tick` — Scheduled task fires → wake assigned agent
- `relay_message` — Agent-to-agent communication → wake target
- `approval_resolved` — Creator approves/rejects → resume blocked agent
- `webhook` — External webhook → wake configured agent
- `credits_exhausted` — Balance hits 0 → pause all company agents
- `credits_purchased` — Credits added → resume paused agents

**Credit model (per-model-tier):**
- Sonnet: 0.3 credits / 1K input tokens, 1.5 credits / 1K output tokens
- Haiku: 0.025 credits / 1K input, 0.125 credits / 1K output
- Minimum 1 credit per turn, max 50 credits/turn (CEO) or 20 (specialist)

**Turn limits (defaults):**
- Timeout: 5 minutes per turn
- Max 10 tool calls per turn
- Max 3 inference rounds per turn

**Worker-side routes added (12):** All under `/api/supervisor/*`, authenticated by `X-Supervisor-Key`

| Route | Purpose |
|-------|---------|
| `GET /api/supervisor/companies` | List active companies |
| `PATCH /api/supervisor/companies/:id` | Update company state |
| `GET /api/supervisor/companies/:id/agents` | List agents for company |
| `POST /api/supervisor/companies/:id/activity` | Log activity entry |
| `PATCH /api/supervisor/agents/:id` | Update agent status |
| `POST /api/supervisor/agents/:id/wake` | Record agent wake |
| `POST /api/supervisor/agents/:id/sleep` | Record agent sleep |
| `GET /api/supervisor/credits` | List all credit balances |
| `GET /api/supervisor/credits/:userId` | Get single balance |
| `POST /api/supervisor/credits/:userId/deduct` | Deduct credits after turn |
| `GET /api/supervisor/cron-tasks` | List enabled cron tasks |
| `PATCH /api/supervisor/cron-tasks/:id` | Update last run time |

**Worker routes updated:**
- `handleChatWithCeo` now proxies to supervisor at `${SUPERVISOR_URL}/companies/:id/agents/:agentId/message` instead of returning 503

**Config updates:**
- `worker/src/types.ts` — added `SUPERVISOR_API_KEY`, `SUPERVISOR_URL` to Env
- `worker/wrangler.toml` — added both to secrets list
- `supervisor/package.json` — dependencies: `@anthropic-ai/claude-code`, `hono`, `@hono/node-server`, `cron-parser`

**Both worker and supervisor pass `tsc --noEmit` type checking.**

### Phase 4: Container Isolation ✅

Docker containers per company on the shared VM, with resource limits, workspace volumes, and MCP server mounts.

**New files (3):**

| File | Purpose |
|------|---------|
| `supervisor/container/Dockerfile` | Agent container image — Node.js 22, Claude Code CLI, non-root `node` user, `/workspace/` mount point |
| `supervisor/src/compose-template.ts` | Docker Compose YAML generator — per-company config with resource limits, workspace volumes, MCP server mounts, network isolation |
| `supervisor/src/container-manager.ts` | Full Docker lifecycle — `create`, `start`, `stop`, `destroy`, `discoverExisting`, `execInContainer`, `listAll` |

**Container specs:**
- 2 CPU limit / 0.5 CPU reserved per container
- 2GB RAM limit / 512MB reserved per container
- Shared Docker network (`aicombinator`) for isolation
- `security_opt: no-new-privileges` enabled
- `/tmp` mounted as tmpfs (256MB)

**Per-company workspace structure:**
```
/srv/aicombinator/companies/{companyId}/
├── docker-compose.yml          (auto-generated)
├── workspace/
│   ├── .agent/                 (agent state, sessions)
│   ├── src/                    (code)
│   ├── docs/                   (documents, plans)
│   └── assets/                 (images, videos)
```

**MCP server mounts (5):** email, browser, finance, domain, social — all mounted read-only at `/mcp/{name}` inside containers.

**Supervisor integration:**
- `Supervisor.provisionCompany(id, name, env)` — creates workspace, generates compose file, builds & starts container, updates D1 state
- `Supervisor.destroyCompany(id, removeData)` — pauses agents, removes container, optionally cleans workspace
- `Supervisor.start()` now calls `containers.discoverExisting()` to pick up containers from previous runs
- `wakeAgent()` uses container workspace path when container is running

**API endpoints updated:**
- `POST /companies/:id/provision` — now creates real Docker container (was stub)
- `POST /companies/:id/destroy` — now tears down container (was stub)
- `GET /companies/:id/container` — new: returns container info
- `GET /containers` — new: lists all tracked containers

**Config (env vars):**
- `COMPANIES_DIR` — host path for company data (default: `/srv/aicombinator/companies`)
- `MCP_SERVERS_DIR` — host path for MCP servers (default: `/srv/aicombinator/mcp-servers`)
- `DOCKER_NETWORK` — Docker network name (default: `aicombinator`)
- `CONTAINER_CPU_LIMIT`, `CONTAINER_MEMORY_LIMIT`, `CONTAINER_CPU_RESERVATION`, `CONTAINER_MEMORY_RESERVATION` — resource overrides

**Types added:** `ContainerConfig`, `ContainerResources`, `ContainerInfo`, `McpServerName`, `DEFAULT_CONTAINER_RESOURCES`, `MCP_SERVERS`

**Both worker and supervisor pass `tsc --noEmit` type checking.**

### Phase 5: Agent Execution ✅

Agent blueprints, CEO org-building, session persistence, and full agent lifecycle management.

**New files (2):**

| File | Purpose |
|------|---------|
| `supervisor/src/blueprints.ts` | Blueprint registry — 20 pre-built agent configs (3 core + 17 specialists) with system prompts, MCP servers, model tiers, workflows |
| `supervisor/src/org-builder.ts` | CEO org-building logic — core team creation, CEO setup prompt, hiring authority, activation helpers |

**Blueprint registry (20 agents):**

| Department | Agents | Model |
|-----------|--------|-------|
| Core (always activated) | CEO, CTO, CMO | sonnet |
| Engineering | Frontend Dev, Backend Dev, Fullstack Dev, DevOps, QA Tester | sonnet/haiku |
| Marketing | Reddit Marketer, Twitter Marketer, Cold Emailer, SEO Writer, Ad Buyer, Content Writer | haiku |
| Sales | Lead Researcher, Outbound Caller | haiku |
| Operations | API Keys Agent, Account Buyer, Bookkeeper, Designer | haiku |

Each blueprint includes: full system prompt, skills, workflows, MCP server requirements, relay channels, estimated credits/day, and tested flag.

**CEO org-building flow:**
1. On provisioning: core team (CEO, CTO, CMO) auto-created
2. CEO woken with setup prompt containing company goal + available agent pool with credit costs
3. CEO analyzes goal, selects agents, writes hiring plan to `/workspace/docs/plan.md`
4. CEO writes hire requests to `/workspace/.agent/hire-requests.json`
5. Supervisor activates requested agents

**Hiring authority:**
- CEO: Can hire anyone from pool
- CTO: Can hire engineering specialists without CEO approval
- CMO: Can hire marketing specialists without CEO approval
- Specialists: Can only request hires upward

**Agent invoker enhancements:**
- **Session persistence**: Captures `session_id` from Claude Code SDK, resumes previous conversations via `resume` option
- **Blueprint-aware system prompts**: Uses full blueprint prompt with workflows, agent identity, and rules
- **Session limits enforcement**: Max 20 turns, 30 min duration, 200 credits per session — auto-resets when exceeded
- **Session credit tracking**: Records per-session credit spend

**Supervisor additions:**
- `activateAgent(companyId, blueprintId)` — creates agent from blueprint
- `activateAgents(companyId, blueprintIds[])` — batch activation
- `deactivateAgent(companyId, agentId)` — terminates and resets session
- `provisionCompany()` now creates core team and wakes CEO with org-building prompt
- `wakeAgent()` now records session credits after deduction

**API endpoints added:**
- `POST /companies/:id/agents/activate` — activate agent(s) by blueprint ID
- `POST /companies/:id/agents/:agentId/deactivate` — terminate agent
- `GET /blueprints` — list all available blueprints (summary view)
- `GET /blueprints/:id` — get full blueprint details

**Worker routes added (2):**
- `POST /api/supervisor/companies/:id/agents` — create agent from activation request
- `GET /api/supervisor/companies/:id/info` — get company details (for org-builder)

**Types added:** `AgentBlueprint`, `AgentProvider`, `AgentDepartment`, `Workflow`, `SessionLimits`, `DEFAULT_SESSION_LIMITS`

**Non-Anthropic agents:** GPT-4o-mini via Agent Relay deferred to Phase 6 (placeholder in invoker).

**Both worker and supervisor pass `tsc --noEmit` type checking.**

### Phase 6: Agent Relay Integration ✅

Agent Relay SDK integration for inter-agent communication and cross-provider support.

**New files (2):**

| File | Purpose |
|------|---------|
| `supervisor/src/relay-manager.ts` | Agent Relay SDK integration — per-company relay instances, channel management, agent spawning, messaging |
| `supervisor/src/types/agent-relay-sdk.d.ts` | TypeScript type declarations for `@agent-relay/sdk` |

**Per-company relay namespace with 6 default channels:**
- `#all-hands` — Company-wide announcements (CEO broadcasts)
- `#leadership` — CEO + CTO + CMO strategic discussions
- `#engineering` — CTO + devs technical discussions
- `#marketing` — CMO + marketing specialists
- `#status` — Automated status updates from all agents
- `#escalations` — Items needing CEO or user attention

**Relay Manager features:**
- `initCompany(companyId)` — creates AgentRelay instance, wires message handler
- `spawnAgent(companyId, agent, blueprint, task)` — spawns non-Anthropic agents via relay (Codex/GPT)
- `sendMessage(companyId, from, to, text, channel?)` — direct agent-to-agent message
- `broadcastToChannel(companyId, from, channel, text)` — broadcast to all agents on a channel
- `destroyCompany(companyId)` — tears down relay instance
- `shutdown()` — graceful shutdown of all relay instances

**Cross-provider support:**
- Claude agents: invoked via Claude Code SDK (unchanged), receive relay messages as wake events
- Codex/GPT agents: spawned via `relay.codex.spawn()`, communicate natively via relay channels
- Token estimation for relay-spawned agents (prompt length / 4 for input, 500 for output)

**Message flow (relay → supervisor → agent wake):**
1. Relay SDK receives message via `onMessageReceived` callback
2. Relay manager resolves target agent by name → agent ID
3. If target is a Claude agent: wakes it with relay message as prompt
4. If target is a relay-spawned agent: relay handles delivery natively

**Agent invoker changes:**
- `invokeNonAnthropic()` now spawns agents via relay if not already running
- Sends prompt as relay message to the agent
- Returns estimated token usage for credit tracking
- `setRelayManager()` method for dependency injection

**Supervisor integration:**
- Relay manager initialized in constructor, message handler wired to event loop
- `provisionCompany()` now initializes relay namespace after container creation
- `destroyCompany()` tears down relay before destroying container
- `stop()` shuts down all relay instances
- New public methods: `sendRelayMessage()`, `broadcastToChannel()`, `getCompanyChannels()`, `getRelayStatus()`, `getRelayManager()`

**API endpoints added (4):**
- `GET /companies/:id/channels` — list relay channels for company
- `POST /companies/:id/relay/send` — send direct message (from, to, text, channel?)
- `POST /companies/:id/relay/broadcast` — broadcast to channel (from, channel, text)
- `GET /relay/status` — relay system status (enabled, active companies, spawned agents)

**Config:**
- `RELAY_ENABLED` — env var to disable relay (default: enabled)
- `@agent-relay/sdk` added to supervisor dependencies

**Types added:** `RelayConfig`, `CompanyChannel`, `DEFAULT_COMPANY_CHANNELS`, `RelayMessage`, `RelayAgentHandle`

**Both worker and supervisor pass `tsc --noEmit` type checking.**

**Dependencies:** Phase 5 ✅ (agents must be running).

### Phase 7: Dashboard Updates ✅

Dashboard updated to reflect the new architecture — real-time status, credit burn rate, task system, and credit-based company creation.

**New dashboard files (5):**

| File | Purpose |
|------|---------|
| `dashboard/src/hooks/use-tasks.ts` | SWR hook for task data (10s refresh) |
| `dashboard/src/hooks/use-burn-rate.ts` | SWR hook for burn rate metrics (30s refresh) |
| `dashboard/src/hooks/use-realtime-status.ts` | SSE hook with auto-reconnect and exponential backoff (1s → 30s) |
| `dashboard/src/components/company/burn-rate-card.tsx` | Credit burn rate display with color-coded urgency (green >7d, amber 3-7d, red <3d) |
| `dashboard/src/components/company/task-board.tsx` | Kanban task board — 4 columns (todo, in_progress, blocked, done), add task, status transitions |

**Updated dashboard files (4):**

| File | Change |
|------|--------|
| `dashboard/src/lib/types.ts` | Added `Task`, `TaskStatus`, `BlueprintSummary`, `BurnRateMetrics`, `RealtimeEvent`, `RealtimeEventType`. Added `"sleeping"` to `AgentStatus`, added Phase 5+ fields to `Agent` |
| `dashboard/src/lib/api.ts` | Added `listTasks()`, `createTask()`, `updateTask()`, `listBlueprints()`, `getBurnRate()`, `connectStatusStream()` |
| `dashboard/src/components/launch-form.tsx` | Rewritten from USDC wallet payment to credit-based system. 2-step flow: idea → confirm with credit balance display and low-credit warning |
| `dashboard/src/components/company/agent-activity-feed.tsx` + `team-panel.tsx` | Added `sleeping` status to color maps |

**New worker files (1):**

| File | Purpose |
|------|---------|
| `worker/src/routes/realtime.ts` | 6 route handlers for real-time data: burn rate, SSE status stream, blueprints proxy, task CRUD |

**Worker API routes added (6):**

| Route | Handler |
|-------|---------|
| `GET /api/companies/:id/burn-rate` | Credit burn rate from D1 credit_events (last 24h) |
| `GET /api/companies/:id/status/stream` | SSE endpoint — polls supervisor + agent statuses, emits as events |
| `GET /api/blueprints` | Proxies to supervisor blueprint list |
| `GET /api/companies/:id/tasks` | List tasks with status/agent_id filters |
| `POST /api/companies/:id/tasks` | Create task (title, description, owner_agent_id, parent_task_id) |
| `PATCH /api/tasks/:id` | Update task fields (title, description, status, owner_agent_id, blocked_reason) |

**Key features:**
- **SSE on Cloudflare Workers**: Emits batch of current state and closes; client EventSource auto-reconnects via retry
- **Burn rate calculation**: Sums credit deductions over last 24h, derives credits/hour, credits/day, days remaining
- **Task board**: Kanban columns with inline status transitions (todo → in_progress → done), blocked reason display, agent assignee badges
- **Launch form rewrite**: Credit-based — shows balance, what-happens-next cards (core team, CEO analysis, work begins), low-credit warning

**Dependencies:** Phase 6 ✅ (supervisor + relay provide live data).

**Both worker and dashboard pass `tsc --noEmit` type checking.**

### Phase 8: VM Provisioning & Deployment ✅

Production deployment infrastructure — VM setup, Cloudflare Tunnel, systemd service, Docker production config, and deploy scripts.

**New directory:** `deploy/` at repo root (6 files)

| File | Purpose |
|------|---------|
| `deploy/setup-vm.sh` | VM provisioning script — installs Docker, Node.js 22, cloudflared, creates service user, directory structure, Docker network, firewall |
| `deploy/Dockerfile.supervisor` | Production Docker image for supervisor — includes Docker CLI for managing agent containers via socket mount |
| `deploy/docker-compose.prod.yml` | Production compose — supervisor + Cloudflare Tunnel sidecar, health checks, resource limits, logging |
| `deploy/cloudflared-config.yml` | Cloudflare Tunnel config — routes `supervisor.example.com` to `localhost:8787` |
| `deploy/aicombinator-supervisor.service` | systemd unit — auto-restart, security hardening, journald logging |
| `deploy/deploy.sh` | Deploy/update script — remote (via SSH+rsync) or local (on VM) modes |

**New supervisor file:**

| File | Purpose |
|------|---------|
| `supervisor/.env.example` | Environment variable template with all required/optional vars |

**VM setup script (`setup-vm.sh`) provisions:**
1. Docker Engine + Docker Compose plugin
2. Node.js 22 via NodeSource
3. cloudflared (Cloudflare Tunnel daemon)
4. Service user `aicombinator` with Docker group access
5. Directory structure: `/srv/aicombinator/{supervisor,companies,mcp-servers/{email,browser,finance,domain,social},logs}`
6. Docker bridge network `aicombinator`
7. Agent container base image `aic-agent:latest`
8. UFW firewall (SSH-only inbound — Tunnel handles all other access)
9. Utilities: htop, jq, logrotate, fail2ban

**Two deployment modes:**

| Mode | Command | How it works |
|------|---------|-------------|
| Docker Compose | `docker compose -f docker-compose.prod.yml up -d` | Supervisor in container + Tunnel sidecar, Docker socket mounted |
| Systemd (native) | `systemctl start aicombinator-supervisor` | Node.js runs directly, security-hardened unit file |

**Cloudflare Tunnel integration:**
- Worker sets `SUPERVISOR_URL=https://supervisor.example.com`
- Tunnel routes to `localhost:8787` — no ports exposed to public internet
- Tunnel token passed as env var in compose, or via `cloudflared service install` for systemd

**Health endpoint enhanced:**
- `GET /health` — now returns uptime, memory usage (RSS/heap), active container count, relay status, version
- Accessible without auth (placed before auth middleware) for Docker healthchecks and monitoring

**Deploy script (`deploy.sh`) supports:**
- `./deploy.sh` — remote deploy via SSH (builds locally, rsync to VM, restarts)
- `./deploy.sh --local` — on-VM deploy (git pull, npm ci, build, restart)
- `./deploy.sh --build-only` — build without restart
- Post-deploy health check with status output

**Supervisor Dockerfile features:**
- Docker CLI inside container (controls host Docker via socket mount)
- Multi-stage friendly (copies only `dist/`, `package.json`, `container/`)
- `HEALTHCHECK` instruction for Docker health monitoring
- `npm ci --omit=dev` for minimal production image

**Production compose resources:**
- Supervisor: 4 CPU / 4GB limit, 1 CPU / 1GB reserved
- JSON logging with 50MB rotation (5 files)
- Tunnel depends on supervisor health check passing

**All three projects (supervisor, worker, dashboard) pass `tsc --noEmit` type checking.**

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `ARCHITECTURE.md` | Complete system spec (19 sections, ~1500 lines) |
| `CLAUDE.md` | Project instructions, moo sound, design language |
| `worker/wrangler.toml` | Worker config (DO deleted via v2 migration) |
| `worker/src/types.ts` | All TypeScript types for D1 tables |
| `worker/src/index.ts` | Worker entry point and route matching |
| `worker/src/routes/` | All API route handlers |
| `worker/src/routes/billing.ts` | Billing API routes (checkout, portal, status, auto-refill, buy-credits) |
| `worker/src/routes/stripe-webhooks.ts` | Stripe webhook handler (5 event types) |
| `worker/src/utils/credits.ts` | Credit ledger helpers (grant, deduct, balance, auto-refill) |
| `worker/migrations/004_credit_billing_tasks.sql` | Phase 1 migration |
| `dashboard/src/app/(app)/company/[id]/page.tsx` | Main company dashboard page |
| `dashboard/src/app/(app)/billing/page.tsx` | Billing settings page |
| `supervisor/src/supervisor.ts` | Core Supervisor class — event dispatch, agent lifecycle, cron checker |
| `supervisor/src/agent-invoker.ts` | Agent invocation via Claude Code SDK `query()` |
| `supervisor/src/d1-client.ts` | D1 access via Worker HTTP API |
| `supervisor/src/api.ts` | Hono HTTP API (Worker → Supervisor) |
| `supervisor/src/credits.ts` | Credit enforcement (check/calculate/deduct) |
| `supervisor/src/container-manager.ts` | Docker container lifecycle (create/start/stop/destroy) |
| `supervisor/src/compose-template.ts` | Docker Compose YAML generator per company |
| `supervisor/container/Dockerfile` | Agent container image (Node.js 22 + Claude Code CLI) |
| `worker/src/routes/supervisor.ts` | Worker-side supervisor D1 routes (14 endpoints) |
| `supervisor/src/blueprints.ts` | Blueprint registry — 20 agent configs with system prompts |
| `supervisor/src/org-builder.ts` | CEO org-building logic and hiring authority |
| `supervisor/src/relay-manager.ts` | Agent Relay SDK integration (channels, spawn, messaging) |
| `worker/src/routes/realtime.ts` | Burn rate, SSE stream, blueprints, task CRUD routes |
| `dashboard/src/components/launch-form.tsx` | Credit-based company creation wizard |
| `dashboard/src/components/company/task-board.tsx` | Kanban task board (4 columns) |
| `dashboard/src/components/company/burn-rate-card.tsx` | Credit burn rate display |
| `dashboard/src/hooks/use-realtime-status.ts` | SSE hook with auto-reconnect |
| `dashboard/src/hooks/use-tasks.ts` | SWR task data hook |
| `dashboard/src/hooks/use-burn-rate.ts` | SWR burn rate hook |
| `dashboard/wrangler.jsonc` | Dashboard worker config |
| `deploy/setup-vm.sh` | VM provisioning script (Docker, Node, firewall) |
| `deploy/Dockerfile.supervisor` | Supervisor production Docker image |
| `deploy/docker-compose.prod.yml` | Production compose (supervisor + Tunnel) |
| `deploy/cloudflared-config.yml` | Cloudflare Tunnel routing config |
| `deploy/aicombinator-supervisor.service` | systemd service unit |
| `deploy/deploy.sh` | Deploy/update script (remote or local) |
| `supervisor/.env.example` | Environment variable template |
| `.sounds/moo.mp3` | Task completion sound |

## Technical Context

- **Worker:** Cloudflare Workers, wrangler 3.x, TypeScript, D1 SQLite
- **Dashboard:** Next.js 16, React, Tailwind, deployed via OpenNext on Cloudflare Workers
- **Auth:** Clerk (JWT verification in worker middleware)
- **Payments:** Stripe (secret key already in wrangler secrets, webhook handler exists for Clerk)
- **Design:** Light theme, orange `#FF6600` accents, Outfit font, `card-clean` cards
- **Domain:** example.com (dashboard), api.example.com (worker API)
- **D1 database:** `agentmarket` (replace-with-d1-database-id), 31 tables

## Important Notes

- Play `afplay /Users/CEF/Projects/automaton/.sounds/moo.mp3` on task completion (see CLAUDE.md)
- Worker routes that previously called DOs now route through the supervisor or have stub comments
- The `webhooks.ts` chat endpoint now proxies to the supervisor
- Existing dashboard components (AgentActivityFeed, AttentionNeeded, CompactMetrics, TeamPanel, CeoChatPanel) are all functional
- The `provisionAgentDO` function in `routes/agents.ts` is stubbed — only creates a runtime_state row
