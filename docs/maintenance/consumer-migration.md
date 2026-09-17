# Consumer migration evidence

Verified 2026-09-17; owner: repository maintainers.

## Core 1.2.0 upgrade

[core-v1.2.0](https://github.com/LukeJiaoR/yuva-agent-starter/releases/tag/core-v1.2.0)
was published from `8290e3888a9a8c05f8a445eb953820b17cdc4669`, manifest
`sha256-UN4Th+1lreVbLsKLH1yiX68zYvRMKlHV3S6OFxEf2eI=`. Both consumers use
these exact published artifacts through separate pending-review upgrade PRs.
[Ziwei PR #595](https://github.com/LukeJiaoR/ziwei/pull/595) remains pending;
the merged product still uses 1.1.0 until its own PR is approved and merged.

The independent Customer Support example previously existed only in a temporary
directory deleted by smoke:consumer; it had no standalone remote repository.
Its owner now retains it at [examples/customer-support](../../examples/customer-support/README.md)
for review, independent npm installation and future upgrade PRs. Its historical
1.1.0 template/product source is retained; package pins, lockfile and required
003–006 schema migration files are the upgrade. Existing OperationStore consumers
need those schema changes even if they do not adopt the new default composition.
Ziwei uses legacy ledger/runtime ports and requires no starter-schema migration.

The original example passed 29/29 before upgrade and after the required migration
adjustment, with real PostgreSQL and the Web build. Current CI checks both the
core and independent consumer on Node 22/24. No product was deployed.

## Historical 1.1.0 migration

The [core-v1.1.0 release](https://github.com/LukeJiaoR/yuva-agent-starter/releases/tag/core-v1.1.0)
is consumed by [Ziwei PR #594](https://github.com/LukeJiaoR/ziwei/pull/594) and an
independently generated Customer Support product. Both pins have source commit
`d105d8420e3df86c2caebf3ad60faec62fa2a8fe` and manifest integrity
`sha256-s9nsGbxa/3arQjU1tePYtqpMPhRoMyFIhmmd5gJ33ws=`.

The release carries the single upstream compatibility fix set from #19. Ziwei
removed its editable core copies and installs the same published archives as the
example. No per-consumer modification of core source was made. The upgrade tool
changes dependency metadata and vendor artifacts while retaining domain/UI files.

Ziwei validation on Node 24.14.0: backend 2786 passed, 2 skipped; public package
exports 5 passed; CI/deploy scope 31 passed; Clerk/deployment/docs checks passed.
PR #594's CI gate passed. The generated example, with no packages/ tree, installed
all dependencies, verified its release pin, passed 29 tests against isolated
PostgreSQL schemas and built the production web bundle. It does not use Ziwei
credentials, schema or business vocabulary.

Reproduce the independent consumer with an explicit disposable/local database:

```sh
gh release download core-v1.1.0 --repo LukeJiaoR/yuva-agent-starter --dir /tmp/yuva-core-1.1.0
TEST_DATABASE_URL=<local-test-postgres-url> npm run smoke:consumer -- --bundle /tmp/yuva-core-1.1.0
```

The command deletes its own temporary generated directory and test schemas.
Installed packages never run schema migration automatically. The sample uses the
starter migration chain; Ziwei continues its existing product migration chain.
This is local/CI evidence, not a production deployment or live provider test.

Current consumers and upgrade ownership: [registry](consumers.json). Runtime
configuration, backup/restore and service lifecycle evidence is tracked by #22.
