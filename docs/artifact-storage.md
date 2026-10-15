# Image artifact storage (local V1)

This application-owned port implements the local storage subset of #77. It does
not enable image generation (#78), change credits/ledger schemas, call a provider,
fetch remote URLs, or provision S3/R2. Existing billing fulfillment contracts can
consume a successfully saved artifact. A generation success alone is not delivery.

## Opt-in composition

The default is `ARTIFACT_STORAGE=disabled`. To opt in, set `ARTIFACT_STORAGE=local`
and `ARTIFACT_DIRECTORY` to a normalized absolute path to an existing dedicated
POSIX directory, owned by the service UID and mode `0700`. The app does not create
or relax directory permissions. Unknown adapters and missing configuration fail
startup; inaccessible/unsafe storage fails closed on access. Mount the directory
on a durable local volume; ephemeral container storage is not persistence.

The server exposes the store through `app.locals.artifactStore` for future trusted
application composition. There is no HTTP upload/save endpoint. Authenticated
`GET /api/artifacts/:id` uses only the verified local account identity from existing
auth middleware. Owner headers/query parameters have no authority. Missing,
foreign, malformed, corrupt, or unreadable IDs return 404; anonymous callers get
401. Disabled routes return 404. PNG responses have a fixed media type and inline
disposition, `nosniff`, same-origin resource policy, and `private, no-store`.
No user filename, directory, URL, or bearer credential becomes an artifact key.

## Storage port and supported input

`save({ accountId, operationId, slot = 'output', bytes | base64, provenance,
expectedSpecs? }) -> artifact`

`get({ accountId, id }) -> { artifact, bytes }`

Only trusted application code may call `save`; it must supply an authenticated
account and server-owned operation/slot. The port is not an authorization service
for arbitrary callers. Provenance has exactly `providerId` and `modelId`; operation
and slot are also retained. Do not put prompts, credentials or temporary URLs in
provenance. There is no timestamp in identity and retries cannot alter provenance.

Input is a Buffer or strict canonical base64, limited to 8 MiB encoded image
bytes, 4096 per dimension and 4,194,304 pixels. Actual supported PNG profile is
**RGBA, 8 bits per channel, non-interlaced, with only IHDR/IDAT/IEND chunks**.
Common RGB, indexed, grayscale, metadata-bearing or interlaced PNGs are rejected
in this release. JPEG/WebP/GIF/SVG/video are unsupported. This is deliberately not
support for every PNG. Providers must return this exact profile or future code
must introduce a separately validated bounded conversion step.

Signature, strict chunk boundaries/order, no data after IEND, bounded full zlib
inflation, exact decompressed size, zlib stream consumption, CRCs and full pixel
decoding with pinned `pngjs` are checked. This is not header-only validation.
Optional expected width/height/mediaType/sizeBytes must exactly match actual bytes;
unknown spec fields are rejected. This synchronous bounded decoder is intended
for the initial low-concurrency path; high-throughput execution needs a worker
pool and admission limits before enabling it at scale.

`url` and `sourceUrl` always reject with `artifact_remote_source_unsupported`,
including trusted-looking HTTPS URLs. No HTTP request, redirect or DNS lookup is
performed. Protocol allowlists, redirect rules, DNS/IP SSRF defenses, byte and
time limits for remote transfer remain unimplemented, disabled scope. Do not feed
an ephemeral provider URL into a fulfillment artifact or claim it was persisted.

## Identity, atomicity and recovery

The stable `art_` ID hashes a canonical array of account/operation/slot; storageKey
is `local-v1/<id>`, version is 1, and SHA-256 hashes original image bytes. Identity
is account-specific and independent of access credentials. GET requires a fresh
valid session; renewing a session changes neither ID nor key. No signed URL
implementation is claimed. A duplicate exact save returns the same artifact;
different content/specs/provenance for the same identity conflicts without
replacing it. Different accounts cannot read each other's IDs.

Each committed file is an immutable JSON envelope containing metadata plus
base64 image bytes. A random private temporary file is completely written and
fsynced, then hard-linked atomically to its final name with create-if-absent
semantics. Temporary link removal and directory fsync precede successful return.
This single-envelope format commits bytes and metadata together: partial metadata
cannot point to an apparently available separate blob. Concurrent writers across
processes cannot overwrite a committed target. Reads have a bounded allocation,
reject special files/symlinks, and decode/hash/compare all saved metadata again.

A crash before publication leaves only `.pending-*`, which reads ignore. A crash
or sync failure after publication can leave a complete committed record even
though the caller received an error; retry the exact same save. Save errors never
return an `available` result. Corrupted or partial final records are unreadable and
are not silently overwritten by retries. Recovery requires operator inspection
and a known-good backup or still-held original bytes. Do not regenerate an image
as an automatic storage retry: the future execution/recovery workflow must retain
or securely stage the already-generated bytes and replay `save`. This release
only tests that storage retry can reuse bytes without invoking generation; it does
not implement durable orchestration across a crash before storage publication.

## Operational boundaries

This adapter targets POSIX filesystems with local atomic hard-link/fsync semantics;
Windows and network filesystems are not validated. Symlinks in the configured path
and final records are rejected. Keep the directory outside web/static roots,
never share it with untrusted writers, and protect its ancestors from replacement.
The checks are defense in depth, not a sandbox against malicious same-UID
processes or actors able to replace ancestors between filesystem operations.
A process with OS-level write access can alter bytes and recompute hashes; SHA-256
here detects accidental corruption, not tampering by a privileged adversary.
Use OS permissions, backups, volume encryption and deployment isolation accordingly.

Retention is indefinite until an operator explicitly performs approved cleanup.
There is no background deletion, TTL, user deletion API or bulk deletion. Operators
must arrange capacity monitoring and backups, reconcile references before manual
removal, and stop writers before cleaning crash leftovers. Test restore in an
isolated directory, preserve ownership/mode, and validate restored records through
`get`. A deleted record returns 404; there is no restore promise without a backup.
Deleting an account in auth does not itself erase files: account erasure and
retention/legal requirements need an explicit operational procedure before use
with real customer data.

The fake adapter offers deterministic `save/get` semantics for isolated tests;
it is never selected from environment configuration. A future S3-compatible port
must preserve account isolation, immutable conditional create, stable identity,
validated metadata/hash, bounded reads and commit-before-available behavior.
S3/R2 credentials, buckets, signing and live-service verification are not included.
