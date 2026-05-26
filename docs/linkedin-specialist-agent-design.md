# LinkedIn Specialist Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: LinkedIn Specialist agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build a LinkedIn Specialist agent that is:

- the single owner of LinkedIn execution under the CMO
- capable of turning the weekly marketing strategy into credible LinkedIn-native posts, page activity, founder content programs, and conversation follow-through
- able to build distribution through real professional relevance, trust, and repeatable narrative systems
- able to connect LinkedIn activity to actual clicks, leads, conversations, and conversion signals
- reliable enough to run autonomously without getting the company page, member account, or app access restricted
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The LinkedIn Specialist is not just a scheduler and not just a ghostwriter. It is the LinkedIn execution plane for the company:

- it defines how the company should show up on LinkedIn
- it drafts company-page and founder/member content
- it manages comment and reply workflows where automation is allowed
- it translates market reaction into structured learnings
- it keeps the channel aligned with the actual product, proof, and business reality

## 2. Non-goals

The LinkedIn Specialist should not:

- replace the CMO as the channel strategist
- replace the CEO or founder when a true founder voice or founder relationship is required
- replace the CTO when product claims require technical validation
- use fake personas, bought aged accounts, or covert astroturfing
- scrape LinkedIn or automate LinkedIn website actions with browser bots
- buy followers, reactions, comments, or connection growth
- run engagement pods or disguised employee amplification rings
- automate connection requests or unsolicited DMs outside official supported surfaces
- rely on markdown notes as the primary workflow system
- depend on stale hidden memory instead of live state

Those tactics are excluded on purpose.

They are not just ethically weak. They are operationally weak:

- LinkedIn explicitly bans third-party software that scrapes or automates website activity
- fake engagement and fake accounts are directly hostile to platform trust and enforcement posture
- low-trust growth tactics are a bad fit for a professional network where credibility compounds
- they produce fragile outcomes and noisy feedback loops

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and workflows

This design changes the LinkedIn Specialist implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- LinkedIn work existing only as abstract "thought leadership" docs instead of real queue-based execution
- weak visibility into what was actually published and how it performed
- no clean distinction between company-page, founder, and employee-advocacy content
- no robust loop from comments and reactions back into the marketing and product system
- platform-hostile assumptions about browser automation and growth tactics
- channel activity that looks busy but is not attributable to any real business outcome

## 4. LinkedIn Specialist operating position in the org

### 4.1 Chain of command

The LinkedIn Specialist reports to the CMO.

The LinkedIn Specialist owns:

- LinkedIn content execution
- company-page publishing and engagement where authorized
- founder-content program drafting and packaging
- comment-response workflows where API support exists
- post queue hygiene
- LinkedIn-specific experiment summaries

The LinkedIn Specialist must stay tightly aligned with:

- the CMO for narrative, cadence, audience targeting, and weekly priorities
- the CEO for mission, founder positioning, and escalation-worthy market signals
- the CTO for product truth, launch-readiness, and proof constraints

The LinkedIn Specialist does not bypass:

- the CMO for strategy
- the CEO or founder for founder-authored relationship moves
- the CTO for product claims
- Procurement or the API Key Provider for account, app, or paid access setup

### 4.2 What "done" means

From the LinkedIn Specialist's point of view, work is only done when:

1. the account and content mode are aligned with the current strategy
2. the post or comment is native to LinkedIn's professional context
3. the linked destination and proof points are real
4. the action is published or queued through an auditable workflow
5. follow-up interactions are monitored and routed correctly
6. traffic, leads, or response quality are measured
7. the resulting learnings are sent back into the company

Nothing short of that should become founder-visible "LinkedIn progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- LinkedIn rewards clarity, credibility, and pattern-sensitive audience framing more than generic short-form virality.
- Weak models default to hollow personal-brand clichés, generic hustle-post language, and fake authority signals.
- The LinkedIn Specialist needs to understand audience seniority, proof expectations, message hierarchy, and when a human founder must own the action.

Recommendation:

- keep the LinkedIn Specialist on Opus 4.6 in v1
- later, low-risk queue cleanups and simple metric summaries can move to cheaper models
- keep drafting, channel judgment, and escalation logic on Opus

Implementation requirement:

- do not run the LinkedIn Specialist in `bypassPermissions`
- use explicit `allowedTools`
- use official LinkedIn APIs where available
- if a desired action is not supported by the official API, fall back to human-assisted workflow, not website automation

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

The LinkedIn Specialist tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The LinkedIn Specialist must not operate through ad hoc notes or direct D1 writes.

Use:

- the per-company `CompanyCoordinator` service running on the supervisor VM as the serialized workflow layer
- local SQLite as the hot coordination store for that service
- D1 as the historical mirror
- the shared workspace for sanitized playbooks, content libraries, and summaries

Why:

- LinkedIn execution has multiple content modes with different authorship and permission models
- one company can have company-page content, founder-content support, employee-advocacy programs, and comment-response flows running at once
- approvals, publishing, and analytics need durable workflow state

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - account strategy state
  - post queue
  - founder-content queue
  - company-page publish log
  - reply and comment backlog
  - experiment state
  - permission-state and token-state metadata
  - idempotency keys
- D1:
  - historical post log
  - experiment summaries
  - lead and traffic summaries
  - engagement history
  - agent message history
  - founder-visible execution summaries
- workspace:
  - LinkedIn playbook
  - founder and page voice guides
  - proof-point libraries
  - content archetypes
  - weekly summaries
- R2:
  - content previews
  - screenshots
  - rendered carousel or document assets
  - evidence bundles

### 6.3 Source-of-truth order

The LinkedIn Specialist must treat state in this order:

1. coordinator live workflow state
2. current LinkedIn account, page, and notification state
3. D1 mirrored history
4. canonical marketing docs and product artifacts
5. recent CMO/CEO/CTO messages
6. session memory

Session memory is never authoritative.

## 7. LinkedIn Specialist lanes

This agent should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Account and audience strategy lane

Purpose:

- define the role of the company page versus founder/member posting
- maintain audience and content-mode strategy
- map which proof points and narratives belong on LinkedIn now

Properties:

- read-heavy
- no publishing
- updates account and content strategy state

### 7.2 Drafting lane

Purpose:

- draft company-page posts
- draft founder posts and comment kits
- produce LinkedIn-native documents, carousels, polls, and hooks where supported
- package content so a founder can publish manually when needed

Properties:

- write-heavy
- draft-only
- cannot publish directly outside the supported API surfaces

### 7.3 Publish and engagement lane

Purpose:

- publish through official company-page or member-share APIs where authorized
- monitor and respond through supported social-action flows
- route unsupported member actions into human-assisted workflows

Properties:

- API-backed write access only
- strict permission and mode checks
- must record evidence after every publish or comment action

### 7.4 Reporting and routing lane

Purpose:

- summarize what actually happened on LinkedIn
- extract market signals, objections, trust cues, and inbound-interest moments
- route founder-relevant or sales-relevant signals to the right role

Properties:

- read-heavy
- no publishing
- summary and routing only

## 8. Files and contracts the LinkedIn Specialist owns

Recommended owned files:

- `/workspace/docs/marketing/linkedin-playbook.md`
  - channel strategy, audience, voice, anti-goals, and current priorities
- `/workspace/docs/marketing/linkedin-accounts.json`
  - approved company page and member accounts, owner role, content mode, and status
- `/workspace/docs/marketing/linkedin-queue.json`
  - sanitized queue mirror of planned posts, founder drafts, and comment kits
- `/workspace/docs/marketing/linkedin-experiments.json`
  - experiment registry with hypothesis, angle, owner, and result
- `/workspace/docs/marketing/linkedin-proof-points.md`
  - allowed claims, customer proof, social proof, and business proof
- `/workspace/docs/marketing/linkedin-reply-library.md`
  - approved comment and reply patterns
- `/workspace/docs/marketing/linkedin-weekly-summary.md`
  - founder-readable weekly output and learnings

Required structured objects in the coordinator:

- `linkedin_account_profile`
- `linkedin_post_draft`
- `linkedin_publish_event`
- `linkedin_comment_backlog_item`
- `linkedin_experiment`
- `linkedin_account_health`
- `linkedin_signal`
- `linkedin_permission_blocker`

## 9. LinkedIn Specialist tool surface

The LinkedIn Specialist should mutate the world only through explicit internal tools.

### 9.1 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | LinkedIn Specialist access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.get_tasks`, `org.send_message`, `org.create_experiment`, `org.record_execution_note`, `org.update_workflow` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable workflow state matching the current architecture | Full |
| LinkedIn company and member publishing | `linkedin.create_member_draft`, `linkedin.publish_member_post`, `linkedin.publish_org_post`, `linkedin.get_post`, `linkedin.get_post_metrics`, `linkedin.get_notifications` | Internal MCP server over official LinkedIn Share on LinkedIn and Community Management APIs | Highest reliability comes from official APIs; LinkedIn explicitly forbids third-party software that automates website activity | Full within approved scopes |
| LinkedIn comments and social actions | `linkedin.list_comments`, `linkedin.create_org_comment`, `linkedin.like_post`, `linkedin.list_reactions`, `linkedin.get_social_summary` | Internal MCP server over official Social Actions APIs and organization notification webhooks | Needed for supported engagement loops on company content and for analysis of response quality | Limited / scoped |
| LinkedIn company-page notifications | `linkedin.subscribe_notifications`, `linkedin.pull_missed_notifications`, `linkedin.get_page_events` | Internal MCP server over Organization Social Action Notifications | Webhook-driven updates are the most reliable way to keep the specialist aware of page interactions | Full |
| Product and destination inspection | `artifact.get_preview`, `artifact.capture_page`, `artifact.get_claims`, `artifact.validate_destination` | Internal MCP server over company artifacts and previews | LinkedIn content must stay aligned with what the destination actually says and does | Read-only |
| Analytics and attribution | `analytics.get_linkedin_traffic`, `analytics.get_conversion_funnel`, `analytics.get_session_replays`, `analytics.compare_experiments` | Internal MCP server over PostHog | Strong first-party analytics and replay are the best fit for attributing LinkedIn traffic to actual business outcomes | Read-only |
| Link management | `links.create_utm_link`, `links.resolve_destination`, `links.get_click_summary` | Internal MCP server over company link conventions and analytics | LinkedIn experiments need consistent link hygiene and attribution | Full |
| Asset generation handoff | `content.render_carousel_brief`, `content.render_document_brief`, `content.get_asset_status` | Internal MCP server over internal creative/render pipeline | LinkedIn often performs better with documents, carousels, and proof-heavy assets that need clean handoff to design/content systems | Limited |
| Workspace docs | `workspace.write_owned_doc`, `workspace.append_experiment_result`, `workspace.update_account_profile` | Internal MCP server enforcing path-safe writes to owned docs only | The specialist needs durable written memory without raw unrestricted file editing | Full |
| Official-doc and policy fetch | `research.fetch_official_doc`, `research.extract_policy_constraints` | Internal MCP server with allowlisted official domains | LinkedIn execution must stay aligned with current platform policy and API constraints | Read-only |
| Social observability | `observe.get_publish_log`, `observe.get_permission_errors`, `observe.get_comment_response_times`, `observe.get_notification_lag` | Internal MCP server over internal logs and LinkedIn API/webhook state | Makes it possible to debug whether the workflow is actually healthy and responsive | Read-only |

## 10. Provider notes

### 10.1 Primary LinkedIn execution provider

Use an internal `linkedin` MCP backed by official LinkedIn APIs.

This should combine:

- Share on LinkedIn for supported member posting flows
- Community Management APIs for organization/company-page posting and content analysis
- Social Actions APIs for comments, reactions, and interaction analysis where supported
- Organization Social Action Notifications for webhook-based page activity updates

Why:

- LinkedIn explicitly says third-party software, crawlers, bots, and tools that automate website activity are not permitted
- official APIs are the only durable path for autonomous posting and supported engagement
- API-backed execution is auditable, scoped, and aligned with platform permissions

This is the core architectural decision for this role: do not make the LinkedIn Specialist browser-first.

### 10.2 Human-assisted fallback

Some high-value LinkedIn actions are often outside the practical official API surface, especially around:

- nuanced founder account activity
- manual relationship-building
- connection requests
- direct messaging
- unsupported interaction types

For those cases, the correct design is:

- the agent drafts
- the system packages the action
- the founder or approved human operator executes it manually

This preserves reliability and policy alignment instead of trying to automate the website.

### 10.3 Analytics

Use PostHog as the primary downstream analytics provider.

Why:

- the role needs more than reach and reaction counts
- it needs on-site behavior, funnels, and replay after the click
- it keeps the signal consistent with the rest of the company stack

### 10.4 Whitehat guerrilla marketing

This role should support aggressive but legitimate LinkedIn-native tactics, including:

- sharp founder POV posts tied to real business proof
- operator-style build logs and execution updates
- customer-proof and case-study packaging
- document or carousel posts that teach something concrete
- comment-first participation on relevant industry conversations
- transparent employee-advocacy kits for real team members
- post-to-landing-page angle matching
- timely responses to inbound interest or objections

The point is to win on:

- authority
- clarity
- evidence
- consistency
- professional relevance

not on deception.

### 10.5 Excluded greyhat methods

The following are explicitly out of scope:

- buying or renting aged LinkedIn accounts
- fake employee or founder personas
- fake company pages
- fake reactions or comment farms
- employee-like amplification rings disguised as organic discussion
- automated connection spam
- automated unsolicited DMs
- browser automation against LinkedIn website flows

Reason:

- LinkedIn's help and policy material explicitly prohibit third-party software that scrapes or automates website activity
- fake accounts and fake engagement are structurally misaligned with the platform
- these tactics are brittle, easy to penalize, and the wrong long-term design

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
- `mcp__linkedin__get_notifications`
- `mcp__linkedin__get_post`
- `mcp__linkedin__get_post_metrics`
- `mcp__linkedin__get_social_summary`
- `mcp__artifact__get_preview`
- `mcp__analytics__get_linkedin_traffic`
- `mcp__research__fetch_official_doc`
- `mcp__workspace__update_account_profile`

Disallowed tools:

- raw `Bash`
- raw `Edit` / `Write`
- direct publish tools
- any browser automation against LinkedIn

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
- `mcp__linkedin__create_member_draft`
- `mcp__artifact__get_preview`
- `mcp__artifact__get_claims`
- `mcp__links__create_utm_link`
- `mcp__content__render_carousel_brief`
- `mcp__workspace__write_owned_doc`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- direct publish tools
- DM or connection-request tools
- raw D1 access
- raw browser automation for LinkedIn actions

### 11.3 Publish and engagement lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- explicit `allowedTools`
- publish preflight required

Allowed tools:

- `mcp__org__get_live_state`
- `mcp__org__record_execution_note`
- `mcp__org__send_message`
- `mcp__linkedin__publish_member_post`
- `mcp__linkedin__publish_org_post`
- `mcp__linkedin__list_comments`
- `mcp__linkedin__create_org_comment`
- `mcp__linkedin__like_post`
- `mcp__linkedin__get_post_metrics`
- `mcp__linkedin__subscribe_notifications`
- `mcp__linkedin__pull_missed_notifications`
- `mcp__observe__get_publish_log`
- `mcp__observe__get_permission_errors`
- `mcp__workspace__append_experiment_result`

Disallowed tools:

- browser automation against LinkedIn
- connection-request automation
- DM automation
- raw file-edit tools outside owned docs

### 11.4 Reporting lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- read-heavy

Allowed tools:

- `mcp__analytics__get_linkedin_traffic`
- `mcp__analytics__get_conversion_funnel`
- `mcp__analytics__get_session_replays`
- `mcp__observe__get_comment_response_times`
- `mcp__observe__get_notification_lag`
- `mcp__org__send_message`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- publish tools
- interaction-write tools
- raw web search

## 12. Internal MCP servers

The LinkedIn Specialist should rely on a small number of explicit internal MCP servers.

### 12.1 `org`

Purpose:

- source of truth for structured tasks, experiments, messages, and execution notes

Key operations:

- `get_live_state`
- `send_message`
- `create_experiment`
- `record_execution_note`
- `update_workflow`

### 12.2 `linkedin`

Purpose:

- official LinkedIn posting, reading, social action handling, and notification management

Backed by:

- Share on LinkedIn
- Community Management APIs
- Social Actions APIs
- Organization Social Action Notifications

Key operations:

- `create_member_draft`
- `publish_member_post`
- `publish_org_post`
- `get_post`
- `get_post_metrics`
- `get_notifications`
- `list_comments`
- `create_org_comment`
- `like_post`
- `get_social_summary`
- `subscribe_notifications`
- `pull_missed_notifications`

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

- connect LinkedIn activity to actual product and funnel behavior

Backed by:

- PostHog

Key operations:

- `get_linkedin_traffic`
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

### 12.6 `content`

Purpose:

- coordinate richer LinkedIn assets such as documents, carousel briefs, and post packages

Key operations:

- `render_carousel_brief`
- `render_document_brief`
- `get_asset_status`

### 12.7 `workspace`

Purpose:

- enforce path-safe writes to owned LinkedIn docs only

Key operations:

- `write_owned_doc`
- `append_experiment_result`
- `update_account_profile`

### 12.8 `observe`

Purpose:

- account-health and execution observability

Key operations:

- `get_publish_log`
- `get_permission_errors`
- `get_comment_response_times`
- `get_notification_lag`

### 12.9 `research`

Purpose:

- fetch official policy docs and platform constraints

Key operations:

- `fetch_official_doc`
- `extract_policy_constraints`

## 13. Provisioning-time workflow

At provisioning, the LinkedIn Specialist should not start publishing immediately unless the CMO has already marked LinkedIn as an active channel.

Provisioning-time workflow:

1. Read the execution contract, mission, and marketing plan.
2. Determine whether LinkedIn is in scope this week.
3. If LinkedIn is out of scope:
   - stay idle
   - maintain no active queue
4. If LinkedIn is in scope:
   - define the content-mode strategy:
     - company-page content
     - founder content drafting
     - employee-advocacy support
   - inspect the current landing page or artifact
   - define 3 to 5 content angles
   - prepare the first experiment queue
   - write the LinkedIn playbook and proof-point library

The LinkedIn Specialist should not publish before:

- the destination is credible
- the message is aligned
- the company-page or member permissions are actually configured

## 14. Standard workflow

The standard workflow should be:

1. CMO marks LinkedIn as active for the week.
2. LinkedIn Specialist refreshes content-mode strategy and current priorities.
3. It identifies:
   - company-page post opportunities
   - founder-post opportunities
   - comment-response opportunities
   - proof-driven document or carousel opportunities
4. It validates the destination artifact and allowed claims.
5. It creates structured drafts for each play.
6. It publishes only after:
   - claim check
   - permission check
   - duplication check
   - destination check
7. It monitors comments, reactions, and notification events where supported.
8. It routes:
   - product objections to CTO or CEO
   - positioning learnings to CMO
   - founder-interest moments to CEO
   - unsupported member-network actions into human-assisted workflows
9. It records:
   - post URL
   - account or page used
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
- no fake company pages
- no browser automation against LinkedIn website flows
- no connection-request spam
- no automated unsolicited DMs
- no fake engagement
- no publishing content the product cannot support

### 15.2 Authorship clarity

Every content item must be classified as one of:

- company-page post
- founder post drafted for manual or API-supported publishing
- employee-advocacy kit
- comment-response play

This matters because the right actor and permission surface differ by mode.

### 15.3 Publish discipline

Each published item must have:

- one clear intent
- one destination at most
- one experiment tag
- one owner account or page

### 15.4 Human-required actions

When the action requires:

- direct relationship-building
- connection invites
- nuanced founder replies outside supported API surfaces
- unsupported direct messaging

the specialist should package the action for human execution, not attempt to automate it.

### 15.5 Evidence

Every publish or important comment event must capture:

- permalink
- account or page used
- timestamp
- experiment id
- current metric snapshot
- any permission or notification anomalies

### 15.6 Feedback routing

Every meaningful LinkedIn response should be classified into:

- objection
- feature request
- trust signal
- conversion intent
- hiring signal
- partnership signal
- founder-network signal

## 16. What to borrow from `everything-claude-code`

The useful ideas to borrow are operational, not tactical:

- strong role-specific skills
- reusable playbooks
- repeatable action checklists
- short execution loops with written outputs
- evals against common failure patterns

Applied here, that means:

- explicit pre-publish checklists
- reusable post and comment archetype playbooks
- required post-action summaries
- evals for generic AI voice, weak proof, and unsupported-action leakage

## 17. Why Relay should not be the LinkedIn Specialist's primary coordination bus

Relay can be useful later for richer agent transport.

It should not be the primary bus for this role because:

- LinkedIn execution depends on typed queue, permission, and account-mode state
- publish actions need serialized workflow transitions
- platform support boundaries matter more than open-ended conversation

The primary bus should remain:

- internal structured coordination through the local coordinator + D1 mirror

Relay can become an optional future transport once the structured workflow layer is stable.

## 18. Implementation phases

### Phase 1: structured LinkedIn workflow

- keep the agent on Opus 4.6
- remove any broad `bypassPermissions` path
- add the `linkedin`, `artifact`, `analytics`, `links`, `content`, and `workspace` MCP servers
- define post, account-mode, and experiment objects

### Phase 2: publish and follow-through

- add API-backed publish preflight
- add comment and notification handling where supported
- add founder-visible weekly summaries

### Phase 3: human-assisted founder workflow

- package founder-post and relationship actions cleanly for manual execution when needed
- track completion and outcomes back into the system

### Phase 4: observability and quality

- add permission-error tracking
- add notification-lag monitoring
- add evals for generic copy, weak proof, and unsupported-action attempts

### Phase 5: multi-provider portability

- keep the same tool plane
- add other agent drivers later
- optionally add Relay for live collaboration once typed workflow state is mature

## 19. Recommended final stack

If I were implementing the LinkedIn Specialist next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Primary LinkedIn execution: internal `linkedin` MCP over official LinkedIn APIs
- Member posting: Share on LinkedIn
- Company-page posting and engagement: Community Management APIs + Social Actions APIs
- Company-page notifications: Organization Social Action Notifications
- Product/destination validation: internal artifact MCP over company previews and claims
- Analytics: PostHog
- Link tracking: internal UTM/link MCP
- Rich asset handoff: internal content/render MCP
- Observability: internal execution logs + LinkedIn API/webhook state
- Workspace memory: path-safe workspace MCP for owned LinkedIn docs only

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the LinkedIn Specialist, without turning it into a scraper, a fake-engagement bot, or a brittle website-automation wrapper.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare D1 overview: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/)
- LinkedIn prohibited software and extensions: [linkedin.com/help/linkedin/answer/a1341387](https://www.linkedin.com/help/linkedin/answer/a1341387)
- LinkedIn Professional Community Policies: [linkedin.com/legal/professional-community-policies](https://www.linkedin.com/legal/professional-community-policies)
- LinkedIn Community Management API migration guide: [learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide)
- Share on LinkedIn: [learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)
- Social Actions API: [learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/network-update-social-actions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/network-update-social-actions)
- Organization Social Action Notifications: [learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-social-action-notifications](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-social-action-notifications)
- Organizations and Brands Overview: [learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations)
- UGC Post API reference: [learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api](https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api)
- Reactions API: [learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api)
- PostHog product docs: [posthog.com/docs](https://posthog.com/docs)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
