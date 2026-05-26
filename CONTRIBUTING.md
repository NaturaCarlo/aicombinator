# Contributing

Thanks for helping improve AI Combinator. This project is still moving quickly, so the most helpful contributions are small, well-scoped, and easy to verify.

## Development Setup

Install dependencies:

```bash
npm install
cd worker && npm install
cd ../dashboard && npm install
cd ../supervisor && npm install
```

Create local environment files from examples:

```bash
cp .env.example .env.local
cp dashboard/.env.local.example dashboard/.env.local
cp supervisor/.env.example supervisor/.env
cp tests/.env.test.example tests/.env.test
```

Do not commit real credentials, local database files, screenshots, traces, or generated test output.

## Checks

Run the relevant checks before opening a pull request:

```bash
npm test
cd worker && npx tsc --noEmit -p tsconfig.json
cd dashboard && npm run build
cd supervisor && npm run typecheck
```

For frontend changes, include screenshots or a short description of the workflow you tested. For runtime or Worker changes, include the affected route, state transition, or migration path.

## Pull Requests

Please keep pull requests focused. A good PR includes:

- The problem being fixed.
- The approach taken.
- The checks that were run.
- Any migration, deployment, or configuration implications.

Avoid mixing product changes, refactors, and generated artifacts in one PR.

## Project Boundaries

The supervisor is the live runtime authority. The Worker owns auth, billing, public API shape, and D1 persistence. The dashboard should render canonical backend state rather than reconstructing runtime truth from raw rows.

When in doubt, prefer a small change that preserves these boundaries.
