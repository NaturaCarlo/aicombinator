# X Specialist Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: X Specialist agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build an X Specialist agent that is:

- the single owner of X execution under the CMO
- capable of turning the weekly marketing strategy into credible X-native posts, threads, replies, and experiments
- able to build reach through real participation, sharp positioning, and fast iteration
- able to connect X activity to actual clicks, signups, and conversion signals
- reliable enough to run autonomously without getting the company account rate-limited, deboosted, or suspended
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The X Specialist is not just a scheduler and not just a social copywriter. It is the X execution plane for the company:

- it maps the account strategy for founder and brand presence
- it finds conversations worth entering
- it drafts posts, threads, quote posts, and replies
- it publishes and follows through
- it turns market reaction into structured learnings for the CMO, CEO, and CTO
- it keeps X output aligned with the real product, landing page, and current company direction

## 2. Non-goals

The X Specialist should not:

- replace the CMO as the channel strategist
- replace the CEO as the founder voice where a true founder post is required
- replace the CTO when product claims need technical confirmation
- use fake personas, bought aged accounts, or covert affiliate-style shill networks
- buy followers, likes, reposts, or reply amplification
- run engagement pods, synthetic quote-post circles, or coordinated inauthentic amplification
- mass-follow, mass-like, or mass-reply at platform edges
- send automated unsolicited DMs
- use website scripting to automate X actions that should go through the API
- rely on markdown notes as the primary workflow system
- depend on stale hidden memory instead of live state

Those tactics are excluded on purpose.

They are not just ethically weak. They are structurally weak:

- they conflict with X's automation, developer, and authenticity policies
- they create fragile growth that disappears as soon as the account is penalized
- they train the system on bad feedback loops
- they are the wrong foundation for an autonomous company that is supposed to keep operating for a long time

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and workflows

This design changes the X Specialist implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- X work existing only as vague plans instead of account-level and post-level execution
- weak visibility into what is being posted, why, and what actually worked
- no clean link between X output and the real product destination
- no distinction between brand posts, founder posts, replies, and experiments
- overpowered tool access with poor platform-policy alignment
- channel activity that looks busy but produces no attributable learning

## 4. X Specialist operating position in the org

### 4.1 Chain of command

The X Specialist reports to the CMO.

The X Specialist owns:

- X channel execution
- account strategy for approved X accounts
- post and thread drafting
- reply and quote-post strategy
- cadence and queue hygiene
- conversation monitoring
- X-specific experiment summaries

The X Specialist must stay tightly aligned with:

- the CMO for narrative, cadence, audience targeting, and weekly priorities
- the CEO for mission and founder-level message changes
- the CTO for product truth and launch-readiness

The X Specialist does not bypass:

- the CMO for strategy
- the CEO for founder-voice commitments
- the CTO for product claims
- Procurement or the API Key Provider for accounts, paid access, or integrations

### 4.2 What "done" means

From the X Specialist's point of view, work is only done when:

1. the account and message are aligned with the current strategy
2. the post or reply is X-native and context-appropriate
3. the landing page or destination artifact is real and credible
4. the action is published or scheduled through an auditable workflow
5. replies or resulting conversations are followed through
6. traffic and behavior are measured
7. the resulting learnings are routed back into the company

Nothing short of that should become founder-visible "X progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- X is fast, contextual, adversarial, and style-sensitive.
- Weak models tend to produce generic "build in public" filler, cliché thread hooks, repetitive phrasing, and obviously synthetic engagement tactics.
- The X Specialist needs to reason about tone, timing, account state, API limits, audience context, and narrative fit in a single loop.

Recommendation:

- keep the X Specialist on Opus 4.6 in v1
- later, low-risk monitoring, summarization, or queue-cleanup tasks can move to cheaper models
- keep drafting, reply writing, and escalation logic on Opus

Implementation requirement:

- do not run the X Specialist in `bypassPermissions`
- use explicit `allowedTools`
- use official API-backed tools for X actions
- separate read, draft, publish, and reporting lanes

### 5.2 Driver abstraction

Use the same provider-neutral driver abstraction proposed for the CEO, CTO, CMO, API Key Provider, and Reddit Specialist.

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

The X Specialist tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The X Specialist must not operate through ad hoc notes or direct D1 mutations.

Use:

- the per-company `CompanyCoordinator` service running on the supervisor VM as the serialized workflow layer
- local SQLite as the hot coordination store for that service
- D1 as the historical mirror
- the shared workspace for sanitized playbooks, experiments, and summaries

Why:

- X work is cadence-sensitive and conversation-sensitive
- one account can easily end up with too many overlapping experiments
- publishing, follow-up, and attribution state need durable serialization

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - account strategy state
  - post queue
  - draft queue
  - reply backlog
  - experiment state
  - publish log
  - account-health flags
  - idempotency keys
- D1:
  - historical post and reply log
  - experiment summaries
  - traffic summaries
  - moderation or enforcement incidents
  - agent message history
  - founder-visible execution summaries
- workspace:
  - X playbook
  - post archetypes
  - reply frameworks
  - founder/brand voice guidance
  - weekly summaries
- R2:
  - screenshots of posts and threads
  - media assets
  - evidence bundles
  - exported reports

### 6.3 Source-of-truth order

The X Specialist must treat state in this order:

1. coordinator live workflow state
2. current X account and conversation state
3. D1 mirrored history
4. canonical marketing docs and current product artifacts
5. recent CMO/CEO/CTO messages
6. session memory

Session memory is never authoritative.

## 7. X Specialist lanes

This agent should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Account strategy and listening lane

Purpose:

- monitor the owned accounts
- identify relevant conversations, creators, and narrative openings
- maintain a clear map of who should post what

Properties:

- read-heavy
- no publishing
- updates account and opportunity state

### 7.2 Drafting lane

Purpose:

- draft posts, threads, quote posts, and reply trees
- adapt voice to founder account versus brand account
- turn product or market signals into X-native content

Properties:

- write-heavy
- draft-only
- cannot publish directly

### 7.3 Publish and reply lane

Purpose:

- publish approved content through official X APIs
- watch replies and mentions
- continue worthwhile conversations
- create follow-up tasks when a conversation turns into a product or sales signal

Properties:

- API-backed write access
- strict rate-limit and duplication controls
- must attach post-action evidence and state

### 7.4 Reporting and routing lane

Purpose:

- summarize what actually happened on X
- turn reactions into structured market insight
- route product, positioning, or founder-signal feedback to the right role

Properties:

- read-heavy
- no publishing
- summary and routing only

## 8. Files and contracts the X Specialist owns

Recommended owned files:

- `/workspace/docs/marketing/x-playbook.md`
  - channel strategy, voice rules, anti-goals, and current priorities
- `/workspace/docs/marketing/x-accounts.json`
  - approved accounts, owner role, voice mode, and status
- `/workspace/docs/marketing/x-queue.json`
  - sanitized queue mirror of planned posts and reply campaigns
- `/workspace/docs/marketing/x-experiments.json`
  - experiment registry with hypothesis, angle, owner, and result
- `/workspace/docs/marketing/x-reply-library.md`
  - approved response patterns and objection handling
- `/workspace/docs/marketing/x-proof-points.md`
  - allowed product claims, launch facts, and social proof
- `/workspace/docs/marketing/x-weekly-summary.md`
  - founder-readable weekly output and learnings

Required structured objects in the coordinator:

- `x_account_profile`
- `x_post_draft`
- `x_publish_event`
- `x_reply_backlog_item`
- `x_experiment`
- `x_account_health`
- `x_conversation_signal`
- `x_enforcement_incident`

## 9. X Specialist tool surface

The X Specialist should mutate the world only through explicit internal tools.

### 9.1 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | X Specialist access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.get_tasks`, `org.send_message`, `org.create_experiment`, `org.record_execution_note`, `org.update_workflow` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable workflow state that matches the current architecture | Full |
| X read/write actions | `x.get_account_health`, `x.search_posts`, `x.get_mentions`, `x.get_home_context`, `x.create_draft`, `x.publish_post`, `x.delete_post`, `x.get_post_metrics`, `x.get_reply_context` | Internal MCP server over official X API v2 and v1.1 upload/media endpoints | Highest reliability for X automation means using the official APIs instead of website scripting, which X's automation rules warn against | Full |
| Media upload and metadata | `media.upload`, `media.attach_alt_text`, `media.get_status` | Internal MCP server over official X media upload endpoints | Needed for image/video posting and accessibility metadata with the correct official upload flow | Full |
| Paid-X coordination | `ads.create_draft_post`, `ads.get_pixel_health`, `ads.get_conversion_events`, `ads.get_campaign_status` | Internal MCP server over official X Ads API | Allows coordination with the Ad Buyer and CMO for draft, nullcast, or paid support flows without making the X Specialist the paid-media owner | Limited |
| Product and destination inspection | `artifact.get_preview`, `artifact.capture_page`, `artifact.get_claims`, `artifact.validate_destination` | Internal MCP server over company artifacts and previews | X posts must stay aligned with what the destination actually says and does | Read-only |
| Analytics and attribution | `analytics.get_x_traffic`, `analytics.get_conversion_funnel`, `analytics.get_session_replays`, `analytics.compare_experiments` | Internal MCP server over PostHog | Strong first-party analytics and replay are the best fit for attributing X traffic to actual user behavior | Read-only |
| Link management | `links.create_utm_link`, `links.resolve_destination`, `links.get_click_summary` | Internal MCP server over company link-tracking conventions and analytics | X experiments need consistent attribution-safe links, not hand-built URLs | Full |
| Workspace docs | `workspace.write_owned_doc`, `workspace.append_experiment_result`, `workspace.update_account_profile` | Internal MCP server enforcing path-safe writes to owned docs only | The specialist needs durable written memory without raw unrestricted file editing | Full |
| Official-doc and policy fetch | `research.fetch_official_doc`, `research.extract_policy_constraints` | Internal MCP server with allowlisted official domains | X execution must stay aligned with current platform policy and API constraints | Read-only |
| Social observability | `observe.get_publish_log`, `observe.get_rate_limit_state`, `observe.get_enforcement_incidents`, `observe.get_reply_response_times` | Internal MCP server over internal logs and X API state | Makes it possible to debug whether the account is healthy and whether the workflow is actually producing results | Read-only |

## 10. Provider notes

### 10.1 Primary X execution provider

Use an internal `x` MCP backed by the official X API.

Why:

- X's automation rules explicitly warn against non-API-based automation such as scripting the X website
- official posting, search, mention, metric, and delete flows are better aligned with rate-limit and policy control
- official API access is the highest-reliability path for a long-running autonomous system

This is the core architectural decision for this role: do not make the X Specialist browser-first.

### 10.2 Media and accessibility

Use the official X media upload endpoints and metadata flow.

Why:

- media posting is part of serious X execution
- alt text should be attached consistently
- the API flow is explicit, inspectable, and easier to audit than ad hoc browser posting

### 10.3 Paid coordination

The X Specialist should not own paid campaigns.

That remains with the Ad Buyer under the CMO.

However, the specialist should be able to:

- inspect X Ads draft/nullcast support
- inspect Pixel or Conversion API state
- read campaign status when organic and paid narratives are linked

### 10.4 Analytics

Use PostHog as the primary downstream analytics provider.

Why:

- the role needs more than impression counts
- it needs funnel impact, replay, and page behavior after the click
- it keeps the signal consistent with the rest of the company stack

### 10.5 Whitehat guerrilla marketing

This role should support aggressive but legitimate X-native tactics, including:

- sharp founder or operator takes tied to real product truth
- rapid quote-posting into relevant live conversations
- concise threads that package useful knowledge, proof, or process
- public build updates with real receipts
- clips, screenshots, or before/after examples from the actual product
- account-specific voice modes for founder versus brand
- memetic phrasing when it fits the audience and remains truthful
- collaborative handoffs where the founder posts and the specialist handles surrounding replies and analytics

The point is to win on:

- timing
- clarity
- signal density
- authenticity
- iteration speed

not on manipulation.

### 10.6 Excluded greyhat methods

The following are explicitly out of scope:

- buying or renting aged accounts
- fake founder or employee personas
- synthetic follower or engagement growth
- engagement pods
- coordinated quote-post rings
- mass-following
- mass auto-replies
- automated unsolicited DMs
- website scripting to bypass API restrictions

Reason:

- X's developer, automation, and authenticity policies cut directly against these tactics
- they are brittle and easy to penalize
- they produce the wrong incentives for the system

## 11. Exact permission profile

### 11.1 Listening lane

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
- `mcp__x__get_account_health`
- `mcp__x__search_posts`
- `mcp__x__get_mentions`
- `mcp__x__get_home_context`
- `mcp__artifact__get_preview`
- `mcp__analytics__get_x_traffic`
- `mcp__research__fetch_official_doc`
- `mcp__workspace__update_account_profile`

Disallowed tools:

- raw `Bash`
- raw `Edit` / `Write`
- direct publish tools
- any DM send tool

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
- `mcp__x__get_reply_context`
- `mcp__x__create_draft`
- `mcp__artifact__get_preview`
- `mcp__artifact__get_claims`
- `mcp__links__create_utm_link`
- `mcp__workspace__write_owned_doc`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- direct publish tools
- DM send tools
- raw D1 access
- raw browser automation for X actions

### 11.3 Publish and reply lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- explicit `allowedTools`
- publish preflight required

Allowed tools:

- `mcp__org__get_live_state`
- `mcp__org__record_execution_note`
- `mcp__org__send_message`
- `mcp__x__publish_post`
- `mcp__x__delete_post`
- `mcp__x__get_mentions`
- `mcp__x__get_reply_context`
- `mcp__x__get_post_metrics`
- `mcp__media__upload`
- `mcp__media__attach_alt_text`
- `mcp__media__get_status`
- `mcp__observe__get_publish_log`
- `mcp__observe__get_rate_limit_state`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- website scripting against X
- bulk follow / bulk DM tools
- unrestricted web browsing
- raw file-edit tools outside owned docs

### 11.4 Reporting lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- read-heavy

Allowed tools:

- `mcp__analytics__get_x_traffic`
- `mcp__analytics__get_conversion_funnel`
- `mcp__analytics__get_session_replays`
- `mcp__observe__get_reply_response_times`
- `mcp__observe__get_enforcement_incidents`
- `mcp__org__send_message`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- publish tools
- media upload tools
- raw web search

## 12. Internal MCP servers

The X Specialist should rely on a small number of explicit internal MCP servers.

### 12.1 `org`

Purpose:

- source of truth for structured tasks, experiments, messages, and execution notes

Key operations:

- `get_live_state`
- `send_message`
- `create_experiment`
- `record_execution_note`
- `update_workflow`

### 12.2 `x`

Purpose:

- official X account reading, drafting, publishing, and reply handling

Backed by:

- X API v2
- X API v1.1 where still needed for media or compatibility

Key operations:

- `get_account_health`
- `search_posts`
- `get_mentions`
- `get_home_context`
- `get_reply_context`
- `create_draft`
- `publish_post`
- `delete_post`
- `get_post_metrics`

### 12.3 `media`

Purpose:

- official media upload and alt-text flow

Key operations:

- `upload`
- `attach_alt_text`
- `get_status`

### 12.4 `ads`

Purpose:

- read paid-X state and create paid-support drafts when needed

Key operations:

- `create_draft_post`
- `get_pixel_health`
- `get_conversion_events`
- `get_campaign_status`

### 12.5 `artifact`

Purpose:

- validate the product destination and claim surface

Key operations:

- `get_preview`
- `capture_page`
- `get_claims`
- `validate_destination`

### 12.6 `analytics`

Purpose:

- connect X activity to actual product behavior

Backed by:

- PostHog

Key operations:

- `get_x_traffic`
- `get_conversion_funnel`
- `get_session_replays`
- `compare_experiments`

### 12.7 `links`

Purpose:

- standardize attribution-safe links

Key operations:

- `create_utm_link`
- `resolve_destination`
- `get_click_summary`

### 12.8 `workspace`

Purpose:

- enforce path-safe writes to owned X docs only

Key operations:

- `write_owned_doc`
- `append_experiment_result`
- `update_account_profile`

### 12.9 `observe`

Purpose:

- account-health and execution observability

Key operations:

- `get_publish_log`
- `get_rate_limit_state`
- `get_enforcement_incidents`
- `get_reply_response_times`

### 12.10 `research`

Purpose:

- fetch official policy docs and platform constraints

Key operations:

- `fetch_official_doc`
- `extract_policy_constraints`

## 13. Provisioning-time workflow

At provisioning, the X Specialist should not start posting immediately unless the CMO has already selected X as an active channel.

Provisioning-time workflow:

1. Read the execution contract, mission, and marketing plan.
2. Determine whether X is in scope this week.
3. If X is out of scope:
   - stay idle
   - maintain no active queue
4. If X is in scope:
   - define the account strategy:
     - founder account
     - brand account
     - automated label requirements if applicable
   - inspect the current landing page or artifact
   - define 3 to 5 content angles
   - prepare the first experiment queue
   - write the X playbook and proof-point library

The X Specialist should not publish before:

- the destination is credible
- the message is aligned
- the account strategy is approved by the CMO

## 14. Standard workflow

The standard workflow should be:

1. CMO marks X as active for the week.
2. X Specialist refreshes account state and current narrative opportunities.
3. It identifies:
   - original post opportunities
   - thread opportunities
   - quote-post opportunities
   - reply opportunities
4. It validates the destination artifact and allowed claims.
5. It creates structured drafts for each play.
6. It publishes only after:
   - duplication check
   - claim check
   - account-health check
   - rate-limit check
7. It monitors replies, mentions, and follow-through signals.
8. It routes:
   - product objections to CTO or CEO
   - positioning learnings to CMO
   - founder-opportunity moments to CEO
9. It records:
   - post URL
   - account used
   - format
   - angle
   - clicks
   - downstream conversions
   - qualitative response
10. It updates the weekly summary and next experiments.

## 15. Reliability controls

### 15.1 Policy compliance

Hard rules:

- no fake personas
- no bought or rented accounts
- no undisclosed coordinated amplification
- no automated unsolicited DMs
- no website scripting to perform X actions that should be API-based
- no publishing content the product cannot support

### 15.2 Account strategy discipline

Prefer a small number of real accounts:

- founder account
- brand account
- optional clearly labeled automated account when the use case actually requires it

The specialist should not multiply accounts just to create the illusion of traction.

### 15.3 Publish discipline

Each published item must have:

- one clear intent
- one destination at most
- one experiment tag
- one owner account

This keeps attribution clean and reduces repetitive content risk.

### 15.4 Reply discipline

Replies should be:

- context-aware
- useful
- sparse enough not to look automated
- escalated when the discussion crosses into product truth, legal claims, or founder commitments

### 15.5 Rate and duplication control

The specialist should limit concurrency by:

- one active high-priority content push per account at a time unless CMO explicitly raises the limit
- bounded daily publish quotas
- bounded reply quotas
- no identical or substantially similar multi-account posting

### 15.6 Evidence

Every publish or enforcement event must capture:

- permalink
- account used
- timestamp
- experiment id
- current metric snapshot
- any enforcement or warning metadata

### 15.7 Feedback routing

Every meaningful X response should be classified into:

- objection
- feature request
- confusion
- social proof
- conversion intent
- partnership or creator signal
- enforcement risk

## 16. What to borrow from `everything-claude-code`

The useful ideas to borrow are operational, not tactical:

- strong role-specific skills
- reusable playbooks
- repeatable action checklists
- short execution loops with written outputs
- evals against common failure patterns

Applied here, that means:

- explicit pre-publish checklists
- reusable post archetype playbooks
- required post-action summaries
- evals for generic AI voice, repetitive phrasing, and policy-risky patterns

## 17. Why Relay should not be the X Specialist's primary coordination bus

Relay can be useful later for richer agent transport.

It should not be the primary bus for this role because:

- X execution depends on typed experiment, queue, and account-health state
- publish actions need serialized workflow transitions
- metrics and enforcement state matter more than open-ended conversation

The primary bus should remain:

- internal structured coordination through the local coordinator + D1 mirror

Relay can become an optional future transport once the structured workflow layer is stable.

## 18. Implementation phases

### Phase 1: structured X workflow

- keep the agent on Opus 4.6
- remove any broad `bypassPermissions` path
- add the `x`, `media`, `artifact`, `analytics`, `links`, and `workspace` MCP servers
- define post, reply, and experiment objects

### Phase 2: publish and follow-through

- add API-backed publish preflight
- add reply monitoring and routing
- add founder-visible weekly summaries

### Phase 3: observability and quality

- add rate-limit and enforcement tracking
- add permalink and metric evidence bundles
- add evals for generic copy, repetition, and weak narrative fit

### Phase 4: paid-organic coordination

- connect read-only Ads API state
- sync learnings with Ad Buyer and CMO

### Phase 5: multi-provider portability

- keep the same tool plane
- add other agent drivers later
- optionally add Relay for live collaboration once typed workflow state is mature

## 19. Recommended final stack

If I were implementing the X Specialist next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Primary X execution: internal `x` MCP over official X API
- Media workflow: official X media upload endpoints
- Paid-X coordination: official X Ads API through an internal limited ads MCP
- Product/destination validation: internal artifact MCP over company previews and claims
- Analytics: PostHog
- Link tracking: internal UTM/link MCP
- Observability: internal execution logs + API rate-limit and enforcement state
- Workspace memory: path-safe workspace MCP for owned X docs only

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the X Specialist, without turning it into a manipulation bot or a brittle website-script wrapper.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare D1 overview: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/)
- X Developer Policy: [developer.x.com/en/developer-terms/policy.html](https://developer.x.com/en/developer-terms/policy.html)
- X automation rules: [help.x.com/articles/20174732](https://help.x.com/articles/20174732)
- X authenticity / platform manipulation policy: [help.x.com/ro/rules-and-policies/platform-manipulation](https://help.x.com/ro/rules-and-policies/platform-manipulation)
- Automated account labels: [help.x.com/en/using-x/automated-account-labels](https://help.x.com/en/using-x/automated-account-labels)
- X API v2 support and limits: [developer.x.com/en/support/twitter-api/v2](https://developer.x.com/en/support/twitter-api/v2)
- Create/manage posts migration guide: [developer.x.com/en/docs/x-api/tweets/manage-tweets/migrate/manage-tweets-standard-to-twitter-api-v2](https://developer.x.com/en/docs/x-api/tweets/manage-tweets/migrate/manage-tweets-standard-to-twitter-api-v2)
- X media upload and metadata: [developer.x.com/en/docs/media/upload-media/api-reference/post-media-upload](https://developer.x.com/en/docs/media/upload-media/api-reference/post-media-upload), [developer.x.com/en/docs/twitter-api/v1/media/upload-media/api-reference/post-media-metadata-create](https://developer.x.com/en/docs/twitter-api/v1/media/upload-media/api-reference/post-media-metadata-create)
- X Ads tweet creation and scheduling: [developer.x.com/en/docs/ads/creatives/api-reference/tweets](https://developer.x.com/en/docs/ads/creatives/api-reference/tweets), [developer.x.com/en/docs/ads/creatives/guides/scheduled-tweets-guide](https://developer.x.com/en/docs/ads/creatives/guides/scheduled-tweets-guide)
- X web conversion tracking / CAPI: [business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites.html](https://business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites.html)
- PostHog overview and MCP server: [posthog.com/services](https://posthog.com/services), [mcp.posthog.com](https://mcp.posthog.com/)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
