# Testing

## Full gate

```bash
npm run check
```

The gate runs:

1. Vitest unit and integration suites.
2. Boundary validation preventing app/domain imports from reusable packages.
3. Production builds for workspaces that define them.

## PostgreSQL-backed HTTP contracts

`starter-app/tests/httpContract.test.js` applies the real schema to an isolated schema, starts the actual Express app on an ephemeral port, and verifies probes, headers, safe parsing errors, auth provisioning, admin audit lifecycle, and that rejected model output is not streamed.

Set a dedicated database when needed:

```bash
TEST_DATABASE_URL=postgresql://starter:starter@localhost:5432/starter_agent npm test
```

Locally, PostgreSQL-dependent tests may skip when no database URL is reachable. In CI, absence is a failure. Never point tests at a production database.

## Runtime matrix

CI runs tests, boundary checks, and builds on Node.js 22 and 24. Node.js 24 is the recommended local and container runtime.

## Manual browser smoke

- Start from an empty database and complete the first prompt.
- Verify the readiness badge transitions correctly.
- Verify light and dark themes persist after reload.
- Exercise malformed JSON parameters and API/provider errors.
- Check keyboard focus and narrow mobile layout.
- Retry the same request ID through an API client and confirm it does not charge twice.

## Before release

Also build both container images and validate `docker compose config`. For provider or auth changes, run a smoke test against the same provider mode and issuer configuration used by the target environment.
