# CTO Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: CTO agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build a CTO agent that is:

- the single owner of digital product delivery
- capable of turning CEO direction into a working product without architectural drift
- able to delegate non-overlapping work to engineers
- strict about QA gates before anything reaches the CEO
- reliable enough to run autonomously without inventing parallel product directions
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The CTO is not just a "senior coder" agent. It is the engineering control plane for the company:

- it turns the execution contract into a technical plan
- it breaks product work into clean engineering slices
- it delegates to engineers
- it consumes QA outcomes and loops failures back correctly
- it integrates passed work into a coherent release candidate
- it sends only passed work upward to the CEO
- it hires additional engineering capacity only when the queue justifies it

## 2. Non-goals

The CTO should not:

- replace the CEO as the company strategist
- bypass QA and declare code "done" by itself
- directly talk to the founder except through the CEO's chain of command
- procure credentials or billing resources instead of the API Specialist
- own channel strategy or campaign execution instead of the CMO org
- use markdown handoffs as the primary workflow system
- depend on stale hidden memory instead of live state
- get raw production cloud credentials "just in case"

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- shared filesystem plus structured tasks, messages, approvals, and workflows

This design changes the CTO implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- conflicting technical directions in the same company workspace
- multiple agents appearing to work without a clear owner/order chain
- tasks that say `running` without a real active execution
- weak QA enforcement
- overly broad agent permissions
- engineering work that exists only in prose instead of structured state
- no durable release pipeline with retry and rollback controls

## 4. CTO operating position in the org

### 4.1 Chain of command

The CTO reports to the CEO.

The CTO owns:

- technical approach
- product architecture
- engineering task decomposition
- engineering integration
- release readiness

The CTO manages:

- frontend engineer
- backend engineer
- fullstack engineer(s), if hired
- devops, if hired
- QA for delivery gating, but not as a subordinate whose gate can be ignored

The CTO does not bypass:

- the CEO for product direction
- QA for release quality
- the API Specialist for secrets/procurement

### 4.2 What "done" means

From the CTO's point of view, work is only done when:

1. the engineer completes the assigned scope
2. QA reviews it
3. failed work is fixed and re-reviewed as needed
4. the CTO integrates the passed parts into the actual product
5. QA performs final release review
6. the release passes
7. the CEO receives a coherent product handoff

Nothing short of that should become founder-facing "done."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- Anthropic positions Opus 4.6 as its strongest agentic coding model and specifically calls out better long-running coding tasks, debugging, code review, and reliability in larger codebases.
- The CTO has to reason over architecture, diffs, test failures, QA feedback, deploy risk, and release tradeoffs in one loop. This is the highest-risk technical agent in the org after the CEO.

Recommendation:

- keep the CTO on Opus 4.6 in v1
- do not prematurely demote the CTO to Sonnet for cost
- if cost tiering is needed later, split low-risk read-only health checks to Sonnet, but keep architecture, integration, and release lanes on Opus

Implementation requirement:

- do not run the CTO in `bypassPermissions`
- use explicit `allowedTools`
- use `Skill` with local CTO skills enabled
- use structured internal tools instead of raw direct cloud access

### 5.2 Driver abstraction

Use the same provider-neutral driver abstraction proposed for the CEO.

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

The CTO tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The CTO must not mutate D1 directly.

Use the same per-company `CompanyCoordinator` service running on the supervisor VM as the serialized mutation layer, with local SQLite as hot state and D1 as the historical mirror.

Why:

- engineering delegation and release state are coordination problems first
- the CTO is exactly the kind of agent that creates race conditions if state changes are not serialized
- the agents already share one VM, so local coordination is the lowest-latency and simplest reliable v1 path

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - live task ownership
  - current workflow stage
  - release candidate state
  - deploy state
  - active run metadata
  - idempotency keys
- D1:
  - queryable task history
  - workflow history
  - approval history
  - founder-visible execution summaries
  - agent message history
- workspace:
  - product code
  - canonical engineering docs
  - local test outputs
  - generated artifacts
- R2:
  - durable QA bundles
  - Playwright traces
  - screenshots
  - release manifests
  - deploy evidence bundles

### 6.3 Source-of-truth order

The CTO must treat state in this order:

1. coordinator live state
2. workflow records for the relevant tasks
3. D1 mirrored state
4. canonical engineering docs
5. recent agent messages
6. session memory

Session memory is never authoritative.

## 7. CTO lanes

The CTO should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Delivery orchestration lane

Purpose:

- read CEO direction
- update architecture
- break work into engineering slices
- assign tasks to engineers
- consume engineer and QA messages

Properties:

- autonomous
- edits architecture and release planning docs
- creates and reassigns structured tasks
- no founder email
- no direct production deploy without release criteria being met

### 7.2 Integration and review lane

Purpose:

- pull together work that has already passed QA at the component level
- resolve integration issues
- produce a coherent release candidate

Properties:

- autonomous
- code-writing allowed
- test-running allowed
- may request additional fixes from engineers
- may not mark final release as passed

### 7.3 Release lane

Purpose:

- create preview deployments
- package release evidence
- request final QA
- promote or roll back after the right gates are met

Properties:

- event-driven
- durable
- should use structured release workflows, not ad hoc shell commands
- must surface progress events the dashboard can display

### 7.4 Tech health lane

Purpose:

- periodically inspect architecture drift, failing tests, deploy health, and unresolved engineering blockers

Properties:

- scheduled
- mostly read-only
- can create corrective engineering tasks
- should not push a release by itself

## 8. Files and contracts the CTO owns

The CTO should own a small, explicit set of engineering control files.

Required files:

- `/workspace/docs/architecture.md`
- `/workspace/docs/technical-plan.md`
- `/workspace/docs/release-manifest.json`
- `/workspace/.agent/hiring/cto.json`
- `/workspace/.agent/workflows/<task-id>.json`

The CEO remains authoritative for:

- `/workspace/docs/execution-contract.json`
- `/workspace/docs/plan.md`

But the CTO must keep engineering artifacts aligned with them.

### 8.1 Proposed `release-manifest.json`

This should be generated by the CTO when preparing a candidate release.

Suggested schema:

```json
{
  "releaseId": "rel_2026_03_08_001",
  "companyId": "company_123",
  "objective": "Launch founder-impressive landing page and first product workflow",
  "taskIds": ["task_a", "task_b", "task_c"],
  "artifactPaths": [
    "/workspace/src/index.html",
    "/workspace/artifacts/landing-preview/index.html"
  ],
  "previewUrl": "https://preview.example.pages.dev",
  "testSummary": {
    "lint": "passed",
    "typecheck": "passed",
    "unit": "passed",
    "integration": "passed",
    "e2e": "passed"
  },
  "qaStatus": "pending_final_review",
  "rollbackTarget": "version_id_or_release_id"
}
```

## 9. CTO tool surface

The CTO should have more agency than the CEO on code and release work, but that does not mean "give it Bash and cloud credentials."

### 9.1 Tooling principles

- every state mutation must be structured and idempotent
- every delivery task must carry acceptance criteria and expected artifacts
- every long-running operation must emit progress events
- every deploy must be traceable and reversible
- every QA result must include evidence
- no raw SQL
- no direct secret access
- no direct founder email
- no unrestricted shell by default

### 9.2 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | CTO access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.create_tasks`, `org.reassign_task`, `org.send_message`, `org.request_hire`, `org.record_execution_note` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable task and workflow control that matches the current architecture | Full |
| Workspace code/docs | `Read`, `Glob`, `Grep`, `Edit`, `Write` | Claude Code built-in tools | Lowest-latency edits on the real shared workspace | Full |
| Repository state | `repo.status`, `repo.diff`, `repo.checkpoint`, `repo.restore_checkpoint`, `repo.log` | Internal MCP server over local Git CLI in the supervisor workspace | Reliable checkpoints and diffs without assuming a remote GitHub repo exists | Full |
| Build and test | `dev.install`, `dev.lint`, `dev.typecheck`, `dev.unit_test`, `dev.integration_test`, `dev.e2e_test`, `dev.start_preview`, `dev.stop_preview`, `dev.inspect_port` | Internal MCP server over the local company runtime | Runs against the actual shared workspace with minimal latency and maximum fidelity | Full |
| QA evidence | `qa.request_review`, `qa.get_latest_bundle`, `qa.attach_result`, `qa.get_trace_links` | Internal MCP server backed by coordinator state + local runner + Cloudflare R2 | Durable storage for traces, screenshots, and reports, plus structured gating | Full |
| Browser verification | `browser.open`, `browser.inspect`, `browser.screenshot`, `browser.extract` | Browserbase Sessions + Playwright + Browserbase Contexts | Deterministic browser automation, persistent auth when needed, session replay, and observability | Full |
| Preview and release deploys | `deploy.create_preview`, `deploy.promote_release`, `deploy.rollback_release`, `deploy.get_status` | Internal MCP server backed by Cloudflare Pages / Workers / Versions APIs and Cloudflare Workflows | Native fit for the existing stack, good preview URLs, gradual deploys, and rollback support | Preview full, production gated |
| Observability | `observe.get_runtime_health`, `observe.get_recent_errors`, `observe.get_trace`, `observe.get_deploy_health`, `observe.get_web_vitals` | Internal MCP server over Cloudflare Observability + Sentry APIs | Cloudflare is best for infra and deployment truth; Sentry is better for application exceptions, traces, and AI/LLM telemetry | Read-only |
| Web research | `research.search_web`, `research.fetch_url` | Brave Search API + internal fetch/extract | Fast, auditable discovery without defaulting to a browser | Full |
| Artifact inspection | `artifacts.list`, `artifacts.open`, `artifacts.inspect_html` | Internal Worker/Supervisor artifact routes | Uses the real company outputs and founder-visible previews | Full |

### 9.3 Provider notes

#### Browser automation

Use Browserbase plus Playwright as the primary browser stack.

Do not use a natural-language browser wrapper as the primary CTO browser contract.

Reason:

- the CTO needs deterministic validation
- Playwright aligns with QA and browser debugging
- Browserbase adds session replay, live debugging, persistent contexts, and scalable browser hosting

#### Deploys

Use Cloudflare as the primary deploy provider for v1:

- Cloudflare Pages for static or front-end previews
- Cloudflare Workers versions/deployments for Worker-based services
- Cloudflare Workflows for durable release orchestration, retries, and approval waits

Do not give the CTO direct AWS/GCP/Vercel credentials in v1.

#### Observability

Use both:

- Cloudflare for deploy/runtime/platform truth
- Sentry for application-level exceptions, distributed traces, and agent/tool telemetry

That split is more reliable than trying to force one system to cover both infra and app behavior.

## 10. Exact CTO permission profile

### 10.1 Delivery orchestration lane

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
- `mcp__repo__status`
- `mcp__repo__diff`
- `mcp__repo__checkpoint`
- `mcp__repo__log`
- `mcp__dev__install`
- `mcp__dev__lint`
- `mcp__dev__typecheck`
- `mcp__dev__unit_test`
- `mcp__dev__integration_test`
- `mcp__dev__start_preview`
- `mcp__dev__stop_preview`
- `mcp__dev__inspect_port`
- `mcp__qa__request_review`
- `mcp__qa__get_latest_bundle`
- `mcp__browser__inspect`
- `mcp__browser__screenshot`
- `mcp__browser__extract`
- `mcp__observe__get_runtime_health`
- `mcp__observe__get_recent_errors`
- `mcp__observe__get_trace`
- `mcp__research__search_web`
- `mcp__research__fetch_url`
- `mcp__artifacts__list`
- `mcp__artifacts__open`

Disallowed tools:

- raw `Bash`
- direct cloud provider tools
- direct secrets tools
- direct founder mail tools
- direct billing/payment tools
- direct SQL tools

### 10.2 Release lane

Recommended SDK configuration:

- `permissionMode: "default"`
- explicit `allowedTools`
- production deploy tools guarded by workflow checks and approvals

Allowed tools:

- all read-only tools above
- `mcp__repo__status`
- `mcp__repo__diff`
- `mcp__dev__lint`
- `mcp__dev__typecheck`
- `mcp__dev__unit_test`
- `mcp__dev__integration_test`
- `mcp__dev__e2e_test`
- `mcp__qa__request_final_review`
- `mcp__qa__get_latest_bundle`
- `mcp__deploy__create_preview`
- `mcp__deploy__get_status`
- `mcp__deploy__promote_release`
- `mcp__deploy__rollback_release`
- `mcp__org__record_execution_note`
- `mcp__org__send_messages`

Extra release guardrails:

- `deploy.promote_release` only if final QA pass exists
- `deploy.rollback_release` always allowed if an active release is unhealthy
- any irreversible migration or spend increase should create a CEO escalation, not self-execute

## 11. Internal MCP servers

The CTO should use a few coherent MCP servers, not a pile of one-off tools.

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

- the CTO should escalate to the CEO, not directly to the founder

### 11.2 `repo` MCP

Purpose:

- safe repository checkpoints and diff inspection

Recommended methods:

- `status()`
- `diff(target?)`
- `log(limit?)`
- `checkpoint(label, paths?)`
- `restore_checkpoint(id)`
- `show_file_history(path, limit?)`

Implementation note:

- back this with local Git in the company workspace
- remote GitHub sync can be phase 2

### 11.3 `dev` MCP

Purpose:

- reliable local engineering execution without raw shell

Recommended methods:

- `install(packageManager?)`
- `lint()`
- `typecheck()`
- `unit_test(filters?)`
- `integration_test(filters?)`
- `e2e_test(filters?)`
- `start_preview(entrypoint?)`
- `stop_preview(previewId?)`
- `inspect_port(port)`
- `collect_coverage()`
- `run_known_script(name, args?)`

Implementation note:

- if the CTO repeatedly needs an unsupported command, add a new structured tool
- do not solve missing capabilities by enabling unrestricted shell

### 11.4 `qa` MCP

Purpose:

- structured quality gates and evidence handling

Recommended methods:

- `request_component_review(taskId, ownerId, evidence?)`
- `request_final_review(releaseId, manifest)`
- `get_review_status(taskIdOrReleaseId)`
- `get_latest_bundle(taskIdOrReleaseId)`
- `attach_result(taskIdOrReleaseId, result)`
- `get_trace_links(taskIdOrReleaseId)`

Implementation note:

- Playwright traces, screenshots, and test logs should be stored in R2
- QA bundles should be linkable in dashboard and CEO summaries

### 11.5 `deploy` MCP

Purpose:

- preview creation, promotion, rollback, and release status

Recommended methods:

- `create_preview(releaseId, target)`
- `get_preview_url(releaseId)`
- `get_status(releaseId)`
- `promote_release(releaseId, strategy?)`
- `rollback_release(releaseIdOrVersionId)`

Implementation note:

- use Cloudflare Pages preview deployments for front-end style previews
- use Cloudflare Workers versions/deployments for Worker services
- use Cloudflare Workflows under the hood for long-running deploy sequences, retries, and waits

### 11.6 `observe` MCP

Purpose:

- runtime, release, and production health

Recommended methods:

- `get_runtime_health(service?)`
- `get_recent_errors(service?, window?)`
- `get_trace(traceId)`
- `get_deploy_health(releaseId)`
- `get_web_vitals(url)`
- `get_release_regressions(releaseId, baselineReleaseId?)`

Implementation note:

- infrastructure truth should come from Cloudflare
- app errors and traces should come from Sentry

### 11.7 `browser` MCP

Purpose:

- deterministic product inspection and validation

Recommended methods:

- `open(url, context?)`
- `inspect(url, instructions)`
- `screenshot(url, selector?)`
- `extract(url, schema, selector?)`

Implementation note:

- reuse the existing Browserbase integration already in the repo
- use Contexts only when a logged-in session is required

## 12. Provisioning-time CTO workflow

Immediately after company provisioning:

1. read:
   - `/workspace/docs/goal.md`
   - `/workspace/docs/execution-contract.json`
   - `/workspace/docs/plan.md`
   - `/workspace/.agent/OPERATING_SYSTEM.md`
2. create or update `/workspace/docs/architecture.md`
3. create `/workspace/docs/technical-plan.md`
4. identify the minimum founder-impressive build slice
5. decompose the product into non-overlapping tasks
6. assign engineering tasks with:
   - owner
   - acceptance criteria
   - expected artifact paths
   - required tests
   - handoff target
7. set up a preview workflow immediately
8. ensure the first preview is something the CEO can show quickly

The CTO's day-zero goal is not "perfect architecture."

It is:

- one coherent architecture
- one coherent task graph
- one fast founder-visible product win

## 13. Standard delivery workflow

### 13.1 CEO -> CTO

The CEO gives the CTO:

- product objective
- business constraint
- priority
- expected founder-visible milestone

The CTO turns that into:

- architecture update
- engineering slices
- release plan

### 13.2 CTO -> engineers

Every delegated task must include:

- exact scope
- exact owner
- explicit non-goals
- acceptance criteria
- required tests
- expected file/artifact paths
- handoff target

Suggested task assignment payload:

```json
{
  "to": "frontend-dev",
  "type": "task",
  "subject": "Build landing page hero and pricing blocks",
  "body": "Implement the founder-facing landing page shell using the current execution contract and architecture doc.",
  "priority": "high",
  "metadata": {
    "taskId": "task_lp_hero_01",
    "taskTitle": "Build landing page hero and pricing blocks",
    "workflowStage": "assigned",
    "acceptanceCriteria": [
      "Responsive on mobile and desktop",
      "Hero, proof, CTA, and pricing are implemented",
      "No layout regressions in preview"
    ],
    "expectedArtifacts": [
      "/workspace/src/app/page.tsx"
    ],
    "requiredChecks": [
      "lint",
      "typecheck",
      "e2e:landing-page"
    ],
    "handoffTarget": "qa-tester"
  }
}
```

### 13.3 Engineers -> QA

When an engineer finishes:

- they do not mark the task done
- they request QA review with evidence
- the workflow moves to `qa_review_request`

### 13.4 QA -> engineer

If QA fails:

- workflow moves to `qa_failed`
- the same engineer gets the task back with exact failure evidence
- the task remains active until fixed and resubmitted

### 13.5 QA -> CTO

If QA passes the component:

- workflow moves to `qa_passed`
- the task returns to the CTO for integration

### 13.6 CTO -> QA final review

Once the CTO integrates passed pieces:

- create or update `release-manifest.json`
- run integration tests
- create preview
- request final QA using `final_qa_review_request`

### 13.7 QA -> CEO

If final QA passes:

- workflow moves to `release_passed`
- the CTO sends a product handoff/report to the CEO with:
  - preview URL
  - passed checks
  - artifacts
  - known limitations

If final QA fails:

- workflow moves to `release_failed`
- the task or release candidate goes back to the CTO

## 14. Hiring policy

The CTO should hire only when one of these is true:

- at least two engineering tasks are blocked by missing engineering capacity
- queue pressure persists across at least two CTO cycles
- required expertise is genuinely missing from the founding team
- QA is consistently becoming the bottleneck and an additional QA role is justified

Default hire pool for the CTO:

- `frontend-dev`
- `backend-dev`
- `fullstack-dev`
- `devops`
- `qa-tester`

Suggested hire schema:

```json
{
  "blueprintId": "fullstack-dev",
  "reportsTo": "cto",
  "reason": "Two product-critical engineering tasks are queued and neither can be absorbed without delaying the release milestone.",
  "expectedImpact": "Own authenticated dashboard implementation and preview hardening this week.",
  "priority": "high",
  "first24hTasks": [
    "Implement dashboard shell",
    "Connect preview auth flow",
    "Hand off to QA"
  ]
}
```

The CTO should not hire because "more hands might help."

It should hire only when the task graph justifies it.

## 15. Reliability controls

### 15.1 Hard controls

- no `bypassPermissions`
- no raw SQL
- no unrestricted shell
- no direct secrets access
- no direct founder mail
- no direct unreviewed production deploys

### 15.2 State consistency

- one active implementation task per engineer in founder-visible state
- one active integration task for the CTO in founder-visible state
- every mutation requires an idempotency key
- every workflow transition is validated
- every release candidate must point to a manifest and evidence bundle

### 15.3 Session hygiene

- integration and delivery lanes may persist session state
- every turn still reloads live workflow/task/deploy state
- session memory is always lower priority than coordinator and workflow state

### 15.4 Workflow enforcement

Enforce these transitions in the coordinator:

- CEO -> CTO assignment
- CTO -> engineer assignment
- engineer -> QA review request
- QA -> engineer failure loop
- QA -> CTO component pass
- CTO -> QA final review
- QA -> CEO final pass
- CTO -> CEO escalation for architectural risk or release risk

### 15.5 Visibility

Every CTO turn should persist:

- current primary task id
- current release candidate id, if any
- current active engineer owners
- latest safe execution note
- last command/test summary
- failing test names, if any
- current preview or deploy status, if relevant

Do not expose raw chain of thought.

Instead, expose safe progress notes such as:

- "Running typecheck on dashboard routes"
- "Fixing QA-reported mobile CTA overlap"
- "Waiting on final QA for release rel_2026_03_08_001"
- "Preview deployed, validating checkout flow in Browserbase"

## 16. What to borrow from `everything-claude-code`

Use it as a pattern source, not as a dependency.

Worth adopting:

- explicit skills for repeated engineering workflows
- hook-driven summaries at session boundaries
- context compaction discipline
- evals for regression testing the CTO prompt/tool contract
- clear distinction between planning and execution

Not worth copying wholesale:

- a giant generic harness
- broad plugin surface before tool contracts are stable
- role behavior hidden in a large third-party ruleset

For this codebase, the right move is:

- small local CTO skills
- explicit MCP surfaces
- explicit workflow contracts
- first-party engineering evals we control

## 17. Why Relay should not be the CTO's primary coordination bus

Relay remains useful for future heterogeneous-agent collaboration.

But it should not be the CTO's primary bus in v1.

Reason:

- the CTO's main job is not conversation
- it is structured delegation, integration, QA gating, and release control
- freeform chat is a weak source of truth for engineering workflow state
- the current system needs strong sequencing and audit more than it needs live chatter

Recommended position:

- primary bus: internal structured coordination through the local coordinator + D1 mirror
- optional future transport: Relay for real-time cross-driver collaboration sessions

Relay becomes more valuable later when:

- Codex engineers or OpenClaw specialists join the system
- pair-debug or swarm-style live collaboration is needed
- the structured workflow engine is already stable

## 18. Implementation phases

### Phase 1: CTO control plane

- add a local `CompanyCoordinator` service inside the supervisor VM
- keep the CTO on Opus 4.6
- remove `bypassPermissions`
- add `repo`, `dev`, `qa`, `deploy`, and `observe` MCP servers
- keep `org` as the single mutation surface for tasks and workflows
- define the release manifest contract

### Phase 2: workflow enforcement

- validate all CTO workflow transitions in the coordinator
- enforce one active implementation task per engineer
- enforce one active integration task for the CTO
- require QA evidence before a pass is accepted

### Phase 3: release reliability

- back release pipelines with Cloudflare Workflows
- add durable preview creation, promote, rollback, and retry logic
- add R2-backed evidence bundles for each candidate release

### Phase 4: visibility and evals

- stream safe progress events into founder UI
- show task-level execution notes and QA/deploy progress
- add evals for architecture drift, bad delegation, missed QA loop, and unsafe promotion

### Phase 5: multi-provider portability

- keep the same tool plane
- add provider drivers for Codex or other coding agents
- optionally add Relay for live cross-agent collaboration

## 19. Recommended final stack

If I were implementing the CTO next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Durable QA/release artifacts: Cloudflare R2
- Browser automation: Browserbase + Playwright + Browserbase Contexts
- Web research: Brave Search API + internal fetch
- Preview and release orchestration: Cloudflare Pages / Workers + Cloudflare Workflows
- Observability: Cloudflare platform metrics/logs plus Sentry for app traces, exceptions, and AI telemetry
- Repository checkpoints: local Git via internal MCP
- Build/test execution: internal local runner MCP over the company workspace

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the CTO, without letting it become an unbounded shell with cloud credentials.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic models overview / Claude 4.6: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- Anthropic Agent SDK agent loop: [platform.claude.com/docs/en/agent-sdk/agent-loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- Anthropic Agent SDK skills/plugins: [platform.claude.com/docs/en/agent-sdk/skills](https://platform.claude.com/docs/en/agent-sdk/skills), [platform.claude.com/docs/en/agent-sdk/plugins](https://platform.claude.com/docs/en/agent-sdk/plugins)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare Workflows overview and events: [developers.cloudflare.com/workflows](https://developers.cloudflare.com/workflows/), [developers.cloudflare.com/workflows/build/events-and-parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/)
- Cloudflare Pages preview deployments: [developers.cloudflare.com/pages/configuration/preview-deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
- Cloudflare Workers versions, deployments, and rollbacks: [developers.cloudflare.com/workers/configuration/versions-and-deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/), [developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
- Cloudflare R2 overview and durability: [developers.cloudflare.com/r2](https://developers.cloudflare.com/r2/), [developers.cloudflare.com/r2/reference/durability](https://developers.cloudflare.com/r2/reference/durability/)
- Browserbase docs, contexts, and session recording: [docs.browserbase.com/introduction](https://docs.browserbase.com/introduction), [docs.browserbase.com/features/contexts](https://docs.browserbase.com/features/contexts), [docs.browserbase.com/features/session-replay](https://docs.browserbase.com/features/session-replay)
- Brave Search API: [brave.com/search/api](https://brave.com/search/api/)
- Sentry Cloudflare AI monitoring and Anthropic instrumentation: [docs.sentry.io/platforms/javascript/guides/cloudflare/tracing/instrumentation/ai-agents-module](https://docs.sentry.io/platforms/javascript/guides/cloudflare/tracing/instrumentation/ai-agents-module/), [docs.sentry.io/platforms/javascript/guides/express/configuration/integrations/anthropic](https://docs.sentry.io/platforms/javascript/guides/express/configuration/integrations/anthropic/)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
