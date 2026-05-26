# Facebook Specialist Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: Facebook Specialist agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build a Facebook Specialist agent that is:

- the single owner of Facebook execution under the CMO
- capable of turning the weekly marketing strategy into credible Facebook-native page content, community participation plans, lead flows, and experiments
- able to build distribution through real page publishing, group-aware community strategy, and measurable attribution
- able to connect Facebook activity to clicks, leads, and downstream conversion signals
- reliable enough to run autonomously without getting the page, app, or business assets restricted
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The Facebook Specialist is not just a scheduler and not just a copywriter. It is the Facebook execution plane for the company:

- it owns Facebook Page publishing and reporting
- it coordinates Facebook community and group strategy
- it handles comment and lead-follow-up routing where official APIs support it
- it keeps organic content aligned with the real product and landing pages
- it connects Facebook activity with downstream attribution and lead flow
- it turns audience reaction into structured learnings for the CMO, CEO, and CTO

## 2. Non-goals

The Facebook Specialist should not:

- replace the CMO as the channel strategist
- replace the CEO or founder when true founder or founder-network activity is required
- replace the CTO when product claims need technical validation
- use fake personas, bought aged accounts, or covert astroturfing
- buy followers, reactions, comments, group members, or engagement
- run disguised employee amplification rings
- scrape Facebook surfaces or automate Facebook website activity with browser bots
- automate personal-profile posting, personal messaging, or group actions through unsupported means
- rely on markdown notes as the primary workflow system
- depend on stale hidden memory instead of live state

Those tactics are excluded on purpose.

They are not just ethically weak. They are structurally weak:

- Meta's automated data collection terms and platform rules are hostile to unauthorized scraping and website automation
- fake engagement and fake accounts are enforcement magnets
- group and community work based on deception produces low-trust signals and poor product feedback
- they are the wrong foundation for an autonomous company that is supposed to operate for a long time

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and workflows

This design changes the Facebook Specialist implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- Facebook work existing only as vague content plans instead of page-level and lead-level execution
- weak visibility into what was actually published and what actually produced results
- no clean distinction between Page posting, group participation planning, lead handling, and paid coordination
- no structured way to route Facebook comments and lead signals back to the rest of the company
- fragile assumptions that browser automation or scraping are acceptable execution primitives
- channel activity that looks busy but is not attributable to any real business outcome

## 4. Facebook Specialist operating position in the org

### 4.1 Chain of command

The Facebook Specialist reports to the CMO.

The Facebook Specialist owns:

- Facebook Page execution
- Facebook Page content queue and cadence
- Facebook-native content packaging
- Facebook group and community participation strategy
- Page comment monitoring and reply routing where supported
- Facebook lead-flow coordination
- Facebook-specific experiment summaries

The Facebook Specialist must stay tightly aligned with:

- the CMO for narrative, audience, cadence, and weekly priorities
- the CEO for mission, founder positioning, and escalation-worthy market signals
- the CTO for product truth, launch-readiness, and proof constraints

The Facebook Specialist does not bypass:

- the CMO for strategy
- the CEO or founder for founder-voice or human relationship actions
- the CTO for product claims
- Procurement or the API Key Provider for accounts, apps, or paid access setup

### 4.2 What "done" means

From the Facebook Specialist's point of view, work is only done when:

1. the content mode and account surface are aligned with the current strategy
2. the post, creative, or lead flow fits Facebook's actual product surface
3. the destination page and proof points are real
4. the action is published, scheduled, or packaged through an auditable workflow
5. comments, leads, or resulting interactions are monitored and routed correctly
6. traffic, leads, and conversion outcomes are measured
7. the resulting learnings are routed back into the company

Nothing short of that should become founder-visible "Facebook progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- Facebook combines page content, comments, community norms, lead forms, and downstream attribution.
- Weak models tend to produce bland brand language, low-trust calls to action, and generic social content that does not match the audience or the surface.
- The Facebook Specialist needs to reason across content, proof, compliance, attribution, and escalation boundaries in one loop.

Recommendation:

- keep the Facebook Specialist on Opus 4.6 in v1
- later, low-risk queue cleanup and simple summary work can move to cheaper models
- keep content judgment, workflow routing, and escalation logic on Opus

Implementation requirement:

- do not run the Facebook Specialist in `bypassPermissions`
- use explicit `allowedTools`
- use official Meta APIs where available
- use human-assisted fallbacks for unsupported personal-profile or group actions rather than website automation

### 5.2 Driver abstraction

Use the same provider-neutral driver abstraction proposed for the other agent designs.

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

The Facebook Specialist tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The Facebook Specialist must not operate through ad hoc notes or direct D1 writes.

Use:

- the per-company `CompanyCoordinator` service running on the supervisor VM as the serialized workflow layer
- local SQLite as the hot coordination store for that service
- D1 as the historical mirror
- the shared workspace for sanitized playbooks, content libraries, and summaries

Why:

- Facebook has multiple distinct execution surfaces with different permission models
- one company can have page publishing, community/group participation, lead forms, and paid coordination happening at the same time
- publish, lead, comment, and attribution state need durable workflow serialization

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - page strategy state
  - post queue
  - creative queue
  - comment backlog
  - lead webhook backlog
  - experiment state
  - page and token health metadata
  - idempotency keys
- D1:
  - historical post log
  - experiment summaries
  - traffic and lead summaries
  - comment and lead routing history
  - agent message history
  - founder-visible execution summaries
- workspace:
  - Facebook playbook
  - content archetypes
  - comment and objection libraries
  - proof-point libraries
  - weekly summaries
- R2:
  - media assets
  - screenshots
  - exported reports
  - evidence bundles

### 6.3 Source-of-truth order

The Facebook Specialist must treat state in this order:

1. coordinator live workflow state
2. current Facebook Page, lead, and attribution state
3. D1 mirrored history
4. canonical marketing docs and product artifacts
5. recent CMO/CEO/CTO messages
6. session memory

Session memory is never authoritative.

## 7. Facebook Specialist lanes

This agent should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Page strategy and listening lane

Purpose:

- define the role of the Facebook Page this week
- monitor page state, content opportunities, and audience response
- map what content mode is appropriate now

Properties:

- read-heavy
- no publishing
- updates page and opportunity state

### 7.2 Drafting lane

Purpose:

- draft page posts, captions, comment kits, and creative briefs
- package group participation plans for human execution where needed
- align content to landing pages, offers, and current proof points

Properties:

- write-heavy
- draft-only
- cannot publish directly outside supported page surfaces

### 7.3 Publish, comments, and lead-response lane

Purpose:

- publish or schedule page content through official APIs
- monitor supported comment and page interaction signals
- consume lead webhooks and route qualified leads into the right workflow

Properties:

- API-backed write access
- strict permission and duplication checks
- must attach evidence and state after each action

### 7.4 Reporting and routing lane

Purpose:

- summarize what actually happened on Facebook
- connect posts and leads to downstream behavior
- route objections, sales signals, and product signals to the right role

Properties:

- read-heavy
- no publishing
- summary and routing only

## 8. Files and contracts the Facebook Specialist owns

Recommended owned files:

- `/workspace/docs/marketing/facebook-playbook.md`
  - channel strategy, audience, surfaces, anti-goals, and current priorities
- `/workspace/docs/marketing/facebook-page-profile.json`
  - approved page, owner role, content modes, and current status
- `/workspace/docs/marketing/facebook-queue.json`
  - sanitized queue mirror of planned page posts, creative packages, and lead-flow follow-ups
- `/workspace/docs/marketing/facebook-experiments.json`
  - experiment registry with hypothesis, angle, owner, and result
- `/workspace/docs/marketing/facebook-proof-points.md`
  - allowed claims, customer proof, offer proof, and launch facts
- `/workspace/docs/marketing/facebook-comment-library.md`
  - approved response patterns and objection handling
- `/workspace/docs/marketing/facebook-group-playbook.md`
  - human-assisted community participation guidance, approved groups, and anti-goals
- `/workspace/docs/marketing/facebook-weekly-summary.md`
  - founder-readable weekly output and learnings

Required structured objects in the coordinator:

- `facebook_page_profile`
- `facebook_post_draft`
- `facebook_publish_event`
- `facebook_comment_backlog_item`
- `facebook_lead_signal`
- `facebook_experiment`
- `facebook_page_health`
- `facebook_permission_blocker`
- `facebook_group_play`

## 9. Facebook Specialist tool surface

The Facebook Specialist should mutate the world only through explicit internal tools.

### 9.1 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | Facebook Specialist access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.get_tasks`, `org.send_message`, `org.create_experiment`, `org.record_execution_note`, `org.update_workflow` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable workflow state matching the current architecture | Full |
| Facebook Page publishing and readback | `facebook.create_page_draft`, `facebook.publish_page_post`, `facebook.schedule_page_post`, `facebook.get_post`, `facebook.get_post_metrics`, `facebook.get_page_state` | Internal MCP server over official Meta Pages API / Graph API | Highest reliability comes from official page publishing surfaces rather than browser automation or scraping | Full within approved scopes |
| Comments and page interactions | `facebook.list_comments`, `facebook.create_page_comment`, `facebook.hide_comment`, `facebook.list_reactions`, `facebook.get_page_notifications` | Internal MCP server over official Page/comment and webhook flows where supported | Needed for supported comment-response loops and moderation awareness on owned page content | Limited / scoped |
| Lead forms and lead retrieval | `facebook.list_lead_forms`, `facebook.get_leads`, `facebook.subscribe_lead_webhooks`, `facebook.acknowledge_lead_signal` | Internal MCP server over Meta Marketing API lead ads retrieval and page leadgen webhooks | Facebook lead forms are one of the highest-leverage native surfaces and need structured routing, not inbox chaos | Full |
| Paid coordination and attribution | `metaads.get_campaign_status`, `metaads.get_pixel_health`, `metaads.get_conversions_health`, `metaads.get_audience_summary` | Internal MCP server over Meta Marketing API and Conversions API state | The Facebook Specialist should stay aligned with paid and attribution state without owning ad buying | Read-only / limited |
| Product and destination inspection | `artifact.get_preview`, `artifact.capture_page`, `artifact.get_claims`, `artifact.validate_destination` | Internal MCP server over company artifacts and previews | Facebook posts and lead forms must stay aligned with the destination experience | Read-only |
| Analytics and attribution | `analytics.get_facebook_traffic`, `analytics.get_conversion_funnel`, `analytics.get_session_replays`, `analytics.compare_experiments` | Internal MCP server over PostHog | Strong first-party analytics and replay are the best fit for tying Facebook traffic and leads to actual business outcomes | Read-only |
| Link management | `links.create_utm_link`, `links.resolve_destination`, `links.get_click_summary` | Internal MCP server over company link conventions and analytics | Facebook experiments need consistent attribution-safe links | Full |
| Asset generation handoff | `content.render_creative_brief`, `content.render_carousel_brief`, `content.get_asset_status` | Internal MCP server over internal creative/render pipeline | Facebook often performs better with proof-heavy creative and simple visual assets that need structured handoff to content/design systems | Limited |
| Workspace docs | `workspace.write_owned_doc`, `workspace.append_experiment_result`, `workspace.update_page_profile` | Internal MCP server enforcing path-safe writes to owned docs only | The specialist needs durable written memory without raw unrestricted file editing | Full |
| Official-doc and policy fetch | `research.fetch_official_doc`, `research.extract_policy_constraints` | Internal MCP server with allowlisted official domains | Facebook execution must stay aligned with current platform policy and API constraints | Read-only |
| Social observability | `observe.get_publish_log`, `observe.get_permission_errors`, `observe.get_comment_response_times`, `observe.get_webhook_lag` | Internal MCP server over internal logs and Meta API/webhook state | Makes it possible to debug whether the workflow is actually healthy and responsive | Read-only |

## 10. Provider notes

### 10.1 Primary Facebook execution provider

Use an internal `facebook` MCP backed by official Meta APIs.

This should combine:

- Meta Pages API / Graph API for Page publishing and reads
- Graph API Webhooks for Page notifications and leadgen events
- Meta Marketing API for lead retrieval and paid-state visibility
- Meta Conversions API state for attribution health and downstream measurement

Why:

- Meta's terms explicitly restrict automated data collection and unauthorized website automation
- official APIs are the only durable path for autonomous page publishing, lead retrieval, and attribution-aware execution
- API-backed execution is scoped, auditable, and aligned with the platform's permission model

This is the core architectural decision for this role: do not make the Facebook Specialist browser-first.

### 10.2 Group and community participation

Facebook Groups can matter strategically, but they should not be automated through scraping or browser bots.

The correct design is:

- the agent maps the opportunity
- the agent drafts the post or comment kit
- the system packages it
- a human founder or approved operator executes it manually if the group and surface actually justify the effort

This preserves reliability and policy alignment.

### 10.3 Lead forms

Use Meta's native lead flows as a first-class surface.

Why:

- they are native to the platform
- they can create immediate founder-visible traction
- they provide a structured route from content or paid distribution into the company workflow

The specialist should not just collect leads. It should route them:

- to CMO for campaign quality review
- to CEO for founder-interest signals
- to sales or ops workflows if those exist later

### 10.4 Analytics

Use PostHog as the primary downstream analytics provider.

Why:

- the role needs more than reach and reaction counts
- it needs on-site behavior, funnel outcomes, and replay after the click
- it keeps the signal consistent with the rest of the company stack

### 10.5 Whitehat guerrilla marketing

This role should support aggressive but legitimate Facebook-native tactics, including:

- strong page posts tied to real business proof
- proof-heavy before/after or case-study content
- simple educational creative that earns saves and shares
- native lead-form tests for obvious offers
- comment-first participation on owned-page interactions
- human-assisted group participation for relevant communities
- founder or operator posts packaged for manual execution when appropriate
- post-to-landing-page angle matching

The point is to win on:

- relevance
- proof
- distribution discipline
- clear offers
- iteration speed

not on deception.

### 10.6 Excluded greyhat methods

The following are explicitly out of scope:

- buying or renting aged Facebook accounts
- fake pages or fake community identities
- fake reactions, comment farms, or bot engagement
- disguised employee amplification rings
- automated group posting through browser bots
- personal-profile automation
- automated unsolicited messaging
- unauthorized scraping or browser automation on Facebook surfaces

Reason:

- Meta's automated data collection terms and platform rules cut directly against these tactics
- they are brittle and easy to penalize
- they produce low-trust, low-quality signals for the company

## 11. Exact permission profile

### 11.1 Strategy and listening lane

Recommended SDK configuration:

- `permissionMode: "default"`
- explicit `allowedTools`
- `settingSources: ["user", "project"]`

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- `Skill`
- `mcp__org__get_live_state`
- `mcp__org__get_tasks`
- `mcp__org__send_message`
- `mcp__facebook__get_page_state`
- `mcp__facebook__get_post`
- `mcp__facebook__get_post_metrics`
- `mcp__facebook__get_page_notifications`
- `mcp__artifact__get_preview`
- `mcp__analytics__get_facebook_traffic`
- `mcp__research__fetch_official_doc`
- `mcp__workspace__update_page_profile`

Disallowed tools:

- raw `Bash`
- raw `Edit` / `Write`
- direct publish tools
- any browser automation against Facebook

### 11.2 Drafting lane

Recommended SDK configuration:

- `permissionMode: "default"`
- explicit `allowedTools`

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- `Skill`
- `mcp__org__get_live_state`
- `mcp__org__create_experiment`
- `mcp__facebook__create_page_draft`
- `mcp__artifact__get_preview`
- `mcp__artifact__get_claims`
- `mcp__links__create_utm_link`
- `mcp__content__render_creative_brief`
- `mcp__content__render_carousel_brief`
- `mcp__workspace__write_owned_doc`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- direct publish tools
- lead retrieval tools
- raw D1 access
- raw browser automation for Facebook actions

### 11.3 Publish, comments, and leads lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- explicit `allowedTools`
- publish and routing preflight required

Allowed tools:

- `mcp__org__get_live_state`
- `mcp__org__record_execution_note`
- `mcp__org__send_message`
- `mcp__facebook__publish_page_post`
- `mcp__facebook__schedule_page_post`
- `mcp__facebook__list_comments`
- `mcp__facebook__create_page_comment`
- `mcp__facebook__hide_comment`
- `mcp__facebook__list_lead_forms`
- `mcp__facebook__get_leads`
- `mcp__facebook__subscribe_lead_webhooks`
- `mcp__facebook__acknowledge_lead_signal`
- `mcp__observe__get_publish_log`
- `mcp__observe__get_permission_errors`
- `mcp__observe__get_webhook_lag`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- browser automation against Facebook
- group or personal-profile automation
- unsolicited messaging tools
- raw file-edit tools outside owned docs

### 11.4 Reporting lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- read-heavy

Allowed tools:

- `mcp__analytics__get_facebook_traffic`
- `mcp__analytics__get_conversion_funnel`
- `mcp__analytics__get_session_replays`
- `mcp__metaads__get_conversions_health`
- `mcp__observe__get_comment_response_times`
- `mcp__observe__get_webhook_lag`
- `mcp__org__send_message`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- publish tools
- lead-write tools
- raw web search

## 12. Internal MCP servers

The Facebook Specialist should rely on a small number of explicit internal MCP servers.

### 12.1 `org`

Purpose:

- source of truth for structured tasks, experiments, messages, and execution notes

Key operations:

- `get_live_state`
- `send_message`
- `create_experiment`
- `record_execution_note`
- `update_workflow`

### 12.2 `facebook`

Purpose:

- official Facebook Page posting, reads, comments, notifications, and lead handling

Backed by:

- Meta Pages API / Graph API
- Page and leadgen webhooks
- Meta Marketing API where needed for lead retrieval

Key operations:

- `create_page_draft`
- `publish_page_post`
- `schedule_page_post`
- `get_post`
- `get_post_metrics`
- `get_page_state`
- `get_page_notifications`
- `list_comments`
- `create_page_comment`
- `hide_comment`
- `list_lead_forms`
- `get_leads`
- `subscribe_lead_webhooks`
- `acknowledge_lead_signal`

### 12.3 `metaads`

Purpose:

- read attribution, paid-state, and audience context

Key operations:

- `get_campaign_status`
- `get_pixel_health`
- `get_conversions_health`
- `get_audience_summary`

### 12.4 `artifact`

Purpose:

- validate the product destination and claim surface

Key operations:

- `get_preview`
- `capture_page`
- `get_claims`
- `validate_destination`

### 12.5 `analytics`

Purpose:

- connect Facebook activity to actual product and funnel behavior

Backed by:

- PostHog

Key operations:

- `get_facebook_traffic`
- `get_conversion_funnel`
- `get_session_replays`
- `compare_experiments`

### 12.6 `links`

Purpose:

- standardize attribution-safe links

Key operations:

- `create_utm_link`
- `resolve_destination`
- `get_click_summary`

### 12.7 `content`

Purpose:

- coordinate creative packages and proof-heavy asset handoffs

Key operations:

- `render_creative_brief`
- `render_carousel_brief`
- `get_asset_status`

### 12.8 `workspace`

Purpose:

- enforce path-safe writes to owned Facebook docs only

Key operations:

- `write_owned_doc`
- `append_experiment_result`
- `update_page_profile`

### 12.9 `observe`

Purpose:

- page, lead, and webhook observability

Key operations:

- `get_publish_log`
- `get_permission_errors`
- `get_comment_response_times`
- `get_webhook_lag`

### 12.10 `research`

Purpose:

- fetch official policy docs and platform constraints

Key operations:

- `fetch_official_doc`
- `extract_policy_constraints`

## 13. Provisioning-time workflow

At provisioning, the Facebook Specialist should not start publishing immediately unless the CMO has already marked Facebook as an active channel.

Provisioning-time workflow:

1. Read the execution contract, mission, and marketing plan.
2. Determine whether Facebook is in scope this week.
3. If Facebook is out of scope:
   - stay idle
   - maintain no active queue
4. If Facebook is in scope:
   - define the channel surface strategy:
     - Facebook Page content
     - lead forms
     - human-assisted group participation
     - paid coordination visibility
   - inspect the current landing page or artifact
   - define 3 to 5 content or offer angles
   - prepare the first experiment queue
   - write the Facebook playbook and proof-point library

The Facebook Specialist should not publish before:

- the destination is credible
- the message is aligned
- the page and permissions are actually configured

## 14. Standard workflow

The standard workflow should be:

1. CMO marks Facebook as active for the week.
2. Facebook Specialist refreshes page strategy, lead surfaces, and current priorities.
3. It identifies:
   - page post opportunities
   - simple creative or carousel opportunities
   - lead-form opportunities
   - human-assisted group participation plays
4. It validates the destination artifact and allowed claims.
5. It creates structured drafts for each play.
6. It publishes or schedules only after:
   - claim check
   - permission check
   - duplication check
   - destination check
7. It monitors comments, lead webhooks, and page signals.
8. It routes:
   - product objections to CTO or CEO
   - positioning learnings to CMO
   - founder-interest moments to CEO
   - qualified lead signals to the correct downstream workflow
   - unsupported group or profile actions into human-assisted execution
9. It records:
   - post URL
   - page used
   - format
   - angle
   - clicks
   - leads
   - downstream conversions
   - qualitative response
10. It updates the weekly summary and next experiments.

## 15. Reliability controls

### 15.1 Policy compliance

Hard rules:

- no fake personas
- no fake pages
- no browser automation against Facebook surfaces
- no group posting automation
- no automated unsolicited messaging
- no fake engagement
- no publishing content the product cannot support

### 15.2 Surface clarity

Every action must be classified as one of:

- page post
- page comment or moderation action
- lead-form play
- human-assisted group participation
- paid-coordination insight

This matters because the actor, permission surface, and allowed tools differ by mode.

### 15.3 Publish discipline

Each published item must have:

- one clear intent
- one destination at most
- one experiment tag
- one owner page

### 15.4 Human-required actions

When the action requires:

- personal-profile posting
- nuanced founder or community relationship work
- unsupported group posting or commenting
- unsupported direct messaging

the specialist should package the action for human execution, not attempt to automate it.

### 15.5 Evidence

Every publish or important comment or lead event must capture:

- permalink or object id
- page used
- timestamp
- experiment id
- current metric snapshot
- any permission or webhook anomalies

### 15.6 Feedback routing

Every meaningful Facebook response should be classified into:

- objection
- feature request
- trust signal
- conversion intent
- lead intent
- partnership signal
- moderation or permission risk

## 16. What to borrow from `everything-claude-code`

The useful ideas to borrow are operational, not tactical:

- strong role-specific skills
- reusable playbooks
- repeatable action checklists
- short execution loops with written outputs
- evals against common failure patterns

Applied here, that means:

- explicit pre-publish and pre-lead-flow checklists
- reusable page-post and lead-offer playbooks
- required post-action and lead-action summaries
- evals for generic copy, weak proof, and unsupported-action leakage

## 17. Why Relay should not be the Facebook Specialist's primary coordination bus

Relay can be useful later for richer agent transport.

It should not be the primary bus for this role because:

- Facebook execution depends on typed page, lead, and permission state
- publish and lead actions need serialized workflow transitions
- webhook and attribution state matter more than open-ended conversation

The primary bus should remain:

- internal structured coordination through the local coordinator + D1 mirror

Relay can become an optional future transport once the structured workflow layer is stable.

## 18. Implementation phases

### Phase 1: structured Facebook workflow

- keep the agent on Opus 4.6
- remove any broad `bypassPermissions` path
- add the `facebook`, `metaads`, `artifact`, `analytics`, `links`, `content`, and `workspace` MCP servers
- define page, lead, and experiment objects

### Phase 2: publish, comments, and lead routing

- add API-backed publish preflight
- add page comment and lead webhook handling
- add founder-visible weekly summaries

### Phase 3: human-assisted group workflow

- package group participation plays for manual execution
- track completion and outcomes back into the system

### Phase 4: observability and quality

- add permission-error tracking
- add webhook-lag monitoring
- add evals for generic copy, weak proof, and unsupported-action attempts

### Phase 5: multi-provider portability

- keep the same tool plane
- add other agent drivers later
- optionally add Relay for live collaboration once typed workflow state is mature

## 19. Recommended final stack

If I were implementing the Facebook Specialist next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Primary Facebook execution: internal `facebook` MCP over official Meta Pages API / Graph API
- Lead handling: Meta Marketing API lead retrieval + Page leadgen webhooks
- Paid and attribution visibility: Meta Marketing API + Conversions API state via internal `metaads` MCP
- Product/destination validation: internal artifact MCP over company previews and claims
- Analytics: PostHog
- Link tracking: internal UTM/link MCP
- Creative handoff: internal content/render MCP
- Observability: internal execution logs + Meta API/webhook state
- Workspace memory: path-safe workspace MCP for owned Facebook docs only
- Human-assisted fallback: packaged manual execution for groups and personal-profile activity

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the Facebook Specialist, without turning it into a scraper, fake-engagement bot, or brittle website-automation wrapper.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare D1 overview: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/)
- Meta Automated Data Collection Terms: [facebook.com/legal/automated_data_collection_terms](https://www.facebook.com/legal/automated_data_collection_terms)
- Meta Pages API and posts docs: [developers.facebook.com/docs/pages-api](https://developers.facebook.com/docs/pages-api/), [developers.facebook.com/docs/pages-api/posts](https://developers.facebook.com/docs/pages-api/posts/)
- Meta Pages API search and getting started docs: [developers.facebook.com/docs/pages-api/search-pages](https://developers.facebook.com/docs/pages-api/search-pages/), [developers.facebook.com/docs/pages-api/getting-started](https://developers.facebook.com/docs/pages-api/getting-started/)
- Meta Graph API webhooks for Pages: [developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages)
- Meta Marketing API: [developers.facebook.com/docs/marketing-apis](https://developers.facebook.com/docs/marketing-apis/)
- Meta lead ads retrieving guide: [developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/)
- Meta Conversions API: [developers.facebook.com/docs/marketing-api/conversions-api](https://developers.facebook.com/docs/marketing-api/conversions-api/)
- Meta Conversions API best practices: [developers.facebook.com/docs/marketing-api/conversions-api/best-practices](https://developers.facebook.com/docs/marketing-api/conversions-api/best-practices/)
- PostHog docs: [posthog.com/docs](https://posthog.com/docs)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
