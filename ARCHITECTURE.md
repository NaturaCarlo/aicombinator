# AI Combinator — Architecture & Product Specification

## 1. What We Are Building

AI Combinator is a platform where users create autonomous AI companies. Each company is staffed by a team of AI agents (CEO, CTO, CMO, and specialists) that operate autonomously — writing code, sending emails, browsing the web, running marketing campaigns, deploying websites, and managing finances. The user acts as the "board of directors": they set the vision, approve key decisions, and fund the company. The agents do everything else.

The key differentiator from competitors (e.g., Polsia) is that we expose the **full agent team**, not just a single CEO agent. Users see every agent's activity, can message any agent, and observe the entire organization working in real time. The agents coordinate with each other through a message relay, hire new specialists when needed, and escalate to the user only when they need approval or input.

The goal is that a user never needs to leave our interface. Domain registration, email setup, hosting, social media accounts, API key procurement — the agents handle all of it.

---

## 2. Business Model

### Pricing

| Tier | Price | Credits | Companies | Infrastructure |
|------|-------|---------|-----------|----------------|
| Free | $0 | 1,000 (one-time) | 1 | Shared VM, subdomain, email |
| Paid | $50/month | 5,000/month | Up to 3 | Shared VM, subdomain, email, custom domain |

### Credit System

- **1 credit = $0.007 USD internal compute cost**
- **User price: $0.01/credit** (embedded in the $50/month for 5,000 credits, same rate for additional purchases)
- **Margin: ~30% on compute + $15/month for infrastructure**
- Credits are **shared across all companies** under one account
- A user with 3 companies spreads 5,000 credits across all three — if they need more, auto-refill charges their card

### Credit Consumption by Model

| Model | Avg Turn Cost | Credits/Turn |
|-------|--------------|-------------|
| Claude Sonnet 4 | ~$0.06 | ~8-9 credits |
| Claude Haiku 3.5 | ~$0.016 | ~2-3 credits |
| GPT-4o-mini | ~$0.003 | ~0.5 credits |

A "turn" is one inference call: system prompt + conversation history in, reasoning + tool calls out. One turn can include multiple tool calls (up to 10) and multiple inference rounds (up to 5), so a single turn can accomplish significant work.

### Credit Allocation Strategy

- **CEO**: Claude Sonnet (best reasoning, strategic decisions, ~8-9 credits/turn)
- **CTO**: Claude Sonnet via Claude Code (best at code, ~8-9 credits/turn)
- **CMO, specialists**: Claude Haiku or GPT-4o-mini (~0.5-3 credits/turn)

With this mix, 5,000 monthly credits supports approximately:
- ~8 CEO turns/day (Sonnet)
- ~15-20 turns/day per specialist agent (Haiku)
- Enough for a company that works actively during business hours and sleeps at night

### Auto-Refill

- User connects a card via Stripe at subscription time
- User configures: "Buy X credits when balance drops below Y"
- Defaults: buy 5,000 credits ($50) when below 1,000
- User can adjust both threshold and refill amount
- Additional credits charged at $0.01/credit (same rate as subscription)

### Why This Pricing

- **$50/month is comparable to Polsia ($49/month)**, which validates market willingness to pay
- **Credits instead of flat fee** means heavy users pay more, light users aren't overpaying
- **Shared credits across companies** encourages experimentation (try 3 companies) while naturally upselling (3 companies burn credits 3x faster)
- **Free tier with 1,000 credits** gives 2-3 days of active work — enough to see agents build something real, not enough to finish. Natural conversion moment.
- **30% margin on compute** covers Stripe fees (~3%), infrastructure, and profit
- **No revenue share** (unlike Polsia's 20%) — simpler, more predictable for users

### Limitations

- Free tier: 1 company, no custom domain, no auto-refill
- Paid tier: up to 3 companies, custom domain, auto-refill
- Credits don't roll over month to month (included credits reset; purchased credits persist)

---

## 3. User Flow

### Signup → Free Tier

```
1. User signs up (Clerk auth — email, Google, GitHub)
2. User clicks "Create Company"
3. User provides: company name, one-line description, goal
4. System provisions:
   a. Subdomain: newcompany.aicombinator.live
   b. Email: info@newcompany.aicombinator.live
   c. Container on shared VM (isolated workspace)
   d. 1,000 free credits
5. CEO agent activates, reads the goal
6. CEO builds initial org chart:
   - Analyzes the goal
   - Selects agents from the pool (e.g., SaaS → CTO + Frontend Dev + Backend Dev)
   - Activates selected agents
   - Assigns initial tasks
7. User watches agents work in real time via dashboard
8. Agents burn through credits over 2-3 days
9. Credits hit 0 → agents pause → "Attention Needed: Subscribe to continue"
```

### Conversion → Paid Tier

```
10. User clicks subscribe → Stripe Checkout ($50/month)
11. Card connected, 5,000 credits added
12. Agents resume automatically
13. Auto-refill configured (defaults: 5,000 credits when below 1,000)
14. User offered custom domain setup:
    a. User provides domain (e.g., aicompany.com)
    b. User buys domain through us (Cloudflare Registrar) OR points existing domain
    c. CEO configures DNS, SSL, deploys website to custom domain
    d. Email moved to custom domain (info@aicompany.com)
15. User can now create up to 2 more companies (sharing the same credit pool)
```

### Ongoing Usage

```
- User checks dashboard: sees agent activity, credit burn, tasks, documents
- "Attention Needed" panel shows approvals and escalations
- User chats with CEO for high-level direction
- User can message any agent directly
- Auto-refill keeps credits topped up
- Monthly subscription renews, 5,000 fresh credits added
```

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLOUDFLARE WORKER                           │
│                  (API layer, dashboard)                          │
│                                                                  │
│  • Next.js dashboard (SSR on Workers)                           │
│  • REST API for dashboard ↔ agents                              │
│  • Clerk auth middleware                                        │
│  • D1 database (companies, agents, issues, messages, costs)     │
│  • Stripe webhook handler                                       │
│  • Subdomain routing (wildcard DNS)                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │ API calls
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SHARED VM                                   │
│              (agent execution environment)                       │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ SUPERVISOR (Node.js, no LLM, zero credit cost)            │ │
│  │                                                            │ │
│  │ • Event listener: user messages, emails, cron, webhooks   │ │
│  │ • Agent lifecycle: wake, sleep, pause, kill               │ │
│  │ • Credit tracking: deduct per turn, enforce limits        │ │
│  │ • Container management: start/stop agent containers       │ │
│  │ • Agent Relay client: routes inter-agent messages         │ │
│  │ • Reports status back to Worker API                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │ Container:   │ │ Container:   │ │ Container:   │            │
│  │ Company A    │ │ Company B    │ │ Company C    │            │
│  │              │ │              │ │              │            │
│  │ ┌──────────┐ │ │ ┌──────────┐ │ │              │            │
│  │ │ CEO      │ │ │ │ CEO      │ │ │  (empty,     │            │
│  │ │ CTO      │ │ │ │ CMO      │ │ │   not yet    │            │
│  │ │ CMO      │ │ │ │ Designer │ │ │   created)   │            │
│  │ │ Dev x2   │ │ │ └──────────┘ │ │              │            │
│  │ └──────────┘ │ │              │ │              │            │
│  │              │ │              │ │              │            │
│  │ /workspace/  │ │ /workspace/  │ │              │            │
│  │ (shared fs)  │ │ (shared fs)  │ │              │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ MCP SERVERS (shared, mounted into containers)              │ │
│  │                                                            │ │
│  │ • email-server (AgentMail — send/receive real email)       │ │
│  │ • browser-server (persistent Chromium sessions)            │ │
│  │ • finance-server (virtual card, USDC wallet, payments)     │ │
│  │ • domain-server (Cloudflare API — DNS, SSL, registrar)     │ │
│  │ • social-server (Twitter/X, Reddit, LinkedIn APIs)         │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

                           │ Real-time messaging
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      AGENT RELAY                                 │
│            (inter-agent communication bus)                        │
│                                                                  │
│  • Channels: #leadership, #engineering, #marketing, #all-hands  │
│  • Cross-provider: Claude agents ↔ OpenAI agents                │
│  • Push-based: no polling, instant delivery                      │
│  • Read receipts, reactions, message threading                   │
│  • SDK: @agent-relay/sdk (TypeScript + Python)                   │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Architecture

**Why Cloudflare Worker for the API layer (not the agent execution)?**
Workers are ideal for request/response workloads: serving the dashboard, handling API calls, processing Stripe webhooks, routing subdomains. They scale automatically, have zero cold start, and cost nothing when idle. But they're wrong for agent execution because agents need persistent state, long-running processes, and filesystem access — things Workers/Durable Objects can't provide.

**Why a shared VM instead of per-company VMs?**
At the current stage (early, few users), a shared VM keeps infrastructure costs predictable and low. Multiple companies run in isolated containers on the same VM. A single $30-50/month VM can host 10-20 companies with container isolation. The alternative (per-company VM) costs $5-15/month per company — fine for paid users, unaffordable for free tier at scale. The shared VM approach means free users cost us nearly nothing beyond the VM we're already running. As we grow, we can shard: multiple shared VMs, each hosting a batch of companies.

**Why containers for isolation (not just processes)?**
Companies must be isolated from each other. Container isolation (Docker or Apple Container, following the NanoClaw pattern) provides:
- Filesystem isolation: Company A cannot see Company B's files
- Process isolation: A runaway process in Company A doesn't affect Company B
- Resource limits: CPU/memory caps per container prevent one company from starving others
- Security: Agents run as non-root users inside containers

**Why Agent Relay instead of custom message passing?**
We previously built custom inter-agent messaging using a D1 database table (agent_messages) with polling. This had problems:
- Polling burns credits (each "check for messages" call was an inference turn)
- Latency: messages weren't delivered until the next poll cycle (30-120 seconds)
- No cross-provider support: couldn't mix Claude and OpenAI agents

Agent Relay solves all three: push-based delivery (instant, no polling cost), channel-based communication (natural for org structures), and cross-provider support (Claude and OpenAI agents on the same relay). It's also maintained by someone else, which means less infrastructure for us to build.

**Why Claude Code SDK as the agentic loop?**
Our custom ReAct loop (src/agent/loop.ts) had significant limitations:
- 20-turn context window with no summarization (agents lost context)
- Manual tool definitions and execution (error-prone)
- Basic error handling (no automatic retries or recovery)
- No multi-file code editing capabilities

Claude Code's agentic loop provides:
- Automatic context management with summarization when the window fills
- Built-in file operations, bash execution, and web search
- Multi-step reasoning with tool chaining
- Superior code generation and editing (it was purpose-built for this)
- Active development by Anthropic (continuous improvements)

The tradeoff is vendor lock-in (Anthropic-only for Claude Code agents). We mitigate this by supporting non-Claude agents via Agent Relay for tasks where model diversity matters.

**Why event-driven supervisor instead of polling?**
The previous architecture had agents polling every 30-120 seconds ("is there work?"), each poll being an LLM inference call that burned credits. With 5 agents polling every 60 seconds, that's 5 credits/minute = 300 credits/hour = 7,200 credits/day — more than the entire monthly allotment, doing nothing.

The event-driven supervisor inverts this: a lightweight process (no LLM, zero credits) watches for events and only wakes agents when there's actual work. If nothing happens for 8 hours, zero credits are burned. Credits only flow when agents think and act.

---

## 5. Agent Framework

### 5.1 Agent Execution

Each agent runs as a Claude Code SDK instance (or OpenAI Codex instance for non-Anthropic agents) inside the company's container. The supervisor manages their lifecycle.

```
Agent Lifecycle:
  sleeping → [event occurs] → waking → running → [work done] → sleeping
                                           ↓
                                    [credits exhausted] → paused
                                           ↓
                                    [user subscribes] → sleeping (ready for next event)
```

**When an agent wakes:**
1. Supervisor receives an event (user message, email, cron, relay message)
2. Supervisor checks credit balance — if zero, reject wake, notify user
3. Supervisor invokes the agent with the event as the prompt
4. Agent runs: reasons, uses tools (bash, files, browser, email), produces output
5. Supervisor records credit cost (based on token usage)
6. Agent returns to sleeping state

**Agent invocation via Claude Code SDK:**
```typescript
import Anthropic from "@anthropic-ai/sdk";

// Each agent has a persistent conversation history on disk
const agent = await invokeClaudeCode({
  systemPrompt: agentBlueprint.systemPrompt,
  prompt: `New message from CEO: "Build the landing page"`,
  cwd: "/workspace",
  mcpServers: agentBlueprint.mcpServers,
  model: agentBlueprint.modelTier, // "sonnet" or "haiku"
  sessionId: agent.sessionId, // resumes previous conversation
});
```

**For non-Anthropic agents (e.g., marketing specialists on GPT-4o-mini):**
```typescript
// Via Agent Relay's codex spawner
const agent = await relay.codex.spawn({
  name: "RedditMarketer",
  model: Models.Codex.GPT_4O_MINI,
  channels: ["marketing"],
  task: redditMarketerPrompt,
});
```

### 5.2 Agent Pool (Blueprints)

The agent pool is a registry of pre-built, tested agent configurations. Each blueprint specifies everything needed to activate an agent:

```typescript
interface AgentBlueprint {
  // Identity
  id: string;                    // "reddit-marketer"
  name: string;                  // "Reddit Marketer"
  role: string;                  // "Specialist"
  department: string;            // "marketing"
  reportsTo: string;             // "cmo"

  // Behavior
  systemPrompt: string;          // Detailed instructions, personality, knowledge
  skills: string[];              // Pre-loaded skills/knowledge modules
  workflows: Workflow[];         // Step-by-step procedures the agent knows

  // Infrastructure
  requiredTools: string[];       // ["browser", "reddit-api", "proxy-service"]
  requiredApiKeys: string[];     // ["reddit_client_id", "proxy_api_key"]
  mcpServers: string[];          // MCP servers to mount
  relayChannels: string[];       // ["marketing", "content"]

  // Cost
  provider: "claude" | "codex";  // Which LLM provider
  modelTier: string;             // "sonnet", "haiku", "gpt4o-mini"
  estimatedCreditsPerDay: number;// Budget planning hint

  // Metadata
  tested: boolean;               // Has this blueprint been validated?
  version: string;               // Semver for blueprint updates
  description: string;           // What this agent does
}
```

**Initial Pool:**

```
Core (always activated):
├── ceo         — Strategic planning, org management, hiring, user communication
├── cto         — Engineering architecture, code review, technical decisions
└── cmo         — Marketing strategy, campaign planning, brand management

Engineering:
├── frontend-dev    — React/Next.js, UI/UX implementation, CSS
├── backend-dev     — API development, databases, server logic
├── fullstack-dev   — Combined frontend + backend
├── devops          — CI/CD, deployment, infrastructure
└── qa-tester       — Testing, bug reporting, quality assurance

Marketing:
├── reddit-marketer   — Reddit engagement, community building, content posting
├── twitter-marketer  — Twitter/X content, engagement, growth
├── cold-emailer      — Outbound email campaigns, lead nurturing
├── seo-writer        — Blog posts, keyword research, content optimization
├── ad-buyer          — Paid advertising (Google Ads, Meta Ads)
└── content-writer    — General content creation, copywriting

Sales:
├── lead-researcher   — Finding prospects, enriching contact data
└── outbound-caller   — Phone outreach (via API-based calling services)

Operations:
├── api-keys-agent    — Provisions and manages API keys for other agents
├── account-buyer     — Purchases accounts, domains, services as needed
├── bookkeeper        — Tracks expenses, generates financial reports
└── designer          — Visual assets, logos, social media graphics
```

### 5.3 Hierarchical Hiring

Agents are organized in a reporting hierarchy. Any agent can request a new hire, but the request flows upward to the CEO, who decides whether to approve.

**Reporting Structure:**
```
CEO
├── CTO
│   ├── Frontend Dev
│   ├── Backend Dev
│   ├── DevOps
│   └── QA Tester
├── CMO
│   ├── Reddit Marketer
│   ├── Twitter Marketer
│   ├── Cold Emailer
│   ├── SEO Writer
│   └── Content Writer
├── CFO (if activated)
│   └── Bookkeeper
└── Operations
    ├── API Keys Agent
    ├── Account Buyer
    └── Designer
```

**Hiring Flow:**

```
1. Reddit Marketer → CMO: "I need someone to create visual memes for posts"
2. CMO evaluates: is this worth the credit cost? Does a blueprint exist?
3. CMO → CEO: "Marketing needs a Designer agent for social media assets"
4. CEO decides:
   a. Blueprint exists (Designer) → activate from pool
   b. No blueprint → CEO designs a custom agent:
      - Writes system prompt
      - Identifies required tools and API keys
      - Requests API keys from API Keys Agent
      - If new paid service needed → escalates to user for approval
      - Creates and spawns the agent
5. New agent joins the org, reports to CMO
```

**Authority Levels:**
- **CEO**: Can hire anyone (pool or custom), create new roles, set org policy
- **C-suite (CTO, CMO, CFO)**: Can hire from pool within their department without CEO approval
- **Specialists**: Can only REQUEST hires upward through their reporting chain

**Why hierarchical hiring?**
- Prevents runaway agent spawning (each agent costs credits)
- CEO maintains strategic coherence (don't hire 5 marketers when you need engineers)
- C-suite autonomy for department-level decisions (CMO doesn't need CEO to hire a copywriter)
- User approval only for custom agents or new paid services (minimizes interruptions)

### 5.4 Custom Agent Creation

When the CEO needs an agent that doesn't exist in the pool (e.g., "AI UGC Creator using Sora 2"), the CEO designs it from scratch:

```
1. CEO reasons about what the agent needs:
   - Role: "UGC Content Creator"
   - Task: "Generate user-generated-content-style videos using AI"
   - Tools needed: Sora 2 API, video editing, asset storage
   - Reports to: CMO

2. CEO checks for required API keys:
   - Sora 2 API key → asks API Keys Agent
   - API Keys Agent checks vault → not found
   - API Keys Agent → User (via Attention Needed): "Approve: Sora 2 API access ($X/video)"
   - User approves → API Keys Agent provisions key

3. CEO writes the agent's system prompt:
   - Detailed instructions on how to use Sora 2
   - Content style guidelines
   - Quality standards
   - Workflow: brief → generate → review → deliver

4. CEO submits blueprint to supervisor:
   - Supervisor creates the agent
   - Agent joins relay channels
   - Agent starts working under CMO direction

5. If the agent works well, the blueprint is saved to the pool
   for other companies to use (manual review by us first)
```

### 5.5 Company Creation — CEO Org Building

When a user creates a company, the CEO is always the first agent activated. The CEO analyzes the company goal and builds the initial team:

```
User goal: "Build a SaaS that helps restaurants manage reservations"

CEO reasoning:
- This is a B2B SaaS product
- Needs: frontend, backend, database, API
- Marketing: B2B outreach (cold email > social media for restaurants)
- No need for: Reddit marketing, UGC, ad buying (too early)

CEO activates:
1. CTO (always for a tech product)
2. Frontend Dev (SaaS needs UI)
3. Backend Dev (SaaS needs API)
4. CMO (needs marketing strategy)
5. Cold Emailer (B2B outreach to restaurants)
6. SEO Writer (long-tail "restaurant management" content)

CEO does NOT activate:
- Reddit Marketer (not relevant for B2B restaurants)
- Ad Buyer (too early, no product yet)
- Designer (CTO/Frontend Dev can handle initial design)

CEO creates initial tasks:
- CTO: "Design the system architecture for a restaurant reservation SaaS"
- Frontend Dev: "Build the landing page at newcompany.aicombinator.live"
- Backend Dev: "Set up the database schema and API endpoints"
- CMO: "Research the restaurant management software market"
- Cold Emailer: "Wait for product to be ready before starting outreach"
- SEO Writer: "Write 3 blog posts about restaurant management challenges"
```

---

## 6. Supervisor Architecture

The supervisor is the most critical piece of custom infrastructure. It's a lightweight Node.js process (no LLM, zero credit cost) that runs on the shared VM and manages all agent lifecycles.

### 6.1 Responsibilities

```typescript
class Supervisor {
  // LIFECYCLE
  async createCompany(config: CompanyConfig): Promise<void>;
  async destroyCompany(companyId: string): Promise<void>;
  async activateAgent(companyId: string, blueprint: AgentBlueprint): Promise<void>;
  async deactivateAgent(companyId: string, agentId: string): Promise<void>;

  // EVENT HANDLING (zero credits — no LLM calls)
  async onUserMessage(companyId: string, agentId: string, message: string): Promise<void>;
  async onEmailReceived(companyId: string, email: InboundEmail): Promise<void>;
  async onCronTick(companyId: string, task: CronTask): Promise<void>;
  async onRelayMessage(companyId: string, fromAgent: string, toAgent: string, message: string): Promise<void>;
  async onApprovalResolved(companyId: string, approval: Approval): Promise<void>;
  async onWebhook(companyId: string, webhook: WebhookEvent): Promise<void>;
  async onCreditsExhausted(companyId: string): Promise<void>;
  async onCreditsPurchased(companyId: string, amount: number): Promise<void>;

  // AGENT INVOCATION (this is where credits are spent)
  async wakeAgent(companyId: string, agentId: string, prompt: string): Promise<void>;

  // CREDIT MANAGEMENT
  async deductCredits(companyId: string, agentId: string, tokensUsed: TokenUsage): Promise<void>;
  async checkCredits(companyId: string): Promise<number>;
  async pauseAllAgents(companyId: string): Promise<void>;
  async resumeAllAgents(companyId: string): Promise<void>;

  // STATUS REPORTING (called by Worker API)
  async getCompanyStatus(companyId: string): Promise<CompanyStatus>;
  async getAgentStatus(companyId: string, agentId: string): Promise<AgentStatus>;
}
```

### 6.2 Event-Driven Architecture (Zero Idle Burn)

The supervisor NEVER calls an LLM itself. It only dispatches events to agents. This is the critical design decision that prevents idle credit burn.

**How events flow:**

```
Event Source              Supervisor Action              Credit Cost
─────────────            ──────────────────             ───────────
User sends chat message  → wake CEO with message        → ~8 credits (Sonnet)
Email arrives            → route to appropriate agent    → ~2 credits (Haiku)
Cron task fires          → wake assigned agent           → varies
Agent Relay message      → relay handles delivery        → 0 (relay is push)
Approval resolved        → wake blocked agent            → ~2 credits
Webhook (GitHub push)    → wake CTO                      → ~8 credits
Nothing happens          → nothing runs                  → 0 credits

Key: if nothing happens, NOTHING runs. Zero credits burned.
```

**What the supervisor checks WITHOUT LLM (zero cost):**
- Is there a new message in the database? (SQL query)
- Is a cron task due? (timestamp comparison)
- Did Stripe send a webhook? (HTTP handler)
- Is the credit balance above zero? (integer comparison)

**What requires LLM (costs credits):**
- Agent reasoning about what to do
- Agent executing tools
- Agent writing code, emails, content

The boundary is sharp: supervisor = free, agent invocation = credits.

### 6.3 Cron Tasks (Scheduled Agent Work)

Some agent work is recurring: check email every hour, post to Twitter at 9am, run tests after every code change. These are stored as cron entries:

```typescript
interface CronTask {
  id: string;
  companyId: string;
  agentId: string;          // Which agent to wake
  schedule: string;         // Cron expression: "0 9 * * *"
  prompt: string;           // What to tell the agent: "Check email and respond"
  enabled: boolean;
  lastRun: string;
  createdBy: string;        // Which agent created this cron
}
```

The supervisor checks cron entries every minute (simple timestamp comparison, zero LLM cost). When a task is due, it wakes the assigned agent with the prompt.

Agents can create their own cron tasks:
- CMO: "Check email every 2 hours" → creates cron entry
- CTO: "Run test suite every 6 hours" → creates cron entry
- CEO: "Generate daily status report at 6pm" → creates cron entry

### 6.4 Communication with Worker API

The supervisor exposes a local API that the Cloudflare Worker calls:

```
Worker → Supervisor (via VM's public IP or Cloudflare Tunnel):

POST /companies/:id/agents/:agentId/message   → wake agent with user message
GET  /companies/:id/status                     → get company status
GET  /companies/:id/agents                     → list agents with statuses
POST /companies/:id/agents/:agentId/pause      → pause agent
POST /companies/:id/agents/:agentId/resume     → resume agent
POST /companies/:id/provision                  → create company containers
POST /companies/:id/destroy                    → tear down company
```

The Worker handles auth (Clerk JWT verification) before forwarding to the supervisor. The supervisor trusts the Worker.

---

## 7. Inter-Agent Communication

### 7.1 Agent Relay Integration

Agent Relay (https://github.com/AgentWorkforce/relay) provides the message bus. Each company gets its own relay namespace with channels:

```
Company "RestaurantSaaS" channels:
├── #all-hands      — Company-wide announcements (CEO broadcasts here)
├── #leadership     — CEO + CTO + CMO strategic discussions
├── #engineering    — CTO + devs technical discussions
├── #marketing      — CMO + marketing specialists
├── #status         — Automated status updates from all agents
└── #escalations    — Items that need CEO or user attention
```

**How agents communicate:**

```typescript
// CEO assigns task to CTO (via relay)
relay.sendMessage({
  from: "CEO",
  to: "CTO",
  channel: "#engineering",
  text: "Build the reservation API. Requirements: REST, PostgreSQL, auth via JWT."
});

// CTO delegates to Backend Dev
relay.sendMessage({
  from: "CTO",
  to: "BackendDev",
  channel: "#engineering",
  text: "Implement the reservation CRUD endpoints. Schema is in /workspace/docs/schema.md"
});

// Backend Dev reports completion
relay.sendMessage({
  from: "BackendDev",
  to: "CTO",
  channel: "#engineering",
  text: "API endpoints done. 12 endpoints, tested. PR ready for review."
});
```

**Cross-provider communication:**
The relay handles Claude agents talking to OpenAI agents transparently. The CEO (Claude Sonnet) can assign tasks to the Reddit Marketer (GPT-4o-mini) through the same channel interface.

### 7.2 Why Not Just Shared Filesystem?

Agents share a filesystem (/workspace/), so they COULD communicate via files. But:
- Files require polling ("did the file change?") — burns credits
- No delivery guarantee — agent might not check the file
- No threading — hard to maintain conversation context
- No cross-provider — file communication only works within the same container

The relay provides push delivery, threading, and cross-provider support. The shared filesystem is for code and assets, not communication.

---

## 8. Provisioning

### 8.1 What Gets Provisioned at Company Creation

**Immediate (automated, seconds):**
- Database records in D1 (company, agents, settings)
- Subdomain: `company.aicombinator.live` (Cloudflare wildcard DNS, already configured)
- Email: `info@company.aicombinator.live` (Cloudflare Email Routing catch-all)
- Container on shared VM (Docker container with workspace volume)
- Agent Relay namespace with default channels

**After CEO activation (minutes):**
- CEO reads the goal, builds org chart
- Selected agents activated from pool
- Initial task assignments created
- Workspace populated with project scaffolding

**After paid subscription (seconds to minutes):**
- Custom domain configured (Cloudflare for SaaS — SSL, routing)
- Custom domain email (MX records → our email infrastructure)
- Auto-refill configured in Stripe

### 8.2 Subdomain Routing

The Cloudflare Worker already handles subdomain routing:

```
*.aicombinator.live → Worker
Worker extracts subdomain → looks up company in D1
If found → serves the company's public website (from workspace/public/)
If not found → 404 page
```

For custom domains:
```
aicompany.com → CNAME to proxy.aicombinator.live
Worker checks hostname → looks up custom domain mapping in D1
If found → serves the company's public website
```

### 8.3 Email Provisioning

**Free tier (subdomain email):**
- Cloudflare Email Routing: catch-all on `*.aicombinator.live`
- Incoming email → forwarded to AgentMail inbox for the company
- Outgoing email → sent via AgentMail API (or SMTP relay)

**Paid tier (custom domain email):**
- User points MX records to our email infrastructure
- Same AgentMail backend, different domain
- CEO handles DNS instruction to user if needed

### 8.4 VM Container Structure

```
/srv/aicombinator/
├── supervisor/
│   ├── index.ts           (main supervisor process)
│   ├── containers.ts      (Docker management)
│   ├── credits.ts         (credit tracking)
│   └── events.ts          (event dispatcher)
│
├── companies/
│   ├── company-abc/
│   │   ├── workspace/     (shared filesystem for all agents)
│   │   │   ├── src/       (code)
│   │   │   ├── docs/      (documents, plans)
│   │   │   ├── assets/    (images, videos)
│   │   │   └── .agent/    (agent state, sessions)
│   │   ├── docker-compose.yml
│   │   └── config.json    (company settings, agent list)
│   │
│   └── company-def/
│       └── ...
│
├── mcp-servers/
│   ├── email/
│   ├── browser/
│   ├── finance/
│   └── domain/
│
└── relay/
    └── config.json        (Agent Relay credentials)
```

---

## 9. Stripe Integration

### 9.1 Billing Flow

```
Free Signup → no Stripe interaction

Subscribe:
1. User clicks "Subscribe" → Stripe Checkout Session created
2. User enters card → Stripe processes payment
3. Stripe webhook: checkout.session.completed
4. Worker handler:
   a. Mark user as "paid" in D1
   b. Add 5,000 credits
   c. Create Stripe Subscription (recurring $50/month)
   d. Store payment method for auto-refill
   e. Resume paused agents (if credits were exhausted)

Monthly renewal:
1. Stripe processes recurring $50/month
2. Stripe webhook: invoice.paid
3. Worker handler: add 5,000 credits

Auto-refill:
1. Supervisor detects credits below threshold
2. Supervisor calls Worker API: "credits low for company X"
3. Worker creates Stripe PaymentIntent for refill amount
4. Stripe charges stored payment method
5. Stripe webhook: payment_intent.succeeded
6. Worker handler: add purchased credits

Failed payment:
1. Stripe webhook: invoice.payment_failed
2. Worker handler: notify user via Attention Needed panel
3. Grace period: 3 days before pausing agents
4. After 3 days: agents paused, user must update payment method
```

### 9.2 Credit Tracking

Credits are tracked in D1 (source of truth) and cached in the supervisor (for fast checks):

```sql
-- Credits ledger
CREATE TABLE credit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company_id TEXT,           -- NULL for account-level events
  agent_id TEXT,             -- NULL for non-agent events
  type TEXT NOT NULL,        -- 'grant', 'deduct', 'refill', 'subscription'
  amount INTEGER NOT NULL,   -- positive for grants, negative for deductions
  balance_after INTEGER,     -- running balance
  description TEXT,          -- "Monthly subscription", "CEO turn #42"
  created_at TEXT NOT NULL
);

-- Quick balance check
CREATE TABLE credit_balances (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

Every agent turn records a deduction with the agent ID and credit cost. The dashboard shows per-agent cost breakdown using this data (already built in CompactMetrics component).

---

## 10. Dashboard

### 10.1 Current State

The dashboard is a Next.js application deployed on Cloudflare Workers. It already has:

- **Company page** (`/company/[id]`) with sidebar layout
- **Agent Activity Feed** — live view of what each agent is doing
- **Attention Needed** — pending approvals and escalations from agents
- **Compact Metrics** — budget bar, credit usage, cost-by-agent breakdown
- **CEO Chat** — direct messaging with the CEO agent
- **Home Tab** — tasks, documents, links, campaigns, products
- **Admin sections** — agent config, genesis prompt, internal state

### 10.2 What Needs to Change

The dashboard currently talks to the Cloudflare Worker (D1 + Durable Objects). With the new architecture:

- **Worker API stays** — dashboard still calls the Worker for auth, company data, agent lists
- **Worker forwards to Supervisor** — agent actions (wake, pause, message) are proxied to the VM supervisor
- **Real-time updates** — supervisor pushes status changes to the Worker via WebSocket or SSE, Worker pushes to dashboard
- **Credit display** — already built, just needs to read from the new credit_events table
- **Stripe integration UI** — new: subscription button, auto-refill settings, payment method management

### 10.3 New Pages Needed

- `/subscribe` — Stripe Checkout integration
- `/settings/billing` — manage subscription, auto-refill settings, payment history
- `/company/[id]/settings` — company-specific settings (custom domain, email config)
- `/launch` — company creation wizard (name, description, goal → CEO starts building)

---

## 11. D1 as Durable Source of Truth

### 11.1 Principle

D1 is the **single source of truth** for all persistent state. The supervisor caches state locally for performance but never owns it. If the supervisor crashes, restarts, or is replaced, it reconstructs its entire state from D1. No local-only state exists that would be lost on restart.

**Write path:** All state mutations go to D1 first. The supervisor updates its local cache only after D1 confirms the write.

**Read path:** Supervisor reads from local cache (refreshed every 5-10 seconds from D1). For critical reads (credit balance before deduction), supervisor reads directly from D1 to avoid stale cache.

### 11.2 What Lives in D1 (Canonical)

```sql
-- Company state
companies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,           -- subdomain
  custom_domain TEXT,
  state TEXT NOT NULL,                 -- 'active', 'paused', 'suspended', 'archived'
  goal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Agent state
agents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  blueprint_id TEXT,                   -- NULL for custom agents
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,                -- 'running', 'sleeping', 'paused', 'error', 'terminated'
  reports_to TEXT,                     -- agent_id of manager
  model_tier TEXT NOT NULL,            -- 'sonnet', 'haiku', 'gpt4o-mini'
  last_wake_at TEXT,
  last_sleep_at TEXT,
  total_credits_consumed INTEGER DEFAULT 0,
  config TEXT,                         -- JSON: system prompt, channels, tools
  created_at TEXT NOT NULL
);

-- Credit balances (denormalized for fast reads)
credit_balances (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Credit ledger (append-only, audit trail)
credit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company_id TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,                  -- 'grant', 'deduct', 'refill', 'subscription', 'free_tier'
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

-- Tasks (structured work tracking — see Section 12)
tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  owner_agent_id TEXT,
  status TEXT NOT NULL,                -- 'todo', 'in_progress', 'blocked', 'done', 'cancelled'
  blocked_on TEXT,                     -- task_id or description of blocker
  artifact TEXT,                       -- path or URL of deliverable
  created_by TEXT NOT NULL,            -- agent_id
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Approvals (gated actions)
approvals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL,                  -- see Section 13 policy types
  requested_by TEXT NOT NULL,          -- agent_id
  payload TEXT NOT NULL,               -- JSON: action details
  status TEXT NOT NULL,                -- 'pending', 'approved', 'rejected'
  resolved_by TEXT,                    -- 'user' or agent_id
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Subscriptions
subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  status TEXT NOT NULL,                -- 'active', 'past_due', 'cancelled'
  current_period_end TEXT,
  auto_refill_enabled BOOLEAN DEFAULT 1,
  auto_refill_threshold INTEGER DEFAULT 1000,
  auto_refill_amount INTEGER DEFAULT 5000,
  created_at TEXT NOT NULL
);

-- Cron tasks
cron_tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  schedule TEXT NOT NULL,              -- cron expression
  prompt TEXT NOT NULL,
  enabled BOOLEAN DEFAULT 1,
  last_run_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 11.3 What Lives on the Supervisor (Cache Only)

The supervisor maintains an in-memory cache for fast lookups. This cache is **reconstructable from D1** at any time:

```typescript
interface SupervisorCache {
  // Refreshed every 5s from D1
  creditBalances: Map<string, number>;           // userId → balance
  agentStatuses: Map<string, AgentStatus>;       // agentId → status
  companyStates: Map<string, CompanyState>;       // companyId → state

  // Refreshed every 60s from D1
  cronTasks: CronTask[];                          // all enabled cron tasks
  autoRefillConfigs: Map<string, RefillConfig>;   // userId → refill settings
}

// On supervisor start:
async function rebuildCache(d1: D1Database): Promise<SupervisorCache> {
  // Query all active state from D1
  // Populate cache
  // Resume any agents that were running before crash
}
```

### 11.4 Consistency Rules

1. **Credits**: Always read from D1 before deducting. Never trust cached balance for deductions. This prevents double-spending if cache is stale.
2. **Agent status**: Supervisor writes status to D1, then updates cache. Dashboard reads from D1 via Worker API.
3. **Tasks**: Created and updated in D1. Agents read tasks from D1 (via supervisor API). No local task state.
4. **Approvals**: Created in D1 by supervisor when agent requests gated action. Dashboard shows pending approvals from D1. Resolution written to D1, supervisor notified.

---

## 12. Task System

### 12.1 Why Structured Tasks

Without structured tasks, work happens through ephemeral relay messages. This creates problems:
- **No visibility**: The dashboard can't show "CTO is 60% done with the API" — it only knows the agent is "running"
- **No blocking**: If Backend Dev needs the schema from CTO, there's no structured way to express "I'm blocked on task X"
- **No artifacts**: When a task is done, where's the output? A message saying "done" doesn't link to the deliverable
- **No history**: "What did the company accomplish this week?" requires reading through all relay messages

### 12.2 Task Object

```typescript
interface Task {
  id: string;
  companyId: string;
  title: string;                    // "Build reservation API"
  description: string;              // Detailed requirements
  ownerAgentId: string | null;      // Who's working on it
  status: TaskStatus;               // 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
  blockedOn: string | null;         // Task ID or free-text blocker description
  artifact: string | null;          // "/workspace/src/api/" or "https://company.aicombinator.live"
  parentTaskId: string | null;      // For subtask hierarchy (optional)
  createdBy: string;                // Agent ID that created the task
  createdAt: string;
  updatedAt: string;
}

type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
```

### 12.3 How Agents Use Tasks

Tasks are exposed to agents as supervisor tools (via MCP server or direct API):

```
create_task(title, description, assignee?)  → creates task in D1, returns task ID
claim_task(taskId)                          → set owner to self, status to in_progress
update_task(taskId, { status, artifact, blockedOn })
list_tasks(filters?)                        → query tasks for the company
get_task(taskId)                            → read task details
```

**Typical flow:**

```
1. CEO creates task: "Build reservation API" → assigned to CTO
2. CTO claims it → status: in_progress
3. CTO creates subtasks:
   - "Design database schema" → assigned to Backend Dev
   - "Build REST endpoints" → assigned to Backend Dev
   - "Write API documentation" → assigned to self
4. Backend Dev claims "Design database schema" → in_progress
5. Backend Dev completes it → status: done, artifact: /workspace/docs/schema.sql
6. Backend Dev claims "Build REST endpoints" → in_progress
7. Backend Dev gets stuck → status: blocked, blockedOn: "Need auth middleware from CTO"
8. CTO sees blocked task → creates auth middleware → unblocks Backend Dev
9. All subtasks done → CTO marks parent task done, artifact: /workspace/src/api/
```

### 12.4 Dashboard Integration

The existing TasksSummary component in the dashboard already displays tasks. The new structured task object maps directly to it, with additional status tracking:

```
TASKS              3 active · 1 blocked · 5 done
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔵 Build reservation API          CTO        in_progress
  └─ 🔵 Design database schema    BackendDev done ✓
  └─ 🟡 Build REST endpoints      BackendDev blocked (auth middleware)
  └─ ⬜ Write API docs             CTO        todo
🔵 Research restaurant market      CMO        in_progress
⬜ Set up cold email campaign      ColdEmailer todo
```

---

## 13. Policy Layer

### 13.1 Why Policies

Agents have powerful tools from day one: browser access, email, financial tools, shell execution. Without explicit policy, there's nothing preventing:
- CMO spending $500 on ads without user approval
- Account Buyer registering 20 domains in one session
- Any agent sending 1000 emails per hour
- CTO deleting the production database
- An agent signing up for an expensive API service

Policies define **what requires approval, what has rate limits, and what is forbidden** — enforced by the supervisor before tool execution.

### 13.2 Policy Types

```typescript
interface PolicyRule {
  id: string;
  action: string;              // Tool or action name
  condition: PolicyCondition;  // When does this rule apply?
  enforcement: PolicyEnforcement; // What happens when triggered?
}

type PolicyCondition =
  | { type: 'always' }                           // Always enforce
  | { type: 'threshold'; field: string; max: number }  // When amount > max
  | { type: 'rate_limit'; max: number; window: string } // Max N per time window
  | { type: 'agent_role'; roles: string[] }       // Only for certain roles

type PolicyEnforcement =
  | { type: 'require_approval' }     // Block until user approves
  | { type: 'require_manager' }      // Block until manager approves
  | { type: 'deny' }                 // Forbidden, always blocked
  | { type: 'rate_limit' }          // Silently enforce rate limit
  | { type: 'log_only' }            // Allow but log for audit
```

### 13.3 Default Policies

These policies are active for every company from day one:

```yaml
# Financial policies
- action: purchase_service
  condition: { type: always }
  enforcement: { type: require_approval }
  reason: "Any purchase of external services requires user approval"

- action: topup_card
  condition: { type: threshold, field: amount_cents, max: 5000 }
  enforcement: { type: require_approval }
  reason: "Card top-ups over $50 require user approval"

- action: send_payment
  condition: { type: threshold, field: amount_cents, max: 1000 }
  enforcement: { type: require_approval }
  reason: "Payments over $10 require user approval"

# Domain & infrastructure policies
- action: register_domain
  condition: { type: always }
  enforcement: { type: require_approval }
  reason: "Domain registration costs money and is hard to undo"

- action: expose_port
  condition: { type: always }
  enforcement: { type: require_manager }
  reason: "Exposing ports to the internet needs manager sign-off"

# Communication policies
- action: send_email
  condition: { type: rate_limit, max: 50, window: "1h" }
  enforcement: { type: rate_limit }
  reason: "Prevent email spam and protect sender reputation"

- action: send_email
  condition: { type: rate_limit, max: 200, window: "24h" }
  enforcement: { type: rate_limit }
  reason: "Daily email cap"

# API key policies
- action: provision_api_key
  condition: { type: always }
  enforcement: { type: require_approval }
  reason: "New API services may incur costs"

# Account policies
- action: create_account
  condition: { type: rate_limit, max: 5, window: "24h" }
  enforcement: { type: rate_limit }
  reason: "Prevent mass account creation"

- action: create_account
  condition: { type: always }
  enforcement: { type: log_only }
  reason: "All account creation is audit-logged"

# Agent hiring policies
- action: hire_agent_custom
  condition: { type: always }
  enforcement: { type: require_approval }
  reason: "Custom agents need user approval (cost + risk)"

- action: hire_agent_pool
  condition: { type: agent_role, roles: ["specialist"] }
  enforcement: { type: require_manager }
  reason: "Specialists can't hire directly, must request through manager"

# Destructive action policies
- action: delete_file
  condition: { type: always }
  enforcement: { type: log_only }
  reason: "All file deletions are audit-logged"

- action: drop_table
  condition: { type: always }
  enforcement: { type: deny }
  reason: "Database drops are always forbidden"

- action: rm_rf
  condition: { type: always }
  enforcement: { type: deny }
  reason: "Recursive force-delete is always forbidden"
```

### 13.4 Policy Enforcement Flow

```
Agent calls tool: send_email(to: "list@example.com", body: "...")
         │
         ▼
Supervisor checks policies for "send_email":
  1. Rate limit: 50/hour → check counter → 47 sent this hour → PASS
  2. Rate limit: 200/day → check counter → 180 sent today → PASS
         │
         ▼
Tool executes. Counter incremented.

---

Agent calls tool: register_domain("coolstartup.com")
         │
         ▼
Supervisor checks policies for "register_domain":
  1. Always requires approval → CREATE APPROVAL in D1
         │
         ▼
Agent receives: "Action blocked: awaiting user approval"
Agent marks its current task as blocked.
         │
         ▼
Dashboard shows in Attention Needed:
  "Approve: Register domain coolstartup.com — requested by CEO"
  [Approve] [Reject]
         │
         ▼
User approves → Supervisor executes tool → Agent unblocked
```

### 13.5 Policy Storage

Policies are stored in D1 and loaded into supervisor cache. Users can customize policies per company via settings (future feature — default policies are sufficient for launch).

```sql
policies (
  id TEXT PRIMARY KEY,
  company_id TEXT,               -- NULL = global default
  action TEXT NOT NULL,
  condition TEXT NOT NULL,        -- JSON
  enforcement TEXT NOT NULL,      -- JSON
  reason TEXT,
  enabled BOOLEAN DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Rate limit counters (in-memory on supervisor, persisted hourly)
policy_counters (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
```

---

## 14. Runtime Limits

### 14.1 Why Runtime Limits

Without hard caps, a single agent can:
- Run a turn that grows to 100K tokens of context and burns 100+ credits
- Keep a browser open for hours eating 500MB of RAM
- Execute a shell command that runs for 30 minutes and blocks the container
- Burn through the entire monthly credit allotment in one runaway session

Runtime limits are the safety net that prevents any single operation from causing disproportionate damage to credits, resources, or the shared VM.

### 14.2 Per-Turn Limits

```typescript
interface TurnLimits {
  maxCreditsPerTurn: number;        // 50 credits — hard cap per inference turn
  maxTokensInput: number;           // 100,000 tokens — context window limit
  maxTokensOutput: number;          // 16,000 tokens — response length limit
  maxToolCallsPerTurn: number;      // 10 — prevents tool call loops
  maxInferenceRoundsPerTurn: number;// 5 — max tool→think→tool cycles
  turnTimeoutMs: number;            // 300,000 (5 min) — total turn wall time
}
```

**Enforcement:** The supervisor wraps every agent invocation with these limits. If any limit is hit, the turn ends immediately, partial results are saved, and the agent is returned to sleeping state.

```typescript
async function wakeAgent(agentId: string, prompt: string) {
  const limits = getTurnLimits(agentId);
  const startTime = Date.now();

  const result = await Promise.race([
    invokeAgent(agentId, prompt, limits),
    timeout(limits.turnTimeoutMs),
  ]);

  const creditsUsed = calculateCredits(result.tokenUsage);
  if (creditsUsed > limits.maxCreditsPerTurn) {
    // Log warning, cap deduction at maxCreditsPerTurn
    creditsUsed = limits.maxCreditsPerTurn;
  }

  await deductCredits(companyId, agentId, creditsUsed);
}
```

### 14.3 Per-Session Limits

A "session" is a sequence of turns when an agent is awake (e.g., CEO receives a message, does 5 turns of work, then sleeps).

```typescript
interface SessionLimits {
  maxTurnsPerSession: number;       // 20 — agent must sleep after 20 turns
  maxSessionDurationMs: number;     // 1,800,000 (30 min) — total wall time
  maxCreditsPerSession: number;     // 200 — session credit cap
}
```

**Why session limits?** An agent might legitimately need multiple turns (research → plan → execute → test → fix). But 20 turns at 8-9 credits each is 160-180 credits — a significant chunk. The session cap prevents infinite loops where an agent keeps trying and failing.

### 14.4 Per-Agent Daily Limits

```typescript
interface DailyLimits {
  maxCreditsPerDay: number;         // 500 per agent (configurable per blueprint)
  maxTurnsPerDay: number;           // 100 per agent
  maxEmailsPerDay: number;          // 200
  maxBrowserSessionsPerDay: number; // 20
}
```

**Enforcement:** Tracked in the supervisor, persisted to D1 hourly. Resets at midnight UTC. When a daily limit is hit, the agent is paused until the next day. The user is notified via Attention Needed: "CEO has hit its daily credit limit (500). Increase limit or wait until tomorrow."

### 14.5 Container Resource Limits

```yaml
# Docker resource constraints per company container
deploy:
  resources:
    limits:
      cpus: "2.0"              # 2 CPU cores max
      memory: "2G"             # 2GB RAM max
    reservations:
      cpus: "0.5"              # 0.5 CPU guaranteed
      memory: "512M"           # 512MB guaranteed
```

**Shared VM sizing:** A 16GB RAM / 8 vCPU shared VM can host ~6-8 active company containers with these limits, with headroom for the supervisor and MCP servers.

### 14.6 Browser Session Limits

Persistent Chromium is the biggest RAM consumer (~200-500MB per instance).

```typescript
interface BrowserLimits {
  maxConcurrentBrowsers: number;    // 1 per company container
  browserIdleTimeoutMs: number;     // 900,000 (15 min) — close if idle
  browserSessionMaxMs: number;      // 3,600,000 (1 hour) — hard session limit
  maxPagesPerSession: number;       // 10 — prevent tab explosion
}
```

**Enforcement:** The browser MCP server manages Chromium lifecycle:
- Starts Chromium only when an agent explicitly requests browser access
- Closes idle browsers after 15 minutes of no interaction
- Hard-kills sessions after 1 hour regardless
- Only 1 browser instance per company (agents within a company share it, taking turns)

### 14.7 Shell Execution Limits

```typescript
interface ShellLimits {
  commandTimeoutMs: number;         // 120,000 (2 min) — per command
  maxConcurrentCommands: number;    // 3 — per container
  maxOutputBytes: number;           // 1,000,000 (1MB) — truncate stdout/stderr
  forbiddenPatterns: RegExp[];      // rm -rf /, DROP TABLE, etc.
}
```

**Long-running processes (dev servers, builds):** These are exempted from the 2-minute timeout but managed separately:
- Dev servers are tracked by the supervisor
- Maximum 2 long-running processes per container
- Long-running processes don't count as "agent is running" — they run in background

### 14.8 Limit Overrides

Blueprint-level overrides allow different limits per agent role:

```typescript
const ROLE_LIMITS: Record<string, Partial<TurnLimits>> = {
  ceo: {
    maxCreditsPerTurn: 50,        // Higher — strategic decisions
    maxCreditsPerSession: 200,
    maxTurnsPerSession: 20,
  },
  cto: {
    maxCreditsPerTurn: 50,        // Higher — complex coding tasks
    maxCreditsPerSession: 300,    // Coding sessions can be longer
    maxTurnsPerSession: 30,
    turnTimeoutMs: 600_000,       // 10 min — builds take time
  },
  specialist: {
    maxCreditsPerTurn: 20,        // Lower — routine tasks
    maxCreditsPerSession: 100,
    maxTurnsPerSession: 10,
  },
};
```

---

## 15. Security Model

### 15.1 Container Isolation

Each company's agents run in an isolated Docker container:
- **Filesystem**: Only the company's `/workspace/` is mounted
- **Network**: Outbound internet access (agents need to browse, send email, call APIs)
- **Resources**: CPU and memory limits per container
- **User**: Agents run as non-root `node` user
- **No inter-container access**: Company A cannot see Company B's filesystem or processes

### 15.2 Agent Safety

Inherited from the current framework:
- **Constitution** (immutable): Three laws — never harm, earn existence honestly, never deceive
- **Forbidden commands**: Regex-blocked patterns prevent agents from destroying their own state
- **Audit logging**: All agent actions are logged
- **User approval gates**: New paid services, significant spending, and custom agent creation require user approval via the Attention Needed panel

### 15.3 API Security

- **Clerk JWT** on all dashboard API calls
- **Supervisor API** only accessible from the Worker (IP whitelist or Cloudflare Tunnel)
- **Stripe webhooks** verified via webhook signing secret
- **Agent Relay** authenticated via API key per company namespace

---

## 16. Technical Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Dashboard frontend | Next.js 16 + React | Already built, SSR on Workers |
| Dashboard backend | Cloudflare Workers | Serverless, scales to zero, global |
| Database | Cloudflare D1 (SQLite) | Already in use, Workers-native |
| Auth | Clerk | Already integrated, handles OAuth/email/phone |
| Payments | Stripe | Industry standard, Checkout + Subscriptions + Usage |
| Agent brain (primary) | Claude Code SDK | Best agentic loop for code + reasoning |
| Agent brain (cheap) | OpenAI Codex / GPT-4o-mini | Cost-effective for routine tasks |
| Inter-agent comms | Agent Relay SDK | Push-based, cross-provider, channels |
| Agent isolation | Docker containers | Filesystem + process isolation |
| VM hosting | TBD (Hetzner, Fly.io, etc.) | Shared VM for cost efficiency |
| Email | AgentMail | Real email addresses for agents |
| Browser | Persistent Chromium (in container) | No external browser service dependency |
| DNS/CDN/SSL | Cloudflare | Already on Cloudflare, wildcard DNS, for SaaS |
| Custom tools | MCP servers | Standardized tool protocol, extensible |

---

## 17. Migration Path

### From Current Architecture (Durable Objects) to New Architecture (VM + Supervisor)

1. **Keep the Worker** — the dashboard, API routes, D1 database, and Clerk auth all stay on Cloudflare Workers. Nothing changes for the frontend.

2. **Build the Supervisor** — new Node.js process that runs on the shared VM. Handles agent lifecycle, event dispatch, credit tracking.

3. **Replace Durable Objects** — instead of routing agent actions to DOs, the Worker routes them to the Supervisor API on the VM. The DO code (`worker/src/agent-do.ts`) is retired.

4. **Replace custom ReAct loop** — agents use Claude Code SDK instead of `src/agent/loop.ts`. The custom inference client, tool definitions, and context management code are retired.

5. **Add Agent Relay** — replace the `agent_messages` D1 table with relay channels. Agents communicate through the relay instead of database polling.

6. **Add Stripe** — new billing routes in the Worker, Stripe Checkout for subscription, webhook handlers for payment events.

7. **Add container isolation** — Docker setup on the shared VM, per-company containers with workspace volumes.

### What Gets Retired

- `worker/src/agent-do.ts` — Durable Object agent execution
- `src/agent/loop.ts` — Custom ReAct loop
- `src/agent/tools.ts` — Custom tool definitions (replaced by MCP servers + Claude Code built-ins)
- `src/agent/system-prompt.ts` — Custom prompt building (simplified, agent-specific prompts)
- `src/conway/` — Conway Cloud integration (replaced by direct VM execution)
- `src/runtime/inference.ts` — Custom inference client (Claude Code SDK handles this)
- `src/heartbeat/daemon.ts` — Polling heartbeat (replaced by event-driven supervisor)

### What Gets Kept

- `worker/src/index.ts` — Worker routes (modified to proxy to supervisor)
- `worker/src/routes/` — API route handlers (modified)
- D1 schema — extended with credit_events, subscriptions tables
- Dashboard components — all frontend code stays
- `src/types.ts` — type definitions (extended)

---

## 18. Open Questions

1. **VM provider**: Hetzner (cheapest, EU-based), Fly.io (scale-to-zero machines, global), DigitalOcean (familiar, US-based), AWS (enterprise, expensive). Decision affects latency, cost, and ops burden.

2. **Agent Relay reliability**: It's a new project. What's the fallback if it goes down? Option: local message queue on the VM as fallback, sync to relay when available.

3. **Custom agent promotion**: When a CEO creates a custom agent that works well, how do we validate it for the pool? Manual review by us? Automated testing? Community voting?

4. **Credit pricing adjustments**: If Anthropic/OpenAI change their pricing, we need to adjust the internal credit cost ($0.007). Should this be dynamic (fetch pricing at runtime) or manually updated?

5. **Multi-VM sharding**: When the shared VM hits capacity (50+ active companies?), how do we shard? Options: geographic sharding, random assignment, or priority-based (paid companies get dedicated VMs).

6. **Browser persistence**: Persistent Chromium sessions in containers use RAM. A single Chromium instance is ~200-500MB. With 5 agents per company and 10 companies, that's significant. Do we pool browser instances? Time-limit sessions? Only start browser when agent explicitly needs it?

7. **Agent state across sessions**: Claude Code SDK sessions have conversation history. How much history do we keep? Unlimited (expensive storage) or rolling window (lose context)? The Claude Code SDK handles its own context summarization, but session files grow.

---

## 19. Success Metrics

- **Free → Paid conversion rate**: Target 15-25% (industry standard for dev tools)
- **Average credits consumed/month (paid)**: Target 4,000-6,000 (indicates active usage)
- **Average revenue per user**: $50 base + $20-30 in refills = $70-80/month
- **VM cost per company**: Target <$3/month on shared infrastructure
- **Agent task completion rate**: % of assigned tasks that reach "done" status
- **Time to first value**: <30 minutes from signup to seeing agents produce real output
- **Churn**: Target <10% monthly (high for SaaS, but this is a new category)
