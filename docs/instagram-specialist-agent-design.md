# Instagram Specialist Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: Instagram Specialist agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build an Instagram Specialist agent that is:

- the single owner of Instagram execution under the CMO
- capable of turning the weekly marketing strategy into credible Instagram-native content, conversation loops, lead signals, and experiments
- able to build distribution through real professional-account publishing, creator-style packaging, and measurable attribution
- able to connect Instagram activity to profile actions, clicks, leads, and downstream conversion signals
- reliable enough to run autonomously without getting the account, app, or business assets restricted
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The Instagram Specialist is not just a scheduler and not just a visual copywriter. It is the Instagram execution plane for the company:

- it owns Instagram professional-account publishing
- it coordinates feed, carousel, reel, and story-adjacent content strategy
- it monitors comments, mentions, and messages where supported
- it keeps Instagram output aligned with the real product, proof, and landing pages
- it routes audience reactions and lead intent back into the company
- it turns content performance into structured learnings for the CMO, CEO, and CTO

## 2. Non-goals

The Instagram Specialist should not:

- replace the CMO as the channel strategist
- replace the CEO or founder when a true founder or creator relationship move is required
- replace the CTO when product claims need technical validation
- use fake personas, bought aged accounts, or covert astroturfing
- buy followers, likes, comments, saves, shares, or fake UGC
- run hidden engagement pods or coordinated inauthentic amplification
- scrape Instagram or automate Instagram website activity with browser bots
- automate unsupported personal-account, creator-collab, or DM workflows outside the official API surface
- rely on markdown notes as the primary workflow system
- depend on stale hidden memory instead of live state

Those tactics are excluded on purpose.

They are not just ethically weak. They are structurally weak:

- Meta is hostile to unauthorized automated data collection and unsupported automation
- fake growth tactics distort content feedback loops and harm account health
- a visual, credibility-sensitive channel becomes useless if the system learns to optimize for fake engagement
- they are the wrong foundation for an autonomous company that is supposed to operate for a long time

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and workflows

This design changes the Instagram Specialist implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- Instagram work existing only as vague "content plans" instead of account-level execution and measurable experiments
- weak visibility into what was published, what was replied to, and what actually worked
- no clean distinction between publishing, messaging, comments, mentions, and paid coordination
- no structured route from Instagram interactions back to product, sales, or founder workflows
- brittle assumptions that browser automation or scraping are valid execution primitives
- content activity that looks busy but is not attributable to any real business outcome

## 4. Instagram Specialist operating position in the org

### 4.1 Chain of command

The Instagram Specialist reports to the CMO.

The Instagram Specialist owns:

- Instagram professional-account execution
- content queue and cadence
- content packaging for feed posts, carousels, reels, and supported publishing surfaces
- Instagram comment, mention, and messaging workflows where officially supported
- Instagram-specific experiment summaries
- Instagram-native lead and intent signal routing

The Instagram Specialist must stay tightly aligned with:

- the CMO for narrative, audience, cadence, and weekly priorities
- the CEO for mission, founder positioning, and escalation-worthy market signals
- the CTO for product truth, launch-readiness, and proof constraints

The Instagram Specialist does not bypass:

- the CMO for strategy
- the CEO or founder for high-trust creator or founder interactions
- the CTO for product claims
- Procurement or the API Key Provider for account, app, or paid access setup

### 4.2 What "done" means

From the Instagram Specialist's point of view, work is only done when:

1. the content mode and account surface are aligned with the current strategy
2. the media, caption, and CTA fit Instagram's actual product surface
3. the destination page and proof points are real
4. the action is published, scheduled, or packaged through an auditable workflow
5. comments, mentions, or messages are monitored and routed correctly
6. traffic, profile actions, leads, and conversion outcomes are measured
7. the resulting learnings are routed back into the company

Nothing short of that should become founder-visible "Instagram progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- Instagram combines visual packaging, caption judgment, CTA discipline, creator-style tone, and response triage.
- Weak models tend to produce generic aspirational copy, interchangeable hook lines, low-trust CTA patterns, and boring content structures.
- The Instagram Specialist needs to reason across media format, proof, audience fit, comments, messaging, and attribution in one loop.

Recommendation:

- keep the Instagram Specialist on Opus 4.6 in v1
- later, low-risk queue cleanup and simple reporting can move to cheaper models
- keep content judgment, publishing decisions, and escalation logic on Opus

Implementation requirement:

- do not run the Instagram Specialist in `bypassPermissions`
- use explicit `allowedTools`
- use official Instagram Graph / Messaging APIs where available
- use human-assisted fallback for unsupported creator, personal, or relationship workflows instead of browser automation

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

The Instagram Specialist tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The Instagram Specialist must not operate through ad hoc notes or direct D1 writes.

Use:

- the per-company `CompanyCoordinator` service running on the supervisor VM as the serialized workflow layer
- local SQLite as the hot coordination store for that service
- D1 as the historical mirror
- the shared workspace for sanitized playbooks, asset plans, and summaries

Why:

- Instagram has multiple distinct execution surfaces with different capability and permission boundaries
- one company can have publishing, comments, mentions, DMs, creator-style content packaging, and paid coordination happening at the same time
- publish, message, and attribution state need durable workflow serialization

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - account strategy state
  - content queue
  - media package queue
  - comment backlog
  - mention backlog
  - DM backlog where supported
  - experiment state
  - account and token health metadata
  - idempotency keys
- D1:
  - historical publish log
  - experiment summaries
  - traffic and lead summaries
  - comment, mention, and message routing history
  - agent message history
  - founder-visible execution summaries
- workspace:
  - Instagram playbook
  - content archetypes
  - comment and objection libraries
  - proof-point libraries
  - weekly summaries
- R2:
  - media assets
  - screenshots
  - rendered reports
  - evidence bundles

### 6.3 Source-of-truth order

The Instagram Specialist must treat state in this order:

1. coordinator live workflow state
2. current Instagram account, message, and insight state
3. D1 mirrored history
4. canonical marketing docs and product artifacts
5. recent CMO/CEO/CTO messages
6. session memory

Session memory is never authoritative.

## 7. Instagram Specialist lanes

This agent should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Account strategy and listening lane

Purpose:

- define the role of Instagram this week
- monitor account state, audience response, and content opportunities
- map which formats and narratives fit now

Properties:

- read-heavy
- no publishing
- updates account and opportunity state

### 7.2 Drafting and packaging lane

Purpose:

- draft captions, carousel narratives, reel briefs, CTA structures, comment kits, and message playbooks
- align content to landing pages, offers, and current proof points
- prepare assets for rendering and review

Properties:

- write-heavy
- draft-only
- cannot publish directly

### 7.3 Publish, comments, and messaging lane

Purpose:

- publish or schedule professional-account content through official APIs
- monitor comments, mentions, and messaging where officially supported
- route qualified signals into the right downstream workflow

Properties:

- API-backed write access
- strict permission and duplication checks
- must attach evidence and state after each action

### 7.4 Reporting and routing lane

Purpose:

- summarize what actually happened on Instagram
- connect content to downstream behavior
- route objections, sales signals, product signals, and creator signals to the right role

Properties:

- read-heavy
- no publishing
- summary and routing only

## 8. Files and contracts the Instagram Specialist owns

Recommended owned files:

- `/workspace/docs/marketing/instagram-playbook.md`
  - channel strategy, audience, surfaces, anti-goals, and current priorities
- `/workspace/docs/marketing/instagram-account-profile.json`
  - approved professional account, owner role, content modes, and current status
- `/workspace/docs/marketing/instagram-queue.json`
  - sanitized queue mirror of planned posts, reels, carousels, story-adjacent prompts, and reply flows
- `/workspace/docs/marketing/instagram-experiments.json`
  - experiment registry with hypothesis, angle, owner, and result
- `/workspace/docs/marketing/instagram-proof-points.md`
  - allowed claims, customer proof, offer proof, and launch facts
- `/workspace/docs/marketing/instagram-comment-library.md`
  - approved response patterns and objection handling
- `/workspace/docs/marketing/instagram-message-playbook.md`
  - approved DM and quick-reply guidance where supported
- `/workspace/docs/marketing/instagram-weekly-summary.md`
  - founder-readable weekly output and learnings

Required structured objects in the coordinator:

- `instagram_account_profile`
- `instagram_post_draft`
- `instagram_publish_event`
- `instagram_comment_backlog_item`
- `instagram_mention_backlog_item`
- `instagram_dm_signal`
- `instagram_experiment`
- `instagram_account_health`
- `instagram_permission_blocker`

## 9. Instagram Specialist tool surface

The Instagram Specialist should mutate the world only through explicit internal tools.

### 9.1 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | Instagram Specialist access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.get_tasks`, `org.send_message`, `org.create_experiment`, `org.record_execution_note`, `org.update_workflow` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable workflow state matching the current architecture | Full |
| Instagram publishing and readback | `instagram.create_media_container`, `instagram.publish_media`, `instagram.get_media`, `instagram.get_post_metrics`, `instagram.get_account_state`, `instagram.get_mentions` | Internal MCP server over official Instagram Graph API and Content Publishing endpoints | Highest reliability comes from official professional-account APIs instead of browser automation or scraping | Full within approved scopes |
| Comments, mentions, and messaging | `instagram.list_comments`, `instagram.reply_to_comment`, `instagram.list_mentions`, `instagram.list_messages`, `instagram.send_message`, `instagram.get_message_context` | Internal MCP server over official Instagram Graph API, Instagram Messaging API, and webhooks | Needed for supported interaction loops and lead-signal capture on professional accounts | Limited / scoped |
| Insights and account analytics | `instagram.get_insights`, `instagram.get_profile_actions`, `instagram.get_content_breakdown` | Internal MCP server over official Instagram Insights endpoints | Native account and content insights should be read directly from the platform source of truth | Read-only |
| Paid coordination and attribution | `metaads.get_campaign_status`, `metaads.get_pixel_health`, `metaads.get_conversions_health`, `metaads.get_audience_summary` | Internal MCP server over Meta Marketing API and Conversions API state | The Instagram Specialist should stay aligned with paid and attribution state without owning ad buying | Read-only / limited |
| Product and destination inspection | `artifact.get_preview`, `artifact.capture_page`, `artifact.get_claims`, `artifact.validate_destination` | Internal MCP server over company artifacts and previews | Instagram posts and CTAs must stay aligned with the destination experience | Read-only |
| Analytics and attribution | `analytics.get_instagram_traffic`, `analytics.get_conversion_funnel`, `analytics.get_session_replays`, `analytics.compare_experiments` | Internal MCP server over PostHog | Strong first-party analytics and replay are the best fit for tying Instagram activity to real business outcomes | Read-only |
| Link management | `links.create_utm_link`, `links.resolve_destination`, `links.get_click_summary` | Internal MCP server over company link conventions and analytics | Instagram experiments need consistent attribution-safe links and CTA routing | Full |
| Asset generation handoff | `content.render_carousel_brief`, `content.render_reel_brief`, `content.render_story_brief`, `content.get_asset_status` | Internal MCP server over internal creative/render pipeline | Instagram is asset-heavy; the specialist needs structured handoff to creative systems instead of improvising formats | Limited |
| Workspace docs | `workspace.write_owned_doc`, `workspace.append_experiment_result`, `workspace.update_account_profile` | Internal MCP server enforcing path-safe writes to owned docs only | The specialist needs durable written memory without raw unrestricted file editing | Full |
| Official-doc and policy fetch | `research.fetch_official_doc`, `research.extract_policy_constraints` | Internal MCP server with allowlisted official domains | Instagram execution must stay aligned with current platform policy and API constraints | Read-only |
| Social observability | `observe.get_publish_log`, `observe.get_permission_errors`, `observe.get_comment_response_times`, `observe.get_webhook_lag` | Internal MCP server over internal logs and Meta API/webhook state | Makes it possible to debug whether the workflow is healthy and responsive | Read-only |

## 10. Provider notes

### 10.1 Primary Instagram execution provider

Use an internal `instagram` MCP backed by official Meta APIs.

This should combine:

- Instagram Graph API for professional-account publishing and readback
- Content Publishing endpoints for supported media publishing flows
- Instagram Messaging API for supported DM and conversation workflows
- Graph API Webhooks for comments, mentions, and message events
- Instagram Insights endpoints for native account and content performance

Why:

- Meta is hostile to unauthorized automation and automated data collection on its surfaces
- official APIs are the only durable path for autonomous publishing, comment handling, messaging, and insight retrieval
- API-backed execution is scoped, auditable, and aligned with the platform's permission model

This is the core architectural decision for this role: do not make the Instagram Specialist browser-first.

### 10.2 Professional account requirement

This role should assume:

- Instagram Business or Creator account
- connected Meta app and permissions
- clean business-asset ownership path

If the company does not have the right professional-account setup, the correct behavior is to create a permission blocker and route setup through the API Key Provider or human operator.

### 10.3 Messaging

Use the official Instagram Messaging API where supported.

Why:

- inbound conversations are high-value signals
- DMs often contain direct purchase intent, objections, or creator collaboration signals
- official messaging support is better than trying to script unsupported message surfaces

When a desired messaging action is unsupported by the API surface, the specialist should package it for human execution.

### 10.4 Analytics

Use PostHog as the primary downstream analytics provider.

Why:

- the role needs more than likes, views, or reach
- it needs on-site behavior, funnels, and replay after the click
- it keeps the signal consistent with the rest of the company stack

### 10.5 Whitehat guerrilla marketing

This role should support aggressive but legitimate Instagram-native tactics, including:

- proof-heavy carousels that teach something real
- reel concepts tied to actual product outcomes or transformations
- comment-first engagement on owned content and inbound mentions
- creator-style hooks grounded in real product truth
- saveable or shareable assets with clear value
- founder or operator content packaged for human or supported publishing
- CTA-to-landing-page angle matching
- DM or comment follow-up where the official API allows it

The point is to win on:

- proof
- visual clarity
- consistency
- audience fit
- iteration speed

not on deception.

### 10.6 Excluded greyhat methods

The following are explicitly out of scope:

- buying or renting aged Instagram accounts
- fake creators or fake community personas
- fake followers, comments, likes, saves, or shares
- hidden engagement pods
- browser-bot posting or scraping
- automated behavior on unsupported personal-account or creator surfaces
- spammy DM automation

Reason:

- Meta's automated data collection terms and platform rules cut directly against these tactics
- they are brittle and easy to penalize
- they poison the feedback loop with low-trust signals

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
- `mcp__instagram__get_account_state`
- `mcp__instagram__get_media`
- `mcp__instagram__get_post_metrics`
- `mcp__instagram__get_mentions`
- `mcp__instagram__get_insights`
- `mcp__artifact__get_preview`
- `mcp__analytics__get_instagram_traffic`
- `mcp__research__fetch_official_doc`
- `mcp__workspace__update_account_profile`

Disallowed tools:

- raw `Bash`
- raw `Edit` / `Write`
- direct publish tools
- any browser automation against Instagram

### 11.2 Drafting and packaging lane

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
- `mcp__artifact__get_preview`
- `mcp__artifact__get_claims`
- `mcp__links__create_utm_link`
- `mcp__content__render_carousel_brief`
- `mcp__content__render_reel_brief`
- `mcp__content__render_story_brief`
- `mcp__workspace__write_owned_doc`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- direct publish tools
- message-send tools
- raw D1 access
- raw browser automation for Instagram actions

### 11.3 Publish, comments, and messaging lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- explicit `allowedTools`
- publish and routing preflight required

Allowed tools:

- `mcp__org__get_live_state`
- `mcp__org__record_execution_note`
- `mcp__org__send_message`
- `mcp__instagram__create_media_container`
- `mcp__instagram__publish_media`
- `mcp__instagram__list_comments`
- `mcp__instagram__reply_to_comment`
- `mcp__instagram__list_mentions`
- `mcp__instagram__list_messages`
- `mcp__instagram__send_message`
- `mcp__instagram__get_message_context`
- `mcp__observe__get_publish_log`
- `mcp__observe__get_permission_errors`
- `mcp__observe__get_webhook_lag`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- browser automation against Instagram
- unsupported personal-account or creator-surface automation
- spam or bulk-message tools
- raw file-edit tools outside owned docs

### 11.4 Reporting lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- read-heavy

Allowed tools:

- `mcp__instagram__get_insights`
- `mcp__analytics__get_instagram_traffic`
- `mcp__analytics__get_conversion_funnel`
- `mcp__analytics__get_session_replays`
- `mcp__metaads__get_conversions_health`
- `mcp__observe__get_comment_response_times`
- `mcp__observe__get_webhook_lag`
- `mcp__org__send_message`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- publish tools
- message-write tools outside supported routed responses
- raw web search

## 12. Internal MCP servers

The Instagram Specialist should rely on a small number of explicit internal MCP servers.

### 12.1 `org`

Purpose:

- source of truth for structured tasks, experiments, messages, and execution notes

Key operations:

- `get_live_state`
- `send_message`
- `create_experiment`
- `record_execution_note`
- `update_workflow`

### 12.2 `instagram`

Purpose:

- official Instagram publishing, reading, messaging, comments, mentions, and insight retrieval

Backed by:

- Instagram Graph API
- Content Publishing endpoints
- Instagram Messaging API
- Graph API webhooks
- Insights endpoints

Key operations:

- `create_media_container`
- `publish_media`
- `get_media`
- `get_post_metrics`
- `get_account_state`
- `get_mentions`
- `list_comments`
- `reply_to_comment`
- `list_messages`
- `send_message`
- `get_message_context`
- `get_insights`

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

- connect Instagram activity to actual product and funnel behavior

Backed by:

- PostHog

Key operations:

- `get_instagram_traffic`
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

- coordinate media packaging and creative handoff

Key operations:

- `render_carousel_brief`
- `render_reel_brief`
- `render_story_brief`
- `get_asset_status`

### 12.8 `workspace`

Purpose:

- enforce path-safe writes to owned Instagram docs only

Key operations:

- `write_owned_doc`
- `append_experiment_result`
- `update_account_profile`

### 12.9 `observe`

Purpose:

- account, message, and webhook observability

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

At provisioning, the Instagram Specialist should not start publishing immediately unless the CMO has already marked Instagram as an active channel.

Provisioning-time workflow:

1. Read the execution contract, mission, and marketing plan.
2. Determine whether Instagram is in scope this week.
3. If Instagram is out of scope:
   - stay idle
   - maintain no active queue
4. If Instagram is in scope:
   - define the channel surface strategy:
     - feed posts
     - carousels
     - reels
     - supported comments, mentions, and messages
     - paid coordination visibility
   - inspect the current landing page or artifact
   - define 3 to 5 content or offer angles
   - prepare the first experiment queue
   - write the Instagram playbook and proof-point library

The Instagram Specialist should not publish before:

- the destination is credible
- the message is aligned
- the professional account and permissions are actually configured

## 14. Standard workflow

The standard workflow should be:

1. CMO marks Instagram as active for the week.
2. Instagram Specialist refreshes account strategy, content surfaces, and current priorities.
3. It identifies:
   - feed post opportunities
   - carousel opportunities
   - reel opportunities
   - comment and mention-response opportunities
   - supported messaging opportunities
4. It validates the destination artifact and allowed claims.
5. It creates structured drafts and asset briefs for each play.
6. It publishes only after:
   - claim check
   - permission check
   - duplication check
   - destination check
7. It monitors comments, mentions, messages, and account insights.
8. It routes:
   - product objections to CTO or CEO
   - positioning learnings to CMO
   - founder-interest moments to CEO
   - qualified lead or creator signals to the correct downstream workflow
9. It records:
   - post URL or media id
   - account used
   - format
   - angle
   - clicks
   - profile actions
   - leads
   - downstream conversions
   - qualitative response
10. It updates the weekly summary and next experiments.

## 15. Reliability controls

### 15.1 Policy compliance

Hard rules:

- no fake personas
- no fake accounts
- no browser automation against Instagram surfaces
- no fake engagement
- no spam messaging
- no publishing content the product cannot support

### 15.2 Surface clarity

Every action must be classified as one of:

- feed or carousel publish
- reel publish
- comment-response action
- mention-response action
- DM action on supported messaging surfaces
- paid-coordination insight

This matters because the actor, permission surface, and allowed tools differ by mode.

### 15.3 Publish discipline

Each published item must have:

- one clear intent
- one destination at most
- one experiment tag
- one owner account

### 15.4 Human-required actions

When the action requires:

- unsupported creator or personal-account behavior
- nuanced founder or creator relationship work
- unsupported outreach patterns
- unsupported messaging actions

the specialist should package the action for human execution, not attempt to automate it.

### 15.5 Evidence

Every publish or important comment, mention, or DM event must capture:

- permalink or media id
- account used
- timestamp
- experiment id
- current metric snapshot
- any permission or webhook anomalies

### 15.6 Feedback routing

Every meaningful Instagram response should be classified into:

- objection
- feature request
- trust signal
- conversion intent
- creator or collaboration signal
- support signal
- moderation or permission risk

## 16. What to borrow from `everything-claude-code`

The useful ideas to borrow are operational, not tactical:

- strong role-specific skills
- reusable playbooks
- repeatable action checklists
- short execution loops with written outputs
- evals against common failure patterns

Applied here, that means:

- explicit pre-publish and pre-message checklists
- reusable caption, carousel, reel, and reply playbooks
- required post-action summaries
- evals for generic copy, weak proof, and unsupported-action leakage

## 17. Why Relay should not be the Instagram Specialist's primary coordination bus

Relay can be useful later for richer agent transport.

It should not be the primary bus for this role because:

- Instagram execution depends on typed content, messaging, and permission state
- publish and message actions need serialized workflow transitions
- webhook, insight, and attribution state matter more than open-ended conversation

The primary bus should remain:

- internal structured coordination through the local coordinator + D1 mirror

Relay can become an optional future transport once the structured workflow layer is stable.

## 18. Implementation phases

### Phase 1: structured Instagram workflow

- keep the agent on Opus 4.6
- remove any broad `bypassPermissions` path
- add the `instagram`, `metaads`, `artifact`, `analytics`, `links`, `content`, and `workspace` MCP servers
- define publish, comment, message, and experiment objects

### Phase 2: publishing, comments, and message routing

- add API-backed publish preflight
- add comment, mention, and message webhook handling
- add founder-visible weekly summaries

### Phase 3: richer asset packaging

- improve carousel, reel, and story-brief generation
- connect creative outputs more tightly to landing-page angles and proof libraries

### Phase 4: observability and quality

- add permission-error tracking
- add webhook-lag monitoring
- add evals for generic copy, weak proof, and unsupported-action attempts

### Phase 5: multi-provider portability

- keep the same tool plane
- add other agent drivers later
- optionally add Relay for live collaboration once typed workflow state is mature

## 19. Recommended final stack

If I were implementing the Instagram Specialist next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Primary Instagram execution: internal `instagram` MCP over official Instagram Graph API and Messaging API
- Publishing: Content Publishing endpoints for supported professional-account media flows
- Messaging and interaction handling: official messaging, comments, mentions, and webhook endpoints where supported
- Paid and attribution visibility: Meta Marketing API + Conversions API state via internal `metaads` MCP
- Product/destination validation: internal artifact MCP over company previews and claims
- Analytics: PostHog
- Link tracking: internal UTM/link MCP
- Creative handoff: internal content/render MCP
- Observability: internal execution logs + Meta API/webhook state
- Workspace memory: path-safe workspace MCP for owned Instagram docs only
- Human-assisted fallback: packaged manual execution for unsupported creator or relationship actions

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the Instagram Specialist, without turning it into a scraper, fake-engagement bot, or brittle website-automation wrapper.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare D1 overview: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/)
- Meta Automated Data Collection Terms: [facebook.com/legal/automated_data_collection_terms](https://www.facebook.com/legal/automated_data_collection_terms)
- Meta Terms of Service: [facebook.com/legal/terms](https://www.facebook.com/legal/terms)
- Instagram Graph API overview: [developers.facebook.com/docs/instagram-platform](https://developers.facebook.com/docs/instagram-platform/)
- Instagram Content Publishing API: [developers.facebook.com/docs/instagram-platform/content-publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
- Instagram Messaging API: [developers.facebook.com/docs/messenger-platform/instagram](https://developers.facebook.com/docs/messenger-platform/instagram)
- Instagram webhooks: [developers.facebook.com/docs/graph-api/webhooks/getting-started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)
- Instagram Insights and mentions reference: [developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights), [developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/recently_searched_hashtags](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/recently_searched_hashtags)
- Meta Marketing API: [developers.facebook.com/docs/marketing-apis](https://developers.facebook.com/docs/marketing-apis/)
- Meta Conversions API: [developers.facebook.com/docs/marketing-api/conversions-api](https://developers.facebook.com/docs/marketing-api/conversions-api/)
- PostHog docs: [posthog.com/docs](https://posthog.com/docs)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
