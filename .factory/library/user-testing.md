# User Testing

## Validation Surface

**Primary surface:** Browser (example.com)
- Launch page: idea input → CEO conversation → provisioning → company dashboard
- Tool: agent-browser
- Auth state: `.factory/auth-state.json`

**Secondary surface:** API endpoints
- Worker API: api.example.com
- Tool: curl
- Health check: `curl -sf https://api.example.com/health`

**Supervisor:** 203.0.113.10:8787
- Tool: curl
- Health check: `curl -sf http://203.0.113.10:8787/health`

## Validation Concurrency

**Machine specs:** 48GB RAM, 18 CPU cores, macOS
**Baseline usage:** ~6GB RAM, light CPU

**agent-browser surface:**
- Each instance: ~300MB RAM (browser + agent)
- Dev server: not needed (deployed to Cloudflare)
- Headroom: ~42GB * 0.7 = 29GB usable
- Max concurrent: **5** (1.5GB total, well within budget)

**curl surface:**
- Negligible resource usage
- Max concurrent: **5**

## Testing Notes

- All services are deployed (no local dev servers)
- Dashboard: Cloudflare Workers at example.com
- Worker API: Cloudflare Workers at api.example.com
- Launch flow is the primary user journey to test
- SSE streaming requires real Claude API calls — tests should account for 5-30s response times
- In some launch states, `Start with the CEO` can remain disabled after name entry; use `I'm Feeling Lucky` to progress into conversation flows for validation.
- `agent-browser` request capture may return `No requests captured`; when this occurs, supplement with in-page fetch instrumentation and/or curl evidence.
- Browser runs currently surface a non-blocking runtime console error: `__name is not defined`.
- Deploy-smoke validation surfaced a recurring launch entry blocker on `/launch`: `Could not verify your session. Refresh and try again.` This can block streaming-dependent assertions even when service health checks pass.
- For deploy-smoke reruns, verify launch session creation immediately before allocating time to streaming/perf assertions; if blocked, capture the session-error evidence first, then mark dependent assertions blocked.

## Flow Validator Guidance: backend-contract-validation

- Work only on assigned assertion IDs and write exactly one flow report JSON per assignment.
- Use read-only verification against repository tests/code paths plus non-mutating health checks; avoid production launch mutations unless the assertion explicitly requires live behavior.
- If any live API interaction is needed, use unique identifiers (session/idea strings with a timestamp suffix) and do not reuse resources across validators.
- Keep artifacts isolated under the assigned evidence directory and do not write outside `.factory/validation/<milestone>/user-testing/flows/` and mission evidence paths.

## Flow Validator Guidance: browser-launch-flow

- Use `agent-browser` only with explicit session IDs scoped to this worker run.
- Use unique test idea/session text per assertion group to avoid cross-run contamination.
- Do not reuse active launch sessions across groups; create a fresh run per group.
- Keep all screenshots/log artifacts inside the assigned evidence directory only.
- Do not modify code or production settings during flow validation.
