# Core release and consumer upgrades

Owner: repository maintainers. Source and port ownership: [ADR](architecture/core-ownership.md).

All five packages use coordinated semver. Patch = compatible fix, minor = additive
interface, major = incompatible contract/schema requirement. No package install
runs SQL. Latest stable plus the prior minor remain supported until consumers have
upgrade evidence; a security fix can require an expedited upgrade. A clean tree,
`development=false`, or a successful checksum check does not prove publication or
deployment readiness. Review the authenticated release/tag, compatibility, and
consumer acceptance separately.

This repository is public. Core bundles are available from its GitHub Releases.
The release/upgrade scripts use `gh`; configure that tool separately if it requests
authentication. Downloaded bundles are verified and vendored as tarballs in
consumer `vendor/yuva-core/<version>`. Credentials never belong in npm URLs,
lockfiles or build containers. SHA-512
pins package bytes; `.core-release.json` pins the manifest SHA-256 and source SHA.
Digests detect changes relative to a trusted pin, not independent authorship:
review the authenticated source/tag and changed manifest in every upgrade PR.

## Current runtime policy

The current starter, generated products, maintained example, and core source
support Node.js 24.x only (`>=24 <25`). The next versioned core release will carry
this engine requirement and advertise only Node 24 in its compatibility manifest.
Published 1.x tags, archives, hashes, and their recorded compatibility remain
immutable. Historical release notes describe those original releases, not the
current starter's support policy. The example retains its original core-v1.2.0
vendor bundle while requiring Node 24 at the application boundary.

## Core 1.5.0 explicit provider-default output policy

[Core 1.5.0](releases/1.5.0.md) adds an opt-in OpenAI Responses output-token
policy. Existing numeric/default behavior and frozen execution budgets remain
unchanged. Products adopt the new policy through their own reviewed upgrades.

## Core 1.4.0 explicit free execution

[Core 1.4.0](releases/1.4.0.md) adds an explicit, opt-in free usage lifecycle.
Consumer-owned schema support and generation limits are required before use;
ordinary positive Credit APIs retain their guards.

## Core 1.3.0 compatibility updates

[Core 1.3.0](releases/1.3.0.md) adds complete-conversation context exports and
optional Credit grant source filtering, and accepts `max`/`xhigh` reasoning
efforts through the Responses adapter. Existing public budget APIs and
unrestricted reservation behavior remain available.

The administrative account update explicitly types its negative Credit delta as
PostgreSQL `integer`, matching `credit_accounts.available_credits`. This prevents
SQLSTATE `42725` (ambiguous unary minus) during manual membership expiration,
administrative deductions, and reversals. The balance guard, account lock,
transaction boundary and ledger behavior are unchanged; no migration is needed.

`starter-app/tests/creditAdjustments.test.js` exercises these public operations on
an isolated PostgreSQL schema, including exact-zero balances, positive reversal,
insufficient-balance rollback, repeated expiration and concurrent expirations.
Consumers receive these fixes through the new immutable 1.3.0 artifacts and a
separate consumer upgrade; previously published archives and deployed consumers
are not modified by this release.

## Release

Merge and pass Node 24 CI first. On the selected clean main commit:

```sh
npm run release:pack -- --output .release
node scripts/release/publish.mjs .release
```

The manual Release Core workflow runs the checks and these commands. It never
runs on push or PR. Publication refuses an existing version and verifies source
ancestry in main. Increase component versions and add release notes before the
next release. Existing asset names/hashes must never be overwritten. Downloaded
consumer pins still detect any out-of-band replacement.

`release:pack` records `buildIntent: release-candidate` for clean source; packing
does not publish it. `--development` explicitly records development intent even
for a clean tree. `--allow-dirty` separately permits uncommitted source, which is
always marked development. These labels describe local build intent, not trust
or a safety certification. Publication does not rewrite the candidate's bytes or
metadata; the authenticated release and tag provide the separate publication
evidence. Older manifests without `buildIntent` remain supported with unknown
build intent; no publication status is inferred from their version number.

## Create a product

```sh
gh release download core-v1.1.0 --repo LukeJiaoR/yuva-agent-starter --dir /tmp/yuva-core-1.1.0
npm run create -- support-agent --domain 'Customer support' --bundle /tmp/yuva-core-1.1.0
```

Without `--bundle`, the generator packs the checked-out source as a **local
development bundle**, even when the tree is clean. Uncommitted source still
requires explicit `--development`. The generated `npm test` / `npm run check`
path explicitly allows development integrity verification, prints the limitation,
and remains usable locally. `npm run core:verify` rejects development bundles by
default; use `npm run core:verify -- --development` only for an intentional local
integrity check. No verifier here certifies that a candidate or legacy bundle has
been published or is deployable. `--bundle` preserves the supplied manifest and
requires `--development` when that manifest is a development bundle.

The generated product contains no editable core packages.
It owns domain/UI and copied setup scripts; those setup scripts are not silently
overwritten by package upgrades. Source commit, starter version and component
versions/hashes are in `.starter.json`; the current core pin is `.core-release.json`.

## Upgrade an existing product

```sh
node scripts/release/upgrade.mjs --target /path/to/product --tag core-v1.1.0
node scripts/release/upgrade.mjs --target /path/to/product --tag core-v1.1.0 --apply
```

Default is a read-only plan. `--apply` only changes declared core dependencies,
vendor artifacts and `.core-release.json`. Specify `--packages app/server`
for a non-workspace consumer, or a comma-separated list for multiple manifests.
Use `--bundle /path` to consume an already downloaded bundle. Run npm lockfile
update in the consumer, inspect the diff, then `npm ci`, `core:verify`, relevant
schema upgrade tests and product regression. Open and merge a consumer PR before
its normal deployment flow. Application code and previous vendor versions remain
untouched. Rolling back the dependency/lockfile does not reverse data migrations.

The five packages can be installed independently; the coordinated bundle supplies
one tested compatibility set. Product code uses public imports and injected ports,
not private paths. SDK dependencies are declared per package, exact install
versions are pinned by each consumer lockfile, and tested versions are recorded
in the release manifest. A different SDK resolution requires consumer validation.
