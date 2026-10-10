# Quickstart

Run the included text-assistant template locally with a mock model and a development guest. You do not need a provider API key or a YUVA account.

## Requirements

- Git, Node.js 24 (recommended) or 22.12+, and npm 10 (`npm@10.9.8` is declared)
- PostgreSQL 16+, or Docker with Compose v2 to run the included PostgreSQL 16 service
- Available local ports: `5173` (web), `3000` (API), and `5432` (database)

These examples use a POSIX shell. In PowerShell, use `Copy-Item` instead of `cp`, and set environment variables with `$env:NAME = 'value'` before running a command.

## Host development

```bash
git clone https://github.com/LukeJiaoR/yuva-agent-starter.git
cd yuva-agent-starter
cp starter-app/.env.example starter-app/.env
cp starter-web/.env.example starter-web/.env
npm ci
```

If you use nvm, run `nvm use` first to select `.nvmrc`. Then start the database and wait for it to accept connections:

```bash
docker compose up -d --wait postgres
npm run db:setup
npm run dev
```

`db:setup` applies the migration chain, seeds the development guest, and checks the database contract. A successful run reports that migrations are up to date, the guest has credits, and the contract check passed. It is safe to rerun setup; the initial credit grant is idempotent.

Open **http://localhost:5173**. The header should say **API ready**. Keep the sample Subject, Parameters, and Question, then select **Prepare and continue** (or **Preview facts**, then **Ask agent**). The mock returns a deterministic answer; the UI should show **Completed** and **2 credits charged**. The initial guest grant is **25 credits**.

The mock does not call a model provider. Output travels through the same validation and credit flow as a real text request; it is buffered before delivery.

In another terminal:

```bash
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/ready
curl --fail http://localhost:3000/api/pricing
```

Expected results:

- `/health`: HTTP 200, `status: "ok"`
- `/ready`: HTTP 200, `status: "ready"`, `database: "connected"`
- `/api/pricing`: the default `fixed` strategy with `credits: 2`

Stop both development servers with Ctrl-C. `docker compose stop postgres` stops the database without removing its data. Run the startup commands again to resume.

## Database setup

The Compose database matches the local example:

```dotenv
DATABASE_URL=postgresql://starter:starter@localhost:5432/starter_agent
```

For an existing PostgreSQL server, create a dedicated database and login using your database administration tools. For a local development server, an administrator can use:

```sql
CREATE ROLE starter WITH LOGIN PASSWORD 'starter';
CREATE DATABASE starter_agent OWNER starter;
```

Use these sample credentials only on a local development database. Set `DATABASE_URL` to the actual host, port, database, and login, then run `npm run db:setup`. The migration user needs privileges to create the application's tables, indexes, and functions, and to enable the `pgcrypto` extension if it is not already installed. A hosted database may require TLS settings supplied by its host.

Do not share a database between unrelated generated products. Root shell environment variables take precedence over `.env` files; the database CLI also reads a root `.env` before `starter-app/.env`. Keep a single consistent database configuration for the API and database commands.

## All-container development

From a clone with Docker and Compose v2 installed:

```bash
docker compose up --build
```

This starts PostgreSQL, applies setup in the API container, and serves the web app through nginx at **http://localhost:8080**. The API is private to the Compose network, so check `http://localhost:8080/ready` for this flow. The host does not need Node.js.

`docker compose down` stops and removes containers while retaining the named database volume. The supplied Compose file uses explicit development values; changing `starter-app/.env` does not override its `environment` block. For real providers or production, configure the service environment deliberately and follow [Deployment](deployment.md).

## Use a real model

Set these server-only values in `starter-app/.env`, replacing both placeholders:

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your-provider-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-responses-compatible-model-id
```

The adapter calls `/responses`; a custom base URL must implement that API. Do not assume a Chat Completions-only endpoint works. The app accepts only `mock`, `openai`, and `anthropic` as provider modes.

For Anthropic, set `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and an `ANTHROPIC_MODEL` available to your account. Restart the API. Provider requests may be billable independently of the app's credits.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and web development servers |
| `npm run dev:api` / `npm run dev:web` | Start either server separately |
| `npm run build` | Build the Vite web app |
| `npm start` | Start the API only; does not serve the built web app |
| `npm run db:migrate` | Apply ordered, checksum-verified migrations |
| `npm run db:seed` | Create the development guest and its one-time initial grant |
| `npm run db:setup` | Migrate, seed, and check the database |
| `npm run db:check` | Check the database contract |
| `npm run check` | Run boundary checks, tests, and the web build |
| `npm run test:acceptance` | Require explicit `TEST_DATABASE_URL` and all acceptance suites |

See [Testing](testing.md) before running database-backed checks. A skipped or blocked database test is not a full pass.

## Troubleshooting

- **`EBADENGINE`:** check `node --version` and select Node.js 24 or 22.12+. The project enforces its Node engine range.
- **`ECONNREFUSED` from setup:** wait for PostgreSQL to be healthy and verify the database URL and port. If Docker is used, inspect `docker compose ps` and `docker compose logs postgres` locally.
- **`pgcrypto` extension error:** the baseline schema requires `pgcrypto`. Have your database administrator install or enable it if your PostgreSQL distribution or hosted plan does not provide it.
- **Authentication/database errors:** confirm that the role and database exist and match `DATABASE_URL`. Changing a Compose password does not change the credentials inside an already initialized volume.
- **`/ready` returns 503 / API unavailable:** `/ready` checks database connectivity. Verify PostgreSQL, then run `npm run db:check` to check the schema. `/health` alone is insufficient.
- **Insufficient credits:** the development seed grants once, so rerunning it does not top up a spent balance. For a new disposable database, choose a larger `DEV_GUEST_CREDITS` before its first setup; for an existing database, use your application's authorized credit-grant flow. Do not delete a database containing data you need.
- **Browser CORS error:** add the exact frontend origin to `CORS_ORIGIN` and restart the API.
- **Port already in use:** stop the conflicting service. If the API port changes, update both `PORT` and `VITE_API_PROXY_TARGET`; if the database port changes, update `DATABASE_URL` too. Vite deliberately fails when port 5173 is occupied.
- **Provider errors:** check the selected model and credentials. An OpenAI-compatible endpoint must support Responses, not just Chat Completions. Do not paste API keys or raw provider payloads into public issues.
- **Generator says the tree is dirty:** use a clean committed checkout, or explicitly choose `--development` for local experiments. Development bundles are not deployable release artifacts.
- **Generated project is not found:** its default path is next to the starter (`cd ../my-agent`), not inside it.

For further help, open a [redacted reproduction](https://github.com/LukeJiaoR/yuva-agent-starter/issues). For sensitive findings, follow [SECURITY.md](../SECURITY.md).
