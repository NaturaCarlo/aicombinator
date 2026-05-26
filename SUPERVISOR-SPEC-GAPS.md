# Supervisor V2 — Gaps Spec

Companion to `SUPERVISOR-SPEC.md`. Covers three capabilities the core spec defers: founder-facing documents, commercial telemetry, and dedicated VM routing. Each section specifies how the capability integrates with the V2 supervisor architecture.

---

## 1. Founder Document Contract

### 1.1 Problem

The current system has agents writing markdown files to `/workspace/docs/` (executive-brief.md, plan.md, founder-daily-update.md, etc.) with word budgets enforced by readiness checks in the supervisor. This works but has issues:

- CEO creates 4 overlapping documents on day 1 (executive brief, plan, daily update, execution contract) with redundant content
- Word budget enforcement is passive — documents are checked but agents aren't told to fix violations
- Date grounding is inconsistent (UTC creation timestamp vs PT email dates)
- All-or-nothing visibility gate: if any of 4 control files is missing/placeholder, ALL documents hide
- No cap on total documents — board reports accumulate without limit

### 1.2 Document Types

The V2 supervisor reduces founder-visible documents to three:

| Document | File | Author | Frequency | Word Budget |
|----------|------|--------|-----------|-------------|
| **Mission** | `/workspace/docs/mission.md` | CEO | Once (planning phase) | 30–80 words |
| **Executive Brief** | `/workspace/docs/executive-brief.md` | CEO | Updated as needed | 80–220 words |
| **Daily Update** | `/workspace/docs/daily-update-{YYYY-MM-DD}.md` | CEO | One per calendar day (PT) | 40–140 words |

Removed from V1:
- `plan.md` — redundant with the structured milestone/task tree visible in the dashboard
- `execution-contract.json` — replaced by the milestone/task data model in SQLite
- `market-analysis.md`, `marketing-plan.md`, `pitch-deck.md`, `architecture.md` — agents can still write these to `/workspace/docs/`, but they are internal working documents, not surfaced to the founder unless the CEO explicitly references them in a daily update

### 1.2.1 Mission Statement

The founder's raw input (`company.goal`) is often messy — "make money with ai ghostwriting for founders" is not a mission statement. The CEO normalizes this into a clean, founder-readable mission during the planning phase.

The planning prompt (SUPERVISOR-SPEC.md Section 4.2) includes:

```
Before writing plan.json, write a mission statement to /workspace/docs/mission.md

This is a clean, 1–3 sentence version of the founder's goal. It should read like
a real company mission — clear, specific, no jargon. The founder will see this
as the first thing on their dashboard.

Founder's input: "{company.goal}"

Rules:
- 30–80 words. One short paragraph.
- State what the company does, for whom, and why it matters.
- Do not embellish. Stay faithful to the founder's intent.
```

The mission is written once during planning. It is not updated unless the company pivots (via `plan_update.json` with a new `goal` — in which case the CEO is prompted to rewrite the mission to match).

The dashboard shows the mission as the first document. If `mission.md` doesn't exist yet (company still in planning), no mission document is shown — the founder sees the task/milestone dashboard view instead. Raw `company.goal` is never surfaced as a document.

### 1.3 Executive Brief

Written once during planning, updated when the company direction changes significantly (pivot, new milestone strategy). The CEO's system prompt includes:

```
# Executive Brief

Maintain /workspace/docs/executive-brief.md — a concise summary of what the
company is building, the current strategy, and near-term priorities.

Rules:
- 80–220 words. No padding, no filler.
- Update it when the strategy changes. Don't rewrite it every day.
- This is the founder's "what is this company doing" reference. Keep it crisp.
```

### 1.4 Daily Update

One file per calendar day. The supervisor enforces this:

```
function request_daily_update(company_id):
  today = format_date_pt(now())  // YYYY-MM-DD in America/Los_Angeles
  update_path = f"/workspace/docs/daily-update-{today}.md"

  if file_exists(update_path):
    return  // already written today

  ceo = get_ceo(company_id)

  // Build context: what happened since last update
  last_update_date = get_last_daily_update_date(company_id)
  completed_tasks = get_tasks_completed_since(company_id, last_update_date)
  in_progress_tasks = get_tasks(company_id, status='in_progress')
  blocked_tasks = get_tasks(company_id, status='blocked')

  prompt = f"""
  Write today's daily update to {update_path}

  Date: {today}
  Day {day_number} of the company.

  Since the last update:
  - Completed: {format_task_summaries(completed_tasks)}
  - In progress: {format_task_summaries(in_progress_tasks)}
  - Blocked: {format_task_summaries(blocked_tasks)}

  Rules:
  - 40–140 words. One short paragraph.
  - State what got done, what's happening now, what's blocked (if anything).
  - No aspirational filler ("exciting progress!"). Just facts.
  - Do not invent metrics. Only reference verified telemetry if it exists.
  """

  invoke_ceo_turn(company_id, ceo, prompt, is_user_facing=false)
```

**Trigger:** Called once per company per calendar day (PT timezone). Checked via cron — a lightweight timer (not an agent turn) that runs every 30 minutes and calls `request_daily_update` for each active company. If the file already exists, it's a no-op.

### 1.5 Date Grounding

Every CEO prompt includes the current date and day number in PT:

```
function build_ceo_date_header(company):
  now_pt = now().astimezone('America/Los_Angeles')
  day_number = compute_day_number(company)
  return f"Current date: {now_pt.strftime('%A, %B %d, %Y')} (Pacific Time) — Day {day_number}"

function compute_day_number(company):
  // Day 1 = the calendar day (PT) the company was created.
  // Day 2 = the next calendar day (PT), regardless of creation time.
  created_pt = parse_datetime(company.created_at).astimezone('America/Los_Angeles')
  now_pt = now().astimezone('America/Los_Angeles')
  return floor((now_pt.date() - created_pt.date()).days) + 1
```

`day_number` is used everywhere a day reference appears: CEO prompts, daily update filenames, email subjects, dashboard labels. It is always computed from `company.created_at` converted to PT, counting calendar days (not 24-hour periods).

This header is prepended to every CEO prompt — planning, user messages, blocked tasks, milestone reviews, daily updates. The CEO always knows what day it is.

### 1.6 Word Budget Enforcement

The supervisor validates word counts after CEO turns that write documents:

```
function check_document_budgets(company_id):
  workspace = get_workspace_dir(company_id)

  checks = [
    ("docs/executive-brief.md", 80, 220),
    // Daily updates: check today's file
    (f"docs/daily-update-{today_pt()}.md", 40, 140),
  ]

  for path, min_words, max_words in checks:
    full_path = f"{workspace}/{path}"
    if not file_exists(full_path): continue

    content = read_file(full_path)
    word_count = count_words(strip_markdown(content))

    if word_count < min_words or word_count > max_words:
      // Don't block — just ask CEO to fix on next turn
      log(f"Document {path} has {word_count} words (expected {min_words}–{max_words})")
      // Queue a lightweight CEO event to revise
      notify_ceo(company_id, 'document_revision', {
        path: path,
        word_count: word_count,
        min: min_words,
        max: max_words
      })
```

Called after `process_ceo_response()` when the CEO has written or updated documents. Not called on every turn — only when file modification is detected in the workspace docs directory.

### 1.7 Visibility Rules

Documents are visible to the founder when they exist AND pass readiness checks:

1. **Mission** — visible once `mission.md` exists and passes word budget (30–80 words). No fallback to raw `company.goal`.
2. **Executive Brief** — visible once it exists and passes word budget (80–220 words) and placeholder check (not "pending ceo brief").
3. **Daily Updates** — visible individually once written AND passing word budget (40–140 words). **Last 7 days only** — older updates are not served (see 1.7.1).

No all-or-nothing gate. Each document is independently gated by its own readiness check. If the mission isn't ready but a daily update is, the daily update shows. Partial, thin, or placeholder documents never leak to the founder.

### 1.7.1 Daily Update Retention

The dashboard displays at most 7 daily updates (the current week). Older updates are not deleted — they remain on disk — but the document fetch endpoint excludes them:

```
function get_founder_documents(company_id):
  company = get_company(company_id)
  docs = []

  // Mission (only if CEO has written it)
  mission = read_file_if_exists(f"{workspace}/docs/mission.md")
  if mission and is_document_ready(mission, 30, 80):
    docs.push({type: 'mission', title: 'Mission', content: mission})
  // If mission.md doesn't exist yet (still planning), show nothing.
  // The founder sees the dashboard task/milestone view instead.
  // Raw company.goal is never shown as a document.

  // Executive Brief
  brief = read_file_if_exists(f"{workspace}/docs/executive-brief.md")
  if brief and is_document_ready(brief, 80, 220):
    docs.push({type: 'executive_brief', title: 'Executive Brief', content: brief})

  // Daily Updates — last 7 days only, with readiness check
  created_pt = parse_datetime(company.created_at).astimezone('America/Los_Angeles')
  for day_offset in range(0, 7):
    date = format_date_pt(now() - days(day_offset))
    update = read_file_if_exists(f"{workspace}/docs/daily-update-{date}.md")
    if update and is_document_ready(update, 40, 140):
      file_day_number = floor((parse_date(date) - created_pt.date()).days) + 1
      docs.push({type: 'daily_update', title: f'Day {file_day_number} — {date}', content: update})

  return docs  // max 9 documents (1 mission + 1 brief + 7 updates)
```

This prevents document accumulation. A company running for 6 months doesn't show 180 daily updates — it shows the last 7. The founder can see history through the task/milestone dashboard, not through a wall of daily update files.

For companies that need longer history, a future enhancement could add a weekly rollup document (CEO summarizes the week in one file, replaces 7 daily updates). Not in V2 scope.

### 1.8 Founder Email Recap

The existing daily email recap continues, but with simplified content:

```
function send_daily_email(company_id):
  today = today_pt()
  email_key = f"email:{company_id}:{today}"

  if already_sent(email_key): return

  company = get_company(company_id)
  update_path = f"/workspace/docs/daily-update-{today}.md"

  if not file_exists(update_path):
    request_daily_update(company_id)
    // If still not written after CEO turn, skip email today

  if file_exists(update_path):
    update_content = read_file(update_path)
  else:
    update_content = "No update today."

  // Append verified telemetry summary (if any)
  telemetry = get_verified_telemetry_summary(company_id)
  telemetry_section = format_verified_telemetry_summary(telemetry)

  send_email(
    to: user.email,
    subject: f"{company.name} — Day {day_number} — {format_date(today)}",
    body: sanitize_founder_content(update_content + telemetry_section)
  )

  mark_sent(email_key)
```

### 1.9 Content Sanitization

Before any document is shown to the founder (dashboard or email), it passes through sanitization:

```
function sanitize_founder_content(text):
  // Strip lines containing unverified metric claims
  // Uses keyword list: "outreach", "leads generated", "revenue",
  //   "meetings booked", "cold emails sent", etc.
  // Appends note if lines were stripped:
  //   "Note: unverified commercial claims were removed."
  return sanitized_text
```

This is the existing logic from `sanitizeFounderVisibleContent()`. It carries over unchanged — agents must not fabricate metrics in documents.

---

## 2. Commercial Telemetry

### 2.1 Problem

The V2 supervisor spec doesn't mention telemetry. The current system has a working telemetry pipeline with grounded verification — agents cannot self-report metrics, only provider-backed system events can create records. This must be preserved.

### 2.2 What Already Exists (Carry Over)

The following are **already built and working** on the Worker/D1 side. They don't need changes for V2:

| Component | Location | Status |
|-----------|----------|--------|
| `telemetry_records` table | D1 (migration 008) | Production |
| Source provenance columns | D1 (migration 009) | Production |
| `validateGroundedCommercialTelemetry()` | `worker/src/utils/company-telemetry.ts` | Production |
| Upsert endpoint | `POST /api/supervisor/companies/:id/telemetry` | Production |
| Summary computation | `worker/src/utils/company-telemetry.ts` | Production |
| Verification levels (self_reported/evidence_attached/system_verified) | Types | Production |
| Trusted sources whitelist (agentmail, calendar, payment, crm) | Validation | Production |

### 2.3 What V2 Needs to Integrate

The V2 supervisor needs to:

1. **Reject self-reported telemetry from agents**
2. **Record telemetry from provider integrations**
3. **Include verified telemetry in CEO context**
4. **Sync telemetry to D1 via existing endpoints**

### 2.4 Agent Telemetry Rejection

When agents write output that contains commercial metric claims, the supervisor ignores them. This is enforced at two levels:

**Level 1 — System prompt (soft).** Worker agent system prompts include:
```
Do not claim outreach results, leads, meetings, or revenue in your output.
Commercial metrics are tracked automatically by provider integrations.
You cannot create them.
```

**Level 2 — Turn processing (hard).** After each agent turn, the supervisor does NOT scan output for telemetry or create records from agent text. Telemetry records are only created by the pathways in Section 2.5.

### 2.5 Provider Integration Pathways

Telemetry enters the system through external integrations, not agent actions:

```
Provider Event → Worker Webhook → Validate Grounding → D1 telemetry_records
```

| Provider | Source | Events | Telemetry Kind |
|----------|--------|--------|---------------|
| AgentMail | `agentmail_outbound` | Email sent | `outreach` (status: sent) |
| AgentMail | `agentmail_inbound` | Reply received | `outreach` (status: replied) |
| AgentMail | `agentmail_inbound` | Qualified reply | `lead` (status: new) |
| Calendar | `calendar_booking` | Meeting scheduled | `meeting` (status: scheduled) |
| Calendar | `calendar_booking` | Meeting completed | `meeting` (status: completed) |
| Stripe | `payment_provider` | Customer payment received | `revenue` (status: paid) |

Each event must have:
- `source` — one of the trusted sources
- `source_event_id` — unique event ID from the provider (prevents duplicates)
- `external_ref` or `evidence_ref` — proof of the event

Without all three, `validateGroundedCommercialTelemetry()` throws and the record is rejected.

**Revenue disambiguation:** The platform uses Stripe for two distinct purposes:

1. **Platform billing** — founder credit purchases, subscriptions, plan upgrades (handled by existing Stripe webhook routes in `stripe-webhooks.ts`)
2. **Company revenue** — payments from the company's customers for its product/service (handled by Stripe Connect or agent-provisioned Stripe accounts)

Only category 2 counts as revenue telemetry. The validation layer must enforce this:

```
function validate_revenue_source(source_event_id, external_ref):
  // Platform billing events use Stripe account IDs that match our own account.
  // Company revenue events come from connected accounts or agent-provisioned accounts.
  // Reject any revenue record whose external_ref matches a platform billing charge.

  if is_platform_billing_charge(external_ref):
    throw "Platform billing charges are not company revenue"

  // Additionally: the Stripe webhook handler for credit purchases
  // (worker/src/routes/stripe-webhooks.ts) NEVER calls the telemetry
  // upsert endpoint. Only the company-revenue webhook path does.
  // This is an architectural boundary, not just a validation check.
```

Founder credit top-ups, subscription payments, and platform fees are never recorded as company revenue. This is enforced at the webhook routing level (separate Stripe webhook endpoints for platform billing vs company revenue) and validated at the telemetry insertion level.

### 2.6 CEO Telemetry Context

When the CEO is woken for any reason, verified telemetry is included in the prompt if it exists:

```
function build_ceo_telemetry_section(company_id):
  summary = get_verified_telemetry_summary(company_id)

  if summary.outreach.total == 0 and summary.leads.total == 0
     and summary.meetings.total == 0 and summary.revenue.events == 0:
    return ""  // no telemetry yet, don't clutter the prompt

  parts = ["# Verified Commercial Metrics (provider-backed)"]

  if summary.outreach.total > 0:
    parts.push(f"Outreach: {summary.outreach.sent} sent, {summary.outreach.replied} replied")

  if summary.leads.total > 0:
    parts.push(f"Leads: {summary.leads.new} new, {summary.leads.qualified} qualified")

  if summary.meetings.total > 0:
    parts.push(f"Meetings: {summary.meetings.scheduled} scheduled, {summary.meetings.completed} completed")

  if summary.revenue.events > 0:
    paid = summary.revenue.paidCents / 100
    parts.push(f"Revenue: ${paid:.2f} ({summary.revenue.paidCount} payments)")

  parts.push("")
  parts.push("These numbers come from verified provider integrations.")
  parts.push("Do not invent or extrapolate beyond what is shown here.")

  return parts.join("\n")
```

This section is appended to every CEO prompt (user messages, blocked tasks, milestone reviews, daily updates). The CEO sees real numbers and is explicitly told not to fabricate beyond them.

### 2.7 Dashboard Telemetry Display

The Worker already returns `verifiedTelemetry` in the company status response. The V2 supervisor doesn't change this — telemetry lives in D1, queried by the Worker, displayed by the dashboard. No supervisor involvement needed for reads.

### 2.8 Local Telemetry Mirror

Telemetry is mirrored to the VM's local SQLite so the supervisor never depends on Worker availability for CEO prompts. The VM is authoritative for operational state — telemetry context is operational.

**Local table (added to SUPERVISOR-SPEC.md Section 2.1):**

```sql
------------------------------------------------------------
-- TELEMETRY MIRROR (pushed from Worker, read locally)
------------------------------------------------------------
CREATE TABLE telemetry_mirror (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  kind               TEXT NOT NULL,        -- 'outreach', 'lead', 'meeting', 'revenue'
  status             TEXT NOT NULL,
  source             TEXT NOT NULL,
  source_event_id    TEXT NOT NULL,
  verification_level TEXT NOT NULL,
  subject_name       TEXT,
  subject_email      TEXT,
  amount_cents       INTEGER,
  currency           TEXT,
  occurred_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_telemetry_mirror_company ON telemetry_mirror(company_id, kind, occurred_at DESC);
```

This is a read-only mirror — the supervisor never writes to it directly. It only accepts pushes from the Worker.

**Push pathway:**

When a provider webhook writes a telemetry record to D1, the Worker also pushes it to the supervisor:

```
Worker webhook handler:
  1. Validate grounding (existing logic)
  2. Insert into D1 telemetry_records (existing logic)
  3. Push to supervisor: POST /companies/{id}/telemetry/mirror
     body: { telemetry record }

Supervisor endpoint:
function handle_telemetry_mirror(company_id, record):
  INSERT OR REPLACE INTO telemetry_mirror (...)
    VALUES (record.id, company_id, record.kind, record.status, ...)
```

Same push pattern as user messages and credit purchases — the Worker notifies the supervisor, the supervisor stores locally. If the push fails, the Worker retries (exponential backoff). The supervisor's local data may lag by seconds, which is acceptable for context in CEO prompts.

**Reading locally for CEO prompts:**

```
function get_verified_telemetry_summary(company_id):
  // Pure local SQLite query — no Worker dependency
  rows = SELECT kind, status, count(*) as cnt,
                sum(amount_cents) as total_cents,
                max(occurred_at) as last_at
         FROM telemetry_mirror
         WHERE company_id = ?
         AND verification_level IN ('system_verified', 'evidence_attached')
         GROUP BY kind, status

  return aggregate_into_summary(rows)
```

**Bootstrap sync:**

On startup, the supervisor fetches current telemetry from D1 to populate the mirror:

```
// Added to Section 16 (Startup Sequence), after step 4:
4b. For each company, fetch telemetry mirror:
    records = GET Worker API: /api/supervisor/companies/{id}/telemetry?scope=verified
    INSERT OR REPLACE INTO telemetry_mirror ... (batch insert)
```

This is a one-time catch-up. After startup, the Worker pushes new records in real-time.

---

## 3. Dedicated VM Routing

### 3.1 Problem

The V2 supervisor spec assumes all companies run on a single shared VM. The Worker already has full dedicated-VM wiring: Hetzner provisioning, cloud-init, per-user scoping, workspace migration, and routing based on `runtime_tier`. The V2 spec needs to account for this.

### 3.2 What Already Exists (Carry Over)

| Component | Location | Status |
|-----------|----------|--------|
| `runtime_tier` + `dedicated_vm_*` columns on companies | D1 (migration 005) | Production |
| `resolveSupervisorBaseUrlForCompany()` | `worker/src/utils/supervisor-routing.ts` | Production |
| `ensureDedicatedVmForUser()` via Hetzner API | `worker/src/utils/dedicated-vm.ts` | Production |
| Cloud-init bootstrap script | `worker/src/utils/dedicated-vm.ts` | Production |
| `migrateCompanyWorkspaceToDedicatedVm()` | `worker/src/utils/dedicated-vm.ts` | Production |
| `/api/supervisor/dedicated-vm/register` endpoint | `worker/src/routes/supervisor.ts` | Production |
| `scopeUserId` in SupervisorConfig | `supervisor/src/types.ts` | Production |
| Scope-aware `bootstrapFromRemote()` | `supervisor/src/d1-client.ts` | Production |
| Stripe webhook → VM provisioning trigger | `worker/src/routes/stripe-webhooks.ts` | Production |

### 3.3 How Routing Works

The Worker routes every supervisor API call through `resolveSupervisorBaseUrlForCompany()`:

```
function resolve_supervisor_url(company):
  if company.runtime_tier == 'dedicated'
     and company.dedicated_vm_status == 'active'
     and company.dedicated_vm_ip:
    return f"http://{company.dedicated_vm_ip}:8787"
  else:
    return shared_supervisor_url  // from KV or env var
```

This is transparent to the dashboard — it always talks to the Worker, which routes to the correct supervisor. The supervisor doesn't need to know whether it's shared or dedicated.

### 3.4 What V2 Needs

The V2 supervisor needs three things to work correctly on dedicated VMs:

**1. Scope-aware bootstrap.**

On startup, a dedicated supervisor fetches only its user's companies from D1:

```
// Section 16 (Startup Sequence) addition:
// Step 4 becomes scope-aware:

4. Fetch companies from D1:
   if config.scopeUserId:
     GET /api/supervisor/companies?userId={config.scopeUserId}
   else:
     GET /api/supervisor/companies  // all companies (shared mode)
```

This already exists in `d1-client.ts` (`withScopeQuery`). The V2 supervisor carries it over.

**2. Scope-aware provisioning.**

When the Worker calls `POST /companies/{id}/provision` on a dedicated supervisor, the supervisor must accept the company even though it wasn't in the initial bootstrap. The provisioning endpoint adds the company to local SQLite and proceeds normally.

```
function handle_provision(company_id):
  // Fetch company details from D1
  company = GET Worker API: /api/supervisor/companies/{company_id}

  // Scope check (dedicated VMs only accept their user's companies)
  if config.scopeUserId and company.user_id != config.scopeUserId:
    return 403 "Company belongs to a different user"

  // Insert into local SQLite and proceed with planning
  insert_company(company)
  init_company_credits(company.id, company.user_id)
  provision_container(company)
  start_planning(company)
```

**3. Credit isolation.**

On a dedicated VM, `credit_balances` has exactly one user. Credit exhaustion pauses all companies on that VM (which all belong to the same user). This is correct behavior — no change needed from the core spec.

### 3.5 VM Lifecycle Events

The Worker manages the dedicated VM lifecycle. The V2 supervisor is passive — it responds to API calls:

| Event | Trigger | Worker Action | Supervisor Action |
|-------|---------|---------------|-------------------|
| User upgrades to paid | Stripe webhook | Provision Hetzner VM, run cloud-init | Boot, register, bootstrap |
| New company (paid user) | Dashboard | Call `POST /provision` on dedicated supervisor | Accept, plan, run |
| Company workspace migration | VM registration | Archive from shared, import to dedicated | Accept workspace, resume |
| VM health check failure | Worker cron | Re-provision or failover to shared | (destroyed and recreated) |
| User downgrades to free | Stripe webhook | Migrate companies back to shared, destroy VM | (shared supervisor handles them) |

### 3.6 What V2 Does NOT Change

- The Worker's routing logic (`resolveSupervisorBaseUrlForCompany`)
- The Hetzner provisioning code
- The cloud-init bootstrap script
- The workspace migration flow
- The Stripe webhook handlers

These all work with the V2 supervisor because they interact through the same HTTP API. The V2 supervisor exposes the same endpoints (`/provision`, `/resume`, `/pause`, `/companies/{id}/status`). The internal scheduling changes (milestones, dependency graph, CEO event queue) are invisible to the Worker.

### 3.7 Supervisor API Surface (for Worker compatibility)

The V2 supervisor must expose these endpoints for the Worker (and dedicated VM registration) to function:

```
POST   /companies/{id}/provision     — initialize company, start planning
POST   /companies/{id}/pause         — pause company (credit exhaustion, user action)
POST   /companies/{id}/resume        — resume paused company
GET    /companies/{id}/status        — return progress JSON (Section 15.1)
POST   /companies/{id}/message       — user message to CEO
POST   /companies/{id}/approval/{id}/resolve  — approval decision from user
POST   /credits/purchased            — credit purchase notification
GET    /health                       — supervisor health check
POST   /companies/{id}/workspace/archive   — export workspace archive
POST   /companies/{id}/workspace/import    — import workspace archive
```

---

## 4. Integration Points with Core Spec

Summary of how these three capabilities connect to `SUPERVISOR-SPEC.md`:

| Core Spec Section | Document Contract | Telemetry | Dedicated VM |
|-------------------|-------------------|-----------|--------------|
| **2.1 Schema** | No new tables (docs are files) | `telemetry_mirror` table (local read-only mirror) | No new tables (routing is Worker-side) |
| **3.4 wake_agent** | — | — | workspace_dir resolved per-company |
| **3.7 Supervisor API** | — | `POST /companies/{id}/telemetry/mirror` (Worker pushes) | — |
| **4.1 Planning** | CEO writes mission.md + executive-brief.md | — | Scope-aware provisioning |
| **8.1.1 invoke_ceo_turn** | Date header prepended to every prompt | Telemetry section appended (read from local mirror) | — |
| **8.2 process_ceo_response** | check_document_budgets() after CEO turns | — | — |
| **8.4 notify_ceo** | 'document_revision' event type added | — | — |
| **10.1 What Syncs** | — | Telemetry pushed Worker → VM (reverse sync) | — |
| **13 Cron Tasks** | Daily update request (30-min check) | — | — |
| **16 Startup** | — | Bootstrap: fetch telemetry mirror from D1 | Scope-aware bootstrap (step 4) |
| **17.1 CEO System Prompt** | Document + mission instructions added | "Do not invent metrics" instruction | — |
| **17.2 Worker System Prompt** | — | "Do not claim metrics" instruction | — |
