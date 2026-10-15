# Documentation

## Start here

1. [Quickstart](quickstart.md): clone, install, configure PostgreSQL, run the mock app, and troubleshoot.
2. [Creating a project](creating-a-project.md): generate an independent product with pinned core packages.
3. [Customization](customization.md): replace domain facts, prompts, validation, pricing, auth, and UI.
4. [API reference](api.md): use the HTTP and SSE contracts.
5. [Testing](testing.md): run unit, database, acceptance, and browser checks.
6. [Deployment](deployment.md): prepare production configuration and rollout.

## Architecture

- [System overview and workspaces](../ARCHITECTURE.md)
- [Core ownership and extension points](architecture/core-ownership.md)
- [Operations, pricing, and settlement](architecture/pricing-and-settlement.md)
- [Durable usage and provenance](architecture/usage.md)
- [Execution budgets](architecture/execution-budget.md)
- [Token pricing](architecture/token-pricing.md)
- [Operation recovery](architecture/recovery.md)

## Releases and operations

- [Versioned core bundles and upgrades](releases.md)
- [Independent Customer Support example](../examples/customer-support/README.md)
- [Public consumer migration evidence](maintenance/consumer-migration.md)
- [Runtime configuration, service lifecycle, and backup/restore](maintenance/operations.md)

## Project information

- [Contributing](../CONTRIBUTING.md)
- [Security reporting](../SECURITY.md)
- [MIT license](../LICENSE)
- [GitHub Issues](https://github.com/LukeJiaoR/yuva-agent-starter/issues)

## Runtime baseline and source of truth

Node.js 24.x is the only supported Node major, npm 10 is the declared package manager, and the database baseline is PostgreSQL 16+. The web app targets modern browsers; validate the browsers your product supports before release.

Executable code, `.env.example`, `scripts/schema.sql`, `scripts/migrations/`, release manifests, and CI configuration define the current behavior. Historical release or test records are evidence for their recorded version, not a guarantee that the current checkout or a deployment has passed. Report documentation mismatches with a reproducible example.

- [Local model catalog foundation](model-catalog.md): explicit approval, versioned text bindings, and current limitations.
