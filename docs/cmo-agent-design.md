# CMO Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: CMO agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build a CMO agent that is:

- the single owner of marketing strategy and channel orchestration
- tightly aligned to the CEO mission and the CTO's actual product reality
- able to decide which channels matter now and which do not
- able to hire and manage channel specialists when justified
- able to create measurable growth systems instead of vague "brand work"
- reliable enough to run autonomously without inventing a fake market or marketing a product that does not exist
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The CMO is not a generic copywriter or social media poster. It is the marketing control plane for the company:

- it turns the execution contract into a weekly marketing strategy
- it defines positioning, channel priorities, and experimentation cadence
- it coordinates specialists under it
- it measures what is actually working
- it keeps launch messaging aligned with the real product
- it reports channel progress and strategic changes back to the CEO

## 2. Non-goals

The CMO should not:

- replace the CEO as the company strategist
- market a different product than the CTO is actually shipping
- talk directly to the founder except through the CEO chain of command
- directly buy API keys, accounts, or infrastructure instead of the API Specialist
- own product delivery instead of the CTO
- rely on markdown notes as the primary workflow system
- run paid spend or public posting through ad hoc tools with weak auditability
- depend on stale hidden memory instead of live state

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- shared filesystem plus structured tasks, messages, approvals, and workflows

This design changes the CMO implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- marketing drifting away from the real product and launch state
- weak visibility into who is doing what across channels
- channel work that exists only as docs, not as structured tasks and measurable experiments
- public marketing claims that are not grounded in the execution contract
- overpowered tool access without clear spend or publication controls
- no single source of truth for campaign state and channel performance

## 4. CMO operating position in the org

### 4.1 Chain of command

The CMO reports to the CEO.

The CMO owns:

- weekly marketing strategy
- positioning and message hierarchy
- channel prioritization
- campaign orchestration
- measurement and iteration cadence
- launch-readiness from a market and messaging perspective

The CMO manages:

- reddit marketer
- twitter marketer
- cold emailer
- seo writer
- ad buyer
- content writer

The CMO must stay tightly aligned with:

- the CEO for mission and tradeoffs
- the CTO for product readiness, launch timing, and current founder-visible experience

### 4.2 What "done" means

From the CMO's point of view, work is only done when:

1. the message is aligned with the actual product and execution contract
2. the landing page or destination artifact exists and matches the campaign promise
3. the channel work has a concrete owner
4. tracking and attribution are in place
5. results are measured against explicit hypotheses
6. the CEO receives a clear summary of what changed and what worked

Nothing short of that should become founder-visible "marketing progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- The CMO has to synthesize audience research, product reality, landing-page quality, channel economics, campaign copy, experimentation, and performance attribution in one loop.
- For the first serious version, the cost of a weak strategic model is higher than the savings from using a cheaper one.

Recommendation:

- keep the CMO on Opus 4.6 in v1
- later, low-risk performance-reporting or simple asset drafting can move to specialists or lower-cost models
- keep strategy, channel selection, and escalation decisions on Opus

Implementation requirement:

- do not run the CMO in `bypassPermissions`
- use explicit `allowedTools`
- use `Skill` with local CMO skills enabled
- route campaign, publish, and approval state through structured internal tools only

### 5.2 Driver abstraction

Use the same provider-neutral driver abstraction proposed for the CEO and CTO.

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

The CMO tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The CMO must not mutate D1 directly.

Use the same per-company `CompanyCoordinator` service running on the supervisor VM as the serialized mutation layer, with local SQLite as hot state and D1 as the historical mirror.

Why:

- channel and campaign orchestration are coordination problems first
- the CMO creates race conditions quickly if publish, approval, and performance state are not serialized
- the agents already share one VM, so local coordination is the fastest and simplest reliable v1 path for hot campaign state

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - live campaign state
  - active experiments
  - channel ownership
  - scheduled specialist tasks
  - approval and spend-gate state
  - live launch-readiness flags
  - idempotency keys
- D1:
  - campaign history
  - specialist message history
  - weekly summaries
  - approvals history
  - founder-visible execution summaries
- workspace:
  - strategy docs
  - positioning docs
  - copy drafts
  - campaign briefs
  - content assets and landing-page feedback
- R2:
  - rendered campaign reports
  - screenshots
  - social previews
  - exported creative bundles
  - performance snapshots and experiment evidence

### 6.3 Source-of-truth order

The CMO must treat state in this order:

1. coordinator live state
2. connected first-party metrics and channel state
3. D1 mirrored state
4. canonical marketing docs
5. recent specialist messages
6. session memory

Session memory is never authoritative.

## 7. CMO lanes

The CMO should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Weekly strategy lane

Purpose:

- set channel priorities
- update positioning and message hierarchy
- define the next week's experiments and deliverables
- keep marketing aligned with CEO direction and CTO reality

Properties:

- autonomous
- edits marketing control docs
- creates and reprioritizes structured tasks
- no direct public publishing
- no direct spend activation

### 7.2 Campaign orchestration lane

Purpose:

- manage channel specialists
- review draft assets and copy
- approve or reject campaign-ready work
- ensure every campaign has a destination, tracking, and owner

Properties:

- autonomous
- may create campaign drafts and queue owned-channel work
- may not spend money or activate risky public campaigns without the right gate

### 7.3 Performance and attribution lane

Purpose:

- read analytics and channel metrics
- compare channel performance against hypotheses
- create follow-up work based on actual outcomes

Properties:

- scheduled
- mostly read-only
- can create corrective or expansion tasks
- should not independently launch a new risky channel

### 7.4 Launch-readiness lane

Purpose:

- audit whether the landing page, messaging, and channel promises are coherent enough to send traffic
- coordinate launch fixes with CTO and content specialists

Properties:

- event-driven around major product milestones
- browser-heavy
- may open blocking tasks
- should not override CTO release quality gates

## 8. Files and contracts the CMO owns

The CMO should own a small, explicit set of marketing control files.

Required files:

- `/workspace/docs/marketing-plan.md`
- `/workspace/docs/market-analysis.md`
- `/workspace/docs/messaging-framework.md`
- `/workspace/docs/channel-scorecard.json`
- `/workspace/docs/launch-readiness.md`
- `/workspace/.agent/hiring/cmo.json`

The CEO remains authoritative for:

- `/workspace/docs/execution-contract.json`
- `/workspace/docs/plan.md`

The CTO remains authoritative for:

- `/workspace/docs/architecture.md`
- actual product and release state

But the CMO must keep marketing files aligned with them.

### 8.1 Proposed `channel-scorecard.json`

This should be generated and updated by the CMO as the live marketing control file.

Suggested schema:

```json
{
  "companyId": "company_123",
  "weekOf": "2026-03-09",
  "channels": [
    {
      "channel": "reddit",
      "priority": "high",
      "status": "active",
      "owner": "reddit-marketer",
      "hypothesis": "Founder-led educational posts will convert early service buyers",
      "primaryMetric": "qualified replies",
      "currentMetric": 7,
      "targetMetric": 20,
      "nextAction": "Test 3 subreddit-specific angles",
      "requiresApproval": false
    },
    {
      "channel": "cold_email",
      "priority": "medium",
      "status": "drafting",
      "owner": "cold-emailer",
      "hypothesis": "Outbound to agency founders will produce qualified intro calls",
      "primaryMetric": "positive response rate",
      "currentMetric": 0,
      "targetMetric": 0.08,
      "nextAction": "Finalize list and first sequence",
      "requiresApproval": false
    }
  ],
  "blockedChannels": [],
  "notes": "Do not scale traffic until landing page promise and CTA flow are coherent."
}
```

## 9. CMO tool surface

The CMO needs strong agency on research, positioning, campaign orchestration, and measurement, but that does not mean "give it direct posting and ad spend everywhere."

### 9.1 Tooling principles

- every campaign or experiment must be structured and measurable
- every public claim must map back to the actual product and execution contract
- every campaign must have a destination URL or artifact before launch
- every spend-bearing action must be auditable
- every channel recommendation must be tied to evidence
- no raw SQL
- no direct founder email
- no unrestricted shell
- no direct ad-spend activation in v1

### 9.2 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | CMO access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.create_tasks`, `org.update_tasks`, `org.send_message`, `org.request_hire`, `org.record_execution_note` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable campaign and channel control that matches the current architecture | Full |
| Workspace docs/assets | `Read`, `Glob`, `Grep`, `Edit`, `Write` | Claude Code built-in tools | Lowest-latency edits on the real shared workspace | Full |
| General web and market research | `research.search_web`, `research.fetch_url`, `research.search_news` | Brave Search API + internal fetch/extract | Fast external discovery, news search, and competitor discovery without defaulting to a browser | Full |
| SEO and SERP intelligence | `seo.get_keyword_ideas`, `seo.get_serp_snapshot`, `seo.get_competitor_keywords` | DataForSEO Labs API | Better fit than generic search for keyword volumes, SERP data, and competitor SEO intelligence | Full |
| First-party search performance | `seo.get_search_console_queries`, `seo.get_search_console_pages`, `seo.inspect_indexing_state` | Google Search Console API | Best first-party source for how the actual site performs in Google once connected | Read-only |
| Product analytics and experiments | `analytics.get_key_metrics`, `analytics.get_funnels`, `analytics.get_replays`, `analytics.get_feature_flags`, `analytics.get_experiments` | PostHog Cloud + PostHog MCP/API | Product analytics, funnels, session replay, feature flags, and experiments in one stack that already fits agent use | Read-only in v1 |
| Browser inspection | `browser.open`, `browser.inspect`, `browser.screenshot`, `browser.extract` | Browserbase Sessions + Playwright + Browserbase Contexts | Reliable hosted browsers for landing-page audit, signup flow review, and competitor inspection | Full |
| Lifecycle email and owned-audience journeys | `engage.get_segments`, `engage.create_draft_journey`, `engage.preview_broadcast`, `engage.launch_broadcast`, `engage.pause_campaign` | Customer.io | Better fit than transactional mail providers for journeys, segments, campaign state, and marketing sends | Draft/create full, live launch gated |
| Social account visibility | `social.get_account_health`, `social.get_scheduled_drafts`, `social.get_post_metrics`, `social.create_draft_post` | Internal MCP server over official X API and Reddit API adapters, with Browserbase fallback for UI-only checks | Keeps the CMO aware of channel state without making it depend on fragile browser-only automation | Read-only and draft-only |
| Paid channel visibility | `ads.get_account_health`, `ads.get_campaign_metrics`, `ads.create_draft_campaign`, `ads.estimate_budget` | Internal MCP server over Google Ads API and Meta Marketing API | First-party ad metrics and draft campaign control, but without letting the CMO directly light money on fire in v1 | Read-only and draft-only |
| Artifact inspection | `artifacts.list`, `artifacts.open`, `artifacts.inspect_html` | Internal Worker/Supervisor artifact routes | Uses the real company outputs and founder-visible artifacts | Full |

### 9.3 Provider notes

#### Search and research

Use a split:

- Brave Search API for broad web and news discovery
- DataForSEO for structured SEO and SERP intelligence

Reason:

- generic search and structured keyword/SERP data are different jobs
- CMO strategy needs both

#### Analytics

Use PostHog for:

- funnels
- conversion metrics
- feature flags
- experiments
- session replay

Reason:

- marketing decisions should be tied to product behavior, not only vanity channel metrics

#### Lifecycle email

Use Customer.io for lifecycle and owned-audience campaigns.

Do not use Postmark as the core marketing email provider.

Reason:

- Postmark is excellent for transactional email
- Customer.io is a better fit for journeys, segments, campaign previews, and controlled launches

#### Social and community channels

Do not make the CMO depend on a generic scheduler as the primary abstraction.

Use:

- official X and Reddit adapters where possible
- Browserbase fallback only where the UI exposes relevant state not cleanly available through APIs

Reason:

- the CMO needs trustworthy visibility into account and draft state
- specialists should own public channel execution
- the CMO should review strategy and output, not blindly click publish across platforms

#### Paid media

Use official Google Ads and Meta Marketing adapters for metrics and draft campaigns only.

Do not allow live spend activation from the CMO in v1.

Reason:

- strong agency still needs strong spend controls
- the CMO should be able to plan and evaluate paid campaigns before a dedicated ad buyer or approval gate takes over

## 10. Exact CMO permission profile

### 10.1 Weekly strategy lane

Recommended SDK configuration:

- `permissionMode: "acceptEdits"`
- explicit `allowedTools`
- `settingSources: ["user", "project"]`

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- `Edit`
- `Write`
- `Skill`
- `mcp__org__get_live_state`
- `mcp__org__get_agents`
- `mcp__org__get_tasks`
- `mcp__org__create_tasks`
- `mcp__org__update_tasks`
- `mcp__org__send_messages`
- `mcp__org__request_hires`
- `mcp__org__record_execution_note`
- `mcp__research__search_web`
- `mcp__research__search_news`
- `mcp__research__fetch_url`
- `mcp__seo__get_keyword_ideas`
- `mcp__seo__get_serp_snapshot`
- `mcp__seo__get_competitor_keywords`
- `mcp__seo__get_search_console_queries`
- `mcp__seo__get_search_console_pages`
- `mcp__analytics__get_key_metrics`
- `mcp__analytics__get_funnels`
- `mcp__analytics__get_experiments`
- `mcp__analytics__get_replays`
- `mcp__browser__inspect`
- `mcp__browser__screenshot`
- `mcp__browser__extract`
- `mcp__artifacts__list`
- `mcp__artifacts__open`

Disallowed tools:

- raw `Bash`
- direct platform posting tools
- direct paid-spend activation
- direct founder mail tools
- direct secrets tools
- direct SQL tools

### 10.2 Campaign orchestration lane

Recommended SDK configuration:

- `permissionMode: "acceptEdits"`
- explicit `allowedTools`

Allowed tools:

- all read tools above
- `mcp__org__create_tasks`
- `mcp__org__update_tasks`
- `mcp__org__send_messages`
- `mcp__org__request_hires`
- `mcp__org__record_execution_note`
- `mcp__engage__get_segments`
- `mcp__engage__create_draft_journey`
- `mcp__engage__preview_broadcast`
- `mcp__engage__pause_campaign`
- `mcp__social__get_account_health`
- `mcp__social__get_scheduled_drafts`
- `mcp__social__get_post_metrics`
- `mcp__social__create_draft_post`
- `mcp__ads__get_account_health`
- `mcp__ads__get_campaign_metrics`
- `mcp__ads__create_draft_campaign`
- `mcp__ads__estimate_budget`

Disallowed tools:

- public publish to X or Reddit
- direct ad activation
- direct billing/payment tools
- founder email

### 10.3 Owned-audience launch lane

This lane exists only for safe owned-channel sends such as opted-in lifecycle or newsletter campaigns.

Recommended SDK configuration:

- `permissionMode: "default"`
- explicit `allowedTools`

Allowed tools:

- read-only tools from above
- `mcp__engage__get_segments`
- `mcp__engage__create_draft_journey`
- `mcp__engage__preview_broadcast`
- `mcp__engage__launch_broadcast`
- `mcp__engage__pause_campaign`
- `mcp__org__record_execution_note`
- `mcp__org__send_messages`

Extra guardrails:

- launch only to opted-in audiences
- require a rendered preview before send
- require a valid landing destination if the campaign has a CTA
- pause always allowed

## 11. Internal MCP servers

The CMO should use a few coherent MCP servers, not a pile of one-off tools.

### 11.1 `org` MCP

Purpose:

- internal company control-plane operations

Recommended methods:

- `get_live_state(companyId)`
- `get_agents(companyId)`
- `get_tasks(companyId, filters?)`
- `create_tasks(companyId, tasks[])`
- `update_tasks(companyId, updates[])`
- `send_messages(companyId, messages[])`
- `request_hires(companyId, hires[])`
- `record_execution_note(companyId, note)`
- `escalate_to_ceo(companyId, escalation)`

Important:

- the CMO should escalate to the CEO, not directly to the founder

### 11.2 `research` MCP

Purpose:

- external market, competitor, and news research

Recommended methods:

- `search_web(query, options?)`
- `search_news(query, options?)`
- `fetch_url(url, mode?)`

### 11.3 `seo` MCP

Purpose:

- keyword and SERP intelligence plus first-party search performance

Recommended methods:

- `get_keyword_ideas(seedKeywords, locale?)`
- `get_serp_snapshot(query, locale?)`
- `get_competitor_keywords(domain)`
- `get_search_console_queries(property, window?)`
- `get_search_console_pages(property, window?)`
- `inspect_indexing_state(url)`

Implementation note:

- DataForSEO should provide third-party market data
- Search Console should provide first-party site data

### 11.4 `analytics` MCP

Purpose:

- product and growth performance

Recommended methods:

- `get_key_metrics`
- `get_funnels`
- `get_replays`
- `get_feature_flags`
- `get_experiments`
- `query_events`

Implementation note:

- PostHog should be the primary product analytics source
- keep this read-only in v1

### 11.5 `engage` MCP

Purpose:

- lifecycle campaigns and owned-audience communication

Recommended methods:

- `get_segments`
- `create_draft_journey`
- `preview_broadcast`
- `launch_broadcast`
- `pause_campaign`
- `get_campaign_metrics`

Implementation note:

- use Customer.io
- do not mix this with founder/agent transactional email

### 11.6 `social` MCP

Purpose:

- social and community account visibility without direct high-risk publishing

Recommended methods:

- `get_account_health(channel)`
- `get_scheduled_drafts(channel)`
- `get_post_metrics(channel, window?)`
- `create_draft_post(channel, payload)`
- `get_inbox_state(channel)`

Implementation note:

- use official adapters first
- use Browserbase only when the product UI exposes relevant state that the API does not

### 11.7 `ads` MCP

Purpose:

- paid-channel visibility and draft planning

Recommended methods:

- `get_account_health(network)`
- `get_campaign_metrics(network, window?)`
- `create_draft_campaign(network, payload)`
- `estimate_budget(network, target)`
- `pause_campaign(network, id)`

Implementation note:

- keep this read-only and draft-oriented in v1
- activation should be handled by a later ad-buyer or explicit approval flow

### 11.8 `browser` MCP

Purpose:

- landing-page and competitor inspection

Recommended methods:

- `open(url, context?)`
- `inspect(url, instructions)`
- `screenshot(url, selector?)`
- `extract(url, schema, selector?)`

Implementation note:

- Browserbase plus Playwright should be the primary browser stack
- use contexts only where authenticated inspection is required

## 12. Provisioning-time CMO workflow

Immediately after company provisioning:

1. read:
   - `/workspace/docs/goal.md`
   - `/workspace/docs/execution-contract.json`
   - `/workspace/docs/plan.md`
   - `/workspace/.agent/OPERATING_SYSTEM.md`
2. inspect the initial landing-page artifact or preview if one exists
3. write or update:
   - `/workspace/docs/market-analysis.md`
   - `/workspace/docs/messaging-framework.md`
   - `/workspace/docs/marketing-plan.md`
   - `/workspace/docs/launch-readiness.md`
   - `/workspace/docs/channel-scorecard.json`
4. identify the first founder-impressive marketing slice
5. score channels by:
   - speed
   - product fit
   - founder brand fit
   - cost
   - measurability
6. create structured tasks for:
   - landing-page messaging fixes
   - first channel preparation
   - tracking and attribution setup
7. do not hire by default unless a channel is clearly justified

The CMO's day-zero goal is not a huge content calendar.

It is:

- one coherent message
- one coherent landing destination
- one or two justified channels
- one measurable near-term experiment plan

## 13. Standard marketing workflow

### 13.1 CEO -> CMO

The CEO gives the CMO:

- mission
- company direction
- near-term business priority
- constraints on positioning or launch timing

The CMO turns that into:

- positioning
- channel priorities
- experiment plan
- specialist task graph

### 13.2 CMO <-> CTO alignment

Before pushing traffic, the CMO must verify:

- the landing page or product artifact exists
- the page promise matches the actual product
- the CTA flow is coherent
- the channel promise is not ahead of product reality

If not, the CMO opens a structured task back to the CTO or content owner.

### 13.3 CMO -> specialists

Every delegated task must include:

- channel
- target audience
- objective
- hypothesis
- required assets
- destination URL or artifact path
- tracking requirements
- acceptance criteria
- reporting expectation

Suggested task payload:

```json
{
  "to": "content-writer",
  "type": "task",
  "subject": "Draft homepage proof and CTA copy for ghostwriting offer",
  "body": "Rewrite the landing page copy so the value proposition, proof, and CTA match the current execution contract and service offer.",
  "priority": "high",
  "metadata": {
    "taskId": "task_copy_home_01",
    "taskTitle": "Draft homepage proof and CTA copy for ghostwriting offer",
    "workflowStage": "assigned",
    "channel": "landing_page",
    "hypothesis": "Clearer proof and offer framing will increase qualified CTA clicks",
    "destination": "/workspace/src/index.html",
    "acceptanceCriteria": [
      "Hero, proof, offer, and CTA match the current service",
      "No unsupported claims are introduced",
      "Copy is ready for CMO review"
    ],
    "handoffTarget": "cmo"
  }
}
```

### 13.4 Specialists -> CMO

When a specialist finishes:

- they do not declare channel success
- they report work and evidence back to the CMO
- the CMO reviews it against strategy, brand, destination quality, and tracking completeness

### 13.5 CMO -> specialists revision loop

If the output is weak:

- the CMO returns it with exact fixes
- the task stays active
- the CMO does not create a fake "done" state just because an asset exists

### 13.6 CMO -> CEO

When a campaign or strategic update is ready:

- the CMO sends a structured summary to the CEO with:
  - what changed
  - what channel is active
  - what asset is live
  - what metrics matter
  - what risk remains

## 14. Hiring policy

The CMO should hire only when one of these is true:

- a channel is explicitly prioritized in the scorecard and needs a dedicated owner
- recurring channel work persists across at least two cycles
- the founding team lacks a concrete capability required for the strategy
- performance indicates a channel deserves deeper iteration than the CMO can absorb alone

Default hire pool for the CMO:

- `reddit-marketer`
- `twitter-marketer`
- `cold-emailer`
- `seo-writer`
- `ad-buyer`
- `content-writer`

Suggested hire schema:

```json
{
  "blueprintId": "reddit-marketer",
  "reportsTo": "cmo",
  "reason": "Reddit is the highest-priority early acquisition channel and requires ongoing community-specific work the CMO cannot absorb directly.",
  "expectedImpact": "Launch 3 subreddit-specific experiments this week and report qualified replies.",
  "priority": "high",
  "first24hTasks": [
    "Map target subreddits",
    "Draft 3 post angles",
    "Coordinate landing page angle with CMO"
  ]
}
```

The CMO should not hire because "more content might help."

It should hire only when the channel strategy and task graph justify it.

## 15. Reliability controls

### 15.1 Hard controls

- no `bypassPermissions`
- no raw SQL
- no unrestricted shell
- no founder email
- no direct public social publish in v1
- no direct ad-spend activation in v1
- no unsupported claims against the execution contract

### 15.2 State consistency

- one active owner per campaign or experiment
- every campaign must point to a destination URL or artifact
- every mutation requires an idempotency key
- every publish-capable workflow must store a preview or evidence bundle
- every channel decision must be tied to a hypothesis and a metric

### 15.3 Session hygiene

- strategy and orchestration lanes may persist sessions
- every turn still reloads live channel, campaign, and product state
- session memory is always lower priority than coordinator and connected metrics

### 15.4 Workflow enforcement

Enforce these transitions in the coordinator:

- CEO -> CMO strategy assignment
- CMO -> specialist campaign assignment
- specialist -> CMO review handoff
- CMO -> specialist revision loop
- CMO -> CEO strategic update
- CMO -> CEO escalation for spend, risk, or product/market mismatch

### 15.5 Visibility

Every CMO turn should persist:

- current primary campaign or experiment id
- current highest-priority channels
- current launch-readiness blockers
- latest safe execution note
- current owned-audience campaign state, if any
- next planned experiment

Do not expose raw chain of thought.

Instead, expose safe progress notes such as:

- "Auditing landing-page promise against current service scope"
- "Scoring Reddit versus cold email for this week"
- "Reviewing draft homepage copy before sending traffic"
- "Waiting on CTO to fix CTA flow before campaign launch"

## 16. What to borrow from `everything-claude-code`

Use it as a pattern source, not as a dependency.

Worth adopting:

- explicit skills for repeated strategy and audit workflows
- hook-driven summaries at session boundaries
- context compaction discipline
- evals for regression testing the CMO prompt/tool contract

Not worth copying wholesale:

- a giant generic harness
- broad plugin surface before tool contracts are stable
- role behavior hidden in a large third-party ruleset

For this codebase, the right move is:

- small local CMO skills
- explicit MCP surfaces
- explicit campaign and experiment contracts
- first-party evals we control

## 17. Why Relay should not be the CMO's primary coordination bus

Relay remains useful for future heterogeneous-agent collaboration.

But it should not be the CMO's primary bus in v1.

Reason:

- the CMO's core job is structured strategy, channel control, measurement, and escalation
- freeform chat is weak as the source of truth for campaigns and experiments
- the current system needs auditability, metrics, and approvals more than it needs live marketer-to-marketer chatter

Recommended position:

- primary bus: internal structured coordination through the local coordinator + D1 mirror
- optional future transport: Relay for real-time cross-driver collaboration when the structured workflow layer is already stable

## 18. Implementation phases

### Phase 1: CMO control plane

- add a local `CompanyCoordinator` service inside the supervisor VM
- keep the CMO on Opus 4.6
- remove `bypassPermissions`
- add `research`, `seo`, `analytics`, `engage`, `social`, and `ads` MCP servers
- keep `org` as the single mutation surface for tasks and workflows
- define `channel-scorecard.json` and launch-readiness contract

### Phase 2: workflow enforcement

- validate channel and campaign transitions in the coordinator
- require destination URLs and previews before launch
- require explicit metrics and hypotheses on campaigns
- enforce specialist -> CMO review loops

### Phase 3: owned-channel autonomy

- allow safe lifecycle and owned-audience sends through Customer.io
- keep public social and paid activation gated
- store previews, metrics snapshots, and evidence in R2

### Phase 4: visibility and evals

- stream safe CMO progress events into founder UI
- expose channel scorecards and launch-readiness blockers
- add evals for false claims, premature traffic pushes, and weak channel selection

### Phase 5: multi-provider portability

- keep the same tool plane
- add provider drivers for Codex or other models later
- optionally add Relay for real-time cross-agent collaboration

## 19. Recommended final stack

If I were implementing the CMO next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Durable campaign evidence and previews: Cloudflare R2
- General web/news discovery: Brave Search API + internal fetch
- SEO and SERP data: DataForSEO Labs API
- First-party search performance: Google Search Console API
- Product analytics and experiments: PostHog Cloud + PostHog MCP/API
- Browser audit and funnel inspection: Browserbase + Playwright + Browserbase Contexts
- Lifecycle and owned-audience campaigns: Customer.io
- Social/community visibility: official X and Reddit adapters behind an internal MCP, with Browserbase fallback
- Paid-channel visibility and drafts: official Google Ads and Meta Marketing adapters behind an internal MCP

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the CMO, without turning it into an unbounded growth bot that can publish, spend, and drift without controls.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- Anthropic Agent SDK skills/plugins: [platform.claude.com/docs/en/agent-sdk/skills](https://platform.claude.com/docs/en/agent-sdk/skills), [platform.claude.com/docs/en/agent-sdk/plugins](https://platform.claude.com/docs/en/agent-sdk/plugins)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare R2 overview: [developers.cloudflare.com/r2](https://developers.cloudflare.com/r2/)
- Browserbase docs, contexts, and session replay: [docs.browserbase.com/introduction](https://docs.browserbase.com/introduction), [docs.browserbase.com/features/contexts](https://docs.browserbase.com/features/contexts), [docs.browserbase.com/features/session-replay](https://docs.browserbase.com/features/session-replay)
- Brave Search API: [brave.com/search/api](https://brave.com/search/api/)
- DataForSEO Labs overview: [docs.dataforseo.com/v3/dataforseo_labs-overview](https://docs.dataforseo.com/v3/dataforseo_labs-overview/)
- Google Search Console API reference: [developers.google.com/webmaster-tools/v1/api_reference_index](https://developers.google.com/webmaster-tools/v1/api_reference_index)
- PostHog overview and MCP: [archive.posthog.com](https://archive.posthog.com/), [mcp.posthog.com](https://mcp.posthog.com/)
- Customer.io journeys and APIs: [docs.customer.io/journeys/journeys-overview](https://docs.customer.io/journeys/journeys-overview/), [docs.customer.io/integrations/api/customerio-apis](https://docs.customer.io/integrations/api/customerio-apis/)
- X API docs: [docs.x.com/x-api/introduction](https://docs.x.com/x-api/introduction)
- Reddit API docs: [developers.reddit.com/docs/capabilities/server/reddit-api](https://developers.reddit.com/docs/capabilities/server/reddit-api)
- Google Ads API docs: [developers.google.com/google-ads/api/docs/start](https://developers.google.com/google-ads/api/docs/start)
- Meta Marketing API docs: [developers.facebook.com/docs/marketing-api](https://developers.facebook.com/docs/marketing-api/)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
