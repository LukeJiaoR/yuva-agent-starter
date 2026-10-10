# Consumer migration evidence

This page records historical verification of the public Customer Support example. Keep private application names, repository links, deployment commits, credentials, and operational records in those applications' own private runbooks.

## Public example: Core 1.2.0 upgrade

[core-v1.2.0](https://github.com/LukeJiaoR/yuva-agent-starter/releases/tag/core-v1.2.0)
was published from `8290e3888a9a8c05f8a445eb953820b17cdc4669`, with manifest integrity
`sha256-UN4Th+1lreVbLsKLH1yiX68zYvRMKlHV3S6OFxEf2eI=`.

The independently installed [Customer Support example](../../examples/customer-support/README.md)
is retained for package installation checks and future upgrade review. Its original
1.1.0 template/product source remains; the upgrade changed package pins, the
lockfile, and required migrations 003–006. Existing `OperationStore` consumers
need those schema changes even if they do not adopt the new default composition.
Legacy ledger/runtime ports do not, by themselves, require starter-schema adoption.

The recorded 2026-09-17 verification used Node.js 24.14.0 and real PostgreSQL:
the original example passed 29/29 tests before the upgrade and after the required
migration adjustment, and its web build passed. This is historical local test
evidence, not a live deployment or a fresh result for the current checkout.

## Historical Core 1.1.0 baseline

The generated Customer Support baseline used the
[core-v1.1.0 release](https://github.com/LukeJiaoR/yuva-agent-starter/releases/tag/core-v1.1.0),
source commit `d105d8420e3df86c2caebf3ad60faec62fa2a8fe`, and manifest integrity
`sha256-s9nsGbxa/3arQjU1tePYtqpMPhRoMyFIhmmd5gJ33ws=`.

It installed without an editable `packages/` tree, verified its release pin,
passed 29 tests against isolated PostgreSQL schemas, and built the web bundle.
The upgrade tool changes dependency metadata and vendor artifacts while retaining
product domain and UI files.

To reproduce that historical bundle with a disposable local database:

```sh
gh release download core-v1.1.0 --repo LukeJiaoR/yuva-agent-starter --dir /tmp/yuva-core-1.1.0
TEST_DATABASE_URL=<local-test-postgres-url> npm run smoke:consumer -- --bundle /tmp/yuva-core-1.1.0
```

The smoke command removes its own temporary generated directory and test schemas.
Package installation never migrates a database automatically. Each consumer owns
and reviews its schema migration chain.

For the checked-in public example, use:

```sh
cd examples/customer-support
npm ci
npm run core:verify
CI=true TEST_DATABASE_URL=<local-test-postgres-url> npm run check
```

Public example metadata is in the [registry](consumers.json). Runtime configuration,
service lifecycle, and backup/restore guidance is in [Operations](operations.md).
