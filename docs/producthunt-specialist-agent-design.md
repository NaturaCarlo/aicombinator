# Product Hunt Specialist Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: Product Hunt Specialist agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build a Product Hunt Specialist agent that is:

- the single owner of Product Hunt execution under the CMO
- capable of turning the weekly marketing strategy into a credible, well-prepared Product Hunt launch system
- able to maximize the legitimate probability of reaching Product of the Day by improving launch readiness, launch assets, timing, community fit, and launch-day responsiveness
- able to connect Product Hunt activity to real traffic, signups, reviews, product feedback, and longer-term discoverability
- reliable enough to operate autonomously without triggering moderation or authenticity filters
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The Product Hunt Specialist is not just a listing copywriter. It is the Product Hunt execution plane for the company:

- it decides whether the company is ready for Product Hunt
- it prepares the launch assets, positioning, first comment, maker coordination, and launch-day runbook
- it monitors ranking, comments, and launch momentum
- it routes product feedback, objections, and lead signals back into the company
- it protects the launch from low-trust tactics that get filtered or unfeatured
- it keeps the launch aligned with the actual product and destination page

## 2. Non-goals

The Product Hunt Specialist should not:

- replace the CMO as the channel strategist
- replace the CEO or founder when a genuine maker/founder voice is required
- replace the CTO when technical claims need technical validation
- use fake personas, bought aged accounts, or covert astroturfing
- buy or broker upvotes, comments, or leaderboard support
- mass-message people asking for upvotes
- incentivize upvotes with giveaways, discounts, or rewards
- use bots, AI-generated community comments, or fake engagement loops
- rely on markdown notes as the primary workflow system
- depend on stale hidden memory instead of live state

Those tactics are excluded on purpose.

They are not just ethically weak. They are operationally weak:

- Product Hunt explicitly filters inauthentic activity and removes manipulative behavior
- company accounts are prohibited for posting, voting, and commenting
- the homepage and leaderboard are curated and cannot be reliably gamed
- fake engagement produces bad launch signals, bad reviews, and account risk
- a Product Hunt launch is only valuable if the product and maker story survive public scrutiny

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and workflows

This design changes the Product Hunt Specialist implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- Product Hunt work existing only as vague launch plans instead of a real launch operating system
- weak visibility into launch readiness, maker readiness, and launch-day responsibilities
- no structured distinction between pre-launch, launch-day, and post-launch workflows
- no clean route from Product Hunt comments and feedback back into product, marketing, and founder workflows
- no explicit separation between legitimate promotion and activity that Product Hunt filters as inauthentic
- launch-day activity that looks busy but is not actually improving the odds of a strong finish

## 4. Product Hunt Specialist operating position in the org

### 4.1 Chain of command

The Product Hunt Specialist reports to the CMO.

The Product Hunt Specialist owns:

- Product Hunt launch readiness
- listing asset preparation
- teaser and schedule preparation
- first-comment drafting
- maker and co-maker launch-day coordination
- launch-day monitoring and routing
- Product Hunt-specific experiment summaries

The Product Hunt Specialist must stay tightly aligned with:

- the CMO for positioning, audience, and launch goals
- the CEO for founder voice, mission, and launch-day escalation
- the CTO for demo credibility, product readiness, and technical proof

The Product Hunt Specialist does not bypass:

- the CMO for launch strategy
- the CEO or founder for maker-authored launch comments and founder-sensitive responses
- the CTO for product claims
- the API Key Provider for account setup or OAuth integration

### 4.2 What "done" means

From the Product Hunt Specialist's point of view, work is only done when:

1. the product is genuinely launch-ready for Product Hunt
2. the listing assets are complete and strong
3. the maker and co-maker accounts are valid and prepared
4. the launch is scheduled or published through an auditable workflow
5. the first comment and launch-day response kit are ready
6. comments, ranking, and downstream traffic are monitored
7. product and market feedback are routed back into the company
8. the post-launch Product Page and follow-up plan are prepared

Nothing short of that should become founder-visible "Product Hunt progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- Product Hunt is highly sensitive to packaging, positioning, craft, and authenticity.
- Weak models default to cliché tagline language, weak first comments, and generic launch-day playbooks.
- The Product Hunt Specialist needs to reason across product quality, listing quality, launch timing, maker coordination, community norms, and post-launch compounding in one loop.

Recommendation:

- keep the Product Hunt Specialist on Opus 4.6 in v1
- later, low-risk monitoring and reporting can move to cheaper models
- keep launch readiness, listing strategy, and comment-routing judgment on Opus

Implementation requirement:

- do not run the Product Hunt Specialist in `bypassPermissions`
- use explicit `allowedTools`
- use official Product Hunt API for reads
- treat maker-authored comments and high-reputation interactions as human-assisted by default

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

The Product Hunt Specialist tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The Product Hunt Specialist must not operate through ad hoc notes or direct D1 writes.

Use:

- the per-company `CompanyCoordinator` service running on the supervisor VM as the serialized workflow layer
- local SQLite as the hot coordination store for that service
- D1 as the historical mirror
- the shared workspace for sanitized launch playbooks, asset checklists, and summaries

Why:

- Product Hunt has distinct pre-launch, launch-day, and post-launch phases
- the system needs durable state for launch readiness, maker coverage, comment routing, and launch-day runbook execution
- the cost of a bad or half-ready launch is high enough that workflow state must be explicit

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - launch readiness state
  - listing asset checklist
  - maker and co-maker readiness state
  - teaser and schedule state
  - launch-day response queue
  - ranking snapshot log
  - experiment state
  - idempotency keys
- D1:
  - historical launch log
  - comment-routing history
  - experiment summaries
  - traffic and signup summaries
  - agent message history
  - founder-visible execution summaries
- workspace:
  - Product Hunt playbook
  - launch checklist
  - first-comment library
  - FAQ and response kits
  - proof-point library
  - weekly summaries
- R2:
  - launch screenshots
  - gallery assets
  - demo assets
  - evidence bundles

### 6.3 Source-of-truth order

The Product Hunt Specialist must treat state in this order:

1. coordinator live workflow state
2. current Product Hunt listing, ranking, and comment state
3. D1 mirrored history
4. canonical marketing docs and product artifacts
5. recent CMO/CEO/CTO messages
6. session memory

Session memory is never authoritative.

## 7. Product Hunt Specialist lanes

This agent should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Launch readiness lane

Purpose:

- determine whether the company should launch on Product Hunt now
- maintain the readiness checklist
- validate that the product meets Product Hunt fit, craft, and availability expectations

Properties:

- read-heavy
- no publishing
- updates readiness state

### 7.2 Listing and asset drafting lane

Purpose:

- draft the name, tagline, description, gallery logic, promo, topics, maker list, teaser copy, and first comment
- package demos and screenshots
- create launch-day FAQ and response kits

Properties:

- write-heavy
- draft-only
- cannot publish directly

### 7.3 Launch-day operations lane

Purpose:

- monitor ranking, comments, reviews, and launch health
- coordinate maker replies and launch-day shifts
- track whether the launch is on pace for a strong finish
- route the right questions to the right owners

Properties:

- high-attention, event-driven
- must attach evidence and state frequently
- should not impersonate makers in comments

### 7.4 Post-launch compounding lane

Purpose:

- convert Product Hunt traffic into lasting benefit
- route leads and feedback
- keep the Product Page and launch learnings useful after day one

Properties:

- read-heavy
- no launch-page mutation beyond approved follow-up actions
- summary and routing only

## 8. Files and contracts the Product Hunt Specialist owns

Recommended owned files:

- `/workspace/docs/marketing/producthunt-playbook.md`
  - launch strategy, anti-goals, readiness standards, and current priorities
- `/workspace/docs/marketing/producthunt-readiness.json`
  - structured readiness checklist with pass/fail and blockers
- `/workspace/docs/marketing/producthunt-listing-draft.md`
  - current listing draft including title, tagline, topics, gallery narrative, promo, and links
- `/workspace/docs/marketing/producthunt-first-comment.md`
  - current maker-first-comment draft and variant notes
- `/workspace/docs/marketing/producthunt-faq-kit.md`
  - likely launch-day questions and answer kits for founder, CEO, and CTO
- `/workspace/docs/marketing/producthunt-experiments.json`
  - experiment registry with hypothesis, angle, owner, and result
- `/workspace/docs/marketing/producthunt-weekly-summary.md`
  - founder-readable output and learnings

Required structured objects in the coordinator:

- `ph_launch_profile`
- `ph_listing_draft`
- `ph_teaser_state`
- `ph_launch_event`
- `ph_comment_backlog_item`
- `ph_maker_shift`
- `ph_experiment`
- `ph_ranking_snapshot`
- `ph_readiness_blocker`

## 9. Product Hunt tool surface

The Product Hunt Specialist should mutate the world only through explicit internal tools.

### 9.1 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | Product Hunt Specialist access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.get_tasks`, `org.send_message`, `org.create_experiment`, `org.record_execution_note`, `org.update_workflow` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable workflow state matching the current architecture | Full |
| Product Hunt live reads | `ph.get_post`, `ph.get_comments`, `ph.get_topics`, `ph.get_votes`, `ph.get_rank_context`, `ph.get_profile_state` | Internal MCP server over Product Hunt GraphQL API v2 | Official read API with OAuth scopes and rate limits is the most reliable way to monitor launch state | Read-heavy |
| Launch drafting and guarded publishing | `ph.prepare_listing`, `ph.prepare_first_comment`, `ph.queue_launch`, `ph.capture_launch_state`, `ph.flag_reputational_risk` | Internal MCP server over internal workflow plus guarded human-assisted Product Hunt account operations | Product Hunt API write access is partial and use-case-specific, and maker comments should stay human-authored, so guarded launch operations are safer than assuming unrestricted API writes | Limited / guarded |
| Product and destination inspection | `artifact.get_preview`, `artifact.capture_page`, `artifact.get_claims`, `artifact.validate_destination` | Internal MCP server over company artifacts and previews | Product Hunt performance is strongly tied to whether the destination page and demo actually feel polished and clear | Read-only |
| Demo and asset packaging | `content.render_gallery_brief`, `content.render_demo_brief`, `content.get_asset_status` | Internal MCP server over internal creative/demo pipeline | Gallery and demo quality are critical launch variables and need structured handoff to asset systems | Limited |
| Analytics and attribution | `analytics.get_producthunt_traffic`, `analytics.get_conversion_funnel`, `analytics.get_session_replays`, `analytics.compare_experiments` | Internal MCP server over PostHog | Strong first-party analytics and replay are the best fit for connecting launch traffic to real outcomes | Read-only |
| Link management | `links.create_utm_link`, `links.resolve_destination`, `links.get_click_summary` | Internal MCP server over company link conventions and analytics | Product Hunt launches need clean attribution-safe links without spammy tracking abuse | Full |
| Maker coordination | `ops.create_shift_plan`, `ops.assign_reply_owner`, `ops.mark_reply_covered`, `ops.get_unanswered_threads` | Internal MCP server over the company coordinator and runbook state | Winning legitimately on Product Hunt requires the team to be present and responsive, not just "posted" | Full |
| Workspace docs | `workspace.write_owned_doc`, `workspace.append_experiment_result`, `workspace.update_launch_profile` | Internal MCP server enforcing path-safe writes to owned docs only | The specialist needs durable written memory without raw unrestricted file editing | Full |
| Official-guideline fetch | `research.fetch_official_doc`, `research.extract_policy_constraints` | Internal MCP server with allowlisted official domains | Product Hunt execution must stay aligned with current launch and community rules | Read-only |
| Social observability | `observe.get_launch_log`, `observe.get_comment_response_times`, `observe.get_rank_snapshots`, `observe.get_readiness_failures` | Internal MCP server over internal logs and Product Hunt API snapshots | Makes it possible to debug whether the launch system is actually healthy and responsive | Read-only |

## 10. Provider notes

### 10.1 Primary Product Hunt API provider

Use the official Product Hunt GraphQL API v2 as the primary read surface.

Why:

- it is the official programmatic interface
- it supports authenticated public and private reads with explicit scopes
- it is the most reliable way to monitor launch state, comments, and profile readiness without scraping

### 10.2 Write access reality

Do not design this role around the assumption of unrestricted Product Hunt API writes.

Product Hunt explicitly says:

- all apps are read-only by default
- write access is only partial and dependent on use case

So the correct design is:

- use the official API for monitoring
- use internal guarded workflows for listing prep and launch operations
- assume that critical maker-authored actions may require human-assisted execution

### 10.3 Launch-day comments

Treat maker comments as human-assisted by default.

Why:

- Product Hunt is person-to-person
- their commenting guidelines explicitly reject AI-generated comments
- the first comment is strategically important enough that it should be drafted by the agent but posted by the maker

This means the Product Hunt Specialist should:

- prepare the first comment
- prepare answer kits
- recommend who should answer each question
- not become a fake maker in the thread

### 10.4 Launch-day rank objective

The specialist should explicitly optimize for `Product of the Day` probability, not promise rank #1.

Because Product Hunt says:

- ranking is not just upvotes
- engagement is not the sole factor in featuring
- the homepage is curated
- inauthentic activity is filtered

So the legitimate optimization targets are:

- launch readiness
- strong craft and novelty
- strong listing assets
- correct timing
- fast human response coverage
- authentic community interest
- post-click product quality

### 10.5 Whitehat launch maximization

This role should support aggressive but legitimate Product Hunt tactics, including:

- scheduling early enough to capture a full cycle when appropriate
- using a teaser and collecting pre-launch followers
- building a strong gallery and interactive demo
- using a specific, humble, clear tagline
- writing a strong maker first comment
- ensuring all co-makers have real profiles and are ready to engage
- sharing the launch link widely but asking for feedback and comments, not upvotes
- routing the team into fast, thoughtful launch-day replies
- using launch-day promos legitimately
- keeping the destination page focused on Product Hunt traffic
- following up post-launch to convert momentum into longer-term value

### 10.6 Excluded greyhat methods

The following are explicitly out of scope:

- buying or renting aged Product Hunt accounts
- asking for upvotes directly
- mass messaging or scraping people for launch support
- offering incentives in exchange for upvotes
- bot or AI-generated community comments
- fake co-makers or fake profiles
- comment rings or upvote rings

Reason:

- Product Hunt explicitly filters and removes inauthentic activity
- manipulative launches can be removed or unfeatured
- these tactics are the opposite of reliability on this platform

## 11. Exact permission profile

### 11.1 Readiness and listening lane

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
- `mcp__ph__get_post`
- `mcp__ph__get_topics`
- `mcp__ph__get_profile_state`
- `mcp__artifact__get_preview`
- `mcp__analytics__get_producthunt_traffic`
- `mcp__research__fetch_official_doc`
- `mcp__workspace__update_launch_profile`

Disallowed tools:

- raw `Bash`
- raw `Edit` / `Write`
- direct launch publish tools
- any upvote solicitation tooling

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
- `mcp__artifact__get_preview`
- `mcp__artifact__get_claims`
- `mcp__links__create_utm_link`
- `mcp__content__render_gallery_brief`
- `mcp__content__render_demo_brief`
- `mcp__workspace__write_owned_doc`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- direct publish tools
- maker-comment write tools
- raw D1 access

### 11.3 Launch-day operations lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- explicit `allowedTools`
- launch preflight required

Allowed tools:

- `mcp__org__get_live_state`
- `mcp__org__record_execution_note`
- `mcp__org__send_message`
- `mcp__ph__get_post`
- `mcp__ph__get_comments`
- `mcp__ph__get_votes`
- `mcp__ph__get_rank_context`
- `mcp__ph__prepare_first_comment`
- `mcp__ph__queue_launch`
- `mcp__ph__capture_launch_state`
- `mcp__ops__create_shift_plan`
- `mcp__ops__assign_reply_owner`
- `mcp__ops__mark_reply_covered`
- `mcp__ops__get_unanswered_threads`
- `mcp__observe__get_launch_log`
- `mcp__observe__get_rank_snapshots`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- fake or automated community-comment posting
- raw browser automation against Product Hunt community surfaces
- mass outreach or vote request tooling
- raw file-edit tools outside owned docs

### 11.4 Post-launch reporting lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- read-heavy

Allowed tools:

- `mcp__analytics__get_producthunt_traffic`
- `mcp__analytics__get_conversion_funnel`
- `mcp__analytics__get_session_replays`
- `mcp__observe__get_comment_response_times`
- `mcp__org__send_message`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- launch publish tools
- raw web search

## 12. Internal MCP servers

The Product Hunt Specialist should rely on a small number of explicit internal MCP servers.

### 12.1 `org`

Purpose:

- source of truth for structured tasks, experiments, messages, and execution notes

Key operations:

- `get_live_state`
- `send_message`
- `create_experiment`
- `record_execution_note`
- `update_workflow`

### 12.2 `ph`

Purpose:

- official Product Hunt reads, listing prep, guarded launch operations, and launch-state tracking

Backed by:

- Product Hunt GraphQL API v2 for reads
- internal guarded launch workflow

Key operations:

- `get_post`
- `get_comments`
- `get_topics`
- `get_votes`
- `get_rank_context`
- `get_profile_state`
- `prepare_listing`
- `prepare_first_comment`
- `queue_launch`
- `capture_launch_state`
- `flag_reputational_risk`

### 12.3 `artifact`

Purpose:

- validate the product destination and claim surface

Key operations:

- `get_preview`
- `capture_page`
- `get_claims`
- `validate_destination`

### 12.4 `content`

Purpose:

- coordinate listing assets, screenshots, demos, and launch-ready collateral

Key operations:

- `render_gallery_brief`
- `render_demo_brief`
- `get_asset_status`

### 12.5 `analytics`

Purpose:

- connect Product Hunt traffic to actual product and funnel behavior

Backed by:

- PostHog

Key operations:

- `get_producthunt_traffic`
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

### 12.7 `ops`

Purpose:

- coordinate launch-day human coverage and reply ownership

Key operations:

- `create_shift_plan`
- `assign_reply_owner`
- `mark_reply_covered`
- `get_unanswered_threads`

### 12.8 `workspace`

Purpose:

- enforce path-safe writes to owned Product Hunt docs only

Key operations:

- `write_owned_doc`
- `append_experiment_result`
- `update_launch_profile`

### 12.9 `observe`

Purpose:

- launch and ranking observability

Key operations:

- `get_launch_log`
- `get_comment_response_times`
- `get_rank_snapshots`
- `get_readiness_failures`

### 12.10 `research`

Purpose:

- fetch official launch and community guidelines

Key operations:

- `fetch_official_doc`
- `extract_policy_constraints`

## 13. Provisioning-time workflow

At provisioning, the Product Hunt Specialist should usually stay idle.

Product Hunt is a high-prep, event-driven channel, not a default always-on channel.

Provisioning-time workflow:

1. Read the execution contract, mission, and marketing plan.
2. Determine whether Product Hunt is actually in scope.
3. If Product Hunt is out of scope:
   - stay idle
   - maintain no active launch profile
4. If Product Hunt is in scope:
   - inspect the current product and destination
   - determine whether it is launch-worthy now
   - initialize the readiness checklist
   - define the likely launch type and goal
   - begin collecting listing assets and maker readiness requirements
   - write the Product Hunt playbook and proof-point library

The Product Hunt Specialist should not push for launch until the readiness checklist clears.

## 14. Standard workflow

The standard workflow should be:

1. CMO marks Product Hunt as active for the current cycle.
2. Product Hunt Specialist refreshes launch readiness and Product Hunt fit.
3. It prepares:
   - listing copy
   - gallery and demo briefs
   - first-comment draft
   - co-maker readiness
   - teaser and schedule plan
   - launch-day shift coverage
4. It validates:
   - destination page clarity
   - product availability
   - proof and novelty
   - maker account readiness
5. It schedules or queues the launch.
6. On launch day it monitors:
   - ranking context
   - comments
   - unanswered questions
   - traffic and signup behavior
7. It routes:
   - technical questions to CTO
   - founder or maker questions to CEO/founder
   - product objections to CTO or CEO
   - positioning feedback to CMO
8. It records:
   - launch time
   - rank snapshots
   - comments
   - traffic
   - signups
   - qualitative feedback
9. It updates the weekly summary and post-launch plan.

## 15. Reliability controls

### 15.1 Policy compliance

Hard rules:

- no fake profiles
- no company accounts posting or commenting
- no asking for upvotes directly
- no incentivized upvotes
- no bot or AI-generated community comments
- no mass outreach asking for votes
- no publishing products that are not genuinely ready

### 15.2 Product Hunt fit gate

Before launch, the system must verify:

- the product is live or has a trustworthy near-term path to availability
- the product is actually a product, not a service or low-substance info item
- the product is useful, novel, high-craft, or creative enough to fit current featuring standards
- the destination page is clear and usable

### 15.3 Human-maker rule

Any public maker comment should be treated as human-authored or explicitly human-approved.

The agent may:

- draft
- suggest
- package replies
- assign reply owners

It should not impersonate makers in public discussion.

### 15.4 Rank objective discipline

The system should optimize for:

- authentic launch performance
- Product of the Day probability
- long-term Product Page value

It should not optimize for:

- short-term point inflation
- gaming filters
- vanity rank screenshots disconnected from real usage

### 15.5 Evidence

Every launch and major rank or comment milestone must capture:

- launch URL
- timestamp
- rank snapshot
- comment count
- experiment id
- traffic snapshot

### 15.6 Feedback routing

Every meaningful Product Hunt interaction should be classified into:

- objection
- feature request
- technical question
- trust signal
- conversion intent
- founder-interest signal
- moderation or authenticity risk

## 16. What to borrow from `everything-claude-code`

The useful ideas to borrow are operational, not tactical:

- strong role-specific skills
- reusable playbooks
- repeatable action checklists
- short execution loops with written outputs
- evals against common failure patterns

Applied here, that means:

- explicit launch-readiness checklists
- reusable first-comment and FAQ playbooks
- required launch-day summaries
- evals for weak listing quality, weak demo quality, and manipulative-launch drift

## 17. Why Relay should not be the Product Hunt Specialist's primary coordination bus

Relay can be useful later for richer agent transport.

It should not be the primary bus for this role because:

- Product Hunt execution depends on typed readiness, launch, ranking, and reply-coverage state
- launch-day actions need serialized workflow transitions
- authenticity and timing risk matter more than open-ended conversation

The primary bus should remain:

- internal structured coordination through the local coordinator + D1 mirror

Relay can become an optional future transport once the structured workflow layer is stable.

## 18. Implementation phases

### Phase 1: structured Product Hunt workflow

- keep the agent on Opus 4.6
- remove any broad `bypassPermissions` path
- add the `ph`, `artifact`, `content`, `analytics`, `links`, `ops`, and `workspace` MCP servers
- define launch, ranking, maker-coverage, and experiment objects

### Phase 2: launch-readiness and listing quality

- add readiness gating
- add listing-draft generation
- add teaser and schedule planning
- add founder-visible readiness summaries

### Phase 3: launch-day operations

- add ranking snapshots
- add unanswered-comment routing
- add maker shift planning and reply ownership

### Phase 4: post-launch compounding

- add Product Page optimization workflow
- add review and feedback harvesting
- add post-launch nurture routing

### Phase 5: multi-provider portability

- keep the same tool plane
- add other agent drivers later
- optionally add Relay for live collaboration once typed workflow state is mature

## 19. Recommended final stack

If I were implementing the Product Hunt Specialist next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Primary Product Hunt reads: official Product Hunt GraphQL API v2
- Listing and launch workflow: internal guarded launch MCP with human-assisted maker actions where needed
- Product/destination validation: internal artifact MCP over company previews and claims
- Listing asset packaging: internal content/render MCP
- Analytics: PostHog
- Link tracking: internal UTM/link MCP
- Launch-day team coverage: internal ops/runbook MCP
- Observability: internal execution logs + Product Hunt API/rank snapshot tracking
- Workspace memory: path-safe workspace MCP for owned Product Hunt docs only

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the Product Hunt Specialist, while staying aligned with Product Hunt’s actual platform rules and maximizing the legitimate chance of a top launch day finish.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare D1 overview: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/)
- Product Hunt Launch Guide: [producthunt.com/launch](https://www.producthunt.com/launch)
- Preparing for launch: [producthunt.com/launch/preparing-for-launch](https://www.producthunt.com/launch/preparing-for-launch)
- How Product Hunt works: [producthunt.com/launch/how-product-hunt-works](https://www.producthunt.com/launch/how-product-hunt-works)
- Sharing your launch: [producthunt.com/launch/sharing-your-launch](https://www.producthunt.com/launch/sharing-your-launch)
- Days after your launch: [producthunt.com/launch/days-after-launch](https://www.producthunt.com/launch/days-after-launch)
- Product Hunt API v2 docs: [producthunt.com/v2/docs](https://www.producthunt.com/v2/docs)
- Product Hunt Featuring Guidelines: [help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines](https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines)
- Community Guidelines: [help.producthunt.com/en/articles/3615694-community-guidelines](https://help.producthunt.com/en/articles/3615694-community-guidelines)
- How do things end up on the homepage?: [help.producthunt.com/en/articles/484923-how-do-things-end-up-on-the-homepage](https://help.producthunt.com/en/articles/484923-how-do-things-end-up-on-the-homepage)
- Why did my launch points go down?: [help.producthunt.com/en/articles/4853541-why-did-my-launch-points-go-down](https://help.producthunt.com/en/articles/4853541-why-did-my-launch-points-go-down)
- How to post a product: [help.producthunt.com/en/articles/479557-how-to-post-a-product](https://help.producthunt.com/en/articles/479557-how-to-post-a-product)
- How to schedule a post: [help.producthunt.com/en/articles/2724119-how-to-schedule-a-post](https://help.producthunt.com/en/articles/2724119-how-to-schedule-a-post)
- Commenting Guidelines: [help.producthunt.com/en/articles/10030102-false-or-inappropriate-product-reviews](https://help.producthunt.com/en/articles/10030102-false-or-inappropriate-product-reviews)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
