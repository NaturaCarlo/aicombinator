# Agent System v2 — Hiring, Config Editor, Org Chart, Skills

> Complete plan for user-controlled agent management: browse a catalog of 100+ agent
> templates, hire specialists, configure every aspect (prompt, goals, skills, model,
> schedule, context, channels), manage org hierarchy with visual organigram, and
> make OpenClaw terminal workflows obsolete.
>
> **Status:** Plan complete, architecture audited 2026-03-15. Ready for Phase 1.
>
> **Start here** if resuming from a previous conversation.

---

## 1. Agent Catalog (Data Layer)

### 1.1 Blueprint Registry → Database

Currently all blueprints live in `blueprints.ts` as hardcoded objects. To support a browsable catalog of 100+ agent types (seeded from [agency-agents](https://github.com/msitarzewski/agency-agents)), blueprints must become data.

**New D1 table: `blueprint_catalog`**

```sql
CREATE TABLE blueprint_catalog (
  id              TEXT PRIMARY KEY,           -- e.g. "ppc-strategist"
  name            TEXT NOT NULL,              -- "PPC Strategist"
  title           TEXT NOT NULL,              -- "Pay-Per-Click Advertising Strategist"
  department      TEXT NOT NULL,              -- "marketing", "engineering", "sales", "design", etc.
  division        TEXT NOT NULL,              -- "paid-media", "frontend", "support", etc.
  description     TEXT NOT NULL,              -- One-line summary
  system_prompt   TEXT NOT NULL,              -- Full personality + instructions
  skills          TEXT NOT NULL DEFAULT '[]', -- JSON array of skill names
  default_model   TEXT NOT NULL DEFAULT 'sonnet-4-6',
  reports_to      TEXT NOT NULL DEFAULT '',   -- Default reporting line: "ceo", "cto", "cmo", or empty
  mcp_servers     TEXT NOT NULL DEFAULT '[]', -- JSON array of MCP server names
  icon            TEXT DEFAULT NULL,          -- Emoji or avatar URL
  credit_cost_day INTEGER NOT NULL DEFAULT 50,-- Estimated daily credit burn
  source          TEXT DEFAULT 'built-in',    -- "built-in", "agency-agents", "community", "custom"
  tags            TEXT NOT NULL DEFAULT '[]', -- JSON array for search/filter
  is_active       BOOLEAN NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_catalog_department ON blueprint_catalog(department);
CREATE INDEX idx_catalog_division ON blueprint_catalog(division);
```

**Migration strategy:**
- Founding 6 blueprints remain in `blueprints.ts` for bootstrap (they're needed before DB is available)
- All hireable agents come from `blueprint_catalog` in D1
- Seed script imports agency-agents markdown files, extracts personality/skills/department, and inserts rows
- Custom user-created blueprints also go here with `source = 'custom'`

### 1.2 Seed from agency-agents

Create `worker/scripts/seed-catalog.ts`:

1. Clone/download https://github.com/msitarzewski/agency-agents
2. Parse each agent `.md` file — extract: name, department, skills, system prompt, personality
3. Map agency-agents divisions to our department taxonomy:
   - Engineering (24 agents) → `engineering`
   - Design (8) → `design`
   - Paid Media (7) → `marketing`
   - Sales (8) → `sales`
   - Marketing (24) → `marketing`
   - Product (4) → `product`
   - Project Management (6) → `operations`
   - Testing (8) → `engineering`
   - Support (6) → `support`
   - Specialized (20+) → varies
4. Set `reports_to` based on department:
   - `engineering` → `cto`
   - `marketing`, `design` → `cmo`
   - `sales`, `product`, `operations`, `support` → `ceo`
5. Insert into `blueprint_catalog`

**Key adaptation:** agency-agents prompts assume a human user. We need to wrap each one with our standard agent framing (task system, signal protocol, workspace conventions, superpowers methodology). This is done at runtime in `build_system_prompt()`, not in the catalog.

---

## 2. Hiring API (Worker Routes)

### 2.1 Browse Catalog

```
GET /api/blueprints/catalog
  ?department=marketing
  ?division=paid-media
  ?search=seo
  ?page=1&limit=20

Response: {
  blueprints: BlueprintCatalogEntry[],
  total: number,
  departments: string[],    // for filter sidebar
  divisions: string[]       // for filter sidebar
}
```

### 2.2 Hire Agent

```
POST /api/companies/:companyId/agents/hire
Body: {
  blueprint_id: string,           // from catalog
  name?: string,                  // optional custom name override
  model_tier?: string,            // optional model override
  system_prompt_override?: string // optional prompt customization (future)
}

Response: {
  agent: AgentRow,
  message: "Agent hired and team notified"
}
```

**What happens server-side:**

1. Validate: company exists, user owns it, company is running, credit balance > 0
2. Validate: blueprint_id exists in catalog
3. Check agent limit (max 15 agents per company, configurable)
4. Create agent row in `agents` table:
   - `blueprint_id` = catalog entry id
   - `reports_to` = resolve from catalog default (find the matching agent in this company)
   - `status` = `idle`
   - `model_tier` = override or catalog default
5. Sync to supervisor
6. **Notify the org** — enqueue CEO event: `agent_hired`

### 2.3 Fire Agent

```
POST /api/companies/:companyId/agents/:agentId/terminate
Body: { reason?: string }
```

1. Set agent status to `terminated`
2. Cancel any in-progress tasks assigned to this agent
3. Enqueue CEO event: `agent_terminated`

---

## 3. Org Structure Adaptation (Supervisor)

This is the critical piece — when an agent is hired or fired, the team must actually reorganize.

### 3.1 New CEO Event Types

Add to `CEOEventType` in `types.ts`:

```typescript
type CEOEventType =
  | ... existing ...
  | "agent_hired"
  | "agent_terminated";
```

### 3.2 CEO Wake Prompt for Hiring

When the CEO is woken for `agent_hired`:

```
# New Agent Hired

A new agent has joined your team:
- Name: {name}
- Role: {title}
- Department: {department}
- Reports to: {reports_to_name} (default, you may reassign)
- Skills: {skills}
- Daily credit cost: ~{credit_cost_day} credits

## What You Must Do

1. Review whether this agent's reporting line makes sense for your current plan.
   - If they should report to someone else, include a plan_update.json.
2. Review your current milestones and tasks.
   - Are there existing tasks that should be reassigned to this new agent?
   - Are there new tasks this agent should work on?
3. Update /workspace/docs/executive-brief.md to reflect the team change.
4. If you want to create work for the new agent, add tasks via plan_update.json
   with assigned_to: "{agent_blueprint_id}".

Current team:
{format_current_agents}

Current milestones and tasks:
{format_milestones_and_tasks}
```

### 3.3 CEO Wake Prompt for Termination

```
# Agent Terminated

{name} ({title}) has been removed from the team.
Reason: {reason}

## What You Must Do

1. Review any tasks that were assigned to the terminated agent.
   - Reassign to existing team members via plan_update.json.
   - Or cancel if no longer needed.
2. Update /workspace/docs/executive-brief.md.
3. Notify the CTO if engineering tasks need reassignment (add a task for CTO).
```

### 3.4 CTO Awareness

The CTO's system prompt already says "You manage: frontend-dev, backend-dev, qa-tester." This list needs to become dynamic.

**Change in `build_system_prompt()`:**

Instead of hardcoding the CTO's reports, query the agents table:
```typescript
// For CTO: list all engineering agents that report to this CTO
const reports = db.all<AgentRow>(
  `SELECT name, blueprint_id, title FROM agents
   WHERE company_id = ? AND reports_to = ? AND status != 'terminated'`,
  [company.id, agent.id]
);
```

Inject into CTO system prompt:
```
You manage:
- frontend-dev (Frontend Developer)
- backend-dev (Backend Developer)
- qa-tester (QA Tester)
- seo-specialist (SEO Specialist)  ← newly hired
```

Same for CMO managing marketing agents, CEO managing direct reports.

### 3.5 Routing Updates

`routing.ts` has `canAssignTo()` and `getReportTarget()`. These must become dynamic:

```typescript
// Current: hardcoded
// New: query agents table for company
export function canAssignTo(
  assigner: AgentRow,
  target_blueprint_id: string,
  company_agents: AgentRow[]
): boolean {
  // CEO can assign to any direct report
  // CTO can assign to any engineering agent reporting to them
  // Others cannot assign
  const target = company_agents.find(a => a.blueprint_id === target_blueprint_id);
  if (!target) return false;
  return target.reports_to === assigner.id;
}
```

---

## 4. Dashboard UI

### 4.1 Hire Page

**Route:** `/company/{id}/hire`

**Layout:**

```
┌──────────────────────────────────────────────────────────┐
│  Hire an Agent                                    [×]     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  [Search agents...]                                      │
│                                                          │
│  Department Filter:                                      │
│  [All] [Engineering] [Marketing] [Sales] [Design]        │
│  [Product] [Operations] [Support]                        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────────┐  ┌─────────────────┐                │
│  │ 🔎 SEO Expert   │  │ 📨 Outbound     │                │
│  │                 │  │   Strategist    │                │
│  │ Marketing       │  │                 │                │
│  │ ~50 credits/day │  │ Sales           │                │
│  │                 │  │ ~40 credits/day │                │
│  │ [View] [Hire]   │  │ [View] [Hire]   │                │
│  └─────────────────┘  └─────────────────┘                │
│                                                          │
│  ┌─────────────────┐  ┌─────────────────┐                │
│  │ 🎨 UI/UX        │  │ ⚡ Performance  │                │
│  │   Designer      │  │   Engineer     │                │
│  │                 │  │                 │                │
│  │ Design          │  │ Engineering     │                │
│  │ ~45 credits/day │  │ ~55 credits/day │                │
│  │                 │  │                 │                │
│  │ [View] [Hire]   │  │ [View] [Hire]   │                │
│  └─────────────────┘  └─────────────────┘                │
│                                                          │
│  ... (paginated grid)                                    │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Your team: 6/15 agents  |  Budget: ~334 credits/day     │
│  Remaining daily budget: ~166 credits/day                │
└──────────────────────────────────────────────────────────┘
```

### 4.2 Agent Detail Modal (on [View])

```
┌──────────────────────────────────────────────────────────┐
│  SEO Expert                                    [× Close] │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Department: Marketing                                   │
│  Reports to: CMO (default)                               │
│  Model: Sonnet 4.6 (configurable)                        │
│  Est. cost: ~50 credits/day                              │
│                                                          │
│  Skills:                                                 │
│  [keyword-research] [on-page-seo] [technical-seo]        │
│  [content-optimization] [competitor-analysis]             │
│                                                          │
│  Description:                                            │
│  Specializes in search engine optimization. Conducts      │
│  keyword research, optimizes on-page elements, performs   │
│  technical SEO audits, and tracks ranking improvements.   │
│                                                          │
│  Integrations needed:                                    │
│  [browser] — for research and auditing live pages         │
│                                                          │
│  ┌─────────────────────────────────────────────────┐     │
│  │  Customize before hiring (optional):            │     │
│  │                                                 │     │
│  │  Name: [SEO Expert          ]                   │     │
│  │  Model: [Sonnet 4.6 ▼]                          │     │
│  │                                                 │     │
│  └─────────────────────────────────────────────────┘     │
│                                                          │
│  Impact on your budget:                                  │
│  Current: 334 credits/day → After hire: 384 credits/day  │
│  Days remaining at current balance: 12 → 10              │
│                                                          │
│              [Cancel]    [Hire Agent]                     │
└──────────────────────────────────────────────────────────┘
```

### 4.3 Sidebar Integration

After hiring, the new agent appears in the existing company sidebar agent list with status `idle`. The CEO is woken automatically and creates tasks for the new hire.

### 4.4 Team Management View Enhancement

Add to existing agents section in sidebar:
- **[+ Hire]** button at bottom of agent list → opens `/company/{id}/hire`
- **[Fire]** action in agent dropdown menu (with confirmation modal)
- Agent count: "Team: 8/15"

---

## 5. Implementation Order

### Phase 1: Data Layer (Backend)
1. Add `blueprint_catalog` table migration to worker
2. Create seed script to import agency-agents → catalog
3. Add `GET /api/blueprints/catalog` route with search/filter
4. Add `POST /api/companies/:id/agents/hire` route
5. Add `POST /api/companies/:id/agents/:agentId/terminate` route (if not already working)

### Phase 2: Supervisor Adaptation
1. Add `agent_hired` and `agent_terminated` to CEO event types
2. Build CEO wake prompts for hiring/termination events
3. Make CTO/CMO system prompts dynamic (query actual reports from DB)
4. Update `routing.ts` to use dynamic agent relationships
5. Wire supervisor sync to pick up new agents from D1

### Phase 3: Dashboard UI
1. Create `BlueprintCatalog` page component with grid layout
2. Create `AgentDetailModal` with hire customization
3. Add hire button to company sidebar
4. Add fire action to agent dropdown
5. Show budget impact calculations (credits/day before/after)
6. Add team count indicator

### Phase 4: Polish
1. Catalog search with fuzzy matching
2. "Recommended for your company" section (based on company goal + current team gaps)
3. Agent performance tracking (credits spent vs value delivered)
4. User-created custom blueprints (copy + edit from catalog)

---

## 6. Agent Limits & Guardrails

| Constraint | Value | Rationale |
|---|---|---|
| Max agents per company | 15 | Credit budget, VM resources |
| Max agents per department | 6 | Prevent top-heavy teams |
| Cannot fire founding CEO | ✓ | Company needs a coordinator |
| Cannot hire duplicate blueprints | ✓ | One SEO expert is enough |
| Credit balance warning | < 3 days runway after hire | Prevent instant budget drain |
| Hiring while paused | Blocked | Must have active credits |

---

## 7. How Agents Learn About New Teammates

The notification flow ensures agents don't operate with stale team knowledge:

```
User clicks [Hire Agent]
    │
    ▼
Worker creates agent row in D1
    │
    ▼
Supervisor syncs new agent from D1
    │
    ├──▶ CEO event: "agent_hired" enqueued
    │       │
    │       ▼
    │    CEO wakes, reviews team, creates/reassigns tasks
    │    CEO updates executive-brief.md
    │       │
    │       ▼
    │    If engineering agent: CEO assigns CTO a coordination task
    │    If marketing agent: CEO assigns CMO a coordination task
    │
    ├──▶ Next time CTO/CMO wakes, their system prompt
    │    dynamically includes the new agent in their reports list
    │
    └──▶ New agent sits idle until CEO/CTO/CMO assigns first task
```

No agent needs a "refresh" — system prompts are built fresh each turn from the current agents table. The hire event just triggers the CEO to create appropriate work.

---

## 8. Skills Registry & Agent Integrations

The skills system is what makes agents actually useful. Without it, agents are just prompts. With it, they can send emails, browse the web, post to social media, manage finances, and use any API integration the platform supports.

### 8.1 Skills Registry Table

```sql
CREATE TABLE skill_registry (
  id              TEXT PRIMARY KEY,           -- e.g. "email", "browser", "youtube-research"
  name            TEXT NOT NULL,              -- "Email"
  description     TEXT NOT NULL,              -- "Send and receive emails via AgentMail + Postmark"
  category        TEXT NOT NULL,              -- "communication", "research", "media", "finance", "dev-tools", "social", "productivity"
  icon            TEXT DEFAULT NULL,          -- Emoji or icon URL
  mcp_server      TEXT DEFAULT NULL,          -- MCP server name if backed by one (e.g. "email", "browser")
  config_schema   TEXT DEFAULT NULL,          -- JSON Schema for skill-specific configuration (API keys, accounts, etc.)
  requires_setup  BOOLEAN NOT NULL DEFAULT 0, -- Does user need to provide credentials?
  setup_guide     TEXT DEFAULT NULL,          -- Markdown instructions for setup
  credit_overhead INTEGER NOT NULL DEFAULT 0, -- Extra credits/day this skill adds to an agent
  max_per_agent   INTEGER NOT NULL DEFAULT 1, -- Usually 1, some skills allow multiple instances
  compatible_with TEXT NOT NULL DEFAULT '[]', -- JSON array of department names, or ["*"] for all
  is_active       BOOLEAN NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Seed skills from current MCP servers + new integrations:**

| id | name | category | mcp_server | requires_setup |
|---|---|---|---|---|
| `email` | Email | communication | `email` | No (AgentMail built-in) |
| `browser` | Web Browser | research | `browser` | No |
| `social-media` | Social Media | social | `social` | Yes (account tokens) |
| `finance` | Financial Tools | finance | `finance` | Yes (Stripe keys) |
| `domains` | Domain Management | dev-tools | `domain` | No (Cloudflare built-in) |
| `notion` | Notion | productivity | — | Yes (Notion API key) |
| `google-workspace` | Google Workspace | productivity | — | Yes (OAuth) |
| `linear` | Linear | productivity | — | Yes (API key) |
| `figma` | Figma (via browser) | design | `browser` | Yes (Figma token) |
| `youtube-research` | YouTube Research | research | — | Yes (SerpAPI or SuperData key) |
| `image-generation` | Image Generation | media | — | Yes (FAL/Replicate key) |
| `video-editing` | Video Editing | media | — | Yes (API key) |
| `slack` | Slack | communication | — | Yes (Bot token) |
| `telegram` | Telegram | communication | — | Yes (Bot token) |
| `discord` | Discord | communication | — | Yes (Bot token) |
| `analytics` | Web Analytics | research | `browser` | Yes (GA4/Plausible key) |
| `crm` | CRM | sales | — | Yes (HubSpot/Salesforce key) |
| `calendar` | Calendar | productivity | — | Yes (Google/Outlook OAuth) |

### 8.2 Agent Skills Table (per-agent configuration)

```sql
CREATE TABLE agent_skills (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  skill_id    TEXT NOT NULL REFERENCES skill_registry(id),
  enabled     BOOLEAN NOT NULL DEFAULT 1,
  config      TEXT DEFAULT NULL,             -- JSON: skill-specific config (API keys stored encrypted)
  priority    INTEGER NOT NULL DEFAULT 0,    -- Order in which agent considers skills
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, skill_id)
);

CREATE INDEX idx_agent_skills_agent ON agent_skills(agent_id);
```

### 8.3 How Skills Get Injected at Runtime

Skills need to reach the agent in two ways:

**a) MCP Servers (tool access)**
Skills backed by MCP servers give the agent actual tool capabilities. When building the agent's runtime config:

```typescript
// In agent-runner.ts or agent-invoker.ts
function resolve_agent_skills(agent_id: string): McpServerName[] {
  const skills = db.all<AgentSkillRow>(
    `SELECT sr.mcp_server, sr.id FROM agent_skills AS ask
     JOIN skill_registry sr ON sr.id = ask.skill_id
     WHERE ask.agent_id = ? AND ask.enabled = 1 AND sr.mcp_server IS NOT NULL`,
    [agent_id]
  );
  return skills.map(s => s.mcp_server).filter(Boolean);
}
```

**b) System Prompt Injection (awareness)**
All enabled skills — including non-MCP ones — get injected into the agent's system prompt so it knows what it can do:

```typescript
function build_skills_prompt_section(agent_id: string): string {
  const skills = db.all<{name: string, description: string, config: string | null}>(
    `SELECT sr.name, sr.description, ask.config FROM agent_skills ask
     JOIN skill_registry sr ON sr.id = ask.skill_id
     WHERE ask.agent_id = ? AND ask.enabled = 1
     ORDER BY ask.priority ASC`,
    [agent_id]
  );
  if (skills.length === 0) return "";

  const lines = skills.map(s => `- **${s.name}**: ${s.description}`);
  return [
    "# Your Skills & Integrations",
    "",
    "You have access to these capabilities:",
    ...lines,
    "",
    "Use the right tool for the job. If a task requires a skill you don't have, declare a blocker.",
  ].join("\n");
}
```

### 8.4 Skill Focus Guardrails

From the transcript insight: 7-10 skills per agent is the sweet spot. Beyond that, agents get confused and unreliable.

| Agent skills count | UI indicator | Behavior |
|---|---|---|
| 0-3 | Green: "Focused" | Normal |
| 4-7 | Green: "Well-equipped" | Normal |
| 8-10 | Yellow: "Near capacity" | Warning tooltip |
| 11+ | Red: "Overloaded — agent reliability may decrease" | Warning modal on add, requires confirmation |

**Dashboard shows:** "Skills: 6/10 recommended" with a progress bar that goes from green → yellow → red.

**Goal alignment check:** When adding a skill, if the agent has goals set, show: "Does this skill serve your agent's goals?" with the goals listed. Non-blocking, but makes users think before adding irrelevant skills.

---

## 9. Agent Config Editor (Full Customization)

Every hired agent — whether from catalog or custom — gets a settings page with deep configurability. This is the feature that makes OpenClaw terminal workflows obsolete.

**Route:** `/company/{id}/agents/{agentId}/settings`

### 9.1 Identity Tab

```
┌──────────────────────────────────────────────────────────┐
│  Identity                                                │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Name:     [Riley's Content Bot     ]                    │
│  Title:    [YouTube Content Strategist]                  │
│  Avatar:   [😎] [Upload custom]                          │
│                                                          │
│  Personality & Instructions:                             │
│  ┌────────────────────────────────────────────────────┐  │
│  │ You are a YouTube content strategist obsessed with │  │
│  │ retention curves. You analyze thumbnails, titles,  │  │
│  │ and hooks with a data-driven approach. You speak   │  │
│  │ in short, punchy sentences. You always back up     │  │
│  │ claims with data from competitor analysis...       │  │
│  │                                                    │  │
│  │ [Markdown editor with syntax highlighting]         │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Reports to: [CEO ▼]  (dropdown of current team leads)   │
│                                                          │
│  [Reset to catalog default]          [Save Changes]      │
└──────────────────────────────────────────────────────────┘
```

**DB changes:**
```sql
ALTER TABLE agents ADD COLUMN custom_system_prompt TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN custom_name TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN custom_title TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN icon TEXT DEFAULT NULL;
```

**Runtime behavior:** `build_system_prompt()` checks `custom_system_prompt` first. If set, it replaces the blueprint's `systemPrompt` (but the base framing — task system, signal protocol, superpowers — still wraps it).

### 9.2 Goals Tab

```
┌──────────────────────────────────────────────────────────┐
│  Goals & KPIs                                            │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  These goals guide your agent's decision-making.         │
│  When given a choice, the agent optimizes for these.     │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  1. [Increase YouTube subscribers    ]            │    │
│  │     Target: [10,000 subs          ]               │    │
│  │     How to measure: [Channel analytics  ]         │    │
│  │                                          [Remove] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  2. [Maximize video view count       ]            │    │
│  │     Target: [50,000 views/video   ]               │    │
│  │     How to measure: [YouTube Studio     ]         │    │
│  │                                          [Remove] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  3. [Drive conversions to product    ]            │    │
│  │     Target: [2% click-through     ]               │    │
│  │     How to measure: [UTM tracking       ]         │    │
│  │                                          [Remove] │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  [+ Add Goal] (max 5)                                    │
│                                                          │
│  ⚡ Goals are injected into your agent's system prompt   │
│  so it knows what to optimize for when making decisions. │
│                                                          │
│                                        [Save Changes]    │
└──────────────────────────────────────────────────────────┘
```

**DB:**
```sql
CREATE TABLE agent_goals (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  metric_name TEXT NOT NULL,              -- "Increase YouTube subscribers"
  target      TEXT DEFAULT NULL,          -- "10,000 subs"
  measurement TEXT DEFAULT NULL,          -- "Channel analytics"
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_goals_agent ON agent_goals(agent_id);
```

**Runtime injection:** Goals are appended to the agent's system prompt:
```
# Your Goals

You are optimizing for these objectives. When making decisions, prioritize accordingly:
1. Increase YouTube subscribers (target: 10,000 subs, measured via: Channel analytics)
2. Maximize video view count (target: 50,000 views/video, measured via: YouTube Studio)
3. Drive conversions to product (target: 2% click-through, measured via: UTM tracking)
```

### 9.3 Skills Tab

```
┌──────────────────────────────────────────────────────────┐
│  Skills & Integrations              Skills: 5/10 ████░░  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Active Skills:                                          │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ ☑ 🌐 Web Browser                                 │    │
│  │   Research, competitor analysis, page auditing     │    │
│  │   No setup required                    [Configure] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ ☑ 📊 YouTube Research                             │    │
│  │   Transcript scraping, competitor thumbnails       │    │
│  │   ⚙️ API Key: ••••••dk3f             [Configure] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ ☑ 🎨 Image Generation                             │    │
│  │   Thumbnail creation, visual assets                │    │
│  │   ⚙️ Provider: FAL                   [Configure] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ ☑ 📝 Notion                                       │    │
│  │   Script storage, content calendar                 │    │
│  │   ⚙️ Workspace: Content Team         [Configure] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ ☑ 📨 Email                                        │    │
│  │   Outreach, collaboration notifications            │    │
│  │   No setup required                    [Configure] │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  [+ Add Skill]                                           │
│                                                          │
│  ┌─ Add Skill ─────────────────────────────────────┐    │
│  │  [Search skills...]                              │    │
│  │                                                  │    │
│  │  Category: [All ▼]                               │    │
│  │                                                  │    │
│  │  ☐ 📱 Telegram — Messaging bot interface         │    │
│  │  ☐ 💬 Slack — Team communication                 │    │
│  │  ☐ 📈 Analytics — Web analytics tracking         │    │
│  │  ☐ 🗓️ Calendar — Schedule management             │    │
│  │  ☐ 🎬 Video Editing — Post-production            │    │
│  │                                                  │    │
│  │  ⚠️ Does this skill serve your goals?            │    │
│  │  → Increase YouTube subscribers                   │    │
│  │  → Maximize video view count                      │    │
│  │  → Drive conversions to product                   │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│                                        [Save Changes]    │
└──────────────────────────────────────────────────────────┘
```

**Skill Configuration Modal (on [Configure]):**

```
┌──────────────────────────────────────────────────────────┐
│  Configure: YouTube Research                   [× Close] │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  API Provider: [SuperData ▼]                             │
│                                                          │
│  API Key:      [sk-•••••••••••••dk3f   ] [Show] [Test]  │
│                                                          │
│  Options:                                                │
│  ☑ Enable transcript scraping                            │
│  ☑ Enable thumbnail analysis                             │
│  ☐ Enable comment sentiment analysis                     │
│                                                          │
│  Rate Limits:                                            │
│  Max requests/day: [100       ]                          │
│                                                          │
│  Status: ✅ Connected (last tested 2h ago)               │
│                                                          │
│                     [Cancel]    [Save Configuration]      │
└──────────────────────────────────────────────────────────┘
```

### 9.4 Model Tab

```
┌──────────────────────────────────────────────────────────┐
│  Model Selection                                         │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Choose the LLM that powers this agent:                  │
│                                                          │
│  ○ Claude Haiku 4.5                                      │
│    Fastest, cheapest. Good for routine tasks.             │
│    ~1 credit/1K input tokens, ~1 credit/1K output        │
│    Est. daily cost: ~20 credits                          │
│                                                          │
│  ● Claude Sonnet 4.6              ← current              │
│    Balanced speed and quality. Best for most agents.      │
│    ~1 credit/1K input, ~2 credits/1K output              │
│    Est. daily cost: ~50 credits                          │
│                                                          │
│  ○ Claude Opus 4.6                                       │
│    Most capable. Best for complex reasoning & planning.   │
│    ~2 credits/1K input, ~8 credits/1K output             │
│    Est. daily cost: ~120 credits                         │
│    ⚠️ Recommended only for leadership agents (CEO, CTO)  │
│                                                          │
│  Impact: 50 → 50 credits/day (no change)                 │
│                                                          │
│                                        [Save Changes]    │
└──────────────────────────────────────────────────────────┘
```

### 9.5 Schedule Tab

```
┌──────────────────────────────────────────────────────────┐
│  Autonomous Schedule                                     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  When should this agent wake up on its own?              │
│                                                          │
│  Mode:                                                   │
│  ○ On-demand only (wakes when assigned a task)           │
│  ● Recurring schedule                                    │
│  ○ Continuous (spreads work throughout the day)           │
│                                                          │
│  ┌─ Recurring Schedule ───────────────────────────┐     │
│  │                                                 │     │
│  │  Preset: [Every 2 hours ▼]                      │     │
│  │                                                 │     │
│  │  Presets:                                       │     │
│  │  • Every 30 minutes                             │     │
│  │  • Every hour                                   │     │
│  │  • Every 2 hours                                │     │
│  │  • Every 4 hours                                │     │
│  │  • 3x/day (9am, 1pm, 5pm)                      │     │
│  │  • Daily (9am)                                  │     │
│  │  • Custom cron: [*/120 * * * *    ]             │     │
│  │                                                 │     │
│  │  Active hours: [8:00 AM] to [8:00 PM] PT        │     │
│  │  ☑ Skip weekends                                │     │
│  │                                                 │     │
│  └─────────────────────────────────────────────────┘     │
│                                                          │
│  Recurring prompt (what the agent does each cycle):      │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Check YouTube analytics for our latest videos.     │  │
│  │ Analyze competitor uploads from the last 2 hours.  │  │
│  │ If anything noteworthy, update the content         │  │
│  │ calendar in Notion.                                │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Est. credit cost per cycle: ~8-15 credits               │
│  Est. daily cost at this schedule: ~60-90 credits        │
│                                                          │
│                                        [Save Changes]    │
└──────────────────────────────────────────────────────────┘
```

**DB changes:**
```sql
ALTER TABLE agents ADD COLUMN cron_schedule TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN cron_prompt TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN cron_active_start TEXT DEFAULT '08:00';
ALTER TABLE agents ADD COLUMN cron_active_end TEXT DEFAULT '20:00';
ALTER TABLE agents ADD COLUMN cron_skip_weekends BOOLEAN DEFAULT 0;
```

**Runtime:** The existing `CronManager` already supports per-agent cron tasks via the `cron_tasks` table. The schedule tab writes to `cron_tasks` with the agent's custom prompt.

### 9.6 Context Tab

```
┌──────────────────────────────────────────────────────────┐
│  Context & Reference Files                               │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Files uploaded here are available to this agent only.    │
│  The agent can read them from /workspace/.agent/{id}/ctx/ │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ 📄 brand-guidelines.md              12 KB  [×]   │    │
│  │ 📸 headshot-1.png                   340 KB [×]   │    │
│  │ 📸 headshot-2.png                   280 KB [×]   │    │
│  │ 📄 competitor-channels.csv          8 KB   [×]   │    │
│  │ 📄 content-playbook.md              24 KB  [×]   │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  [Upload Files]  [Paste Text as File]                    │
│                                                          │
│  Storage: 664 KB / 10 MB                                 │
│                                                          │
│  Context Instructions (tells agent how to use files):    │
│  ┌────────────────────────────────────────────────────┐  │
│  │ - headshot-1.png and headshot-2.png are photos of │  │
│  │   me (Riley) for thumbnail generation              │  │
│  │ - brand-guidelines.md has our color palette and    │  │
│  │   typography rules                                 │  │
│  │ - competitor-channels.csv lists channels to track  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│                                        [Save Changes]    │
└──────────────────────────────────────────────────────────┘
```

**API:**
```
POST /api/agents/{agentId}/context/upload    — multipart file upload
DELETE /api/agents/{agentId}/context/{filename}
GET /api/agents/{agentId}/context            — list files
PATCH /api/agents/{agentId}/context-instructions — update instructions text
```

**DB:**
```sql
ALTER TABLE agents ADD COLUMN context_instructions TEXT DEFAULT NULL;
```

**Storage:** Files go to `/workspace/.agent/{agent_id}/ctx/` on the supervisor's filesystem. The agent's system prompt gets an additional section:

```
# Your Context Files

You have reference files in /workspace/.agent/{agent_id}/ctx/:
- brand-guidelines.md (12 KB)
- headshot-1.png (340 KB)
- headshot-2.png (280 KB)
- competitor-channels.csv (8 KB)
- content-playbook.md (24 KB)

Instructions from your founder:
- headshot-1.png and headshot-2.png are photos of me (Riley) for thumbnail generation
- brand-guidelines.md has our color palette and typography rules
- competitor-channels.csv lists channels to track
```

### 9.7 Channels Tab (Output Destinations)

```
┌──────────────────────────────────────────────────────────┐
│  Output Channels                                         │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Where should this agent deliver work and notifications?  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │ ☑ 📊 Dashboard (always on)                       │    │
│  │   Results visible in company dashboard            │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ ☑ 📱 Telegram                                    │    │
│  │   Bot: @riley_content_bot                         │    │
│  │   Chat ID: -100198234567              [Configure] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ ☐ 💬 Slack                                       │    │
│  │   Not configured                      [Configure] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ ☐ 📧 Email                                       │    │
│  │   Not configured                      [Configure] │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ ☐ 🔗 Webhook                                     │    │
│  │   POST results to a URL               [Configure] │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  Notification rules:                                     │
│  ☑ Notify when task completed                            │
│  ☑ Notify when daily update written                      │
│  ☐ Notify on every agent turn (verbose)                  │
│                                                          │
│                                        [Save Changes]    │
└──────────────────────────────────────────────────────────┘
```

**DB:**
```sql
CREATE TABLE agent_channels (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  channel     TEXT NOT NULL,              -- "telegram", "slack", "email", "webhook"
  config      TEXT NOT NULL DEFAULT '{}', -- JSON: bot token, chat ID, webhook URL, etc.
  enabled     BOOLEAN NOT NULL DEFAULT 1,
  notify_on   TEXT NOT NULL DEFAULT '["task_done"]', -- JSON array of event types
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, channel)
);
```

---

## 10. Agent Lifecycle Actions

Beyond hire/fire, agents need lifecycle operations accessible from the settings page or sidebar:

### 10.1 Duplicate Agent

```
POST /api/companies/:companyId/agents/:agentId/duplicate
Body: { name?: string }
```

1. Read source agent's full config (prompt, skills, goals, schedule, context instructions)
2. Create new agent row with same config but new ID
3. Copy context files to new agent's directory
4. Copy skill assignments
5. Copy goals
6. Copy channel config
7. Enqueue CEO event: `agent_hired`

UI: **[Duplicate]** button in agent settings header → modal to rename → creates clone.

### 10.2 Export Agent Config

```
GET /api/companies/:companyId/agents/:agentId/export
```

Returns a JSON blob:
```json
{
  "version": "1.0",
  "name": "Riley's Content Bot",
  "title": "YouTube Content Strategist",
  "system_prompt": "You are a YouTube content strategist...",
  "model_tier": "sonnet-4-6",
  "goals": [
    { "metric_name": "Increase YouTube subscribers", "target": "10,000 subs" }
  ],
  "skills": [
    { "skill_id": "browser", "config": {} },
    { "skill_id": "youtube-research", "config": { "provider": "superdata" } }
  ],
  "schedule": {
    "cron": "*/120 * * * *",
    "prompt": "Check YouTube analytics...",
    "active_hours": ["08:00", "20:00"]
  },
  "context_instructions": "headshot-1.png and headshot-2.png are photos of me...",
  "channels": [
    { "channel": "telegram", "config": { "chat_id": "-100198234567" } }
  ]
}
```

UI: **[Export]** button → downloads `.json` file. Shareable with teammates or community.

### 10.3 Import Agent Config

```
POST /api/companies/:companyId/agents/import
Body: { config: AgentExportBlob }
```

1. Validate config blob schema
2. Create agent from config
3. Map skills to available skill registry (warn if some skills unavailable)
4. Create goals, channels
5. Prompt user for any `requires_setup` skill credentials
6. Enqueue CEO event: `agent_hired`

UI: **[Import Agent]** button on hire page → file picker or paste JSON.

### 10.4 Create from Scratch

```
POST /api/companies/:companyId/agents/create-custom
Body: { name, title, system_prompt, model_tier, department, reports_to }
```

UI: **[Create Custom Agent]** button on hire page → opens the config editor with all tabs blank. User fills in identity, goals, skills from scratch.

---

## 11. How Custom Config Overrides Work at Runtime

The prompt assembly priority chain in `build_system_prompt()`:

```
1. Base framing (task system, signal protocol, workspace rules)
   └── Always injected. User cannot override.

2. Agent personality prompt
   └── Source priority:
       a) agent.custom_system_prompt (if user edited Identity tab)
       b) blueprint_catalog.system_prompt (if hired from catalog)
       c) blueprints.ts hardcoded prompt (founding agents only)

3. Goals section
   └── Queried from agent_goals table. Injected as "# Your Goals" block.
       Only present if user set goals.

4. Skills section
   └── Queried from agent_skills + skill_registry. Injected as
       "# Your Skills & Integrations" block.
       Replaces hardcoded mcpServers from blueprint.

5. Context section
   └── Lists files in /workspace/.agent/{id}/ctx/ + context_instructions.
       Only present if user uploaded context.

6. Superpowers methodology
   └── Always injected for engineering department agents.
       User cannot override (it's a quality baseline).
```

**Key invariant:** Users can customize personality, goals, skills, and context. They cannot remove the base framing (task system, signals) or superpowers (engineering quality). This ensures agents remain functional within the orchestration system no matter how much the user customizes.

---

## 12. Why This Beats OpenClaw + Terminal

| Capability | OpenClaw (terminal) | AI Combinator (dashboard) |
|---|---|---|
| Edit agent prompt | SSH into Mac, edit `.md` file | Click Identity tab, edit in browser |
| Add a skill/integration | Install npm package, edit `openclaw.json` | Toggle in Skills tab, paste API key |
| Change LLM model | Edit config file, restart | Click radio button, see cost impact |
| Set up cron schedule | Write cron expression manually | Pick preset or custom, set active hours |
| Upload context files | SCP/copy files to workspace | Drag and drop in browser |
| Duplicate an agent | Manually copy directory, edit configs | Click [Duplicate], rename |
| Share agent with teammate | ZIP directory, send, unzip, reconfigure | Click [Export], send JSON, [Import] |
| Set goals/KPIs | Add to prompt manually, hope agent reads it | Structured form, injected automatically |
| See budget impact | Calculate token costs manually | Real-time credit estimate in UI |
| Monitor agent activity | Read terminal logs | Dashboard with status, turn history |
| Hire a new specialist | Research prompts, write from scratch | Browse catalog of 100+ templates |
| Wire output to Telegram | Set up bot, configure gateway, edit config | Paste bot token in Channels tab |

**The thesis:** Every single thing the transcript user does manually in a terminal, our users do in a browser with visual feedback and guardrails. Same power, zero terminal.

---

## 13. Org Chart — Task Assignment Hierarchy & Visual Organigram

### 13.1 Current Problem

Task routing is completely hardcoded in `routing.ts`:

```typescript
// Static lookup tables — cannot adapt to new agents
ASSIGNMENT_TABLE = {
  ceo: ["cto", "cmo"],
  cto: ["frontend-dev", "backend-dev", "qa-tester"],
};
REPORTS_TO_TABLE = {
  cto: "ceo", cmo: "ceo",
  "frontend-dev": "cto", "backend-dev": "cto", "qa-tester": "cto",
};
```

This breaks the moment a user hires a new agent. If they hire an "SEO Specialist", it's invisible to the routing system — the CEO can't assign it tasks, the CMO can't delegate to it, and nobody receives its status reports.

### 13.2 Dynamic Hierarchy Rules

Replace static tables with rules derived from the `agents` table itself. The `reports_to` column on each agent already defines the tree — we just need to enforce it.

**Core rule: An agent can assign tasks to any agent that directly reports to it.**

```typescript
// routing.ts — new implementation
export function canAssignTo(
  assigner_id: string,
  assignee_id: string,
  company_agents: AgentRow[],
): boolean {
  const assignee = company_agents.find(a => a.id === assignee_id);
  if (!assignee) return false;
  // Direct reports only — no skip-level assignment
  return assignee.reports_to === assigner_id;
}

export function getReportTarget(
  agent_id: string,
  company_agents: AgentRow[],
): string | undefined {
  const agent = company_agents.find(a => a.id === agent_id);
  return agent?.reports_to || undefined;
}

export function getDirectReports(
  agent_id: string,
  company_agents: AgentRow[],
): AgentRow[] {
  return company_agents.filter(
    a => a.reports_to === agent_id && a.status !== "terminated"
  );
}
```

**Call sites that need updating** (4 files):
- `task-manager.ts` lines 358, 482, 558 — pass `company_agents` array
- `scheduler.ts` line 1237 — pass `company_agents`
- `agent-runner.ts` lines 1159, 1220, 1259 — pass `company_agents`
- CEO system prompt in `agent-runner.ts` — dynamically list direct reports

### 13.3 Assignment Privilege Tiers

Not every agent can delegate. The hierarchy enforces three tiers:

| Tier | Role | Can assign to | Can create subtasks | Can reassign |
|---|---|---|---|---|
| **Executive** | CEO | Direct reports (CTO, CMO, + any agent reporting to CEO) | No (delegates via plan_update) | Yes (any task) |
| **Manager** | CTO, CMO, or any agent with direct reports | Their direct reports only | Yes (subtask_request.json) | Own team's tasks only |
| **Specialist** | Any agent with no reports | Nobody | No | No |

**Tier is computed, not stored:**
```typescript
function getAgentTier(agent_id: string, company_agents: AgentRow[]): "executive" | "manager" | "specialist" {
  const agent = company_agents.find(a => a.id === agent_id);
  if (!agent) return "specialist";
  if (agent.blueprint_id === "ceo" || agent.role === "ceo") return "executive";
  const reports = company_agents.filter(a => a.reports_to === agent_id && a.status !== "terminated");
  return reports.length > 0 ? "manager" : "specialist";
}
```

**What this enables:**
- User hires "SEO Specialist" → reports_to CMO → CMO can now assign tasks to it
- User hires "DevOps Engineer" → reports_to CTO → CTO can delegate infrastructure work
- User hires "Sales Manager" → reports_to CEO → they become a manager if user later hires "SDR" reporting to them
- User promotes a specialist to manager simply by hiring agents that report to it

### 13.4 Changing the Hierarchy (User Controls)

Users can rewire reporting lines from two places:

**a) Agent Settings → Identity Tab**

The "Reports to" dropdown already proposed in Section 9.1. Lists all agents in the company that are executive or manager tier. Changing it updates `agents.reports_to` and triggers a CEO event.

**b) Org Chart drag-and-drop (see 13.5)**

Drag an agent node to a new parent → updates `reports_to` → CEO gets notified.

**Constraints enforced on hierarchy changes:**
- CEO always exists and has no parent (root node)
- No circular reporting (A reports to B, B reports to A)
- Max depth: 4 levels (CEO → Manager → Sub-manager → Specialist)
- An agent cannot report to itself
- Terminated agents cannot be parents

**Validation:**
```typescript
function validateReportingChange(
  agent_id: string,
  new_parent_id: string,
  company_agents: AgentRow[],
): { valid: boolean; error?: string } {
  if (agent_id === new_parent_id) return { valid: false, error: "Cannot report to self" };

  const agent = company_agents.find(a => a.id === agent_id);
  if (agent?.blueprint_id === "ceo") return { valid: false, error: "CEO cannot have a parent" };

  const parent = company_agents.find(a => a.id === new_parent_id);
  if (!parent || parent.status === "terminated") return { valid: false, error: "Invalid parent" };

  // Check for circular reference
  let cursor = new_parent_id;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === agent_id) return { valid: false, error: "Circular reporting chain" };
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const current = company_agents.find(a => a.id === cursor);
    cursor = current?.reports_to ?? "";
  }

  // Check depth (agent would be at parent's depth + 1)
  let depth = 1;
  cursor = new_parent_id;
  while (cursor) {
    depth++;
    const current = company_agents.find(a => a.id === cursor);
    cursor = current?.reports_to ?? "";
  }
  if (depth > 4) return { valid: false, error: "Max hierarchy depth is 4 levels" };

  return { valid: true };
}
```

### 13.5 Organigram — Visual Org Chart in Dashboard

**Route:** `/company/{id}/org` (new tab in company dashboard)

**Layout:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Organization Chart                        [Edit Mode] [+ Hire] │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                         ┌──────────┐                             │
│                         │ 👔 CEO   │                             │
│                         │  Opus    │                             │
│                         │ ● active │                             │
│                         └────┬─────┘                             │
│                    ┌─────────┼──────────┐                        │
│                    ▼         ▼          ▼                         │
│              ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│              │ 💻 CTO   │ │ 📣 CMO   │ │ 📊 Sales │              │
│              │ Sonnet   │ │ Sonnet   │ │  Manager │              │
│              │ ● active │ │ ○ idle   │ │ ○ idle   │              │
│              └────┬─────┘ └────┬─────┘ └──────────┘              │
│           ┌───────┼───────┐    │                                 │
│           ▼       ▼       ▼    ▼                                 │
│     ┌─────────┐┌─────────┐┌────────┐┌──────────┐                │
│     │ 🎨 FE   ││ ⚙️ BE   ││ 🧪 QA  ││ 🔎 SEO   │                │
│     │  Dev    ││  Dev    ││ Tester ││ Expert   │                │
│     │ Sonnet  ││ Sonnet  ││ Sonnet ││ Sonnet   │                │
│     │ ● work  ││ ○ idle  ││ ○ idle ││ ○ idle   │                │
│     └─────────┘└─────────┘└────────┘└──────────┘                │
│                                                                  │
│  Legend:  ● working  ○ idle  ◉ error  ◌ paused                   │
│                                                                  │
│  ─────────────── Assignment Flow ───────────────                 │
│  CEO assigns to → CTO, CMO, Sales Manager                       │
│  CTO delegates to → FE Dev, BE Dev, QA Tester                   │
│  CMO delegates to → SEO Expert                                   │
│  Sales Manager → (no reports yet — hire SDRs?)                   │
│                                                                  │
│  Team: 9/15 agents │ Daily burn: ~480 credits │ Depth: 3 levels  │
└──────────────────────────────────────────────────────────────────┘
```

**Edit Mode interactions:**
- **Drag agent node** to a new parent → confirms with validation → updates `reports_to`
- **Click agent node** → opens agent settings page
- **Click [+ Hire]** → opens hire page, pre-selects "reports to" based on where you click
- **Right-click agent** → context menu: Settings, Duplicate, Fire, Change Model
- **Hover agent** → tooltip: skills, goals, last activity, credits consumed today

**Implementation:**

Use a tree layout library (e.g., `d3-hierarchy` or `reactflow` which you may already use). Data source:

```typescript
// Build tree from flat agents list
function buildOrgTree(agents: AgentRow[]): OrgNode {
  const ceo = agents.find(a => a.blueprint_id === "ceo" || a.role === "ceo");
  if (!ceo) throw new Error("No CEO found");

  function buildNode(agent: AgentRow): OrgNode {
    const children = agents.filter(
      a => a.reports_to === agent.id && a.status !== "terminated"
    );
    return {
      id: agent.id,
      name: agent.custom_name || agent.name,
      title: agent.custom_title || agent.title,
      blueprint_id: agent.blueprint_id,
      model_tier: agent.model_tier,
      status: agent.status,
      icon: agent.icon,
      children: children.map(buildNode),
    };
  }

  return buildNode(ceo);
}
```

**API endpoint:**
```
GET /api/companies/:id/org-chart
Response: {
  tree: OrgNode,                    // nested tree structure
  stats: {
    total_agents: number,
    max_agents: number,
    daily_burn: number,
    max_depth: number,
  },
  assignment_edges: [               // for rendering arrow overlays
    { from: "ceo-id", to: "cto-id" },
    { from: "cto-id", to: "fe-dev-id" },
    ...
  ]
}

PATCH /api/companies/:id/org-chart
Body: { agent_id: string, new_reports_to: string }
// Validates hierarchy, updates agents.reports_to, enqueues CEO event
```

### 13.6 Default Org Structures by Company Type

When a new company is provisioned, the CEO selects the founding team. But the catalog also suggests org templates:

| Company Type | Default Org |
|---|---|
| SaaS Product | CEO → CTO (FE, BE, QA) + CMO |
| Content/Media | CEO → Content Manager (Writers, SEO, Designer) + CMO (Social, Email) |
| E-commerce | CEO → CTO (FE, BE) + CMO (SEO, Email, Ads) + Sales Manager |
| Agency/Services | CEO → PM (FE, BE, QA) + CMO + Sales Manager (SDRs) |
| Solo/Newsletter | CEO → Content Agent + Email Agent |

These are just starting points — the user can rewire everything from the org chart.

### 13.7 How This Flows Through the System

```
User drags "SEO Expert" from under CMO to under CTO in org chart
    │
    ▼
Dashboard: PATCH /api/companies/:id/org-chart
    { agent_id: "seo-xyz", new_reports_to: "cto-abc" }
    │
    ▼
Worker: validates hierarchy (no cycles, depth ≤ 4)
    │
    ▼
Worker: UPDATE agents SET reports_to = 'cto-abc' WHERE id = 'seo-xyz'
    │
    ▼
Supervisor syncs change
    │
    ├──▶ CEO event: "org_change" enqueued
    │    CEO wakes → reviews change → updates plan if needed
    │
    ├──▶ Next CTO turn: system prompt now lists SEO Expert as a report
    │    CTO can now assign tasks to SEO Expert
    │
    └──▶ Next CMO turn: system prompt no longer lists SEO Expert
         CMO can no longer assign tasks to it
```

No agent needs a restart. System prompts are built fresh every turn from the current `agents` table. The org chart is always the source of truth.

---

## 14. Revised Implementation Phases

### Phase 1: Data Foundation
1. Migration: `blueprint_catalog`, `skill_registry`, `agent_skills`, `agent_goals`, `agent_channels` tables
2. Migration: New columns on `agents` — `custom_system_prompt`, `custom_name`, `custom_title`, `icon`, `context_instructions`, `cron_schedule`, `cron_prompt`
3. Seed `skill_registry` with current MCP servers + planned integrations
4. Seed `blueprint_catalog` from agency-agents repo
5. API: `GET /api/blueprints/catalog`, `GET /api/skills`

### Phase 2: Dynamic Routing & Org Chart
1. Rewrite `routing.ts` — replace static tables with `reports_to`-based queries
2. Update all call sites in `task-manager.ts`, `scheduler.ts`, `agent-runner.ts` to pass `company_agents`
3. Add hierarchy validation (no cycles, max depth 4, no self-reference)
4. Add `org_change` CEO event type
5. Make CTO/CMO/manager system prompts dynamically list their reports
6. API: `GET /api/companies/:id/org-chart`, `PATCH /api/companies/:id/org-chart`
7. Dashboard: Org chart page with tree visualization
8. Dashboard: Drag-and-drop to rewire reporting lines (edit mode)

### Phase 3: Hiring Flow
1. API: `POST /api/companies/:id/agents/hire`
2. API: `POST /api/companies/:id/agents/:id/terminate`
3. Supervisor: `agent_hired` / `agent_terminated` CEO events
4. Dashboard: Hire page with catalog grid + detail modal
5. Dashboard: Fire action in sidebar + org chart context menu

### Phase 4: Agent Config Editor
1. Dashboard: Agent settings page with all 7 tabs (Identity, Goals, Skills, Model, Schedule, Context, Channels)
2. API: `PATCH /api/agents/:id/settings` (identity, model, schedule)
3. API: Agent skills CRUD (`POST/DELETE /api/agents/:id/skills`)
4. API: Agent goals CRUD (`POST/PATCH/DELETE /api/agents/:id/goals`)
5. API: Agent channels CRUD
6. API: Context file upload/delete
7. Supervisor: `build_system_prompt()` reads custom prompt + goals + skills + context from DB
8. Supervisor: Skill-to-MCP resolution from `agent_skills` table instead of blueprint

### Phase 5: Agent Lifecycle
1. API + UI: Duplicate agent
2. API + UI: Export/Import agent config JSON
3. API + UI: Create custom agent from scratch
4. Dashboard: Skill focus guardrails (count indicator, goal alignment prompt)

### Phase 6: Channels & Notifications
1. Telegram bot gateway per agent
2. Slack webhook integration
3. Email notification channel
4. Generic webhook channel
5. Notification routing based on `agent_channels` config

### Phase 7: Community & Sharing
1. Public agent template gallery (curated exports)
2. "Publish to community" flow from export
3. One-click deploy from community gallery
4. Agent ratings and usage stats

---

## 15. Architecture Audit — Compatibility with Current Codebase

Audited 2026-03-15 against the live codebase. This section documents what fits, what needs targeted fixes, and what's missing.

### 15.1 What Already Exists and Fits

| Assumption in Plan | Current Status | Notes |
|---|---|---|
| `blueprint_id` column on agents | Present (migration 004) | Used by `getBlueprint()` |
| `model_tier` column on agents | Present (migration 004) | Default `'haiku'` in D1, overridden at runtime |
| `reports_to` column on agents | Present (migration 001) | Used for hierarchy but routing ignores it |
| D1 is source of truth | Confirmed | Supervisor pulls from D1 via `bootstrapFromRemote()` |
| Supervisor syncs bidirectionally | Confirmed | Inbound: D1→SQLite. Outbound: `sync_queue`→D1 |
| CEO event queue plumbing | Confirmed | `notify_ceo()`, `drain_ceo_event_queue()`, `deliver_ceo_event()` all work |
| Agent termination endpoint | Exists | `POST /api/agents/:id/terminate` — but doesn't enqueue CEO events |
| Agent creation endpoint | Exists | `POST /api/companies/:companyId/agents` — freeform, not catalog-driven |
| Cron task system | Exists | `cron_tasks` table + `CronManager` — schedule tab can write directly to this |
| Shared container per company | Confirmed | All agents share one Docker container + `/workspace` volume |
| System prompts built fresh per turn | Confirmed | `build_system_prompt()` called each invocation, no caching |
| Email reservation per agent | Exists | `reserveAgentEmailAddress()` in agent creation flow |

### 15.2 Hard Problems (Require Targeted Fixes)

#### Problem 1: MCP Servers Baked into Container at Bootstrap

**Current behavior:** `container-manager.ts` generates `docker-compose.yml` with MCP servers from `FOUNDING_BLUEPRINTS` only. MCP servers are started as sidecars when the container boots.

**Impact:** Hiring an agent that needs a new MCP server (e.g., `finance`, `social`) won't have access to it unless the container is rebuilt.

**Fix (recommended):**
```
On agent hire:
  1. Resolve required MCP servers from blueprint
  2. Compare against currently running MCP servers in container
  3. If new servers needed → rebuild container (restart docker-compose)
     - /workspace is a mounted volume, survives restart
     - Active agent sessions are aborted (they'll resume next turn)
     - Takes ~5-10 seconds
  4. If no new servers needed → no restart
```

**Where to implement:** `scheduler.ts` after processing `agent_hired` event — call `container_manager.ensure_mcp_servers(company_id, required_servers)`.

**Risk level:** Low. Container restarts are fast, workspace persists, and agents resume automatically.

#### Problem 2: Blueprint Loading Only from Hardcoded `FOUNDING_BLUEPRINTS`

**Current behavior:** `getBlueprint(id)` searches an in-memory `Map` built from the 6 founding blueprints. Hired agents with catalog blueprint IDs (e.g., `"seo-specialist"`) return `undefined`.

**Impact:** `build_system_prompt()` falls back to the base prompt without the blueprint's personality/instructions. Agent works but has no specialization.

**Fix:**
```typescript
// In agent-runner.ts build_system_prompt():
const blueprint = agent.blueprint_id ? getBlueprint(agent.blueprint_id) : undefined;

// If not a founding blueprint, check supervisor's local SQLite
// (which syncs blueprint_catalog from D1)
const catalog_prompt = !blueprint && agent.blueprint_id
  ? db.get<{system_prompt: string}>(
      `SELECT system_prompt FROM blueprint_catalog WHERE id = ?`,
      [agent.blueprint_id]
    )?.system_prompt
  : undefined;

const personality = blueprint?.systemPrompt ?? catalog_prompt ?? "";
const prompt = personality ? `${base}\n\n${personality}` : base;
```

**Where to implement:**
- Add `blueprint_catalog` to supervisor's local SQLite schema (`db.ts`)
- Add `blueprint_catalog` to sync pull in `sync.ts` (`bootstrapFromRemote`)
- Update `build_system_prompt()` fallback in `agent-runner.ts`

**Risk level:** Low. Additive change, founding blueprints unaffected.

#### Problem 3: Supervisor Only Syncs Agents at Bootstrap

**Current behavior:** `bootstrapFromRemote()` pulls agents from D1 into local SQLite. This runs once at supervisor startup. If an agent is hired while the supervisor is running, it won't see the new agent.

**Impact:** Hired agents sit invisible to the supervisor until restart.

**Fix options:**

a) **Event-driven (recommended):** Worker calls supervisor's internal API after hire:
```
POST /internal/companies/:id/sync-agents
```
Supervisor re-fetches agents for that company from D1 and upserts locally.

b) **Periodic:** Add agent sync to the existing 5-second sync tick. Heavier but simpler.

c) **Already partially there:** The supervisor's internal API already has company-scoped endpoints. Adding one more is trivial.

**Where to implement:** `sync.ts` — add `syncAgentsForCompany(company_id)` method. Wire to internal API in `api.ts`.

### 15.3 What's Missing (Must Be Built)

| Missing Piece | Effort | Plan Section |
|---|---|---|
| `blueprint_catalog` D1 table | 1 migration | 1.1 |
| `skill_registry` D1 table | 1 migration | 8.1 |
| `agent_skills` D1 table | 1 migration | 8.2 |
| `agent_goals` D1 table | 1 migration | 9.2 |
| `agent_channels` D1 table | 1 migration | 9.7 |
| New columns on `agents`: `custom_system_prompt`, `custom_name`, `custom_title`, `context_instructions` | 1 migration | 9.1, 9.6 |
| Seed script for `blueprint_catalog` from agency-agents | 1 script | 1.2 |
| Seed data for `skill_registry` | 1 script | 8.1 |
| `GET /api/blueprints/catalog` endpoint | 1 route | 2.1 |
| `POST /api/companies/:id/agents/hire` endpoint | 1 route | 2.2 |
| `GET /api/companies/:id/org-chart` endpoint | 1 route | 13.5 |
| `PATCH /api/companies/:id/org-chart` endpoint | 1 route | 13.5 |
| Agent skills CRUD endpoints | 3 routes | 8.2 |
| Agent goals CRUD endpoints | 3 routes | 9.2 |
| Context file upload endpoint | 1 route | 9.6 |
| `agent_hired`, `agent_terminated`, `org_change` CEO event types | 3 lines in types.ts | 3.1 |
| CEO wake prompts for hire/fire/reorg | 3 prompt templates | 3.2, 3.3 |
| Dynamic routing in `routing.ts` | 1 file rewrite | 13.2 |
| Update 4 call sites for dynamic routing | ~20 lines across 3 files | 13.2 |
| `blueprint_catalog` in supervisor local SQLite + sync | ~30 lines | 15.2 |
| `build_system_prompt()` catalog fallback | ~10 lines | 15.2 |
| Container MCP hot-reload | ~40 lines | 15.2 |
| Agent sync endpoint on supervisor | ~20 lines | 15.2 |
| Dashboard: Hire page | 1 page component | 4.1 |
| Dashboard: Agent settings (7 tabs) | 1 page + 7 tab components | 9.1-9.7 |
| Dashboard: Org chart | 1 page component | 13.5 |

### 15.4 What Does NOT Need Changing

- `CronManager` — already supports per-agent crons, schedule tab writes to `cron_tasks`
- `CreditManager` — already tracks per-agent credit usage, no changes needed
- `TaskManager` — task creation/assignment works, just needs dynamic routing passed in
- `AgentInvoker` — invocation pipeline unchanged, just needs MCP resolution update
- `SyncManager` — bidirectional sync works, just needs `blueprint_catalog` added to pull
- `StallDetector` — works on any agent regardless of how it was created
- Dashboard sidebar — already renders agents dynamically from API response
- SSE real-time updates — already emit agent status changes

### 15.5 Migration Dependency Order

```
Migration 005: blueprint_catalog, skill_registry
Migration 006: agent_skills, agent_goals, agent_channels
Migration 007: agents ADD custom_system_prompt, custom_name, custom_title, context_instructions
```

Must run in order. 006 depends on 005 (foreign keys to skill_registry). 007 is independent.

### 15.6 Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Container restart disrupts active turns | Medium | Low | Turns auto-resume; add grace period before restart |
| Blueprint catalog sync lag | Low | Medium | Event-driven sync on hire, not periodic |
| Too many agents overwhelm CEO planning | Medium | Medium | Max 15 agents guardrail; warn at 10+ |
| MCP server conflicts between agents | Low | High | Each MCP server runs once per container, shared by all agents |
| Circular reporting chains | Low | High | Validation function prevents; DB constraint as backup |
| Credit burn spike after hiring spree | Medium | Medium | Budget impact shown before hire; daily burn estimate in UI |
