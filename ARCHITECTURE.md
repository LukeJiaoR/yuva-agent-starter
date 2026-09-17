# Architecture

Yuva Agent Starter uses a small hexagonal core: HTTP and provider adapters surround request-scoped orchestration, while product-specific behavior enters through explicit domain seams.

```text
React web
    |
Express routes and security middleware
    |
Agent runtime
    +-- domain facts and validation
    +-- prompt and context planning
    +-- AI provider streaming
    +-- credit reservation and settlement
    +-- identity and audit adapters
    |
PostgreSQL
```

## Workspaces

| Workspace | Responsibility |
| --- | --- |
| `starter-web` | Product UI, request forms, SSE consumption, status and error states |
| `starter-app` | Composition root, routes, domain adapter, provider selection, database access |
| `packages/ai-engine` | Provider-neutral streaming and request lifecycle |
| `packages/context-engine` | Token budgets and context selection |
| `packages/billing-core` | Credit grants, reservation, settlement, release, and replay |
| `packages/auth-core` | JWT/session authentication, user provisioning, rate limiting, redaction |
| `packages/admin-core` | Privileged operations and append-only audit records |

Core packages must not import `starter-app` or a vertical domain. `npm run verify:boundaries` enforces that rule.

## Request lifecycle

1. HTTP middleware applies security headers, JSON limits, CORS policy, and request authentication.
2. The domain adapter validates input and creates a deterministic facts snapshot.
3. Billing checks idempotency and atomically reserves credits.
4. Context and prompt adapters assemble the provider request.
5. Provider output is buffered server-side while SSE status events are emitted.
6. The validation seam accepts or transforms the complete output.
7. Billing settles measured usage, then the validated output and terminal usage are delivered.
8. Any failure releases the reservation and exposes only a stable public error.

Buffering is deliberate: unvalidated model text must never reach the client.

## Data boundaries

- `users` is the local identity projection and can be provisioned from an external provider.
- `credit_grants` is the source of available value.
- `credit_usage_requests` is the idempotent request and settlement record.
- `admin_audit_logs` records privileged mutations.
- `rate_limits` supports database-coordinated limits.
- Domain snapshots are JSON so a generated project can evolve its own typed contract without changing reusable packages.

## Runtime topology

Host development uses Vite on `5173`, Express on `3000`, and PostgreSQL on `5432`. Vite proxies API and probe paths to Express. The Compose stack exposes nginx on `8080`; nginx serves the built web app and proxies API traffic to the private API container.

## Production boundaries

- The local `mock` provider is rejected in production.
- `ALLOW_DEV_GUEST` must be false in production.
- Production must provide explicit allowed frontend origins and real provider/auth secrets.
- Run database migration before serving traffic.
- `/health` is liveness only; `/ready` verifies database connectivity.

See [Deployment](docs/deployment.md) for the operational checklist.
