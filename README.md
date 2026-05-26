# AI Combinator

AI Combinator is an experimental platform for launching and operating autonomous AI companies. A founder shapes a company idea, the platform provisions a founding team of agents, and the supervisor coordinates planning, task execution, founder communication, documents, credits, and runtime state.

This repository contains the main product surface:

- `dashboard/` - Next.js founder dashboard and launch studio.
- `worker/` - Cloudflare Worker API, D1 schema, billing, auth, launch sessions, public routes, and supervisor bridge.
- `supervisor/` - VM-hosted runtime that manages companies, agents, tasks, credits, scheduling, and agent execution.
- `tests/` - unit, API, and Playwright test suites.
- `docs/` - architecture notes and public extension specifications.
- `deploy/` - supervisor VM deployment assets.

The project is under active development. The current codebase is useful for studying the architecture and contributing to the platform, but a production deployment requires several third-party services and private credentials.

## Architecture

At a high level:

1. The dashboard talks to the Worker API.
2. The Worker owns auth, billing, public API shape, D1 persistence, and Cloudflare integrations.
3. The supervisor owns live runtime truth for companies, agents, tasks, scheduling, and agent turns.
4. D1 mirrors runtime state for founder views, recovery, billing, and public routes.
5. The launch studio creates a structured company brief before provisioning begins.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/open-source-spec.md](docs/open-source-spec.md) for deeper notes.

## Requirements

- Node.js 20+
- npm
- Cloudflare account for Worker/D1/KV/Pages-style deployment
- A VM or compatible host for the supervisor
- Clerk for auth
- Stripe for billing
- At least one LLM provider key

Optional integrations include AgentMail, Browserbase, Porkbun, Gemini, OpenRouter, and Anthropic.

## Local Setup

Install dependencies from the repository root:

```bash
npm install
cd worker && npm install
cd ../dashboard && npm install
cd ../supervisor && npm install
```

Prepare environment files from examples:

```bash
cp .env.example .env.local
cp dashboard/.env.local.example dashboard/.env.local
cp supervisor/.env.example supervisor/.env
cp tests/.env.test.example tests/.env.test
```

Run typechecks and tests:

```bash
npm test
cd worker && npx tsc --noEmit -p tsconfig.json
cd ../dashboard && npm run build
cd ../supervisor && npm run typecheck
```

Run local services in separate terminals:

```bash
cd worker && npm run dev
cd dashboard && npm run dev
cd supervisor && npm run dev
```

## Environment

The examples intentionally use placeholders. Do not commit real keys.

Important settings:

- `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `SUPERVISOR_API_KEY`
- `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`
- `WORKER_API_URL`, `FRONTEND_URL`
- Cloudflare D1, KV, and account identifiers

The production `worker/wrangler.toml` in a private deployment may contain account-specific identifiers. For a public fork, use a sanitized Wrangler config and set secrets with `wrangler secret put`.

## Tests

Common commands:

```bash
npm test
cd worker && npx tsc --noEmit -p tsconfig.json
cd dashboard && npm run build
cd supervisor && npm run typecheck
```

Playwright tests require valid test credentials and should not commit generated screenshots or traces.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening issues or pull requests.

## Security

Please read [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities or leaked credentials.

## License

MIT. See [LICENSE](LICENSE).
