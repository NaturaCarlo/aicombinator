# Reddit Specialist Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: Reddit Specialist agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build a Reddit Specialist agent that is:

- the single owner of Reddit execution under the CMO
- capable of turning the weekly marketing strategy into credible Reddit-native posts, comments, replies, and experiments
- able to discover the right subreddits, threads, and angles without inventing fake demand
- able to operate quickly enough to create early traction and visible signals for the founder
- reliable enough to run autonomously without getting the company account flagged, ignored, or banned
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The Reddit Specialist is not just a copywriter and not just a scheduler. It is the Reddit execution plane for the company:

- it maps relevant subreddits and thread opportunities
- it drafts Reddit-native content
- it engages in real conversations
- it routes product feedback back to CMO, CEO, and CTO
- it reports what narratives, objections, and hooks actually work
- it keeps Reddit activity aligned with the real product and landing page

## 2. Non-goals

The Reddit Specialist should not:

- replace the CMO as the marketing strategist
- replace the CEO as the founder voice when a founder reply is required
- market a product the CTO has not actually shipped or staged
- use fake personas, undisclosed shill accounts, or employee sockpuppets
- buy, rent, or revive aged accounts for deceptive posting
- run vote manipulation, comment rings, karma farming, or brigading
- send unsolicited mass DMs or chats
- rely on markdown notes as the primary workflow system
- depend on stale hidden memory instead of live state

Those tactics are excluded on purpose.

They are not just ethically weak. They are operationally weak:

- they violate Reddit policy
- they are easy to detect
- they create low-signal feedback loops
- they are bad foundations for a company that is supposed to run reliably

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and workflows

This design changes the Reddit Specialist implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- Reddit work existing only as vague docs instead of real thread-level execution
- weak visibility into which subreddits, threads, and angles are currently active
- poor alignment between Reddit claims and the actual product
- no clean way to surface live community signals back to CMO and CTO
- fragile channel work that looks busy but does not produce replies, clicks, or learnings
- confusion between authentic community participation and spammy promotion

## 4. Reddit Specialist operating position in the org

### 4.1 Chain of command

The Reddit Specialist reports to the CMO.

The Reddit Specialist owns:

- subreddit discovery and prioritization
- thread discovery and opportunity mapping
- Reddit-native draft creation
- Reddit account execution for approved accounts
- comment and reply loops
- community feedback capture
- weekly Reddit experiment summaries

The Reddit Specialist must stay tightly aligned with:

- the CMO for messaging, campaign goals, and channel priority
- the CEO for mission and high-level narrative changes
- the CTO for product readiness and founder-visible reality

The Reddit Specialist does not bypass:

- the CMO for strategy
- the CTO for claims about product capability
- the CEO for founder-voice responses
- Procurement or API Key Provider for account, spend, or service setup

### 4.2 What "done" means

From the Reddit Specialist's point of view, work is only done when:

1. the target subreddit or thread is actually relevant
2. the post or comment matches subreddit rules and norms
3. the linked landing page or destination artifact is real and credible
4. the content is posted or scheduled through an auditable workflow
5. replies are monitored and responded to
6. outcomes are measured
7. learnings are routed back into the marketing system

Nothing short of that should become founder-visible "Reddit progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- Reddit success depends on nuance, tone, community fit, and fast adaptation.
- Weak models default to obvious SaaS copy, generic calls to action, and tone-deaf promotional language.
- The Reddit Specialist needs to read thread context, infer community norms, write naturally, and decide when not to post.

Recommendation:

- keep the Reddit Specialist on Opus 4.6 in v1
- later, low-risk monitoring and summary tasks can move to lower-cost models
- keep live drafting, reply writing, and escalation logic on Opus

Implementation requirement:

- do not run the Reddit Specialist in `bypassPermissions`
- use explicit `allowedTools`
- separate read, draft, and publish lanes
- require subreddit-rule checks before publishing

### 5.2 Driver abstraction

Use the same provider-neutral driver abstraction proposed for the CEO, CTO, CMO, and API Key Provider.

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

The Reddit Specialist tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The Reddit Specialist must not operate from ad hoc notes or direct D1 writes.

Use:

- the per-company `CompanyCoordinator` service running on the supervisor VM as the serialized workflow layer
- local SQLite as the hot coordination store for that service
- D1 as the historical mirror
- the shared workspace for sanitized strategy docs, content libraries, and summaries

Why:

- Reddit work is thread-level and timing-sensitive
- the same subreddit can have many overlapping opportunities
- publish, reply, escalation, and feedback state need a clean source of truth

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - subreddit map
  - thread opportunity queue
  - post and comment drafts
  - publish state
  - reply backlog
  - moderation incidents
  - account health state
  - idempotency keys
- D1:
  - historical thread log
  - experiment summaries
  - feedback history
  - agent message history
  - founder-visible execution summaries
- workspace:
  - subreddit playbooks
  - draft libraries
  - response frameworks
  - weekly Reddit summaries
  - claim and proof libraries
- R2:
  - screenshots of posts and replies
  - evidence bundles
  - exported reports
  - preview assets

### 6.3 Source-of-truth order

The Reddit Specialist must treat state in this order:

1. coordinator live workflow state
2. current Reddit account and thread state
3. D1 mirrored history
4. canonical marketing docs and product artifacts
5. recent CMO/CEO/CTO messages
6. session memory

Session memory is never authoritative.

## 7. Reddit Specialist lanes

This agent should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Community mapping lane

Purpose:

- identify the best-fit subreddits
- understand subreddit norms, rules, tone, and tolerance for links or self-reference
- maintain a ranked subreddit list

Properties:

- read-heavy
- no publishing
- updates the opportunity map and community playbooks

### 7.2 Thread discovery and triage lane

Purpose:

- find live threads worth engaging
- score them for relevance, timing, risk, and likely payoff
- route the best ones into the execution queue

Properties:

- read-heavy
- can create structured thread opportunities
- no direct posting

### 7.3 Drafting and response lane

Purpose:

- draft posts, comments, and replies in subreddit-native tone
- adapt language to context
- choose whether to link, mention, or stay purely conversational

Properties:

- write-heavy
- creates drafts only
- cannot publish directly

### 7.4 Publish and conversation lane

Purpose:

- publish approved posts and comments
- monitor replies
- keep conversations moving
- escalate founder or product questions when needed

Properties:

- account-execution enabled
- strict rate limits and policy checks
- must attach evidence and current state after each action

### 7.5 Feedback and reporting lane

Purpose:

- turn Reddit responses into structured insights
- capture objections, language patterns, feature requests, and conversion signals
- report back to CMO and relevant product owners

Properties:

- read-heavy
- no publishing
- summary and routing only

## 8. Files and contracts the Reddit Specialist owns

Recommended owned files:

- `/workspace/docs/marketing/reddit-playbook.md`
  - current strategy for Reddit
  - target subreddits
  - content archetypes
  - anti-goals
- `/workspace/docs/marketing/reddit-subreddits.json`
  - ranked subreddit map with rules, tone, and fit score
- `/workspace/docs/marketing/reddit-experiments.json`
  - experiment registry with hypothesis, angle, owner, and result
- `/workspace/docs/marketing/reddit-response-library.md`
  - approved response patterns and objection handling
- `/workspace/docs/marketing/reddit-weekly-summary.md`
  - founder-readable summary of what worked and what changed
- `/workspace/docs/marketing/reddit-proof-points.md`
  - product facts, social proof, and claims that are allowed
- `/workspace/docs/marketing/reddit-mod-notes.md`
  - sanitized notes on moderator guidance and subreddit-specific constraints

Required structured objects in the coordinator:

- `subreddit_profile`
- `thread_candidate`
- `engagement_play`
- `reddit_draft`
- `publish_event`
- `reply_backlog_item`
- `community_feedback_item`
- `moderation_incident`
- `reddit_account_state`
- `reddit_experiment`

## 9. Reddit Specialist tool surface

The Reddit Specialist should mutate the world only through explicit internal tools.

### 9.1 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | Reddit Specialist access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.get_tasks`, `org.send_message`, `org.create_experiment`, `org.record_execution_note`, `org.update_workflow` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable marketing workflow state that matches the current architecture | Full |
| Reddit account and content actions | `reddit.get_subreddit_rules`, `reddit.search_threads`, `reddit.get_post_context`, `reddit.create_draft`, `reddit.publish_post`, `reddit.publish_comment`, `reddit.fetch_replies`, `reddit.get_account_health` | Internal MCP server over Reddit web/account adapters, with official Reddit API/Devvit adapters where policy-approved and available | The role needs real Reddit account operations; UI-backed execution is more reliable than betting the whole role on API approval paths that may not exist or may be restricted | Full |
| Browser execution | `browser.start_session`, `browser.resume_context`, `browser.open`, `browser.capture`, `browser.end_session` | Browserbase + Playwright | Best fit for durable, inspectable Reddit account execution and moderation-event debugging | Full |
| Product and landing-page inspection | `artifact.get_preview`, `artifact.capture_page`, `artifact.get_claims`, `artifact.validate_destination` | Internal MCP server over company artifacts and previews | Reddit claims must stay aligned with the real destination page and product state | Read-only |
| Analytics and attribution | `analytics.get_reddit_traffic`, `analytics.get_conversion_funnel`, `analytics.get_session_replays`, `analytics.compare_experiments` | Internal MCP server over PostHog | Strong first-party web/product analytics, funnels, and replay make it the best fit for tying Reddit traffic to actual behavior | Read-only |
| Paid Reddit coordination | `ads.get_pixel_health`, `ads.get_conversion_events`, `ads.get_attribution_window` | Internal MCP server over Reddit Pixel / Conversions API state | Lets the specialist coordinate with Ad Buyer and CMO when organic and paid Reddit efforts intersect | Read-only |
| Link management | `links.create_utm_link`, `links.resolve_destination`, `links.get_click_summary` | Internal MCP server over company link-tracking conventions and analytics | Reddit experiments need consistent link hygiene and attribution without hand-built URLs | Full |
| Workspace docs | `workspace.write_owned_doc`, `workspace.append_experiment_result`, `workspace.update_subreddit_profile` | Internal MCP server enforcing path-safe writes to owned docs only | The specialist needs a durable written memory without raw unrestricted file editing | Full |
| Official-doc and policy fetch | `research.fetch_official_doc`, `research.fetch_subreddit_rules_snapshot`, `research.extract_policy_constraints` | Internal MCP server with allowlisted official domains and subreddit rule capture | Reddit execution must be policy-aware and subreddit-aware, not just tone-aware | Read-only |
| Social observability | `observe.get_moderation_incidents`, `observe.get_publish_log`, `observe.get_thread_response_times` | Internal MCP server over internal logs and Browserbase evidence | Makes it possible to debug why Reddit work is or is not landing | Read-only |

## 10. Provider notes

### 10.1 Primary Reddit execution provider

Use an internal `reddit` MCP backed primarily by Browserbase + Playwright against the real Reddit web interface.

Why:

- the role needs to act through real owned accounts
- Reddit's current builder and API landscape is policy-constrained and approval-heavy
- many practical workflows for marketers are still better represented in the live UI than in a narrow data API path
- Browserbase provides recordings, contexts, and debugging, which matter a lot when an account state changes unexpectedly

This is an inference from Reddit's current public developer policy and tooling posture: the most reliable v1 architecture is a compliant UI-grounded execution layer, not a product that depends on broad API privileges appearing by default.

### 10.2 Official Reddit API and Devvit

Use official Reddit API and Devvit adapters opportunistically where policy-approved and actually useful.

Good uses:

- rule or metadata reads
- approved automation on owned experiences
- lightweight read operations where the official path is cleaner than browser automation

Do not make the entire Reddit Specialist depend on broad commercial Reddit API access in v1.

### 10.3 Analytics

Use PostHog as the primary downstream analytics provider for Reddit traffic and on-site behavior.

Why:

- funnels and event analysis matter more than vanity click counts
- session replay helps distinguish curiosity traffic from actually interested users
- the same analytics layer can be shared with CMO, CEO, and product owners

### 10.4 Paid Reddit coordination

The Reddit Specialist should not be the paid-media owner.

That remains with the Ad Buyer under the CMO.

However, when paid Reddit is in play, the specialist should be able to read:

- Reddit Pixel health
- Reddit Conversions API status
- supported conversion events
- attribution settings

This keeps organic and paid learnings aligned.

### 10.5 Whitehat guerrilla marketing

This role should support aggressive but legitimate Reddit-native tactics, including:

- founder or operator story posts with real disclosure
- transparent build-in-public updates
- useful teardown posts
- resource drops, templates, and checklists that genuinely help the community
- comment-first participation before link-sharing
- feedback requests on real product artifacts
- honest comparisons and postmortems
- AMA-style engagement where relevant
- subreddit-specific landing-page angles

The point is to win on:

- relevance
- speed
- honesty
- pattern recognition

not on disguise or manipulation.

### 10.6 Excluded greyhat methods

The following are explicitly out of scope:

- buying or renting aged accounts
- karma farming
- undisclosed employee or agent personas
- account farms
- mass reposting for exposure
- vote manipulation
- brigading
- synthetic social proof
- DM spam

Reason:

- Reddit's spam and builder policies directly cut against these tactics
- they create account risk and platform risk
- they are low-reliability systems for a company that is supposed to run autonomously for a long time

## 11. Exact permission profile

### 11.1 Community mapping and triage lanes

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
- `mcp__reddit__get_subreddit_rules`
- `mcp__reddit__search_threads`
- `mcp__reddit__get_post_context`
- `mcp__reddit__get_account_health`
- `mcp__artifact__get_preview`
- `mcp__analytics__get_reddit_traffic`
- `mcp__research__fetch_official_doc`
- `mcp__workspace__update_subreddit_profile`

Disallowed tools:

- raw `Bash`
- raw `Edit` / `Write`
- direct publish tools
- any DM or chat send tool

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
- `mcp__reddit__get_post_context`
- `mcp__reddit__create_draft`
- `mcp__artifact__get_preview`
- `mcp__artifact__get_claims`
- `mcp__links__create_utm_link`
- `mcp__workspace__write_owned_doc`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- direct publish tools
- browser session tools
- raw outbound email
- raw D1 access

### 11.3 Publish and conversation lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- explicit `allowedTools`
- publish preflight required

Allowed tools:

- `mcp__org__get_live_state`
- `mcp__org__record_execution_note`
- `mcp__org__send_message`
- `mcp__reddit__publish_post`
- `mcp__reddit__publish_comment`
- `mcp__reddit__fetch_replies`
- `mcp__reddit__get_account_health`
- `mcp__browser__start_session`
- `mcp__browser__resume_context`
- `mcp__browser__open`
- `mcp__browser__capture`
- `mcp__browser__end_session`
- `mcp__observe__get_publish_log`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- mass messaging tools
- unrestricted web browsing
- raw edit/write tools outside owned docs
- any tool that can impersonate an unapproved account

### 11.4 Reporting lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- read-heavy

Allowed tools:

- `mcp__analytics__get_reddit_traffic`
- `mcp__analytics__get_conversion_funnel`
- `mcp__analytics__get_session_replays`
- `mcp__observe__get_thread_response_times`
- `mcp__observe__get_moderation_incidents`
- `mcp__org__send_message`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- publish tools
- browser session tools
- raw web search

## 12. Internal MCP servers

The Reddit Specialist should rely on a small number of explicit internal MCP servers.

### 12.1 `org`

Purpose:

- source of truth for structured tasks, experiments, messages, and execution notes

Key operations:

- `get_live_state`
- `send_message`
- `create_experiment`
- `record_execution_note`
- `update_workflow`

### 12.2 `reddit`

Purpose:

- Reddit-native reading, drafting, publishing, account state, and reply handling

Backed by:

- Browserbase-backed web execution
- optional official Reddit API or Devvit adapters where approved and useful

Key operations:

- `get_subreddit_rules`
- `search_threads`
- `get_post_context`
- `create_draft`
- `publish_post`
- `publish_comment`
- `fetch_replies`
- `get_account_health`

### 12.3 `browser`

Purpose:

- durable browser sessions, evidence capture, and debugging

Backed by:

- Browserbase sessions, contexts, recordings, and live view

Key operations:

- `start_session`
- `resume_context`
- `open`
- `capture`
- `end_session`

### 12.4 `artifact`

Purpose:

- validate that the linked destination is real and aligned

Key operations:

- `get_preview`
- `capture_page`
- `get_claims`
- `validate_destination`

### 12.5 `analytics`

Purpose:

- connect Reddit execution to on-site outcomes

Backed by:

- PostHog product analytics and replay

Key operations:

- `get_reddit_traffic`
- `get_conversion_funnel`
- `get_session_replays`
- `compare_experiments`

### 12.6 `ads`

Purpose:

- read shared paid-Reddit telemetry when relevant

Key operations:

- `get_pixel_health`
- `get_conversion_events`
- `get_attribution_window`

### 12.7 `links`

Purpose:

- standardize attribution-safe links

Key operations:

- `create_utm_link`
- `resolve_destination`
- `get_click_summary`

### 12.8 `workspace`

Purpose:

- enforce path-safe writes to owned Reddit docs only

Key operations:

- `write_owned_doc`
- `append_experiment_result`
- `update_subreddit_profile`

### 12.9 `observe`

Purpose:

- moderation and execution observability

Key operations:

- `get_moderation_incidents`
- `get_publish_log`
- `get_thread_response_times`

### 12.10 `research`

Purpose:

- fetch official policy docs and capture subreddit-rule snapshots

Key operations:

- `fetch_official_doc`
- `fetch_subreddit_rules_snapshot`
- `extract_policy_constraints`

## 13. Provisioning-time workflow

At provisioning, the Reddit Specialist should not start posting immediately unless the CMO has already selected Reddit as a priority channel.

Provisioning-time workflow:

1. Read the execution contract, mission, and marketing plan.
2. Determine whether Reddit is in-scope this week.
3. If Reddit is out of scope:
   - stay idle
   - maintain no active queue
4. If Reddit is in scope:
   - generate an initial subreddit map
   - inspect the current landing page or destination artifact
   - define 3 to 5 plausible content angles
   - propose the first experiment set to the CMO
   - prepare the Reddit playbook and proof-point library

The Reddit Specialist should not post into communities before:

- the destination is credible
- the message is aligned
- subreddit rules have been checked

## 14. Standard workflow

The standard workflow should be:

1. CMO marks Reddit as active for the week.
2. Reddit Specialist refreshes the subreddit map.
3. It identifies live thread opportunities and active content angles.
4. It validates that the landing page and product claims are real.
5. It creates structured drafts for:
   - original posts
   - comment-first plays
   - reply trees
6. It publishes only after:
   - subreddit-rule check
   - product-claim check
   - rate-limit check
7. It monitors replies and responds where useful.
8. It routes:
   - product objections to CTO/CEO
   - positioning insights to CMO
   - founder-interest moments to CEO
9. It records:
   - post URL
   - subreddit
   - content angle
   - replies
   - clicks
   - conversions
   - qualitative feedback
10. It updates the weekly summary and next experiments.

## 15. Reliability controls

### 15.1 Policy compliance

Hard rules:

- no undisclosed affiliation when disclosure is expected or strategically necessary
- no mass-posting or repetitive posting
- no mass unsolicited DMs
- no vote manipulation
- no fake accounts or purchased aged accounts
- no posting content that the landing page cannot support

### 15.2 Subreddit fit checks

Every publish action must validate:

- subreddit rules
- recent tone and format norms
- whether links are allowed
- whether self-promotion is tolerated
- whether the account has enough legitimate context to participate

### 15.3 One-account, one-truth rule

Do not create parallel hidden personas.

Prefer:

- a real brand account
- a real founder account where appropriate
- transparent affiliation
- consistent behavior

### 15.4 Publish discipline

Each post or comment must have:

- one clear intent
- one linked destination at most
- one experiment tag
- one owner

This prevents thread spam and keeps attribution clean.

### 15.5 Feedback routing

Every meaningful Reddit response should be classified into:

- objection
- feature request
- confusion
- positive proof
- conversion intent
- moderator warning

### 15.6 Rate and saturation control

The specialist should limit concurrency by:

- one active publish play per account at a time unless the CMO explicitly raises the limit
- bounded daily publish quotas
- bounded reply quotas
- automatic cool-down after moderation events or poor response

### 15.7 Evidence

Every publish or moderation event must capture:

- screenshot
- permalink
- subreddit
- timestamp
- account used
- experiment id

## 16. What to borrow from `everything-claude-code`

The useful ideas to borrow are operational, not tactical:

- strong role-specific skills
- reusable playbooks
- repeatable checks before action
- short execution loops with written outputs
- evals against common failure patterns

Applied here, that means:

- explicit subreddit-fit checklists
- reusable thread archetype playbooks
- required post-action summaries
- evals for tone drift, policy risk, and generic AI copy

## 17. Why Relay should not be the Reddit Specialist's primary coordination bus

Relay can be useful later for richer agent transport.

It should not be the primary bus for this role because:

- Reddit execution depends on typed experiment, thread, and moderation state
- publish actions need serialized workflow transitions
- evidence capture matters more than open-ended conversation

The primary bus should remain:

- internal structured coordination through the local coordinator + D1 mirror

Relay can become an optional future transport once the structured workflow layer is stable.

## 18. Implementation phases

### Phase 1: structured Reddit workflow

- keep the agent on Opus 4.6
- remove any broad `bypassPermissions` path
- add the `reddit`, `artifact`, `analytics`, `links`, and `workspace` MCP servers
- define thread, draft, and experiment objects

### Phase 2: publish and feedback loop

- add policy-aware publish preflight
- add reply monitoring and routing
- add founder-visible weekly summaries

### Phase 3: observability and quality

- add moderation incident tracking
- add screenshot and permalink evidence bundles
- add evals for generic copy, over-promotion, and weak subreddit fit

### Phase 4: paid-organic coordination

- connect read-only Reddit Pixel and Conversions API telemetry
- sync learnings with Ad Buyer and CMO

### Phase 5: multi-provider portability

- keep the same tool plane
- add other agent drivers later
- optionally add Relay for live collaboration once typed workflow state is mature

## 19. Recommended final stack

If I were implementing the Reddit Specialist next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Primary Reddit execution: internal `reddit` MCP over Browserbase + Playwright
- Secondary official Reddit integration: official Reddit API / Devvit adapters where approved and useful
- Product/destination validation: internal artifact MCP over company previews and claims
- Analytics: PostHog
- Paid Reddit telemetry: Reddit Pixel and Conversions API via internal read-only ads MCP
- Link tracking: internal UTM/link MCP
- Observability: internal execution logs + Browserbase recordings
- Workspace memory: path-safe workspace MCP for owned Reddit docs only

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the Reddit Specialist, without turning it into a spam bot or a brittle growth hack wrapper.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare D1 overview: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/)
- Reddit API overview: [developers.reddit.com/docs/capabilities/server/reddit-api](https://developers.reddit.com/docs/capabilities/server/reddit-api)
- Reddit server overview: [developers.reddit.com/docs/0.13/capabilities/server/overview](https://developers.reddit.com/docs/0.13/capabilities/server/overview)
- Reddit Responsible Builder Policy: [support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- Reddit spam policy: [support.reddithelp.com/hc/en-us/articles/360043504051-Spam](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)
- Browserbase overview and session tooling: [docs.browserbase.com/introduction/what-is-browserbase](https://docs.browserbase.com/introduction/what-is-browserbase), [docs.browserbase.com/features/session-replay](https://docs.browserbase.com/features/session-replay), [docs.browserbase.com/features/session-live-view](https://docs.browserbase.com/features/session-live-view), [docs.browserbase.com/features/contexts](https://docs.browserbase.com/features/contexts)
- Playwright introduction: [playwright.dev/python/docs/intro](https://playwright.dev/python/docs/intro)
- PostHog product overview and MCP server: [newsletter.posthog.com/p/what-is-posthog](https://newsletter.posthog.com/p/what-is-posthog), [mcp.posthog.com](https://mcp.posthog.com/)
- Reddit web attribution and conversion events: [business.reddithelp.com/articles/Knowledge/Web-Attribution-Overview](https://business.reddithelp.com/articles/Knowledge/Web-Attribution-Overview), [business.reddithelp.com/articles/Knowledge/supported-conversion-events](https://business.reddithelp.com/articles/Knowledge/supported-conversion-events)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
