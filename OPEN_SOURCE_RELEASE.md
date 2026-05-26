# Open Source Release Checklist

This repository is not ready to publish as-is. Use this checklist to cut a safe public branch.

## Current Status

- License exists: MIT.
- Community files exist: README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue templates, PR template.
- Secret-like local files are ignored going forward.
- Tracked generated artifacts and internal validation output have been removed from the public tree.
- Wrangler and dashboard examples use placeholder Cloudflare IDs, routes, admin IDs, and supervisor URLs.

## Must Do Before Making The Repository Public

1. Confirm tracked generated artifacts are absent:

```bash
git ls-files playwright-report test-results .factory/test-results .factory/validation 'tmp-*.png' tmp-check.db
```

2. Decide what to do with `.factory/`.

The `.factory` directory contains useful internal process docs and validation output. For a clean public launch, keep only reusable skills/docs and remove run-specific validation output.

Recommended public subset:

- `.factory/init.sh`
- `.factory/library/*.md` after review
- `.factory/skills/**/SKILL.md` after review

Review before keeping:

- `.factory/bootstrap-investigation-report.md`
- `.factory/dashboard-architecture-report.md`
- `.factory/research/*`

Remove:

- `.factory/test-results/`
- `.factory/validation/`

3. Review deployment configuration before publishing.

Files to review:

- `worker/wrangler.toml`
- `worker/wrangler.route-less.toml`
- `deploy/*.yml`
- `deploy/*.sh`
- `deploy/*.service`

Public configs should not contain real:

- production account IDs
- admin user IDs
- live IP addresses
- live D1/KV identifiers
- private domain routing assumptions
- credential names that imply real secret values

Prefer committing example config and keeping production config private.

4. Rotate any credential that has ever appeared in local files, terminal logs, screenshots, Playwright traces, or temporary artifacts.

At minimum, verify rotation for:

- Clerk secret keys
- Stripe secret and webhook keys
- Supervisor internal API key
- Anthropic/OpenRouter/Gemini keys
- AgentMail keys
- Browserbase keys
- Cloudflare tokens
- Porkbun keys

5. Review docs for private operational detail.

Search before release:

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!dashboard/node_modules/**' \
  '(sk-|whsec_|AIza|bb_live_|am_[a-z]{2}_|user_[A-Za-z0-9]|[0-9]{1,3}(\\.[0-9]{1,3}){3}|aicombinator\\.live|api\\.aicombinator\\.live)' .
```

Expected public docs may mention domains as examples, but private IDs, real users, and live infrastructure should be removed.

6. Run checks:

```bash
npm test
cd worker && npx tsc --noEmit -p tsconfig.json
cd ../dashboard && npm run build
cd ../supervisor && npm run typecheck
```

7. Confirm GitHub settings:

- Enable secret scanning.
- Enable Dependabot alerts.
- Add branch protection for `main`.
- Require pull request review before merge.
- Disable Actions secrets for forks unless explicitly needed.

## Suggested Public Branch Flow

```bash
git switch -c codex/open-source-prep
# apply cleanup changes
# remove tracked generated/private artifacts
# sanitize configs
# run checks
git status --short
```

Do not force-push a cleaned history over the private repository until the team has decided whether old private history must be rewritten. If old commits contain secrets or private artifacts, use a fresh public repository or a history-rewrite process.

## History Warning

Removing files in a new commit does not remove them from Git history. If any committed historical file contains real secrets, cookies, screenshots with private user data, or production credentials, treat those values as compromised and rotate them before publishing.
