# Hacker News Specialist Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: Hacker News Specialist agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build a Hacker News Specialist agent that is:

- the single owner of Hacker News execution under the CMO
- capable of turning the weekly marketing strategy into Hacker News-native submissions, launch timing, comment participation, and feedback harvesting
- able to connect Hacker News activity to real traffic, signups, product signals, and founder credibility
- reliable enough to operate autonomously without triggering community rejection or moderator backlash
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The Hacker News Specialist is not just a launch copywriter. It is the Hacker News execution plane for the company:

- it decides whether the company belongs on HN at all
- it identifies the right moment and angle for a Show HN, launch, technical writeup, or discussion submission
- it drafts titles, submission text, and first-comment scaffolding
- it monitors comments and routes substantive feedback back into the company
- it keeps HN messaging aligned with the actual product and technical truth
- it reports what the HN community actually found interesting, suspicious, weak, or compelling

## 2. Non-goals

The Hacker News Specialist should not:

- replace the CMO as the channel strategist
- replace the CEO or founder when an authentic founder response is required
- replace the CTO when technical questions need authoritative technical answers
- use fake personas, bought aged accounts, or covert astroturfing
- solicit votes, comments, or brigaded attention
- run sockpuppet threads or undisclosed employee amplification
- spam repeated submissions or title variants to force exposure
- rely on markdown notes as the primary workflow system
- depend on stale hidden memory instead of live state

Those tactics are excluded on purpose.

They are not just ethically weak. They are operationally weak:

- HN users are unusually sensitive to marketing posture and manipulation
- fake engagement is quickly detected and heavily counterproductive
- the platform culture rewards honesty, technical clarity, and relevance
- the wrong tactics permanently poison founder and product credibility

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and workflows

This design changes the Hacker News Specialist implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- HN work existing only as vague launch ideas instead of real submission and comment workflows
- weak visibility into what was submitted, when, and why
- no clear distinction between Show HN, launch link, technical essay, and comment participation plays
- no structured route from HN comments into product, messaging, or founder workflows
- no clear source of truth for HN account, submission, and conversation state
- activity that looks like launch work but is not grounded in HN norms

## 4. Hacker News Specialist operating position in the org

### 4.1 Chain of command

The Hacker News Specialist reports to the CMO.

The Hacker News Specialist owns:

- Hacker News submission strategy
- title and first-comment preparation
- comment-monitoring workflows
- HN-specific experiment summaries
- routing of HN feedback to the right internal owners

The Hacker News Specialist must stay tightly aligned with:

- the CMO for positioning and weekly priorities
- the CEO for mission, founder voice, and escalation-worthy moments
- the CTO for technical truth, launch-readiness, and demo credibility

The Hacker News Specialist does not bypass:

- the CMO for strategy
- the CEO or founder for founder-authored HN comments or reputationally sensitive responses
- the CTO for technical claims
- the API Key Provider for accounts or service setup

### 4.2 What "done" means

From the Hacker News Specialist's point of view, work is only done when:

1. the angle is actually HN-relevant
2. the destination and demo are real and credible
3. the submission is published or correctly queued through an auditable workflow
4. early comments are monitored and routed
5. technical and founder questions are answered by the right owner
6. traffic and downstream actions are measured
7. the resulting learnings are routed back into the company

Nothing short of that should become founder-visible "HN progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- Hacker News punishes generic marketing language harder than most channels.
- Weak models default to hype, superlatives, vague founder-story framing, and superficial technical positioning.
- The HN Specialist needs to reason about technical fit, HN norms, submission timing, likely skepticism, and comment dynamics in one loop.

Recommendation:

- keep the Hacker News Specialist on Opus 4.6 in v1
- later, low-risk monitoring and summarization can move to cheaper models
- keep angle selection, title drafting, and comment triage on Opus

Implementation requirement:

- do not run the Hacker News Specialist in `bypassPermissions`
- use explicit `allowedTools`
- separate listening, drafting, submission, and reporting lanes
- use read APIs for monitoring and human-approved submission flows when the risk is high

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

The Hacker News Specialist tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The Hacker News Specialist must not operate through ad hoc notes or direct D1 writes.

Use:

- the per-company `CompanyCoordinator` service running on the supervisor VM as the serialized workflow layer
- local SQLite as the hot coordination store for that service
- D1 as the historical mirror
- the shared workspace for sanitized HN playbooks, launch artifacts, and summaries

Why:

- HN plays are sparse but high leverage
- the system needs durable state for launch windows, queued submissions, comment routing, and feedback harvesting
- one bad submission can be reputationally expensive, so workflow state must be explicit

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - HN account strategy state
  - submission queue
  - comment backlog
  - live thread watchlist
  - experiment state
  - moderator or community risk notes
  - idempotency keys
- D1:
  - historical submission log
  - comment-routing history
  - experiment summaries
  - traffic summaries
  - agent message history
  - founder-visible execution summaries
- workspace:
  - HN playbook
  - title and first-comment library
  - proof-point library
  - weekly summaries
  - launch prep docs
- R2:
  - screenshots of submissions and thread state
  - evidence bundles
  - exported reports

### 6.3 Source-of-truth order

The Hacker News Specialist must treat state in this order:

1. coordinator live workflow state
2. current HN item and comment state
3. D1 mirrored history
4. canonical marketing docs and product artifacts
5. recent CMO/CEO/CTO messages
6. session memory

Session memory is never authoritative.

## 7. Hacker News Specialist lanes

This agent should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Channel fit and launch timing lane

Purpose:

- determine whether HN is worth using this week
- identify the right submission type and moment
- maintain a view of comparable launches and current HN context

Properties:

- read-heavy
- no submitting
- updates HN strategy state

### 7.2 Drafting lane

Purpose:

- draft titles, submission text, Show HN intros, and first-comment scaffolding
- package technical proof, demo guidance, and likely FAQ responses
- prepare founder or CTO answer kits for expected questions

Properties:

- write-heavy
- draft-only
- cannot submit directly

### 7.3 Submission and comment-triage lane

Purpose:

- submit or queue the approved HN item
- monitor early comments
- route technical, founder, and market questions to the correct owner
- record thread dynamics and risk

Properties:

- low-frequency, high-signal
- must attach evidence and current state after each action
- should prefer supported account-level human-assisted submission where reputational risk is high

### 7.4 Reporting and routing lane

Purpose:

- summarize what actually happened on HN
- connect discussion to downstream traffic and product signals
- route objections, feature requests, and founder-interest moments to the right role

Properties:

- read-heavy
- no submitting
- summary and routing only

## 8. Files and contracts the Hacker News Specialist owns

Recommended owned files:

- `/workspace/docs/marketing/hackernews-playbook.md`
  - channel strategy, anti-goals, submission types, and current priorities
- `/workspace/docs/marketing/hackernews-queue.json`
  - sanitized queue mirror of planned submissions and response kits
- `/workspace/docs/marketing/hackernews-experiments.json`
  - experiment registry with hypothesis, angle, owner, and result
- `/workspace/docs/marketing/hackernews-proof-points.md`
  - allowed claims, demo proof, technical proof, and launch facts
- `/workspace/docs/marketing/hackernews-title-library.md`
  - working titles and framing variants
- `/workspace/docs/marketing/hackernews-first-comment-library.md`
  - prepared launch comments, disclosures, and FAQs
- `/workspace/docs/marketing/hackernews-weekly-summary.md`
  - founder-readable output and learnings

Required structured objects in the coordinator:

- `hn_submission_draft`
- `hn_submission_event`
- `hn_comment_backlog_item`
- `hn_thread_watch`
- `hn_experiment`
- `hn_account_profile`
- `hn_risk_note`
- `hn_feedback_signal`

## 9. Hacker News Specialist tool surface

The Hacker News Specialist should mutate the world only through explicit internal tools.

### 9.1 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | HN Specialist access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.get_tasks`, `org.send_message`, `org.create_experiment`, `org.record_execution_note`, `org.update_workflow` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable workflow state matching the current architecture | Full |
| Hacker News live reads | `hn.get_item`, `hn.get_user`, `hn.get_top_stories`, `hn.get_new_stories`, `hn.get_item_tree` | Internal MCP server over the official Hacker News Firebase API | Best source of truth for live story and comment state | Read-only |
| Search and historical discovery | `hn.search_stories`, `hn.search_comments`, `hn.find_similar_launches` | Internal MCP server using Algolia HN Search when available, with fallback to local indexed snapshots | Useful for historical pattern discovery, but should remain optional because its status is less stable than the official Firebase API | Read-heavy |
| Submission and account workflow | `hn.prepare_submission`, `hn.submit_link`, `hn.submit_text`, `hn.flag_reputational_risk`, `hn.capture_thread_state` | Internal MCP server over company-managed submission workflow and optional human-in-the-loop execution | HN is reputationally sensitive; submission should be controlled, inspectable, and optionally human-confirmed | Limited / guarded |
| Product and destination inspection | `artifact.get_preview`, `artifact.capture_page`, `artifact.get_claims`, `artifact.validate_destination` | Internal MCP server over company artifacts and previews | HN submissions live or die on whether the demo or article is actually worth clicking | Read-only |
| Analytics and attribution | `analytics.get_hn_traffic`, `analytics.get_conversion_funnel`, `analytics.get_session_replays`, `analytics.compare_experiments` | Internal MCP server over PostHog | Strong first-party analytics and replay are the best fit for tying HN traffic to real business outcomes | Read-only |
| Link management | `links.create_utm_link`, `links.resolve_destination`, `links.get_click_summary` | Internal MCP server over company link conventions and analytics | HN submissions need consistent attribution-safe links without ugly tracking abuse | Full |
| Workspace docs | `workspace.write_owned_doc`, `workspace.append_experiment_result`, `workspace.update_hn_profile` | Internal MCP server enforcing path-safe writes to owned docs only | The specialist needs durable written memory without raw unrestricted file editing | Full |
| Official-guideline fetch | `research.fetch_official_doc`, `research.extract_policy_constraints` | Internal MCP server with allowlisted official domains | HN execution must stay aligned with current guidelines and norms | Read-only |
| Social observability | `observe.get_submission_log`, `observe.get_thread_change_log`, `observe.get_comment_response_times` | Internal MCP server over internal logs and HN item snapshots | Makes it possible to debug whether the workflow is actually healthy and responsive | Read-only |

## 10. Provider notes

### 10.1 Primary HN read provider

Use the official Hacker News Firebase API as the primary read surface.

Why:

- it is the official live source of truth
- it provides direct access to current items, users, and comment trees
- it is sufficient for live monitoring without fragile scraping

### 10.2 Historical search

Use Algolia HN Search only as an optional convenience layer.

Why:

- it is useful for full-text search and historical pattern discovery
- however, it is not the core platform source of truth and its long-term maintenance status is less stable

So the correct design is:

- official Firebase API for live state
- Algolia search only when available and useful
- local caching/indexing as a fallback

### 10.3 Submission model

Treat HN submission as a guarded workflow, not as a free-fire posting primitive.

Why:

- HN is reputationally sensitive
- the right title and first-comment posture matter a lot
- founder or CTO involvement is often necessary for credible follow-through

Default rule:

- the agent can prepare and queue a submission
- actual submission should allow an explicit human-confirm step or a higher-confidence autonomous path only after the system proves itself

### 10.4 Analytics

Use PostHog as the primary downstream analytics provider.

Why:

- the role needs more than referral counts
- it needs on-site behavior, funnels, and replay after the click
- it keeps the signal consistent with the rest of the company stack

### 10.5 Whitehat guerrilla marketing

This role should support aggressive but legitimate HN-native tactics, including:

- strong Show HN framing when there is a real thing to show
- technical writeups with actual substance
- honest launch intros with direct disclosure
- fast, technically grounded follow-up in comments
- title discipline that emphasizes what was built rather than how amazing it is
- launching only when the product or article can survive scrutiny
- routing harsh feedback back into product and messaging quickly

The point is to win on:

- substance
- honesty
- technical relevance
- demo quality
- response quality

not on manipulation.

### 10.6 Excluded greyhat methods

The following are explicitly out of scope:

- buying or renting aged HN accounts
- fake founder or employee accounts
- vote solicitation
- coordinated upvote or comment rings
- sockpuppet discussion seeding
- repetitive resubmission spam

Reason:

- HN norms and guidelines cut directly against these tactics
- they are easy to detect
- they destroy credibility with exactly the audience this channel is meant to reach

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
- `mcp__hn__get_top_stories`
- `mcp__hn__get_new_stories`
- `mcp__hn__get_item`
- `mcp__hn__search_stories`
- `mcp__artifact__get_preview`
- `mcp__analytics__get_hn_traffic`
- `mcp__research__fetch_official_doc`
- `mcp__workspace__update_hn_profile`

Disallowed tools:

- raw `Bash`
- raw `Edit` / `Write`
- direct submit tools
- any vote or engagement-request tooling

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
- `mcp__workspace__write_owned_doc`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- direct submit tools
- raw D1 access
- raw browser automation

### 11.3 Submission and comment-triage lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- explicit `allowedTools`
- submission preflight required

Allowed tools:

- `mcp__org__get_live_state`
- `mcp__org__record_execution_note`
- `mcp__org__send_message`
- `mcp__hn__prepare_submission`
- `mcp__hn__submit_link`
- `mcp__hn__submit_text`
- `mcp__hn__get_item_tree`
- `mcp__hn__capture_thread_state`
- `mcp__observe__get_submission_log`
- `mcp__observe__get_thread_change_log`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- vote or comment solicitation tools
- raw browser automation against HN
- raw file-edit tools outside owned docs

### 11.4 Reporting lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- read-heavy

Allowed tools:

- `mcp__analytics__get_hn_traffic`
- `mcp__analytics__get_conversion_funnel`
- `mcp__analytics__get_session_replays`
- `mcp__observe__get_comment_response_times`
- `mcp__org__send_message`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- submit tools
- raw web search

## 12. Internal MCP servers

The Hacker News Specialist should rely on a small number of explicit internal MCP servers.

### 12.1 `org`

Purpose:

- source of truth for structured tasks, experiments, messages, and execution notes

Key operations:

- `get_live_state`
- `send_message`
- `create_experiment`
- `record_execution_note`
- `update_workflow`

### 12.2 `hn`

Purpose:

- live HN reads, search, submission preparation, and thread tracking

Backed by:

- official HN Firebase API
- optional Algolia HN Search
- internal submission guardrails

Key operations:

- `get_item`
- `get_user`
- `get_top_stories`
- `get_new_stories`
- `get_item_tree`
- `search_stories`
- `search_comments`
- `find_similar_launches`
- `prepare_submission`
- `submit_link`
- `submit_text`
- `capture_thread_state`

### 12.3 `artifact`

Purpose:

- validate the product destination and claim surface

Key operations:

- `get_preview`
- `capture_page`
- `get_claims`
- `validate_destination`

### 12.4 `analytics`

Purpose:

- connect HN activity to actual product and funnel behavior

Backed by:

- PostHog

Key operations:

- `get_hn_traffic`
- `get_conversion_funnel`
- `get_session_replays`
- `compare_experiments`

### 12.5 `links`

Purpose:

- standardize attribution-safe links

Key operations:

- `create_utm_link`
- `resolve_destination`
- `get_click_summary`

### 12.6 `workspace`

Purpose:

- enforce path-safe writes to owned HN docs only

Key operations:

- `write_owned_doc`
- `append_experiment_result`
- `update_hn_profile`

### 12.7 `observe`

Purpose:

- submission and thread observability

Key operations:

- `get_submission_log`
- `get_thread_change_log`
- `get_comment_response_times`

### 12.8 `research`

Purpose:

- fetch official guidelines and norms

Key operations:

- `fetch_official_doc`
- `extract_policy_constraints`

## 13. Provisioning-time workflow

At provisioning, the Hacker News Specialist should usually stay idle.

HN is not a default "always on" channel in the way X or Reddit can be.

Provisioning-time workflow:

1. Read the execution contract, mission, and marketing plan.
2. Determine whether HN is actually in scope this week.
3. If HN is out of scope:
   - stay idle
   - maintain no active submission queue
4. If HN is in scope:
   - inspect the current product or article artifact
   - determine whether it is HN-worthy yet
   - define the right submission type:
     - Show HN
     - launch link
     - technical writeup
     - comment participation only
   - prepare the first title set and first-comment scaffolding
   - write the HN playbook and proof-point library

The HN Specialist should not push for launch if the product, demo, or article is not ready for scrutiny.

## 14. Standard workflow

The standard workflow should be:

1. CMO marks HN as active for the week.
2. HN Specialist refreshes launch fit, comparable stories, and current HN context.
3. It identifies:
   - Show HN opportunities
   - technical article opportunities
   - launch-link opportunities
   - comment-participation-only plays
4. It validates the destination artifact and allowed claims.
5. It creates structured drafts for title, submission body, and first comment.
6. It submits only after:
   - channel-fit check
   - title-discipline check
   - destination check
   - founder or CTO response readiness check
7. It monitors comments and routes:
   - technical questions to CTO
   - mission or founder questions to CEO/founder
   - product objections to CTO or CEO
   - positioning learnings to CMO
8. It records:
   - item id
   - title
   - type
   - timestamp
   - early score/comments
   - traffic
   - downstream conversions
   - qualitative feedback
9. It updates the weekly summary and next experiments.

## 15. Reliability controls

### 15.1 Policy and norm compliance

Hard rules:

- no fake accounts
- no vote solicitation
- no comment rings
- no undisclosed sockpuppets
- no superlative-heavy or hypey titles
- no publishing content the product or article cannot support

### 15.2 Submission discipline

Every submission must have:

- one clear type
- one clear destination
- one experiment tag
- one owner

### 15.3 Founder and CTO readiness

Before submission, the system must verify:

- founder or CEO is available for mission-level responses
- CTO is available for technical follow-up if the submission is technical or product-heavy
- the demo or article can withstand scrutiny

### 15.4 Evidence

Every submission and major thread state change must capture:

- item id
- title
- timestamp
- item URL
- experiment id
- current score/comment snapshot

### 15.5 Feedback routing

Every meaningful HN response should be classified into:

- objection
- feature request
- technical skepticism
- praise or trust signal
- conversion intent
- founder-interest signal
- moderation or reputational risk

## 16. What to borrow from `everything-claude-code`

The useful ideas to borrow are operational, not tactical:

- strong role-specific skills
- reusable playbooks
- repeatable action checklists
- short execution loops with written outputs
- evals against common failure patterns

Applied here, that means:

- explicit pre-submission checklists
- reusable title and first-comment playbooks
- required post-launch summaries
- evals for hypey copy, weak demos, and bad HN fit

## 17. Why Relay should not be the Hacker News Specialist's primary coordination bus

Relay can be useful later for richer agent transport.

It should not be the primary bus for this role because:

- HN execution depends on typed submission, thread, and feedback state
- launch actions need serialized workflow transitions
- reputational and timing risk matter more than open-ended conversation

The primary bus should remain:

- internal structured coordination through the local coordinator + D1 mirror

Relay can become an optional future transport once the structured workflow layer is stable.

## 18. Implementation phases

### Phase 1: structured HN workflow

- keep the agent on Opus 4.6
- remove any broad `bypassPermissions` path
- add the `hn`, `artifact`, `analytics`, `links`, and `workspace` MCP servers
- define submission, thread, and experiment objects

### Phase 2: submission and comment routing

- add guarded submission preflight
- add live thread tracking and question routing
- add founder-visible weekly summaries

### Phase 3: historical pattern support

- add optional Algolia-backed search where useful
- add local snapshot indexing fallback
- improve comparable-launch analysis

### Phase 4: observability and quality

- add thread-change tracking
- add launch evidence bundles
- add evals for hype, bad fit, and weak response readiness

### Phase 5: multi-provider portability

- keep the same tool plane
- add other agent drivers later
- optionally add Relay for live collaboration once typed workflow state is mature

## 19. Recommended final stack

If I were implementing the Hacker News Specialist next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Primary HN live state: official Hacker News Firebase API
- Historical search: optional Algolia HN Search plus local fallback index
- Submission workflow: internal guarded submission MCP with optional human confirmation
- Product/destination validation: internal artifact MCP over company previews and claims
- Analytics: PostHog
- Link tracking: internal UTM/link MCP
- Observability: internal execution logs + HN item snapshot tracking
- Workspace memory: path-safe workspace MCP for owned HN docs only

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the Hacker News Specialist, without turning it into a spam launcher or a manipulation wrapper.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare D1 overview: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/)
- Hacker News Guidelines: [news.ycombinator.com/newsguidelines.html](https://news.ycombinator.com/newsguidelines.html)
- Hacker News FAQ: [news.ycombinator.com/newsfaq.html](https://news.ycombinator.com/newsfaq.html)
- Hacker News Firebase API reference: [github.com/HackerNews/API](https://github.com/HackerNews/API)
- Algolia Hacker News Search index: [algolia.com/developers/code-exchange/hacker-news](https://www.algolia.com/developers/code-exchange/hacker-news)
- PostHog docs: [posthog.com/docs](https://posthog.com/docs)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
