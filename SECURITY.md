# Security Policy

AI Combinator coordinates authenticated users, payment flows, third-party API keys, autonomous agent execution, and VM-hosted runtime state. Please report security issues privately.

## Reporting a Vulnerability

Do not open a public GitHub issue for vulnerabilities, leaked credentials, auth bypasses, payment issues, or supervisor escape paths.

Send a private report to the maintainers with:

- A concise description of the issue.
- Steps to reproduce.
- Impact and affected component.
- Any logs, screenshots, or proof of concept that do not expose unrelated private data.

If you accidentally discover a real credential or user data, stop testing and report it privately.

## Sensitive Areas

Please be especially careful around:

- Clerk authentication and session handling.
- Stripe billing, credit balances, and webhook verification.
- Supervisor control routes and `SUPERVISOR_API_KEY`.
- Agent execution adapters and workspace access.
- Cloudflare Worker, D1, KV, and deployment configuration.
- Launch-session prompts and stored conversation data.

## Secret Handling

Never commit real values for:

- `CLERK_SECRET_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPERVISOR_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`
- `AGENTMAIL_API_KEY`
- `BROWSERBASE_API_KEY`
- Cloudflare, Porkbun, or VM provider credentials

Use example files and provider secret stores instead.
