# API Key Provider Agent Design

Status: proposal only  
Date: 2026-03-08  
Scope: API Key Provider agent design, tool surface, provider selection, workflow contract, and reliability model. No implementation in this document.

## 1. Objective

Build an API Key Provider agent that is:

- the single owner of service-account creation, credential custody, and runtime secret distribution
- capable of helping any company agent obtain the external access it needs without leaking secrets into docs, chat, or code
- strict about approvals, billing, auditability, and least privilege
- reliable enough to automate common signup and credential workflows end to end
- portable enough that the same control plane can later support Claude, Codex, OpenClaw, or other agent drivers

The API Key Provider is not a generic "ops helper" or a note-taking specialist. It is the secure credential control plane for the company:

- it receives service and credential requests from other agents
- it decides whether an existing integration can be reused or a new account is needed
- it provisions accounts and API keys when allowed
- it stores secrets in the vault, not in workspace files
- it binds secret references into the correct runtime target
- it tracks renewal, rotation, and revocation state
- it escalates to the founder only when approvals, billing, identity verification, or human ownership are actually required

## 2. Non-goals

The API Key Provider should not:

- replace the CTO for deployment or runtime ownership
- replace the CMO for channel strategy or publishing
- replace Procurement for spend approval decisions
- talk directly to the founder except through structured approval or escalation flows
- store plaintext secrets in markdown, D1, chat history, or general task notes
- become a freeform browser agent that signs up for random services without policy
- make purchases automatically with raw card access
- solve phone verification, KYC, or high-friction vendor onboarding by improvising risky workarounds
- act as a generic agent-to-agent communication hub

## 3. Design constraints from the current system

This proposal keeps the current architecture:

- `dashboard` = founder UI
- `worker` = public and internal API layer
- `supervisor` = agent runtime
- one shared company workspace per company
- one standard founding team at provisioning
- structured tasks, messages, approvals, and workflows

This design changes the API Key Provider implementation, not the whole product architecture.

The most important existing weaknesses this design must eliminate:

- secrets or service instructions drifting into workspace docs
- account creation work happening without a durable, auditable workflow
- no real source of truth for service inventory versus actual secrets
- browser signup flows with weak observability and no replay
- no clean distinction between "need a secret", "need a service account", and "need founder approval"
- inability to safely distribute secrets to the correct runtime without exposing them broadly

## 4. API Key Provider operating position in the org

### 4.1 Chain of command

The API Key Provider reports to the CEO administratively, but operationally serves the whole company.

This is the right org model for v1:

- CEO owns escalation and founder-facing approvals
- CTO owns runtime and deploy targets
- CMO owns channel/account demand
- API Key Provider owns secure service access and credential custody

The API Key Provider serves:

- CTO and engineers for infrastructure, product, analytics, auth, and deployment integrations
- CMO and specialists for marketing, social, outreach, and analytics integrations
- QA for testing accounts and sandbox credentials
- CEO when a new strategic service or approval path is needed

The API Key Provider must not be bypassed when a new credential or service account is needed.

### 4.2 What "done" means

From the API Key Provider's point of view, a request is only done when:

1. the request is categorized correctly
2. the correct provider and account type are selected
3. any spend or risk approvals are collected
4. the account or key is actually created or a clear blocker is recorded
5. the credential is stored in the vault
6. the target runtime receives a secret reference or scoped binding
7. the requesting agent receives the non-secret usage contract it needs
8. rotation and ownership metadata are recorded
9. the whole workflow is auditable

Nothing short of that should show as completed.

## 5. Recommended runtime

### 5.1 Model and driver

Primary driver:

- Anthropic Claude Agent SDK / Claude Code SDK

Primary model:

- `claude-opus-4-6`

Why:

- This agent handles security-sensitive, policy-sensitive, and money-sensitive workflows.
- It has to reconcile provider docs, signup states, approval policy, runtime targets, and secret hygiene without taking shortcuts.
- Anthropic currently positions Opus 4.6 as its strongest model for agents and coding, and it is the safest default for high-risk automation in this stack.

Recommendation:

- keep the API Key Provider on Opus 4.6 in v1
- later split simple audit or inventory checks to Sonnet
- keep signup, vault writes, rotation decisions, and risky escalation logic on Opus

Implementation requirement:

- do not run this agent in `bypassPermissions`
- use explicit `allowedTools`
- prefer internal MCP tools over raw shell or raw browser control
- use adaptive thinking on high-risk turns

### 5.2 Driver abstraction

Use the same provider-neutral driver abstraction proposed for the CEO, CTO, and CMO.

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

The API Key Provider tool plane should remain stable even if the underlying model provider changes later.

## 6. Control-plane architecture

### 6.1 Core decision

Do not let the API Key Provider write secrets into D1 or the workspace.

Instead, use:

- a per-company `CompanyCoordinator` service running on the supervisor VM as the serialized workflow layer
- local SQLite as the hot coordination store for that service
- D1 as the historical mirror for founder-visible history and analytics
- a dedicated secrets vault as the source of truth for actual secret values

This is the correct split because credential workflows combine:

- hot coordination state
- founder-facing audit/history
- highly sensitive data that should not live in general app storage

### 6.2 Storage split

Recommended storage model:

- local coordinator SQLite:
  - live service requests
  - signup workflow state
  - pending verification state
  - runtime binding requests
  - active rotation jobs
  - idempotency keys
- D1:
  - historical request log
  - approval history
  - agent message history
  - founder-visible summaries
  - sanitized service inventory mirror
- Vault:
  - API keys
  - OAuth client credentials
  - service passwords
  - webhook secrets
  - TOTP seeds
  - rotation metadata
  - machine identities and access policies
- workspace:
  - sanitized service inventory
  - setup instructions
  - non-secret integration notes
  - secret reference names only
- R2:
  - signup evidence bundles
  - screenshots
  - session recordings references
  - audit exports

### 6.3 Source-of-truth order

The API Key Provider must treat state in this order:

1. coordinator live workflow state
2. vault state
3. provider console state or verification inbox state
4. D1 mirrored history
5. canonical ops docs in the workspace
6. session memory

Session memory is never authoritative.

## 7. API Key Provider lanes

This agent should not be one monolithic session. It should operate in distinct lanes.

### 7.1 Service triage lane

Purpose:

- read service requests from other agents
- classify the type of request
- decide whether the company already has what is needed
- decide whether the request needs signup, approval, rotation, or just runtime distribution

Properties:

- read-heavy
- no secret reveal by default
- can create approvals and workflow records
- can respond quickly to other agents

### 7.2 Signup and verification lane

Purpose:

- create accounts and app credentials on external services
- handle email verification
- handle dashboard navigation and settings changes
- record evidence and next steps

Properties:

- browser-enabled
- mail-enabled
- writes to the vault
- may create purchase requests
- must stop and escalate on CAPTCHA, SMS OTP, KYC, or ambiguous billing commitments

### 7.3 Secret custody and distribution lane

Purpose:

- store credentials in the vault
- create scoped secret references
- bind references into the correct runtime targets
- notify the requesting agent that the binding is ready

Properties:

- vault-heavy
- no open-web browsing
- no founder chat
- audit trail required for every write and every reveal

### 7.4 Rotation and hygiene lane

Purpose:

- monitor expiring or stale credentials
- rotate eligible secrets
- scan for leaked secrets
- revoke or quarantine compromised keys

Properties:

- scheduled
- read-heavy plus controlled mutation
- should prefer automatic rotation only where the provider and service contract are well understood

### 7.5 Escalation and procurement lane

Purpose:

- request founder approval when a service needs money, identity verification, or legal ownership
- ask Procurement to buy required services when needed
- return the workflow to execution once the blocker is cleared

Properties:

- event-driven
- cannot spend directly
- produces crisp summaries and exact next actions

## 8. Files and contracts the API Key Provider owns

The agent should own only sanitized workspace files.

The actual secrets live in the vault.

Recommended owned files:

- `/workspace/docs/ops/api-services.md`
  - founder-readable inventory of active services, purpose, owner, and status
  - never contains plaintext secrets
- `/workspace/docs/ops/service-requests.json`
  - sanitized queue mirror of requested services and resolution state
- `/workspace/docs/ops/runtime-secret-bindings.json`
  - maps service name -> runtime target -> vault reference name
  - no secret values
- `/workspace/docs/ops/provider-accounts.md`
  - describes which services exist, what they are for, and whether they are staging or production
- `/workspace/docs/ops/rotation-calendar.json`
  - next review date, rotation policy, owner, criticality
- `/workspace/docs/ops/procurement-blockers.md`
  - services waiting on billing, founder approval, KYC, or phone verification
- `/workspace/.agent/handoffs/to-api-keys-agent.md`
  - legacy compatibility only
  - not the primary workflow bus

Required structured objects in the coordinator:

- `service_request`
- `provider_account`
- `credential_record`
- `runtime_binding`
- `verification_inbox`
- `rotation_job`
- `procurement_blocker`
- `security_incident`

## 9. API Key Provider tool surface

The agent should mutate the world only through explicit internal tools.

### 9.1 Tool/provider matrix

| Tool family | Tool examples | Provider | Why this provider | API Key Provider access |
| --- | --- | --- | --- | --- |
| Company coordination | `org.get_live_state`, `org.create_service_request`, `org.update_workflow`, `org.send_message`, `org.request_approval`, `org.record_execution_note` | Internal MCP server backed by the supervisor-local `CompanyCoordinator` service + SQLite, mirrored to Worker/D1 | Serialized, auditable company workflow state that matches the current architecture | Full |
| Vault and secret custody | `vault.create_secret`, `vault.rotate_secret`, `vault.bind_runtime_ref`, `vault.list_access`, `vault.audit_secret`, `vault.reveal_masked` | Internal MCP server over Infisical | Machine identities, access requests, rotation, secret scanning, and Cloudflare integration make it the strongest fit for this stack | Full |
| Service catalog and provider playbooks | `catalog.lookup_service`, `catalog.get_signup_requirements`, `catalog.get_rotation_policy`, `catalog.get_runtime_contract` | Internal MCP server over curated provider metadata in repo + D1 | Prevents the agent from improvising random signup flows and keeps decisions consistent | Full |
| Browser signup automation | `browser.start_session`, `browser.resume_context`, `browser.open`, `browser.fill`, `browser.click`, `browser.capture`, `browser.end_session` | Browserbase + Playwright | Strong observability, recordings, contexts, live view, and reliable managed browsers fit agentic signup flows better than self-hosted browser fleets | Full |
| Verification inboxes and branded mailboxes | `mail.create_inbox`, `mail.wait_for_message`, `mail.extract_otp`, `mail.open_verification_link`, `mail.create_domain`, `mail.verify_webhook` | AgentMail with custom domains | Built specifically for agent inboxes, supports send/receive, webhooks, idempotent create operations, and custom domains | Full |
| Branded inbound alias routing when needed | `mailroute.create_alias`, `mailroute.update_route`, `mailroute.attach_worker_rule` | Cloudflare Email Routing + Email Workers | Useful when the product wants zone-level alias logic or catch-all handling tied directly to the Cloudflare zone | Limited / optional |
| Procurement and spend approvals | `procurement.request_purchase`, `procurement.get_budget_status`, `procurement.check_request_status` | Internal MCP server over existing Worker approval + purchase request flow | Keeps card access and billing decisions out of the agent and inside the platform approval path | Create / read-only on spend |
| Runtime distribution | `runtime.bind_secret_ref`, `runtime.validate_binding`, `runtime.list_targets`, `runtime.revoke_binding` | Internal MCP server over Worker/deploy/runtime adapters plus Infisical sync where possible | The agent should deliver references into real runtime targets, not hand secrets to other agents in prose | Full |
| TOTP and second-factor handling | `totp.create_seed`, `totp.generate_code`, `totp.rotate_seed`, `totp.get_policy` | Internal MCP server backed by vault-stored TOTP seeds | Keeps 2FA state under company control without introducing another external provider | Full |
| Security scanning and audit | `observe.scan_workspace_for_secrets`, `observe.list_vault_events`, `observe.list_signup_failures`, `observe.get_browser_recording`, `observe.get_mail_delivery_events` | Internal MCP server over Infisical scanning + Browserbase session data + Worker audit logs | Credential workflows need evidence, replay, and leak detection, not just success/failure strings | Read-only |
| Provider-doc fetch | `research.fetch_official_doc`, `research.extract_requirements` | Internal MCP server with allowlisted official domains | Security-sensitive work should read official docs when catalog coverage is missing, not browse arbitrary forums by default | Read-only |

## 10. Provider notes

### 10.1 Secret vault

Use Infisical as the source of truth for secrets.

Why:

- machine identities with Universal Auth are a good fit for the supervisor/runtime model
- access requests and approvals match the need for controlled secret access
- secret scanning reduces the chance of leaks into code or workspace files
- Cloudflare app connections make runtime sync easier for Workers and Pages
- rotation support is strong enough for the types of systems likely to be added early

This is an inference from Infisical's published capabilities and the current Cloudflare-heavy architecture: it is a better fit here than introducing a separate Vault-style infrastructure control plane just for v1.

### 10.2 Verification and branded inboxes

Use AgentMail as the primary mailbox provider for agent operations.

Why:

- it is purpose-built for programmatic inbox creation and email workflows for agents
- it supports receive/send flows, webhooks, idempotent create patterns, and custom domains
- it aligns with the repo's existing AgentMail integration instead of introducing a second operational email API

Use Cloudflare Email Routing and Email Workers only where zone-native alias logic is still needed.

This split keeps the operational email plane agent-friendly while preserving Cloudflare-level routing control when the platform specifically needs it.

### 10.3 Browser automation

Use Browserbase with Playwright as the default browser layer.

Why:

- signup and console workflows are much easier to debug with session recordings and live view
- reusable contexts reduce repeat logins and verification churn
- managed infrastructure is a better fit than maintaining our own browser fleet inside the supervisor VM

The API Key Provider should prefer API-first setup when a provider offers a good developer flow, and use browser automation only when the console path is required.

### 10.4 Runtime secret sync

Use Infisical as the secret source of truth, but distribute into runtime targets through an internal `runtime` MCP.

Reason:

- the platform still needs company-specific binding logic
- not every target is just "sync all secrets to a provider"
- agents need secret references and target-specific validation, not raw vault access

Default binding strategy:

1. store secret in Infisical
2. create a named reference for the company/runtime/environment
3. sync or inject that reference into the target runtime
4. validate the binding
5. return only the reference name and usage instructions to the requester

### 10.5 Purchases and billing

Do not give this agent direct card powers in v1.

Use the existing internal purchase request and approval flow instead.

Reason:

- billing approval belongs to the founder/platform control plane
- it is safer and easier to audit
- it avoids teaching the agent to improvise spend decisions

### 10.6 Phone verification and KYC

Do not make SMS, phone farming, or KYC bypass a default capability of this agent.

Reason:

- it creates abuse and compliance risk
- it is brittle
- it often requires real human ownership or legal accountability anyway

When a provider requires:

- SMS verification
- government ID
- business tax data
- manual sales approval

the correct behavior is to create a blocker and escalate.

## 11. Exact permission profile

### 11.1 Triage lane

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
- `mcp__org__get_messages`
- `mcp__org__create_service_request`
- `mcp__org__request_approval`
- `mcp__org__record_execution_note`
- `mcp__catalog__lookup_service`
- `mcp__catalog__get_signup_requirements`
- `mcp__catalog__get_rotation_policy`
- `mcp__research__fetch_official_doc`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- `Bash`
- `Edit`
- `Write`
- any deploy tool
- any direct database tool
- any raw secret reveal tool

### 11.2 Signup and verification lane

Recommended SDK configuration:

- `permissionMode: "default"`
- explicit `allowedTools`
- approval callback required for high-risk tool classes

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- `Skill`
- `mcp__org__get_live_state`
- `mcp__org__send_message`
- `mcp__org__request_approval`
- `mcp__vault__create_secret`
- `mcp__vault__update_secret_metadata`
- `mcp__browser__start_session`
- `mcp__browser__resume_context`
- `mcp__browser__open`
- `mcp__browser__fill`
- `mcp__browser__click`
- `mcp__browser__capture`
- `mcp__mail__create_inbox`
- `mcp__mail__wait_for_message`
- `mcp__mail__extract_otp`
- `mcp__mail__open_verification_link`
- `mcp__procurement__request_purchase`
- `mcp__totp__create_seed`
- `mcp__totp__generate_code`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- raw `Bash`
- raw `Edit` / `Write`
- raw outbound email to founder
- raw payment execution
- any unrestricted web search

### 11.3 Secret custody and distribution lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- only explicit internal tools allowed

Allowed tools:

- `mcp__vault__create_secret`
- `mcp__vault__rotate_secret`
- `mcp__vault__bind_runtime_ref`
- `mcp__vault__list_access`
- `mcp__runtime__bind_secret_ref`
- `mcp__runtime__validate_binding`
- `mcp__runtime__revoke_binding`
- `mcp__org__send_message`
- `mcp__org__record_execution_note`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- browser tools
- public web tools
- raw file-edit tools outside owned docs
- raw shell tools

### 11.4 Rotation and hygiene lane

Recommended SDK configuration:

- `permissionMode: "dontAsk"`
- read-heavy plus bounded rotation tools

Allowed tools:

- `mcp__vault__list_rotation_candidates`
- `mcp__vault__rotate_secret`
- `mcp__vault__revoke_secret`
- `mcp__observe__scan_workspace_for_secrets`
- `mcp__observe__list_vault_events`
- `mcp__observe__get_browser_recording`
- `mcp__org__record_execution_note`
- `mcp__workspace__write_owned_doc`

Disallowed tools:

- browser signup tools
- procurement tools
- raw secret export

## 12. Internal MCP servers

The API Key Provider should rely on a small number of explicit internal MCP servers.

### 12.1 `org`

Purpose:

- source of truth for structured requests, task state, approvals, and agent messaging

Key operations:

- `get_live_state`
- `create_service_request`
- `claim_service_request`
- `send_message`
- `request_approval`
- `record_execution_note`
- `resolve_workflow`

### 12.2 `vault`

Purpose:

- secret custody and policy

Backed by:

- Infisical projects, machine identities, folders, policies, and webhook events

Key operations:

- `create_secret`
- `read_masked_metadata`
- `rotate_secret`
- `revoke_secret`
- `bind_runtime_ref`
- `list_access`
- `audit_secret`

### 12.3 `catalog`

Purpose:

- hold curated provider playbooks and approved service metadata

Data model:

- service name
- category
- signup path
- billing requirement
- verification requirement
- runtime env vars
- default scopes
- rotation policy
- owner role

Key operations:

- `lookup_service`
- `get_signup_requirements`
- `get_rotation_policy`
- `get_runtime_contract`
- `get_approval_policy`

### 12.4 `browser`

Purpose:

- run browser-based provider signup or console operations

Backed by:

- Browserbase sessions, contexts, recordings, and live view

Key operations:

- `start_session`
- `resume_context`
- `open`
- `fill`
- `click`
- `capture`
- `handoff_live_view`
- `end_session`

### 12.5 `mail`

Purpose:

- provision inboxes and consume verification mail

Backed by:

- AgentMail inboxes, custom domains, threads, and webhooks

Key operations:

- `create_inbox`
- `create_domain`
- `wait_for_message`
- `extract_otp`
- `open_verification_link`
- `list_thread_events`
- `verify_webhook`

### 12.6 `mailroute`

Purpose:

- optional Cloudflare-native alias routing on company domains

Key operations:

- `create_alias`
- `update_route`
- `attach_worker_rule`
- `check_dns_state`

### 12.7 `totp`

Purpose:

- generate second-factor codes from vault-stored TOTP seeds

Key operations:

- `create_seed`
- `generate_code`
- `rotate_seed`
- `get_policy`

### 12.8 `procurement`

Purpose:

- request approval for spend or paid accounts

Key operations:

- `request_purchase`
- `get_budget_status`
- `check_request_status`

### 12.9 `runtime`

Purpose:

- safely expose secret references to the correct runtime targets

Key operations:

- `list_targets`
- `bind_secret_ref`
- `validate_binding`
- `revoke_binding`

### 12.10 `observe`

Purpose:

- audit and leak detection

Key operations:

- `scan_workspace_for_secrets`
- `list_vault_events`
- `list_signup_failures`
- `get_browser_recording`
- `get_mail_delivery_events`

### 12.11 `workspace`

Purpose:

- enforce path-safe writes to owned docs only

Key operations:

- `write_owned_doc`
- `append_inventory_note`
- `update_rotation_calendar`

This MCP exists so the agent does not need raw unrestricted `Edit` and `Write`.

## 13. Provisioning-time workflow

At company provisioning, the API Key Provider should not immediately sign up for random services.

Instead, it should establish the secure substrate for later work.

Provisioning-time workflow:

1. Read the execution contract and mission.
2. Initialize the sanitized service inventory files.
3. Create the company vault project, environments, and folder policy structure.
4. Create the company machine identity for runtime secret access.
5. Create a branded verification inbox strategy:
   - default AgentMail inboxes
   - company-domain email plan if the company domain is already available
6. Seed the provider catalog view for likely launch services:
   - Anthropic
   - Browserbase
   - AgentMail
   - analytics provider
   - auth provider
   - deploy/runtime provider
7. Publish a founder-invisible but agent-readable note describing how to request services properly.
8. Wait for real service requests from CTO, CMO, QA, or CEO.

The API Key Provider should not burn credits signing up for optional services before the company actually needs them.

## 14. Standard workflow

The standard workflow for a request should be:

1. Another agent creates a structured `service_request`.
2. The API Key Provider triages it:
   - existing integration
   - new key under existing account
   - new provider account
   - blocked by approval
3. If existing integration is enough:
   - create or reuse the correct vault reference
   - bind it to the target runtime
   - send the requester the non-secret contract
4. If a new provider account is required:
   - read the catalog playbook
   - check whether spend approval is needed
   - check whether email verification is needed
   - check whether phone/KYC is required
5. If approval is required:
   - create approval and procurement blockers
   - stop
6. If the path is automatable:
   - launch browser session
   - create or attach the correct verification inbox
   - complete signup
   - generate app credentials
   - store them in the vault
7. Create runtime binding references.
8. Notify the requester with:
   - what was provisioned
   - where it is bound
   - what scopes/limits apply
   - what follow-up remains
9. Attach rotation policy and next review date.
10. Close the request.

## 15. Reliability controls

### 15.1 Secret hygiene

Hard rules:

- never write plaintext secrets to the workspace
- never write plaintext secrets to D1
- never include plaintext secrets in task descriptions or agent messages
- never echo raw verification emails into general chat
- never reveal a secret to another agent if a runtime binding or scoped reference can be used instead

### 15.2 Approval rules

Founder approval is required for:

- paid services
- production-only credentials with broad scopes
- services that require legal or tax identity
- services that require phone verification or KYC
- any credential that would materially increase platform risk

### 15.3 Browser safety

Every signup workflow must:

- use a recorded browser session
- attach workflow metadata to the session
- end with a structured result
- stop immediately on unexpected billing, CAPTCHA loops, SMS OTP, or identity checks

### 15.4 Vault discipline

Every secret record must include:

- provider
- company
- environment
- owner role
- rotation policy
- creation time
- last verification time
- blast radius

### 15.5 Leak detection

Require:

- scheduled secret scanning on the workspace
- provider webhook handling for secret changes where available
- incident creation when a leaked or compromised key is detected

### 15.6 Idempotency

Every create path must use idempotency keys.

This matters especially for:

- inbox creation
- domain creation
- provider account signup
- purchase requests
- runtime binding creation

### 15.7 Isolation

Do not reuse one broad credential everywhere.

Prefer:

- company-specific accounts
- environment-specific credentials
- service-scoped tokens
- staging and production separation

## 16. What to borrow from `everything-claude-code`

The useful ideas to borrow are operational, not architectural:

- strong role-specific skills and playbooks
- small explicit tools instead of giant prompts
- repeatable checklists for sensitive operations
- persistent artifacts after each run
- evals for common failure modes

Applied to this agent, that means:

- keep provider playbooks as reusable skills
- make signup and rotation checklists deterministic
- require post-run evidence and notes
- add evals for leak prevention, incomplete signup flows, and missing rotation metadata

## 17. Why Relay should not be the API Key Provider's primary coordination bus

Relay can be useful later for richer agent-to-agent transport.

It should not be the primary bus for this agent because:

- secret workflows need structured typed state, not chat-style messages
- approvals and procurement need serialized workflow transitions
- replay and audit matter more than conversational richness here
- secrets should not flow through a generic messaging layer

The primary bus should remain:

- internal structured coordination through the local coordinator + D1 mirror

Relay can become an optional future transport for live debugging or assisted operations once the structured workflow layer is stable.

## 18. Implementation phases

### Phase 1: secure control plane

- keep the agent on Opus 4.6
- remove any broad `bypassPermissions` path
- add `vault`, `catalog`, `runtime`, and `workspace` MCP servers
- make sanitized inventory docs and secret references first-class

### Phase 2: inbox and verification automation

- add AgentMail-backed verification inboxes and custom-domain support
- add Browserbase session workflow with evidence capture
- add TOTP seed management and generation

### Phase 3: procurement and approval hardening

- connect purchase request flow to structured service requests
- add founder approval summaries for paid or risky providers
- block phone/KYC paths behind explicit escalation

### Phase 4: rotation and incident response

- add scheduled rotation checks
- add secret scanning and quarantine workflows
- add incident objects for leaked or compromised keys

### Phase 5: multi-provider portability

- keep the same tool plane
- allow other agent drivers later
- optionally add Relay for live collaboration once typed workflow state is mature

## 19. Recommended final stack

If I were implementing the API Key Provider next, this is the stack I would choose:

- Driver: Anthropic Claude Agent SDK / Claude Code SDK
- Model: Claude Opus 4.6
- Coordination: local `CompanyCoordinator` service on the supervisor VM + SQLite
- Historical mirror: Cloudflare D1
- Secret source of truth: Infisical
- Runtime auth to vault: Infisical Universal Auth machine identities
- Runtime secret sync: internal `runtime` MCP plus Infisical Cloudflare integration where applicable
- Service catalog: internal curated catalog in repo + D1
- Browser automation: Browserbase + Playwright
- Verification inboxes: AgentMail
- Custom branded email domains: AgentMail custom domains by default
- Optional zone-native aliasing: Cloudflare Email Routing + Email Workers
- Purchases and spend approvals: internal Worker approval and purchase request flow
- TOTP handling: internal TOTP service backed by vault-stored seeds
- Audit and leak detection: Infisical secret scanning + internal audit/event tooling
- Evidence and replay: Browserbase recordings + R2 evidence bundles

This is not the simplest stack. It is the stack that best matches the stated goal: highest reliability and agency for the API Key Provider, without turning it into an unbounded browser-and-secrets bot.

## 20. Sources

- Anthropic Claude Opus 4.6 announcement: [anthropic.com/news/claude-opus-4-6](https://www.anthropic.com/news/claude-opus-4-6)
- Anthropic Claude 4.6 model docs: [platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- Anthropic Agent SDK loop and permissions: [platform.claude.com/docs/en/agent-sdk/agent-loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop), [platform.claude.com/docs/en/agent-sdk/permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- Anthropic Agent SDK skills: [platform.claude.com/docs/en/agent-sdk/skills](https://platform.claude.com/docs/en/agent-sdk/skills)
- SQLite documentation: [sqlite.org/docs.html](https://sqlite.org/docs.html)
- Cloudflare D1 overview: [developers.cloudflare.com/d1](https://developers.cloudflare.com/d1/)
- Cloudflare Email Routing and Email Workers: [developers.cloudflare.com/email-routing](https://developers.cloudflare.com/email-routing/), [developers.cloudflare.com/email-routing/email-workers/enable-email-workers](https://developers.cloudflare.com/email-routing/email-workers/enable-email-workers/)
- Browserbase overview, contexts, observability, session replay, and live view: [docs.browserbase.com/introduction/what-is-browserbase](https://docs.browserbase.com/introduction/what-is-browserbase), [docs.browserbase.com/features/contexts](https://docs.browserbase.com/features/contexts), [docs.browserbase.com/features/observability](https://docs.browserbase.com/features/observability), [docs.browserbase.com/features/session-replay](https://docs.browserbase.com/features/session-replay), [docs.browserbase.com/features/session-live-view](https://docs.browserbase.com/features/session-live-view)
- AgentMail overview, webhooks, idempotency, pods, and custom domains: [docs.agentmail.to](https://docs.agentmail.to/), [docs.agentmail.to/webhook-verification](https://docs.agentmail.to/webhook-verification), [docs.agentmail.to/idempotency](https://docs.agentmail.to/idempotency), [docs.agentmail.to/documentation/core-concepts/pods](https://docs.agentmail.to/documentation/core-concepts/pods), [docs.agentmail.to/custom-domains](https://docs.agentmail.to/custom-domains)
- Infisical introduction, machine identities, Universal Auth, access requests, Cloudflare connection, secret scanning, dynamic secrets, rotation, and webhooks: [infisical.com/docs/documentation/getting-started/introduction](https://infisical.com/docs/documentation/getting-started/introduction), [infisical.com/docs/documentation/platform/identities/overview](https://infisical.com/docs/documentation/platform/identities/overview), [infisical.com/docs/documentation/platform/identities/universal-auth](https://infisical.com/docs/documentation/platform/identities/universal-auth), [infisical.com/docs/documentation/platform/access-controls/access-requests](https://infisical.com/docs/documentation/platform/access-controls/access-requests), [infisical.com/docs/integrations/app-connections/cloudflare](https://infisical.com/docs/integrations/app-connections/cloudflare), [infisical.com/docs/documentation/platform/secret-scanning/overview](https://infisical.com/docs/documentation/platform/secret-scanning/overview), [infisical.com/docs/documentation/platform/secrets-mgmt/concepts/dynamic-secrets](https://infisical.com/docs/documentation/platform/secrets-mgmt/concepts/dynamic-secrets), [infisical.com/docs/documentation/platform/secret-rotation/overview](https://infisical.com/docs/documentation/platform/secret-rotation/overview), [infisical.com/docs/documentation/platform/webhooks](https://infisical.com/docs/documentation/platform/webhooks)
- `everything-claude-code`: [github.com/affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- `AgentWorkforce/relay`: [github.com/AgentWorkforce/relay](https://github.com/AgentWorkforce/relay)
