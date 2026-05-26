# CEO Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: CEO agent design, tool surface, provider selection, and runtime contract. No implementation in this document.

## 1. Objective

Build a CEO agent that is:

- founder-facing at all times
- aware of the real company state, not stale memory
- able to set direction, delegate, hire, escalate, and report
- reliable enough to be left running autonomously
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The CEO is not a general-purpose "do everything" agent. It is the company controller:

- it steers the mission
- it maintains the canonical execution contract
- it delegates to CTO and CMO
- it requests founder approval when needed
- it reports to the founder once per day and any time founder action is needed
- it stays continuously available in founder chat

## 2. Non-goals

The CEO should not be the default implementer of product, marketing, or operations work.

The CEO should not:

- ship product code instead of the CTO and engineers
- procure API keys instead of the API Specialist
- manually run ads or publish campaigns instead of the CMO org
- directly approve its own risky actions
- rely on freeform markdown handoffs as the primary coordination system
- depend on long-lived hidden model memory for "awareness"

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and docs

This design changes the CEO implementation, not the whole product model.

The most important existing weaknesses that this design must eliminate:

- stale session memory overriding live state
- multiple competing company directions
- freeform, non-auditable delegation
- overpowered tool access (`bypassPermissions`)
- no single writer for coordination state
- founder chat that can answer without actually changing execution

## 4. Recommended runtime

### 4.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- Anthropic describes Opus 4.6 as its strongest model and positions it specifically as the most capable model for building agents and coding.
- It supports extended thinking, adaptive thinking, and long context, which matters because the CEO must reconcile founder chat, live task state, canonical docs, and cross-team tradeoffs.

Implementation requirement:

- do not run the CEO in `bypassPermissions`
- use explicit `allowedTools` / `disallowedTools`
- default to `acceptEdits` only for the autonomous lane

This is a hard requirement. The current `bypassPermissions` configuration is wrong for a founder-facing control agent.

### 4.2 Driver abstraction

The CEO must not be hard-coded to Anthropic-only logic. Add a provider-neutral driver interface and keep the CEO tools above it.

Recommended abstraction:

```ts
interface AgentDriver {
  provider: "anthropic" | "openai" | "openclaw" | "custom";
  supportsStreaming: boolean;
  supportsMcp: boolean;
  supportsSkills: boolean;

  runTurn(input: DriverTurnInput): Promise<DriverTurnResult>;
  streamTurn(input: DriverTurnInput, handlers: DriverStreamHandlers): Promise<DriverTurnResult>;
  resetSession(sessionKey: string): Promise<void>;
}
```

The CEO tool plane should stay the same even if the model driver changes later.

## 5. Control-plane architecture

### 5.1 Core decision

Do not make the CEO talk directly to D1 for mutations.

Instead:

- use a per-company `CompanyCoordinator` service running on the supervisor VM as the serialized mutation layer
- keep hot coordination state in local SQLite on that same VM
- mirror authoritative history to D1 for dashboard reads, audit, and analytics

Why:

- all company agents already share the same VM and workspace
- the system still needs transactional, strongly consistent coordination state
- a local coordinator avoids unnecessary network hops while keeping a single serialized writer

This is the best fit for:

- task ownership changes
- inter-agent messages
- hiring requests
- approvals
- founder directives
- workflow stage transitions

### 5.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - live coordination state
  - idempotency keys
  - per-agent inbox/outbox state
  - current workflow transitions
  - founder directive queue
- D1:
  - queryable historical mirror for dashboard
  - approvals history
  - activity log
  - task history
  - founder chat history
- workspace:
  - canonical docs and founder-viewable artifacts

### 5.3 Source-of-truth order

The CEO must treat state in this order:

1. Coordinator live state
2. D1 mirrored state
3. canonical workspace docs
4. recent founder thread
5. session memory

Session memory is never authoritative.

## 6. CEO lanes

The CEO should run as three separate lanes, not one shared session.

### 6.1 Founder chat lane

Purpose:

- answer the founder quickly
- read current company state
- convert founder directives into execution

Properties:

- stateless per message
- session reset every turn
- fresh context injected every time
- streaming enabled
- read-heavy, mutation-light

Allowed mutations:

- create a founder directive event
- create a strategy change request
- send founder reply email if chat was initiated from email

Not allowed:

- direct hiring
- direct task graph rewrites
- direct approval creation

Instead, founder chat should call one internal tool like `org.commit_founder_directive(...)`, which wakes the autonomous CEO lane.

### 6.2 Autonomous CEO lane

Purpose:

- maintain strategy
- write control docs
- delegate work
- review CTO/CMO/QA output
- request hires and approvals

Properties:

- autonomous
- can edit workspace control docs
- can mutate structured company state through the coordinator
- can send founder emails

### 6.3 Daily recap lane

Purpose:

- send one digest to the founder every day

Properties:

- scheduled
- read-only except email send
- no hiring, no task mutation

### 6.4 Action-needed lane

Purpose:

- notify founder when a real approval or blocker exists

Properties:

- event-driven
- read-only plus approval email send
- must include direct link or embedded summary of what needs approval

## 7. CEO tool surface

The CEO should use a small number of high-quality tools with strong contracts. The CEO should not get raw access to everything "just in case."

### 7.1 Tooling principles

- every write tool must be structured and idempotent
- every tool must return founder-readable summaries
- all tool output must be auditable
- no raw SQL tool
- no raw deploy tool
- no direct payment / card tool
- no unrestricted shell

### 7.2 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | CEO access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.create_tasks`, `org.reassign_task`, `org.send_message`, `org.request_hire`, `org.create_approval`, `org.record_directive` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Best fit for serialization, replayability, audit, and future multi-provider compatibility | Full |
| Workspace docs | `Read`, `Glob`, `Grep`, `Edit`, `Write` on control docs only | Claude Code built-in tools | Highest reliability for local shared workspace manipulation | Full in autonomous lane, read-only in founder chat lane |
| Founder email outbound | `mail.send_founder_email` | Postmark API | Best-in-class transactional email focus and clean API for daily recap / action-needed sends | Full |
| Founder/CEO inbound aliases | email route -> Worker event -> CEO lane | Cloudflare Email Routing + Email Workers | Domain-native catch-all routing on `aicombinator.live`, easy routing logic, already aligned with platform | Event source, not direct tool |
| Web search | `research.search_web` | Brave Search API | Independent search index, direct search API, dedicated web/news/LLM context endpoints | Full |
| URL fetch and extraction | `research.fetch_url` | Internal fetch/extract tool over standard HTTP | Faster and cheaper than a browser for simple pages; easier to cache and audit | Full |
| Browser inspection | `browser.open`, `browser.inspect`, `browser.screenshot`, `browser.extract` | Browserbase Sessions API + Playwright, with Browserbase Contexts | Reliable hosted browsers, observability, recordings, persistent contexts for logged-in inspection | Full, but read-only intent |
| Product analytics | `analytics.query_insights`, `analytics.get_funnels`, `analytics.get_replays` | PostHog Cloud + PostHog MCP/API | Product analytics, feature flags, session replay, experiments, and AI-facing query surface in one stack | Read-only, phase 2 |
| Credit and budget state | `finance.get_credit_balance`, `finance.get_company_spend` | Internal MCP server over Worker/D1 | Founder economics are internal system state | Read-only |
| Artifact inspection | `artifacts.list`, `artifacts.open`, `artifacts.inspect_html` | Internal Worker/Supervisor artifact routes | Uses the real company workspace and founder-visible outputs | Full |

## 8. Exact CEO permission profile

### 8.1 Founder chat lane

Recommended SDK configuration:

- `permissionMode: "default"`
- explicit `allowedTools`
- no `Bash`

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- `Skill`
- `mcp__org__get_live_state`
- `mcp__org__get_docs_snapshot`
- `mcp__org__get_recent_messages`
- `mcp__org__record_founder_directive`
- `mcp__mail__read_founder_thread`
- `mcp__mail__send_founder_email`
- `mcp__research__search_web`
- `mcp__research__fetch_url`
- `mcp__browser__inspect_page`
- `mcp__artifacts__list`
- `mcp__artifacts__open`

Disallowed tools:

- `Bash`
- deploy tools
- direct payment tools
- direct secrets tools
- direct task mutation tools
- direct hire / approval tools

### 8.2 Autonomous CEO lane

Recommended SDK configuration:

- `permissionMode: "acceptEdits"`
- explicit `allowedTools`
- still no unrestricted `Bash`

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- `Edit`
- `Write`
- `Skill`
- all read tools from founder chat lane
- `mcp__org__create_tasks`
- `mcp__org__update_tasks`
- `mcp__org__send_messages`
- `mcp__org__request_hires`
- `mcp__org__create_approval`
- `mcp__org__record_progress_note`
- `mcp__mail__send_founder_email`
- `mcp__browser__inspect_page`

Disallowed tools:

- unrestricted `Bash`
- deploy
- `git push`
- infrastructure mutation
- API key creation
- payment/card actions

The CTO, API Specialist, and CMO should own those surfaces instead.

## 9. Internal MCP servers

The CEO should not call many tiny tools. It should call a few coherent MCP servers.

### 9.1 `org` MCP

Purpose:

- all internal company control-plane operations

Recommended methods:

- `get_live_state(companyId)`
- `get_agents(companyId)`
- `get_tasks(companyId, filters?)`
- `get_messages(companyId, filters?)`
- `get_approvals(companyId)`
- `create_tasks(companyId, tasks[])`
- `update_tasks(companyId, updates[])`
- `send_messages(companyId, messages[])`
- `request_hires(companyId, hires[])`
- `create_approval(companyId, approval)`
- `record_founder_directive(companyId, directive)`
- `record_progress_note(companyId, note)`
- `get_credit_state(companyId)`

The `org` MCP should sit on top of the local company coordinator service, not on top of raw SQL.

### 9.2 `mail` MCP

Purpose:

- founder thread read/send only

Recommended methods:

- `read_founder_thread(companyId, limit?)`
- `send_founder_email(companyId, subject, text, html?, category?)`
- `get_inbound_email_context(companyId, messageId)`

### 9.3 `research` MCP

Purpose:

- external information gathering

Recommended methods:

- `search_web(query, options?)`
- `search_news(query, options?)`
- `fetch_url(url, mode: "text" | "markdown" | "html_summary")`

Implementation note:

- use Brave Search for discovery
- use HTTP fetch for static pages
- use browser only for dynamic or authenticated pages

### 9.4 `browser` MCP

Purpose:

- inspect the actual product, landing page, dashboard pages, or third-party services

Recommended methods:

- `open(url, context?)`
- `inspect(url, instructions)`
- `screenshot(url, selector?)`
- `extract(url, schema, selector?)`

Implementation note:

- use Browserbase with Playwright
- use Browserbase Contexts for persistent auth/cookies where needed
- do not use natural-language wrappers like Stagehand as the primary control surface for the CEO

Reason:

- Playwright is more deterministic for a control agent
- Stagehand-like abstractions are useful later, but not as the CEO's default browser contract

### 9.5 `analytics` MCP

Purpose:

- read product and growth performance once analytics exist

Recommended methods:

- `get_key_metrics`
- `run_saved_insight`
- `query_events`
- `get_funnel`
- `get_session_replay_links`
- `get_feature_flags`

This should be phase 2, not day zero.

## 10. Provisioning-time CEO workflow

Immediately after company provisioning:

1. Load the goal from `/workspace/docs/goal.md`
2. Load the core team from coordinator state
3. Read any seeded landing page / artifact snapshot
4. Write `/workspace/docs/execution-contract.json`
5. Write `/workspace/docs/plan.md`
6. Write `/workspace/docs/executive-brief.md`
7. Write `/workspace/docs/founder-daily-update.md`
8. Create structured tracked tasks for:
   - CTO
   - CMO
   - API Specialist
9. Send structured messages that define:
   - objective
   - expected output
   - handoff target
   - approval requirements
10. Send the founder kickoff email

The CEO should not hire during provisioning by default.

It may request hires only later, when justified by actual queue pressure or missing capability.

## 11. Founder directive workflow

If the founder says:

- "the website is bad, make it better"
- "focus on launch"
- "this is the wrong direction"

the CEO must do more than answer.

Required behavior:

1. founder chat lane replies immediately
2. founder chat lane creates a structured founder directive event
3. autonomous CEO lane wakes
4. CEO updates:
   - execution contract
   - operating plan
   - executive brief
   - founder daily update
5. CEO creates or reassigns tracked tasks
6. CEO sends structured messages to affected agents
7. if the directive needs approval or budget, CEO creates an approval request

This is the minimum bar for "the CEO acted on the founder request."

## 12. Hiring policy

The CEO should hire only when one of these conditions is true:

- two or more blocked tasks depend on a missing capability
- the CTO or CMO has more open tracked work than their org can absorb
- a recurring workflow exists for at least two cycles
- the founder explicitly requests a new capability

Hire requests must be structured, not prose.

Suggested schema:

```json
{
  "blueprintId": "reddit-marketer",
  "reportsTo": "cmo",
  "reason": "Reddit is now a top acquisition channel in the execution contract and the CMO has 3 channel-specific tasks queued.",
  "expectedImpact": "Launch and iterate 3 subreddit-specific campaigns this week.",
  "priority": "medium"
}
```

The CEO should never create a hire request that does not identify:

- who the hire reports to
- why the founding team cannot absorb the work
- what concrete work will be assigned in the first 24 hours

## 13. Daily recap contract

The CEO daily recap should be one founder-readable email with:

- what changed today
- what shipped
- what is running now
- what is blocked
- what founder action is needed, if any
- what tomorrow's priority is

The recap must be generated from live coordination state plus the canonical docs, not from model memory.

## 14. Reliability controls

### 14.1 Hard controls

- no `bypassPermissions`
- no raw SQL
- no unrestricted shell
- no direct deploy access
- no direct secrets access
- no founder-facing reply without live state injection

### 14.2 State consistency

- one coordinator service instance per company
- one active running task per agent in founder-facing state
- every mutation requires an idempotency key
- every task transition is validated against workflow rules

### 14.3 Session hygiene

- founder chat session resets every turn
- autonomous CEO session may persist, but every turn reloads live state
- cached session memory is always lower priority than live state

### 14.4 Workflow enforcement

The CEO should not rely on prompt discipline alone.

Enforce these transitions in the coordinator:

- CTO -> engineer -> QA -> CTO -> QA -> CEO
- CMO -> channel specialist -> CMO -> CEO
- founder directives -> CEO strategy update -> delegated tasks
- approvals -> founder action -> CEO/CTO/CMO resume

### 14.5 Visibility

Every CEO turn should persist:

- current work summary
- current primary task id
- last turn summary
- latest execution note safe for founder display

Do not expose raw chain of thought.

## 15. What to borrow from `everything-claude-code`

Use the repo as a pattern source, not as a drop-in dependency.

Worth adopting:

- explicit skills for repetitive workflows
- hooks for session start/stop summaries
- context compaction and memory hygiene
- eval-driven iteration
- research-first operating style

Not worth copying wholesale:

- giant generic harness config
- broad plugin surface before the CEO tool contract is stable
- role behavior hidden inside a huge third-party ruleset

For this codebase, the right move is:

- small local CEO skills
- explicit local hooks
- explicit MCP surfaces
- first-party contracts we can test

## 16. Why Relay should not be the CEO's primary coordination bus

`AgentWorkforce/relay` is useful and should remain an option for future heterogeneous agents, especially if Codex and Claude need real-time communication.

But it should not be the primary CEO coordination mechanism right now.

Reason:

- the CEO needs auditable, replayable, founder-visible control state
- freeform real-time chat is weaker than structured tasks/messages/approvals for this product
- the current system needs reliable sequencing more than it needs low-latency chatter

Recommended position:

- primary bus: internal structured coordination via the local coordinator + D1 mirror
- optional future transport: Relay for real-time cross-driver conversation

Relay becomes valuable later when:

- Codex/OpenClaw agents join
- multiple long-running agent sessions need peer-to-peer live exchange
- the structured workflow engine is already stable

## 17. Implementation phases

### Phase 1: CEO control plane

- add a local `CompanyCoordinator` service inside the supervisor VM
- add `org`, `mail`, `research`, and `browser` MCP servers
- split CEO into founder chat / autonomous / recap lanes
- remove `bypassPermissions`
- move CEO mutations to structured tools only

### Phase 2: CEO reliability

- add idempotency keys and workflow validation
- add explicit founder directive event flow
- add daily recap and action-needed email policies
- add leader-hire policy checks

### Phase 3: analytics-aware CEO

- add `analytics` MCP using PostHog
- let CEO reason over funnels, events, replays, and flags
- keep write access read-only at first

### Phase 4: multi-provider portability

- add driver abstraction for Codex / OpenClaw
- keep the same MCP tool plane
- optionally introduce Relay as an additional transport, not the source of truth

## 18. Recommended final stack

If I were implementing the CEO next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Founder inbound email: Cloudflare Email Routing + Email Workers
- Founder outbound email: Postmark
- Search: Brave Search API
- Browser: Browserbase + Playwright + Browserbase Contexts
- Analytics: PostHog Cloud + PostHog MCP/API

This stack is not the simplest possible stack. It is the stack that best matches the stated goal: high reliability, high agency, and clean future support for additional agent providers.

## 19. Sources

- Anthropic model overview: [platform.claude.com/docs/en/about-claude/models/overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- Anthropic Agent SDK tool permissions: [platform.claude.com/docs/en/agent-sdk/agent-loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- Anthropic Agent SDK skills/plugins: [platform.claude.com/docs/en/agent-sdk/skills](https://platform.claude.com/docs/en/agent-sdk/skills), [platform.claude.com/docs/en/agent-sdk/plugins](https://platform.claude.com/docs/en/agent-sdk/plugins)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare Email Workers: [developers.cloudflare.com/email-routing/email-workers](https://developers.cloudflare.com/email-routing/email-workers/)
- Browserbase docs and Contexts: [docs.browserbase.com/introduction](https://docs.browserbase.com/introduction), [docs.browserbase.com/features/contexts](https://docs.browserbase.com/features/contexts)
- Brave Search API: [brave.com/search/api](https://brave.com/search/api/)
- Postmark developer docs: [postmarkapp.com/developer](https://postmarkapp.com/developer/)
- PostHog product/API overview and MCP: [archive.posthog.com](https://archive.posthog.com/), [mcp.posthog.com](https://mcp.posthog.com/)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
