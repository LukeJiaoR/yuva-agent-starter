# Yuva Agent Starter

Build a domain-specific AI web app on a reusable JavaScript foundation: React, Express, PostgreSQL, model adapters, authentication hooks, and a credit ledger.

The included app is a working text-assistant template. Replace its facts, prompts, pricing, and UI for your own product, such as a support assistant or document-analysis tool. No YUVA service or account is required to run it.

[简体中文](README.zh-CN.md) · [Quickstart](docs/quickstart.md) · [Documentation](docs/README.md) · [Architecture](ARCHITECTURE.md)

## Self-hosted authentication

Email/password signup, verification, password reset, cookie sessions, device
sign-out and a loopback-only development inbox are available through the
application-owned Better Auth adapter. Select `AUTH_MODE=self-hosted` and follow
[Self-hosted auth setup](docs/self-hosted-auth.md). Existing Clerk mode remains
available. No OAuth issuer, live provider setup or account migration runs automatically.

## What's included

- **Web app:** React 19 + Vite, structured input, facts preview, light/dark themes, request status, and credit feedback.
- **AI runtime:** request-scoped orchestration, context budgets, OpenAI Responses and Anthropic adapters, and a credential-free local mock.
- **Credits and recovery:** PostgreSQL-backed grants, reservations, fixed or token-based pricing, idempotent replay, usage records, and recovery primitives.
- **Application security:** authentication and user-provisioning hooks, rate-limit primitives, security headers, CORS allowlists, and safe public errors.
- **Reusable modules:** separate AI, context, billing, auth, and admin/audit packages, with enforced app/core boundaries.
- **Developer tooling:** project generation, versioned core bundles, migrations, tests, and development containers.

The default app delivers text over SSE. It buffers model output for validation before sending the answer; it is not an unfiltered token-by-token chat UI. Domain expertise, production sign-in UX, payment checkout, and live image/video generation are application work you add. Admin/audit APIs are provided as a library, not a bundled admin dashboard.

## Quickstart

### Requirements

- Git
- **Node.js 24.x** is required (`>=24.22.1 <25`; `.nvmrc` and `.node-version` select 24.22.1). Node.js 22 is no longer supported. Verified against the [official Node release index](https://nodejs.org/dist/index.json) on 2026-10-22: latest 24.x is 24.22.1 (2026-10-20 security release).
- **npm 10** is the declared package manager (`npm@10.9.8`).
- **PostgreSQL 16+**, or Docker with **Compose v2** for the supplied PostgreSQL 16 container.

Run these commands from a terminal. The examples use a POSIX shell; in PowerShell, use `Copy-Item` in place of `cp`.

```bash
git clone https://github.com/LukeJiaoR/yuva-agent-starter.git
cd yuva-agent-starter

cp starter-app/.env.example starter-app/.env
cp starter-web/.env.example starter-web/.env
npm ci

docker compose up -d --wait postgres
npm run db:setup
npm run dev
```

Already running PostgreSQL? Set `DATABASE_URL` in `starter-app/.env` to a database you created for this app and skip the Docker command. The database user needs permission to create the application's tables and functions. See [database setup](docs/quickstart.md#database-setup).

Open **http://localhost:5173**. Wait for **API ready**, keep the sample inputs, then select **Prepare and continue**. A successful first request returns a deterministic mock answer and a charge of **2 local credits**. Setup gives the development guest **25 credits**. No model API key, paid provider request, or payment account is needed for this local flow.

The API runs at `http://localhost:3000`. In a second terminal, check readiness:

```bash
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/ready
```

`/health` reports process liveness; `/ready` must return HTTP 200 with `"status":"ready"` and `"database":"connected"`. See [troubleshooting](docs/quickstart.md#troubleshooting) if it does not.

> Local defaults only: guest access, sample database credentials, and mock AI are for development. Do not expose this configuration to the internet. Production rejects the mock provider and needs your own authentication, secrets, and deployment configuration.

### All-container alternative

From the cloned repository, with Docker and Compose v2 installed:

```bash
docker compose up --build
```

Open **http://localhost:8080** once the services are healthy. Compose builds the web/API images, initializes PostgreSQL, and uses the same local mock. Node.js is not needed on the host for this path. Stop the stack with `docker compose down`; the database volume is retained.

## Configuration

Local configuration lives in two files:

| File | Purpose |
| --- | --- |
| `starter-app/.env` | Server-only database, provider, authentication, and runtime settings |
| `starter-web/.env` | Public app name, description, and Vite development proxy settings |

The [server example](starter-app/.env.example) and [web example](starter-web/.env.example) are the starting point. Important local defaults:

| Variable | Default / use |
| --- | --- |
| `DATABASE_URL` | `postgresql://starter:starter@localhost:5432/starter_agent` for the Compose database |
| `AI_PROVIDER` | `mock`; supported app values are `mock`, `openai`, and `anthropic` |
| `ALLOW_DEV_GUEST` | `true` for local development; set `false` for production |
| `DEV_GUEST_CREDITS` | `25`, granted once by the development seed |
| `PORT` | `3000` for the API |
| `CORS_ORIGIN` | Comma-separated allowed frontend origins |
| `VITE_API_PROXY_TARGET` | `http://127.0.0.1:3000` for local API requests |

Never commit credentials. Every `VITE_*` value can be included in browser code, so it must be safe to make public. Restart the relevant server after changing configuration.

### Use a real model (optional)

Edit `starter-app/.env`, replacing the placeholders with a credential and model available to your account:

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your-provider-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-responses-compatible-model-id
```

The OpenAI adapter uses **`/responses`**. A custom `OPENAI_BASE_URL` must support that API; compatibility with only `/chat/completions` is insufficient. There are no separate `deepseek` or `ollama` provider modes in the app.

For Anthropic, set `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_MODEL` instead. Use the model ID supported by your provider account. Real providers can incur charges independently of this app's local credit ledger.

## Create your own project

Run the generator from a **clean checkout** of this repository:

```bash
npm run create -- my-agent --domain "Customer support" --domain-key support --install
cd ../my-agent

docker compose up -d --wait postgres
npm run db:setup
npm run dev
```

The default output is a **sibling directory**, not a child of the starter. Use `--target /path/to/my-agent` to choose another location. Do not run the template's and generated app's database containers on the same host port at the same time; use a separate database for each product.

The generator writes local environment files and product workspaces. Reusable core packages are pinned as verified local tarballs under `vendor/yuva-core/`, rather than copied as editable core source. No private npm registry or GitHub token is required for this flow. See [project creation](docs/creating-a-project.md) and [core upgrades](docs/releases.md).

## Architecture and customization

```text
React UI -> Express API -> domain facts + prompt/context planning
                              |
                         AI provider adapter
                              |
                    validation + credit settlement
                              |
                    PostgreSQL -> SSE response
```

| Location | Responsibility / extension point |
| --- | --- |
| `starter-web/` | Product UI, branding, and API client |
| `starter-app/server/domain/adapter.js` | Product input, facts, snapshots, and context |
| `starter-app/server/domain/prompts.js` | Product-specific instructions |
| `starter-app/server/domain/pricing.config.js` | Default fixed feature prices |
| `starter-app/server/domain/aiProduct.js` | Fixed/token pricing, execution limits, fulfillment, and result persistence |
| `starter-app/server/index.js` | Dependency injection, auth, routes, and output-validation hook |
| `packages/` | Reusable `ai-engine`, `context-engine`, `billing-core`, `auth-core`, and `admin-core` |
| `scripts/schema.sql`, `scripts/migrations/` | Baseline schema and ordered migrations |
| `examples/customer-support/` | Independently installed consumer example |

Keep product behavior in the application workspaces. The supplied facts adapter is a minimal example; it does not implement your domain's calculations. Follow the [customization guide](docs/customization.md) before treating generated output as product-ready.

## Development and verification

```bash
npm run verify:boundaries  # Check reusable package boundaries
npm run build             # Build the web app
npm run check             # Boundary checks, tests, then web build
```

Database-backed tests need a **dedicated disposable PostgreSQL database**. For the fail-closed acceptance gate, set an explicit URL:

```bash
TEST_DATABASE_URL=postgresql://starter:starter@localhost:5432/starter_agent npm run test:acceptance
```

Use that example URL only for your disposable local database. Some local tests can skip without a reachable database; other suites fail. A partial test run or a successful web build does not establish database or end-to-end correctness. See [testing](docs/testing.md) for the full gate and browser smoke checklist.

## Documentation

- [Quickstart and troubleshooting](docs/quickstart.md)
- [Generate an independent app](docs/creating-a-project.md)
- [Customize domain, auth, pricing, and UI](docs/customization.md)
- [HTTP and SSE API](docs/api.md)
- [Architecture and package boundaries](ARCHITECTURE.md)
- [Testing](docs/testing.md) and [production deployment](docs/deployment.md)
- [Core releases and upgrades](docs/releases.md)
- [All documentation](docs/README.md)

## Contributing, support, and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and pull requests. Use [GitHub Issues](https://github.com/LukeJiaoR/yuva-agent-starter/issues) for reproducible bugs, questions, and feature proposals; redact credentials and private data from examples and logs.

For suspected vulnerabilities or exposed secrets, follow [SECURITY.md](SECURITY.md). Do not publish exploit details or credentials in an issue.

## License

[MIT](LICENSE). Dependency licenses remain with their respective authors.

### Local mock image product

An opt-in authenticated **1×1 synthetic PNG demo** exercises durable image artifacts, fixed-credit settlement and scoped restart recovery without a real image provider. It is disabled by default and rejected in production. See [local mock image configuration and API](docs/mock-image-product.md).

Read-only operation timeline and trusted operator wiring: [operations guide](docs/operations-read-only.md). Disabled by default.

### Optional local synthetic checkout

[Local synthetic checkout orders](docs/mock-checkout.md) provides an explicitly enabled, authenticated, loopback-only test order demo. It records pending/cancelled synthetic orders in the existing payments table. It never takes money or grants credits; the fixed pack values are illustrative only. Default off; requires a disposable-database acknowledgement and trusted local browser origin.
