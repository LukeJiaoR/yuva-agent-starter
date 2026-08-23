# Yuva Agent Starter

An open-source starter for shipping a vertical AI web application with a React UI, an Express API, PostgreSQL-backed credits, streaming responses, authentication hooks, and admin audit trails.

[中文说明](README.zh-CN.md) · [Documentation](docs/README.md) · [Architecture](ARCHITECTURE.md)

## What you get

- React 19 and Vite workspace UI with light and dark themes
- Express API with health and readiness checks, secure headers, CORS allowlists, and safe public errors
- Request-scoped AI streaming with OpenAI-compatible, Anthropic, DeepSeek, Ollama, and local mock providers
- PostgreSQL credit grants, atomic reservation and settlement, idempotent request replay, auth provisioning, rate limits, and admin audit logs
- Explicit domain seams for facts, prompts, validation, and pricing
- A project generator, Docker Compose stack, database setup commands, CI, and Node.js 22/24 coverage

## Fastest local start

Requirements: Node.js 24 (recommended), npm 10, and PostgreSQL 16 or newer.

```bash
cp starter-app/.env.example starter-app/.env
npm ci
npm run db:setup
npm run dev
```

Open `http://localhost:5173`. The default `mock` AI provider needs no API key. It is intentionally disabled when `NODE_ENV=production`.

The database defaults in `.env.example` match the Docker Compose database. If PostgreSQL is not already running, start only the database first:

```bash
docker compose up -d postgres
npm run db:setup
npm run dev
```

For an all-container smoke test:

```bash
docker compose up --build
```

Then open `http://localhost:8080`.

## Create a new app

From this repository:

```bash
npm run create -- my-agent --domain "Legal operations" --domain-key legal
cd my-agent
npm ci
npm run db:setup
npm run dev
```

The generator copies only reusable source, assigns the new package name, creates local environment files, and records the project metadata in `.starter.json`. Use `--install` to install dependencies during generation.

See [Creating a project](docs/creating-a-project.md) for naming, generated files, and the customization checklist.

## Where to customize

Most product-specific work stays in four files:

| Concern | File |
| --- | --- |
| Deterministic facts and input shape | `starter-app/server/domain/adapter.js` |
| System and analysis prompts | `starter-app/server/domain/prompts.js` |
| Feature credit costs | `starter-app/server/domain/pricing.config.js` |
| Product name and description | `starter-web/.env` |

Provider credentials and deployment configuration belong in `starter-app/.env`. Never commit that file.

## Quality gates

```bash
npm run check
```

This runs package and HTTP integration tests, repository-boundary checks, and production builds. The HTTP contract tests use an isolated PostgreSQL schema when `TEST_DATABASE_URL` or `DATABASE_URL` is available; CI treats a missing database as a failure.

## Documentation

Start at [docs/README.md](docs/README.md). It links to the quickstart, project creation, customization, API, testing, deployment, and architecture guides.

## License

[MIT](LICENSE)
