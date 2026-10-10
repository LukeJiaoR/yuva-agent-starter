# Independent Customer Support consumer

This is the previously disposable Customer Support example, now retained as an
independently installable product for review and future upgrade PRs. It is **not**
a root workspace and contains no editable core packages. The original template
is `d9d635fe15d6526d111789f71bb907387f760265` (PR #25); `.starter.json`
keeps its initialization provenance and `.core-release.json` records its current
core. All five tarballs are exactly those published in core-v1.2.0 at
`8290e3888a9a8c05f8a445eb953820b17cdc4669`.

Use Node.js 24.x (`>=24 <25`; `.nvmrc` selects 24) and the declared npm 10
toolchain. This application no longer supports Node 22. The published core-v1.2.0
archives and their original compatibility metadata are unchanged.

```sh
cd examples/customer-support
npm ci
npm run core:verify
CI=true TEST_DATABASE_URL=<local-disposable-postgres-url> npm run check
```

The checked-in lockfile and vendor assets support installation without a GitHub
token. Optional Web source is the original generated UI; no UI redesign is part
of this upgrade. Core billing/execution does not depend on Web. Tests use provider
fixtures and isolated local schemas, not paid provider calls.

## Upgrade from 1.1.0

The original generated product passed 29 tests and its Web build against 1.1.0.
Applying only the 1.2.0 package pin exposed three OperationStore failures: the
older schema lacked `financial_status`. This consumer already exercised
`createOperationStore`, so its reviewed upgrade includes the published source's
003–006 SQL migrations and updates the expected migration sequence. No core
source, domain implementation or UI implementation was copied from 1.2.0.
The package lock, manifests and archives are pinned here for the upgrade review.

With those migrations, 29/29 original product tests and its Web build pass on
Node 24.14.0 with real PostgreSQL. The legacy-schema upgrade test verifies existing
balance preservation, concurrent reservation, frozen quotes and rollback. CI
now installs and validates this independent consumer on Node 24 only.

The migration runner applies files only when explicitly invoked by the product;
package installation does not execute SQL. For an actual existing installation,
back up first, apply reviewed migrations before starting the new OperationStore,
and verify replay/balance invariants. The old runner rejects newer schemas:
rolling back tarballs alone is insufficient after a schema upgrade. Prefer a
schema-compatible application rollback or a separately tested database restore.
No deployed database exists for this example and none was migrated.

The generator excludes `examples/` so new products do not recursively inherit
this maintenance fixture. Future changes to this consumer belong in its own PR.
