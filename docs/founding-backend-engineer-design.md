# Founding Backend Engineer Design

Status: proposal only  
Date: 2026-03-08  
Scope: founding backend engineer design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build a founding backend engineer agent that is:

- the owner of backend implementation within its assigned scope
- capable of turning CTO requirements into real APIs, services, data models, background jobs, and integrations
- able to produce production-grade backend behavior early, not fake scaffolding
- reliable enough to operate autonomously without corrupting state or inventing architecture
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

This agent is not just "the API guy." It is the implementation owner for:

- request handlers and service logic
- persistence and data modeling
- background jobs and async workflows
- webhooks and third-party integrations
- auth-adjacent backend flows
- backend reliability within the current task scope

Its job is to make the product actually work behind the UI.

## 2. Non-goals

The founding backend engineer should not:

- replace the CTO as architecture owner
- replace the API Specialist for key procurement or account creation
- replace the frontend engineer for user-facing UI
- replace QA as the release gate
- invent product scope or business logic beyond the execution contract
- rely on markdown plans as proof of progress
- mutate production data through raw console-style access
- use raw shell, raw SQL, or ad hoc cloud dashboards as its primary workflow

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- shared filesystem plus structured tasks, messages, approvals, and workflows

This design changes the backend-agent implementation, not the overall product architecture.

The most important existing weaknesses this design must eliminate:

- backend tasks that appear active without a clear artifact or service result
- data and API work living only in prose or partially-written files
- architecture drift between the CTO plan and actual backend implementation
- no durable structure for migrations, jobs, and webhooks
- weak visibility into which backend work is running, blocked, or deployed
- overpowered tool access without strong state and mutation controls

## 4. Operating position in the org

### 4.1 Chain of command

The founding backend engineer reports to the CTO.

It takes input from:

- CTO for technical scope, acceptance criteria, and handoff target
- frontend engineer indirectly through integration requirements
- API Specialist indirectly when credentials or service setup are required

It owns:

- implementation of the backend scope assigned to it
- API routes and service logic
- database models, queries, and migrations within task scope
- queue consumers and async job handlers
- webhook consumers and replay-safe processing
- testable backend artifacts

It does not own:

- the overall architecture
- production release approval
- founder communication
- key procurement

### 4.2 What "done" means

From the founding backend engineer's point of view, work is only done when:

1. the assigned backend path exists in code
2. request/response contracts are explicit
3. persistence or async logic is real, not mocked
4. required tests pass
5. observable signals exist for runtime behavior
6. the work is handed to QA with evidence

Nothing short of that should become founder-visible "backend progress."

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- This role needs strong coding reliability across data modeling, concurrency, async processing, contracts, and debugging.
- A backend mistake is often silent until it corrupts state or causes cascading failures. Reliability matters more than raw speed.

Recommendation:

- keep the founding backend engineer on Opus 4.6 in v1
- later, low-risk maintenance or narrow bugfix lanes can move to cheaper models if needed
- keep migrations, core services, and async workflows on Opus

Implementation requirement:

- do not run this agent in `bypassPermissions`
- use explicit `allowedTools`
- use `Skill` with local backend/reliability skills enabled
- make contract validation, migration discipline, and runtime checks part of the normal loop

### 5.2 Driver abstraction

Use the same provider-neutral driver abstraction proposed for the CEO, CTO, CMO, and frontend engineer.

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

The tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

The backend engineer must not mutate D1 directly.

Use the same per-company `CompanyCoordinator` service running on the supervisor VM as the serialized mutation layer, with local SQLite as hot state and D1 as the historical mirror.

Why:

- backend work depends on reliable task, workflow, and execution-note state
- queue, webhook, migration, and data-repair actions must be serialized and auditable
- the system already needs stronger structured mutation controls, not more direct writes

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - live task ownership
  - workflow stage
  - active execution note
  - hot coordination state
  - idempotency keys
- D1:
  - queryable task history
  - workflow history
  - agent message history
  - founder-visible execution summaries
- workspace:
  - source code
  - schema definitions
  - migrations
  - fixtures
  - local test reports
  - generated OpenAPI artifacts
- R2:
  - exported seed data
  - API traces and request/response fixtures
  - replay bundles
  - evidence bundles for QA

### 6.3 Source-of-truth order

The backend engineer must treat state in this order:

1. coordinator live state
2. current task workflow record
3. D1 mirrored state
4. execution contract and architecture
5. API contract and data-model files
6. session memory

Session memory is never authoritative.

## 7. Backend lanes

The founding backend engineer should not be one monolithic session. It should operate in distinct lanes.

### 7.1 API build lane

Purpose:

- implement request handlers and service logic
- establish request/response contracts
- connect business logic to persistence

Properties:

- autonomous
- code-writing allowed
- contract-first
- every turn must materially improve a real backend artifact

### 7.2 Data and migrations lane

Purpose:

- model data
- create migrations
- evolve schema safely
- validate query behavior and indexes

Properties:

- autonomous
- migration-heavy
- should prefer reversible or well-documented forward-only changes
- must not use raw ad hoc SQL as the default editing workflow

### 7.3 Async jobs and webhooks lane

Purpose:

- implement queue consumers
- implement replay-safe webhook handlers
- process off-request work safely

Properties:

- autonomous
- idempotency-heavy
- must surface retry and DLQ behavior

### 7.4 Hardening and incident lane

Purpose:

- inspect runtime failures
- fix broken data flows
- repair reliability regressions
- improve tracing and observability

Properties:

- autonomous
- mostly read-heavy until a fix is clear
- must keep fixes narrow and evidence-backed

## 8. Files and contracts the backend engineer owns

Required files:

- backend implementation files under `/workspace/src/`
- `/workspace/docs/api/openapi.yaml`
- `/workspace/docs/data-model.md`
- `/workspace/docs/backend-service-map.json`
- `/workspace/docs/backend-ops-runbook.md`
- `/workspace/docs/webhook-contracts.md`

The CTO remains authoritative for:

- `/workspace/docs/architecture.md`
- task decomposition and technical constraints

The backend engineer should translate those constraints into real services.

### 8.1 Proposed `backend-service-map.json`

This should be the backend implementation contract for services, data stores, and async flows.

Suggested schema:

```json
{
  "surface": "core_product_api",
  "runtime": "cloudflare-workers",
  "httpFramework": "hono",
  "schemaValidation": "zod",
  "database": {
    "primary": "d1",
    "orm": "drizzle",
    "hotState": "durable-objects"
  },
  "blobStorage": "r2",
  "async": {
    "queueProvider": "cloudflare-queues",
    "dlqEnabled": true
  },
  "auth": {
    "provider": "clerk",
    "mode": "hosted"
  },
  "observability": {
    "errors": "sentry",
    "platform": "cloudflare"
  },
  "endpoints": [
    {
      "name": "createLead",
      "route": "POST /api/leads",
      "owner": "backend-dev",
      "storage": ["d1"],
      "queueEmits": ["lead-followup"],
      "webhookConsumers": []
    }
  ]
}
```

## 9. Default backend stack recommendation

This agent needs a default implementation stack that is opinionated enough to move fast but flexible enough to avoid obvious dead ends.

### 9.1 Default stack for v1 products

Prefer this stack by default:

- runtime: Cloudflare Workers
- HTTP framework: Hono
- validation and contracts: Zod
- relational persistence: D1
- hot serialized product state: Durable Objects with SQLite
- ORM and migrations: Drizzle ORM + drizzle-kit
- blob storage: R2
- async jobs: Cloudflare Queues
- external relational DB bridge when needed: Hyperdrive
- auth when hosted auth is appropriate: Clerk
- observability: Sentry + Cloudflare platform signals
- API docs and mocking: OpenAPI + Scalar

This is the right default because it matches the current repo structure and preserves a coherent operating model.

### 9.2 Decision ladder

The backend engineer should not pick infrastructure randomly.

Use this decision ladder:

1. If the product fits Cloudflare-native primitives, stay fully Cloudflare-native.
2. Use D1 for launch-speed relational storage unless the CTO explicitly decides external Postgres is justified.
3. Use Durable Objects only for customer-facing product runtime coordination or strongly-serialized product state, not for inter-agent coordination and not as a generic relational store replacement.
4. Use Queues for deferred work and retries, not ad hoc cron-plus-table polling if real async delivery is needed.
5. Use Hyperdrive only when an external relational database is required.
6. Use Clerk when the product needs robust hosted auth fast; otherwise let the CTO decide if custom auth is worth it.

## 10. Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | Backend access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.send_message`, `org.record_execution_note` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable workflow state matching the current architecture | Full |
| Workspace code/docs | `Read`, `Glob`, `Grep`, `Edit`, `Write` | Claude Code built-in tools | Lowest-latency edits on the real shared workspace | Full |
| Repository state | `repo.status`, `repo.diff`, `repo.checkpoint`, `repo.restore_checkpoint`, `repo.log` | Internal MCP server over local Git CLI in the supervisor workspace | Reliable checkpoints and rollback of backend changes without assuming remote sync | Full |
| Local execution | `dev.install`, `dev.lint`, `dev.typecheck`, `dev.unit_test`, `dev.integration_test`, `dev.start_preview`, `dev.stop_preview`, `dev.inspect_port` | Internal MCP server over the local company runtime | Fastest and most accurate way to validate the real backend in its actual workspace | Full |
| API contracts and HTTP testing | `api.generate_openapi`, `api.validate_contract`, `api.mock_from_openapi`, `api.smoke_request`, `api.replay_fixture` | Internal MCP server over Hono/Zod/OpenAPI plus Scalar mock/docs tooling | Keeps the API contract explicit, testable, and docs-ready | Full |
| Data modeling and migrations | `db.plan_migration`, `db.apply_local_migration`, `db.explain_query`, `db.seed_fixture`, `db.inspect_schema`, `db.snapshot_state` | Internal MCP server over Drizzle ORM / drizzle-kit, D1 bindings, product-runtime Durable Objects where relevant, and Hyperdrive where needed | Strong typed schema workflow and safe migration discipline across the current stack | Full |
| Async jobs | `queue.publish`, `queue.inspect`, `queue.replay`, `queue.get_dlq`, `queue.pause_consumer` | Internal MCP server over Cloudflare Queues | Guaranteed delivery, batching, retries, delays, and DLQs align with reliable backend automation | Full |
| Blob/object storage | `storage.put_blob`, `storage.get_blob`, `storage.list_prefix`, `storage.create_signed_url` | Internal MCP server over Cloudflare R2 | Native fit for artifact and object storage in the existing Cloudflare stack | Full |
| Auth and identity | `auth.inspect_session`, `auth.verify_webhook`, `auth.lookup_user`, `auth.replay_auth_event` | Internal MCP server over Clerk backend-only SDK plus webhook verification helpers | Fast reliable hosted auth path for app products without forcing custom auth from day one | Read-heavy / integration-focused |
| Observability | `observe.get_runtime_health`, `observe.get_recent_errors`, `observe.get_trace`, `observe.get_queue_health`, `observe.get_webhook_failures` | Internal MCP server over Cloudflare platform signals + Sentry | Cloudflare is the platform truth; Sentry is stronger for exceptions, traces, and debugging | Read-only |
| Browser inspection | `browser.open`, `browser.inspect`, `browser.screenshot` | Browserbase + Playwright | Useful for OAuth, callback, cookie, or webhook-console validation when API-only debugging is insufficient | Limited |

## 11. Provider notes

### 11.1 HTTP framework

Use Hono by default for Worker-based backend services.

Reason:

- native fit for Cloudflare Workers
- Web Standards-first
- typed environment and route handling
- simple enough for an autonomous agent to reason about

### 11.2 Contracts and validation

Use Zod as the schema and validation layer.

Reason:

- TypeScript-first
- strong runtime validation
- good fit for request, response, config, webhook, and queue payload contracts
- easy path to OpenAPI generation and schema reuse

### 11.3 ORM and migrations

Use Drizzle ORM plus drizzle-kit as the default relational modeling layer.

Reason:

- strong support for D1
- typed schema and query ergonomics
- migration workflow that an agent can reason about more safely than raw SQL scattered across files

### 11.4 Primary database

Use D1 as the default relational store.

Reason:

- native to Workers
- built-in Time Travel
- strong fit for launch-speed products and per-entity/per-tenant patterns
- lower operational burden than managing a separate database on day zero

Do not use D1 for every coordination problem.

Use Durable Objects only when the product being built needs serialized and hot runtime state.

### 11.5 Hot serialized state

Use SQLite-backed Durable Objects for product-runtime concerns like:

- counters
- per-room/per-entity coordination
- strongly-serialized workflows
- hot write-heavy or coordination-heavy state

Do not treat Durable Objects as the general relational database for everything, and do not use them as the agent coordination backend in this system.

### 11.6 External relational fallback

Use Hyperdrive only when the CTO explicitly decides that external Postgres/MySQL is required.

Reason:

- it accelerates and pools access from Workers to an external database
- it should be a deliberate choice, not the default

### 11.7 Async jobs

Use Cloudflare Queues by default.

Reason:

- guaranteed delivery
- batching, retries, delays
- dead-letter queues
- strong fit for webhook follow-up, background indexing, emails, and async side effects

### 11.8 Auth

Use Clerk as the default hosted auth provider when the product needs user auth quickly.

Reason:

- current repo already uses Clerk in the platform
- backend-only SDK supports Workers / isolates
- hosted auth reduces avoidable auth implementation risk at the start

The backend engineer should integrate auth through an internal `auth` MCP and adapter layer, not hard-code product logic directly to one provider everywhere.

### 11.9 API docs and mocking

Use OpenAPI as the required API contract and Scalar for docs and mocking workflows.

Reason:

- the backend agent needs a machine- and human-readable contract
- mock generation and documentation improve coordination with frontend and QA
- Scalar gives docs and mock-server workflows without the backend agent inventing ad hoc documentation

### 11.10 Observability

Use both:

- Cloudflare for platform/runtime truth
- Sentry for application errors, traces, and AI/tool telemetry

This split is more reliable than trying to force one system to cover everything.

## 12. Exact permission profile

### 12.1 API build and data lanes

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
- `mcp__org__get_tasks`
- `mcp__org__send_messages`
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
- `mcp__api__generate_openapi`
- `mcp__api__validate_contract`
- `mcp__api__mock_from_openapi`
- `mcp__api__smoke_request`
- `mcp__api__replay_fixture`
- `mcp__db__plan_migration`
- `mcp__db__apply_local_migration`
- `mcp__db__explain_query`
- `mcp__db__seed_fixture`
- `mcp__db__inspect_schema`
- `mcp__db__snapshot_state`
- `mcp__queue__inspect`
- `mcp__queue__publish`
- `mcp__storage__put_blob`
- `mcp__storage__get_blob`
- `mcp__auth__inspect_session`
- `mcp__auth__verify_webhook`
- `mcp__observe__get_runtime_health`
- `mcp__observe__get_recent_errors`
- `mcp__observe__get_trace`
- `mcp__observe__get_queue_health`
- `mcp__observe__get_webhook_failures`

Disallowed tools:

- raw `Bash`
- direct cloud dashboard mutation tools
- direct secrets tools
- direct founder email tools
- direct SQL console tools

### 12.2 Webhook and async hardening lane

Recommended SDK configuration:

- `permissionMode: "default"`
- explicit `allowedTools`

Allowed tools:

- all read/test tools above
- `mcp__queue__publish`
- `mcp__queue__inspect`
- `mcp__queue__replay`
- `mcp__queue__get_dlq`
- `mcp__queue__pause_consumer`
- `mcp__api__smoke_request`
- `mcp__api__replay_fixture`
- `mcp__auth__replay_auth_event`
- `mcp__observe__get_queue_health`
- `mcp__observe__get_webhook_failures`
- `mcp__browser__open`
- `mcp__browser__inspect`
- `mcp__browser__screenshot`

Extra guardrails:

- no consumer should be marked healthy without retry and DLQ visibility
- no webhook handler should be considered complete without signature verification and replay safety

## 13. Internal MCP servers

### 13.1 `org` MCP

Purpose:

- internal company control-plane operations

Recommended methods:

- `get_live_state(companyId)`
- `get_tasks(companyId, filters?)`
- `send_messages(companyId, messages[])`
- `record_execution_note(companyId, note)`
- `escalate_to_cto(companyId, escalation)`

Important:

- the backend engineer should escalate to the CTO, not the founder

### 13.2 `repo` MCP

Purpose:

- safe checkpoints and diff inspection for backend work

Recommended methods:

- `status()`
- `diff(target?)`
- `log(limit?)`
- `checkpoint(label, paths?)`
- `restore_checkpoint(id)`

### 13.3 `dev` MCP

Purpose:

- reliable local engineering execution without raw shell

Recommended methods:

- `install(packageManager?)`
- `lint()`
- `typecheck()`
- `unit_test(filters?)`
- `integration_test(filters?)`
- `start_preview(entrypoint?)`
- `stop_preview(previewId?)`
- `inspect_port(port)`
- `run_known_script(name, args?)`

### 13.4 `api` MCP

Purpose:

- explicit API contract generation and request testing

Recommended methods:

- `generate_openapi()`
- `validate_contract()`
- `mock_from_openapi()`
- `smoke_request(requestSpec)`
- `replay_fixture(nameOrId)`
- `assert_response(schemaName, response)`

Implementation note:

- OpenAPI should be required for founder-facing or integration-facing APIs
- Scalar can be used for docs and mocks, but the source of truth stays in the repo

### 13.5 `db` MCP

Purpose:

- safe schema, migration, query, and snapshot workflows

Recommended methods:

- `plan_migration(changeRequest)`
- `apply_local_migration(name)`
- `inspect_schema(target?)`
- `explain_query(sqlOrBuilder)`
- `seed_fixture(name, data?)`
- `snapshot_state(label?)`
- `restore_local_snapshot(id)`

Implementation note:

- back this with Drizzle and the relevant Cloudflare bindings
- raw SQL should remain an implementation detail inside the MCP when needed

### 13.6 `queue` MCP

Purpose:

- inspect and control async job behavior safely

Recommended methods:

- `publish(queueName, payload, options?)`
- `inspect(queueName, filters?)`
- `replay(messageIdOrBatchId)`
- `get_dlq(queueName)`
- `pause_consumer(queueName)`

### 13.7 `storage` MCP

Purpose:

- object and binary payload management

Recommended methods:

- `put_blob(key, body, metadata?)`
- `get_blob(key)`
- `list_prefix(prefix)`
- `create_signed_url(key, options?)`

### 13.8 `auth` MCP

Purpose:

- auth and identity integration work without forcing raw provider SDK logic into every turn

Recommended methods:

- `inspect_session(tokenOrCookie)`
- `verify_webhook(headers, body)`
- `lookup_user(userIdOrEmail)`
- `replay_auth_event(eventId)`

### 13.9 `observe` MCP

Purpose:

- runtime and reliability inspection

Recommended methods:

- `get_runtime_health(service?)`
- `get_recent_errors(service?, window?)`
- `get_trace(traceId)`
- `get_queue_health(queueName?)`
- `get_webhook_failures(window?)`
- `get_release_regressions(releaseId?)`

### 13.10 `browser` MCP

Purpose:

- limited real-browser inspection when backend behavior interacts with browser state

Recommended methods:

- `open(url, context?)`
- `inspect(url, instructions)`
- `screenshot(url, selector?)`

Implementation note:

- use only when API-only tools are insufficient, such as OAuth or cookie/callback debugging

## 14. Provisioning-time workflow

Immediately after company provisioning:

1. read:
   - `/workspace/docs/goal.md`
   - `/workspace/docs/execution-contract.json`
   - `/workspace/docs/architecture.md` if present
   - `/workspace/.agent/OPERATING_SYSTEM.md`
2. inspect the CTO task and identify the minimum real backend slice
3. create or update:
   - `/workspace/docs/api/openapi.yaml`
   - `/workspace/docs/data-model.md`
   - `/workspace/docs/backend-service-map.json`
   - `/workspace/docs/backend-ops-runbook.md`
4. implement the first real service path
5. define the first data model and migration path if storage is needed
6. wire observability into the service path
7. produce testable backend evidence for QA

The day-zero goal is not a huge backend framework.

It is:

- one real service path
- one explicit contract
- one real persistence path if needed
- one observable backend slice

## 15. Standard workflow

### 15.1 CTO -> backend engineer

The CTO gives:

- scope
- constraints
- acceptance criteria
- required artifact path
- handoff target

### 15.2 Backend engineer implementation

The backend engineer must:

- define the contract
- implement the service
- wire persistence
- add the async side effects if needed
- validate through automated tests
- inspect runtime behavior
- hand off to QA with evidence

### 15.3 Backend engineer -> QA

When ready, hand off with:

- task id
- endpoint or service paths
- test results
- request/response fixtures
- migration notes if relevant
- known limitations

### 15.4 QA -> backend engineer

If QA fails the work:

- the task loops back with exact issues
- the backend engineer fixes the relevant issues and resubmits

## 16. Reliability controls

### 16.1 Hard controls

- no `bypassPermissions`
- no raw SQL
- no unrestricted shell
- no direct cloud deploy access
- no direct founder messaging
- no production-destructive mutation without a controlled tool path

### 16.2 State consistency

- one active backend implementation task per agent in founder-visible state
- every contract-bearing endpoint should have an explicit schema
- every queue consumer should be idempotent
- every webhook should be replay-safe
- every migration should be planned and recorded
- every mutation requires an idempotency key

### 16.3 Session hygiene

- API and hardening lanes may persist sessions
- every turn still reloads live task state, contracts, and runtime signals
- session memory is always lower priority than coordinator and file state

### 16.4 Runtime enforcement

The backend engineer should not rely on prompt discipline alone.

Enforce these checks:

- no queue consumer without retry and DLQ visibility
- no webhook handler without signature verification
- no API handoff without contract validation
- no persistence-heavy change without schema/migration record
- no QA handoff without a test result bundle

### 16.5 Visibility

Every backend turn should persist:

- current primary task id
- current service or endpoint being worked on
- current safe execution note
- latest test bundle id
- latest migration id if any
- latest queue or webhook health summary if relevant

Do not expose raw chain of thought.

Instead, expose safe progress notes such as:

- "Implementing `POST /api/leads` validation and persistence"
- "Adding idempotency guard to webhook consumer"
- "Reworking D1 schema and local migration after QA found duplicate rows"
- "Inspecting DLQ messages for failed follow-up jobs"

## 17. What to borrow from current ecosystem patterns

The strongest pattern for reliable backend agent work is:

- contract-first
- schema-first
- migration-first
- observability-first
- async jobs through durable queue semantics, not ad hoc timers and flags

The backend engineer should explicitly borrow:

- Cloudflare-native primitives where the product fits them
- Hono's Web Standards-first approach
- Zod-first validation
- Drizzle's typed schema and D1 support
- OpenAPI-first coordination with frontend and QA
- replay and inspection discipline for webhooks and async jobs

The agent should not treat "a route file exists" as proof that the backend works.

## 18. Why Relay should not be the primary backend bus

Relay may become useful later for heterogeneous-agent collaboration.

But it should not be the founding backend engineer's primary bus in v1.

Reason:

- this role needs structured tasks, contracts, migrations, traces, and evidence bundles
- freeform chat is weak as the source of truth for backend correctness
- the system needs stronger workflow and runtime signals more than faster chatter

Recommended position:

- primary bus: internal structured coordination through the local coordinator + D1 mirror
- optional future transport: Relay for live debugging sessions once the structured workflow layer is stable

## 19. Implementation phases

### Phase 1: backend control plane

- keep the agent on Opus 4.6
- remove `bypassPermissions`
- add `api`, `db`, `queue`, `storage`, `auth`, and `observe` MCP servers
- define `backend-service-map.json`, `data-model.md`, and OpenAPI contract workflow

### Phase 2: async and reliability discipline

- require idempotency on queues and webhooks
- require migration planning and snapshot support
- require explicit runtime signals before QA handoff

### Phase 3: integration maturity

- improve auth adapter support
- improve external-db path through Hyperdrive only when needed
- expand replay, fixture, and mock-server tooling

### Phase 4: visibility and evals

- stream safe execution notes into founder UI
- expose backend evidence bundles and service health summaries
- add evals for schema drift, missing idempotency, weak contract coverage, and silent failure modes

### Phase 5: multi-provider portability

- keep the same tool plane
- add provider drivers for Codex or other models later
- optionally add Relay for live collaboration

## 20. Recommended final stack

If I were implementing the founding backend engineer next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Backend runtime: Cloudflare Workers
- HTTP framework: Hono
- Validation: Zod
- ORM and migrations: Drizzle ORM + drizzle-kit
- Primary relational store: D1
- Hot serialized product state: Durable Objects
- Object storage: R2
- Async jobs: Cloudflare Queues
- External relational bridge when needed: Hyperdrive
- Auth adapter: Clerk by default when hosted auth is appropriate
- API docs and mocks: OpenAPI + Scalar
- Observability: Cloudflare platform signals + Sentry
- Limited browser debugging: Browserbase + Playwright

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the founding backend engineer, without turning it into an unbounded shell with raw database and cloud powers.

## 21. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK permissions: [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- Cloudflare D1 overview and Worker API: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/), [developers.cloudflare.com/d1/worker-api](https://developers.cloudflare.com/d1/worker-api/)
- Cloudflare D1 Time Travel: [developers.cloudflare.com/d1/reference/time-travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare Queues overview and configuration: [developers.cloudflare.com/queues](https://developers.cloudflare.com/queues/), [developers.cloudflare.com/queues/configuration/configure-queues](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- Cloudflare Hyperdrive: [developers.cloudflare.com/hyperdrive/get-started](https://developers.cloudflare.com/hyperdrive/get-started/)
- Cloudflare R2 overview: [developers.cloudflare.com/r2](https://developers.cloudflare.com/r2/)
- Hono on Cloudflare Workers and Web Standards: [hono.dev/docs/getting-started/cloudflare-workers](https://hono.dev/docs/getting-started/cloudflare-workers), [hono.dev/docs/concepts/web-standard](https://hono.dev/docs/concepts/web-standard)
- Zod: [zod.dev](https://zod.dev/)
- Drizzle ORM with D1: [orm.drizzle.team/docs/connect-cloudflare-d1](https://orm.drizzle.team/docs/connect-cloudflare-d1)
- Clerk backend-only SDK: [clerk.com/docs/guides/development/sdk-development/backend-only](https://clerk.com/docs/guides/development/sdk-development/backend-only)
- Scalar docs and mock server: [guides.scalar.com/scalar/scalar-docs](https://guides.scalar.com/scalar/scalar-docs), [guides.scalar.com/scalar/scalar-mock-server](https://guides.scalar.com/scalar/scalar-mock-server)
- Sentry Cloudflare and AI monitoring: [docs.sentry.io/platforms/javascript/guides/cloudflare/tracing/instrumentation/ai-agents-module](https://docs.sentry.io/platforms/javascript/guides/cloudflare/tracing/instrumentation/ai-agents-module/)
- Browserbase docs and contexts: [docs.browserbase.com/introduction](https://docs.browserbase.com/introduction), [docs.browserbase.com/features/contexts](https://docs.browserbase.com/features/contexts)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
