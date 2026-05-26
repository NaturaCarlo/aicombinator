---
name: deploy-test-worker
description: Deploys all packages, runs D1 migrations, and performs comprehensive E2E browser testing.
---

# Deploy & Test Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill
- Deploying all 3 packages (dashboard, worker, supervisor) to production/staging
- Running D1 database migrations
- Comprehensive end-to-end testing of the full deployed application
- Verifying every page and feature works after a release

## Required Skills
- **agent-browser** — MUST be invoked for all browser-based E2E testing.

## Work Procedure

### Phase 1: Deploy

1. **Deploy the worker package**
   ```bash
   npm run deploy --prefix /Users/CEF/Projects/automaton/worker
   ```

2. **Run D1 migrations**
   ```bash
   npm run db:migrate --prefix /Users/CEF/Projects/automaton/worker
   ```

3. **Deploy the supervisor**
   ```bash
   cd /Users/CEF/Projects/automaton && ./deploy/deploy.sh
   ```

4. **Deploy the dashboard**
   ```bash
   npm run deploy --prefix /Users/CEF/Projects/automaton/dashboard
   ```

5. **Record output** — Capture stdout/stderr for every deploy command. Note any warnings or errors.

### Phase 2: Health Checks

6. **Verify each service is healthy** — Hit the health/status endpoint of each deployed service and confirm a 200 response:
   - Dashboard: load the main URL, confirm page renders.
   - Worker API: call the health endpoint.
   - Supervisor: call the health endpoint.

   Record the HTTP status code and response time for each.

### Phase 3: E2E Browser Testing

7. **Invoke the `agent-browser` skill** — This is mandatory.

8. **Use saved auth state** at `.factory/auth-state.json` if authentication is required.

9. **Test every page and feature systematically**:
   - **Login / Auth flow** — Verify login works (or auth state loads correctly).
   - **Dashboard home** — Page loads, data populates, no console errors.
   - **Sidebar navigation** — Every link navigates correctly.
   - **Model selector** — All model tiers appear and can be selected.
   - **Chat / Agent interaction** — Send a message, receive a response.
   - **Settings page** — All settings render, can be modified and saved.
   - **Portfolio page** — Data loads, charts/tables render.
   - **Responsive layout** — Check at mobile (375px) and desktop (1440px) widths.

10. **Take screenshots** — Capture a screenshot of every major page and any failures.

11. **Record pass/fail for each feature** with a brief note on what was observed.

### Phase 4: Prepare Handoff

12. **Compile results** — Gather deploy outputs, health checks, screenshots, and per-feature test results.

## Example Handoff

```json
{
  "worker_type": "deploy-test-worker",
  "status": "complete",
  "deploy_outputs": {
    "worker": { "success": true, "url": "https://worker.example.com", "output_summary": "Deployed in 12s" },
    "supervisor": { "success": true, "url": "https://supervisor.example.com", "output_summary": "Deployed in 8s" },
    "dashboard": { "success": true, "url": "https://dashboard.example.com", "output_summary": "Deployed in 22s" }
  },
  "migrations": {
    "success": true,
    "output_summary": "Applied 2 pending migrations"
  },
  "health_checks": {
    "worker": { "status": 200, "response_time_ms": 120 },
    "supervisor": { "status": 200, "response_time_ms": 95 },
    "dashboard": { "status": 200, "response_time_ms": 340 }
  },
  "e2e_results": [
    { "feature": "Login / Auth", "result": "pass", "note": "Auth state loaded, redirected to dashboard" },
    { "feature": "Dashboard Home", "result": "pass", "note": "All widgets rendered, no console errors" },
    { "feature": "Sidebar Navigation", "result": "pass", "note": "All 5 links navigate correctly" },
    { "feature": "Model Selector", "result": "pass", "note": "3 tiers shown: fast, standard, premium" },
    { "feature": "Chat / Agent", "result": "pass", "note": "Sent test message, received response in 2.1s" },
    { "feature": "Settings Page", "result": "pass", "note": "All fields editable and save persists" },
    { "feature": "Portfolio Page", "result": "pass", "note": "Charts render with live data" },
    { "feature": "Responsive (375px)", "result": "pass", "note": "Sidebar collapses, content stacks" },
    { "feature": "Responsive (1440px)", "result": "pass", "note": "Full sidebar, 3-column layout" }
  ],
  "screenshots": [
    "screenshots/dashboard-home.png",
    "screenshots/settings.png",
    "screenshots/portfolio.png",
    "screenshots/mobile-view.png"
  ],
  "notes": ""
}
```

## When to Return to Orchestrator
- All deploys succeed, all health checks pass, and all E2E tests pass — return `status: complete`.
- Any deploy fails — return `status: blocked` with the deploy error output.
- Health checks fail — return `status: blocked` with the failing service and HTTP response.
- E2E tests have failures — return `status: partial` with the full results (pass and fail) so the orchestrator can dispatch fix workers.
