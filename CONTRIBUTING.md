# Contributing

Bug reports, documentation fixes, and focused pull requests are welcome. Start with the [README](README.md) and [quickstart](docs/quickstart.md).

## Report a bug or propose a change

Use [GitHub Issues](https://github.com/LukeJiaoR/yuva-agent-starter/issues). Search existing issues first, then include:

- The commit or core version, Node/npm/PostgreSQL versions, and operating system
- Minimal reproduction steps using synthetic data
- Expected and actual behavior
- Relevant errors with tokens, connection strings, private prompts, and personal data removed

For a large behavior or API change, describe the use case before implementing it. Security-sensitive reports follow [SECURITY.md](SECURITY.md), not the normal public bug-report flow.

## Develop locally

Fork and clone the repository, create a topic branch, and follow the [quickstart](docs/quickstart.md). Use Node.js 24 and the declared npm 10 toolchain. A full verification run also needs a disposable PostgreSQL 16+ database.

```bash
npm ci
npm run verify:boundaries
npm run check
TEST_DATABASE_URL=postgresql://starter:starter@localhost:5432/starter_agent npm run test:acceptance
npm run ops:verify
```

The URL above is only an example for a local disposable database. Never run tests against production. Clearly report skipped or blocked checks; a build alone does not validate database behavior. Additional container and browser checks are in [Testing](docs/testing.md).

## Keep changes focused

- Keep product-specific behavior in `starter-app` and `starter-web`. Core packages must not import the app or a domain.
- Test behavior changes, including failure, retry, and idempotency paths when relevant.
- Add a new numbered SQL migration for schema changes. Do not modify an already applied migration.
- Update the English and Chinese READMEs together when changing onboarding.
- Keep secrets, local environment files, real customer data, internal deployment records, and personal filesystem paths out of commits and logs.
- Preserve the existing license notices. Core version changes and release artifacts follow the [release guide](docs/releases.md).

## Submit a pull request

Open a focused pull request against `main`. Explain the problem, implementation, user-visible changes, and exact checks run. Include screenshots for UI changes where useful, using synthetic data. Note any remaining database, browser, or provider verification limits.

Release publication, production deployment, and live paid-provider calls are separate from ordinary contribution testing.
