# Running and maintaining the shared solution

Status: implemented template and local drill evidence, not a production rollout.
Owner: repository maintainers. Template version: 1.0.0, reviewed 2026-09-17.

[Service registry](../../ops/stack.json) names component interfaces, service owners,
configuration names, maturity, failure procedure and review cadence. Operators
replace role owners with accountable contacts in the project's private record.
[Consumer registry](consumers.json) records core versions and schema ownership.
No secret values are stored in these registries.

## Default supported deployment

Node 24.x only, PostgreSQL 16, Express API and Vite/nginx
frontend. Product-specific authentication/profile rules, pricing and delivery are
injected at composition. This release does not implement a payment provider,
marketing service or image/video generator. Their status is product-owned/deferred
in the registry, not silently enabled by adding a credential.

Use `ops/compose.production.yaml` as the portable baseline. It takes an external
database, starts no seed, requires a protected environment file, keeps API private
to the container network and binds web to loopback for an HTTPS reverse proxy.
Project name, environment, database and domain must be unique per product/env.
Do not use development Compose with production secrets: it enables mock/guest.

```sh
npm ci
npm run check
npm run ops:verify
# Load environment using the host secret manager without printing values.
npm run ops:verify -- --production
APP_ENV_FILE=/protected/path/app.env docker compose -f ops/compose.production.yaml config --quiet
APP_ENV_FILE=/protected/path/app.env docker compose -f ops/compose.production.yaml build
APP_ENV_FILE=/protected/path/app.env docker compose -f ops/compose.production.yaml run --rm api npm run db:migrate
APP_ENV_FILE=/protected/path/app.env docker compose -f ops/compose.production.yaml up -d
```

These are operator commands, not actions performed by this change. Verify archive
pins/lockfile before building. `ops/production.env.example` contains placeholders.
Validation returns field names and reasons, not values, and does not prove external
credentials, DNS or TLS are ready. No package install migrates the database.

Core and copied runtime templates have separate lifecycle. Package upgrades do
not rewrite product Dockerfiles, workflows or environments. Record template
versions and review their updates in separate PRs. Base tags track the supported
major; operators pin built image digests for exact rollback and refresh bases
through reviewed security changes. Avoid arbitrary cloud/database expansion.

## One-shot operational inspection

```sh
OPS_BASE_URL=https://api.example.test DATABASE_URL=<read-only-db-url> npm run ops:inspect
```

The command reads health/readiness, aggregate active/released/reconciliation counts
and oldest reservation age. It schedules nothing, sends no messages, never
releases credits, and prints no request text or personal identifiers. Use read-only
DB credentials. Cost output explicitly says unavailable: durable per-call cost
integration/recovery remains Epic #1. Until then use provider cost/budget dashboards;
missing coverage is not zero cost.

The registry recommends alerting after two readiness failures and investigating
reservations older than 15 minutes, tuned per product duration. An external monitor
may invoke this command; none is configured here. During provider failure disable
new costly requests via product controls, preserve operation/call identity and
follow its recovery runbook. Disconnect/lease expiry is not proof of failure.

## Backup, restore and rollback

Planning defaults: daily backups, 14-day retention, RPO 24 hours, RTO 60 minutes.
These are operator targets, not production guarantees. Encrypt backups, store them
separately from the app, restrict access, check freshness, and test restoration
monthly and before incompatible migrations. Operators choose actual resources.

Before release record application SHA, core manifest hash, lockfile, image digest,
configuration version and migration versions. Take/inspect a backup. Apply forward
migrations only within an understood old/new app compatibility window. Database
restore requires stopping writes and an explicit recovery decision; reverting
code does not revert schema or data.

For an incident: stop writes, preserve evidence, restore to an isolated database,
compare identities/balances/ledger, check migrations and smoke, then explicitly
cut over. Keep the prior DB until reconciliation completes. Do not run unreviewed
`pg_restore --clean` against a live database.

### Actual local restore drill

```sh
TEST_DATABASE_URL=<loopback-test-db-url> PG_TOOLS_BIN=/path/to/postgres-16/bin npm run ops:restore-drill
# Alternative: matching local test DB container and its PostgreSQL 16 clients.
TEST_DATABASE_URL=<loopback-test-db-url> PG_TOOL_CONTAINER=<test-db-container> npm run ops:restore-drill
```

The drill rejects non-loopback and NODE_ENV=production. It creates a random schema,
applies migrations, creates synthetic identity/grants/settled ledger, uses real
pg_dump/pg_restore, drops only its schema, restores and compares every table's data
hash, then reruns migration checks. It removes its schema and temporary dump.
The container must address the same local test DB; test credentials need schema
creation privileges.

[Recorded evidence](restore-evidence.json): PostgreSQL 16.14 clients, 15 tables,
56,783-byte custom backup, exact data match, migration recheck passed, 586 ms for
the synthetic drill. This validates mechanics, not production-scale RPO/RTO. The
evidence contains no credentials or database addresses.

## Service and credential lifecycle

Separate database, auth instance/application, provider key/quota, webhook endpoint
and cost attribution per project/environment. A central vendor account is suitable
only if it supports these isolation boundaries; otherwise operators use separate
accounts. Current service implementation/version/owner is in the registry.

Review dependency PRs weekly and critical advisories promptly. Monthly inspect
API/model retirement notices, SDK compatibility, limits/rates and service owners.
Pin replacements, test fixtures and a bounded authorized provider smoke, then
update the product configuration through its release flow. Vendor cost changes
never rewrite frozen user prices or historical ledger entries.

Rotate credentials after exposure/access changes and per provider policy. Where
supported, add the new key, configure the target, validate, retire the old key and
record completion. Webhook signing-key overlap must cover expected retries.
Never commit values or include them in logs; registry entries are variable names.

Support latest stable and the prior minor until consumers have migration evidence.
Security incidents can shorten the window with a documented upgrade requirement.
Unknown manifest/schema compatibility must fail rather than silently change code
under an existing release version.

## Verification evidence

Node 24.14.0 full check: 102 tests passed and web build passed. Production Compose
configuration validates using placeholders without printing expanded secrets.
Local container builds were stopped while waiting for Docker Hub base-image metadata; no local container
build success is claimed. The Node 24 CI job builds both portable images.
