# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Required Environment Variables

### Dashboard (.env.local)
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk auth publishable key
- `CLERK_SECRET_KEY` — Clerk auth secret key
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`
- `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`
- `NEXT_PUBLIC_API_URL` — Worker API URL (https://api.example.com)

### Worker (.dev.vars)
- `CLERK_SECRET_KEY` — Clerk JWT verification
- `CLERK_PUBLISHABLE_KEY` — Clerk publishable key
- `STRIPE_SECRET_KEY` — Stripe payment processing
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook verification
- `OPENROUTER_API_KEY` — OpenRouter API for LLM routing
- `INTERNAL_API_KEY` — Shared secret for supervisor communication
- Plus other secrets (do not expose)

### Supervisor (.env)
- `WORKER_API_URL` — Worker API URL
- `INTERNAL_API_KEY` — Shared secret
- `ANTHROPIC_API_KEY` — Claude API key
- `OPENROUTER_API_KEY` — OpenRouter API key for non-Anthropic model routing
- `PORT` — Supervisor port (8787)
- Plus optional: CACHE_REFRESH_MS, CRON_CHECK_MS, RELAY_ENABLED

## External Dependencies

- **Clerk** — Authentication (sign-in, JWT, user management)
- **Stripe** — Billing (subscriptions, token purchases, portal)
- **OpenRouter** — LLM routing (non-Anthropic models)
- **Anthropic** — Claude models (direct API)
- **Cloudflare** — Dashboard and Worker hosting (Workers, D1 database)

## Auth State

Saved Clerk session state at `.factory/auth-state.json` for agent-browser testing.
Valid until 2027-03-29. Use with `--storage-state` flag.
This file contains live session/cookie material and must never be committed; copy it to a temporary per-run file when needed.

## Testing Time-Mocking Quirk

In Vitest, stubbing `Date.now()` does not change `new Date()` behavior.
For deterministic clock tests, either use `vi.setSystemTime(...)` or make code consume `Date.now()` consistently.

## Known Pre-Existing Supervisor Log Noise

During supervisor deploy/health verification, logs may include:
`RequestInit: duplex option is required when sending a body`.

This has been observed as pre-existing noise while health checks still pass and the supervisor remains stable; do not treat it as a new regression by itself.
