# PostgreSQL usage-store ownership and upgrade review

`starter-app/server/stores/usageStore.js` is product-owned application code copied
by the generator. It adapts the public AI usage and billing/execution-budget contracts
to the starter PostgreSQL schema. A core package upgrade does **not** replace this
file or migrate the database. Two independent examples exercise that composition;
this is not justification for moving AI SDK dependencies into the billing package.

## One provenance record, not a plugin registry

New locally packed bundles include a `starterUsageAdapter` record containing only:

- record format version 1;
- the fixed relative path `starter-app/server/stores/usageStore.js`;
- the upstream source commit;
- a SHA-256 content digest.

The commit plus digest identify the precise source revision. Format version 1 is
the metadata format, not a promise that every adapter/API/schema revision is compatible.
There is no new package, runtime plugin API or automatic application updater.

During explicit installation, `.core-release.json` records the application's adapter
base only when the actual product file exactly matches the known upstream digest.
The application base is separate from the newly installed core's source commit.
Customized files retain their previous adapter base across core upgrades. Unknown
legacy provenance is not synthesized from a package version or `.starter.json`.
Existing archived bundles remain valid without the optional record. A development
bundle whose adapter has uncommitted changes omits provenance rather than binding
those bytes to a commit that does not contain them.

## Read-only plan

```sh
npm run core:upgrade -- --target ../my-product --bundle ../reviewed-local-bundle
```

The existing plan now includes a single `starterUsageAdapter` section with base,
current digest, upstream and a suggested review action:

| Status | Meaning |
| --- | --- |
| `unchanged` | Base, product and upstream bytes match. |
| `local_changed` | Product differs; upstream bytes still match the recorded base. |
| `upstream_changed` | Product matches its base; upstream differs. |
| `diverged` | Both product and upstream differ from the base and from each other. |
| `upstream_applied` | Product bytes exactly match the known new upstream revision. |
| `base_unknown` | No valid application base is recorded; no three-way conclusion is possible. |
| `upstream_unknown` | The bundle has no adapter provenance. |
| `current_unavailable` | The expected product file is absent, unreadable or not a regular file. |

Planning does not edit the product, lockfile, vendor archive or provenance pin.
Comparison reads and hashes the fixed local file; it does not upload consumer code,
contact the source repository, or put file contents/private repository information in
the report. Symlinks in the adapter’s relative path are not followed for inspection. The public record has no absolute
paths. Local modifications are preserved even when `--apply` updates core artifacts.

## Applying a reviewed application change

For `upstream_changed` or `diverged`, review the public upstream file between the
recorded base and target commits and merge the desired change in the product's own
repository. Inspect related core APIs and migration/recovery requirements; this
single-file report is not a complete compatibility or security assessment. Run the
product's real PostgreSQL, execution-budget and recovery acceptance before deployment.

If the reviewed product file exactly matches the target source, a subsequent explicit
core install with `--apply` can record the new base. A custom merged implementation
continues to report local differences rather than being silently certified as upstream.
Do not overwrite the product to make a warning disappear. Missing legacy provenance
requires human review; it does not imply the product is current or broken.

This mechanism does not publish a release, alter existing vendor archives, upload
consumer source, change prices or migrate/deploy a product. Current-source local
bundles remain distinct from officially published release artifacts.
