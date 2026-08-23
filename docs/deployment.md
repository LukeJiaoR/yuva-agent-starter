# Deployment

The included containers are a portable baseline, not a hosted-platform requirement. Deploy the web image, API image, and PostgreSQL on your preferred platform, or reproduce the same build commands in managed services.

## Build

```bash
npm ci
npm run check
docker compose build
```

Apply the schema before starting a new API release:

```bash
NODE_ENV=production npm run db:migrate
npm run db:check
```

## Required production decisions

- Set `NODE_ENV=production`.
- Set `ALLOW_DEV_GUEST_AUTH=false`.
- Use a real `AI_PROVIDER`; production rejects `mock`.
- Provide a strong PostgreSQL connection with TLS as required by the host.
- Set exact comma-separated `CORS_ORIGIN` values. Do not use `*` with authenticated traffic.
- Configure identity issuer, audience, authorized parties, and secrets.
- Store all credentials in the platform secret manager, not an image or repository.
- Treat `starter-web/.env.production` as public build configuration; never place secrets in a `VITE_*` variable.
- Define backup, restore, retention, and migration rollback procedures.

## Probes and rollout

Use `/health` for process liveness and `/ready` for database-aware readiness. Stop sending traffic before shutdown, allow in-flight streams to finish, and keep API instances stateless; PostgreSQL owns request idempotency and billing state.

## Reverse proxy

The included nginx image serves the Vite build and proxies `/api`, `/health`, and `/ready` to the API service. If the platform routes services directly, reproduce these paths and preserve SSE streaming without response buffering.

## Security checklist

- HTTPS is terminated at the edge.
- CORS and authorized parties contain only controlled domains.
- Development guest access and mock AI are disabled.
- Request body limits and edge rate limits are configured.
- Public logs contain request identifiers but no tokens, prompts, or sensitive domain payloads.
- Admin routes require explicit roles and all mutations create audit records.
- Database role privileges are scoped to the application schema.

## Smoke after deployment

1. Confirm `/health` and `/ready` return `200`.
2. Confirm an unauthorized request is rejected.
3. Complete a valid authenticated stream.
4. Verify one credit settlement and an audit/log correlation by request ID.
5. Force a provider failure and verify credit release plus a safe public error.
