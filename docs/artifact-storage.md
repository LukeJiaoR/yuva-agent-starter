# Image artifact storage (local V1)

This application-owned port implements the local storage subset of #77. It does
not enable image generation (#78), change credits/ledger schemas, call a generation
provider, or provision S3/R2. A separate opt-in trusted HTTPS ingestion port can
fetch an already-generated PNG into this same immutable store. Existing billing fulfillment contracts can
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

Direct `store.save` still rejects `url` and `sourceUrl` with
`artifact_remote_source_unsupported`. Use the separate trusted ingestion port
below; do not put an ephemeral provider URL into a fulfillment artifact or claim
it was persisted before ingestion and save succeed.

## Opt-in trusted HTTPS ingestion

`app.locals.artifactIngestor.ingest({ sourceUrl, accountId, operationId,
slot = 'output', provenance, expectedSpecs? }) -> artifact`

The default is `ARTIFACT_REMOTE_INGESTION=disabled`, with an empty hostname
allowlist. Explicitly select `ARTIFACT_REMOTE_INGESTION=https` and set
`ARTIFACT_REMOTE_TRUSTED_HOSTNAMES` to comma-separated, exact, lowercase ASCII
hostnames from a trusted application-owned provider configuration. Local storage
must also be enabled. Enabling ingestion without a store or a nonempty valid
allowlist fails startup. Wildcards, IP literals, trailing dots, ports and URLs are
not allowed in the hostname configuration. Do not populate it from user input.
There is still no HTTP upload, save or arbitrary URL ingestion endpoint; only
trusted application code may invoke this port with an authenticated account and
server-owned operation/slot. No default host or provider is configured.

Source URLs are limited to 4096 characters, HTTPS on port 443, exact allowlisted
hostnames, no userinfo, fragments, whitespace, backslashes or IP literals. DNS
must return 1–64 answers, **all** public. `ipaddr.js` is a direct exact-pinned
existing dependency (1.9.1), supplemented with conservative special-purpose
range exclusions. IPv6 is restricted to global unicast 2000::/3, excluding
special-purpose ranges including mapped/compatible, translation, Teredo, 6to4,
benchmarking and documentation addresses. The conservative policy may reject
some globally reachable special-purpose addresses. Keep it reviewed against the
[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and
[IPv6 registries](https://www.iana.org/assignments/iana-ipv6-special-registry/).

The Node HTTPS request connects directly to one validated IP, with the original
hostname for TLS SNI, certificate hostname verification and Host. No second DNS
lookup, shared connection agent, proxy configuration, redirects or automatic
retry is used. TLS verification stays enabled. The only request headers are
Host, Accept: image/png and Accept-Encoding: identity; caller-provided headers,
authentication, cookies and mixed byte/URL input are rejected. Signed source URL
query parameters necessarily go to the selected trusted source, but source URLs
are never added to artifact metadata, error causes or logs by this port. Native
DNS/TLS/transport errors are replaced with fixed safe codes. Callers must also
avoid logging the input URL or putting credentials/URLs into provenance.

One 10-second total transfer deadline starts before DNS and includes DNS, socket
connection, TLS, headers and all body chunks. DNS is not cancellable through the
Node lookup API; late completion is ignored and cannot initiate a request.
Requests and responses are destroyed on failure/timeout. Only status 200 and an
exact image/png Content-Type are accepted. Any Content-Encoding, excessive or
invalid Content-Length, truncated stream or length mismatch fails. Headers are
bounded to 8 KiB and the body to 8 MiB, independently of Content-Length; chunked
responses remain subject to the same byte cap. A bounded receive buffer prevents
unbounded per-chunk accumulation. The original bytes must pass the same strict
PNG and expected-spec validation described above. No format conversion occurs.

Account, operation, slot, provenance and expected specs are validated/snapshotted
before asynchronous work, and the hostname allowlist is copied at construction.
Successful transfer alone is not availability: ingestion waits for the existing
store's immutable save to succeed. Download/validation failures never call save.
Exact retries retain existing idempotency/conflict rules. The transfer deadline
does not interrupt the filesystem commit; a storage error is still an error and
can require reconciliation of a fully published record, as described below.

DNS and HTTPS request dependencies are injectable only in trusted code for
synthetic tests. Tests use no external requests, live providers or credentials.
Without the optional staging pipeline below, retrying ingestion downloads again
and may fail if the source URL expired or its bytes changed. With staging enabled,
recover the trusted account/operation/slot directly instead of ingesting again.
A completed durable stage permits offline replay of the original bytes. Network
allowlists, trusted DNS and outbound firewall rules remain useful operational
defense in depth; address classification cannot defend against privileged local
routing changes or a compromised allowed public endpoint.

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
or securely stage the already-generated bytes and replay `save`. The optional pipeline below implements this replay after the first durable stage.
Direct store calls still bypass staging; callers needing recovery must use the pipeline.

## Opt-in private durable staging and offline recovery

Staging is disabled by default. Set `ARTIFACT_STAGING=local` only with
`ARTIFACT_STORAGE=local`, and provide `ARTIFACT_STAGING_DIRECTORY`: a second
pre-created, service-owned mode `0700`, normalized absolute durable POSIX directory.
It must be disjoint from `ARTIFACT_DIRECTORY`, outside web/static roots and free
of symlink ancestors. Equal or nested paths fail configuration. Every operation
also checks real paths and directory device/inode ancestry, rejecting aliases
and overlapping roots before writing or recovering. These checks retain the
same trusted-operator and ancestor-replacement limitations as the local store.
No directories, credentials, cloud resources or actual deployment configuration
are provisioned by this feature. Unknown modes and missing configuration fail closed.

The application exposes `app.locals.artifactPipeline` (null when disabled):

- `stage(saveInput) -> { recoveryId, state: 'staged' }`
- `save(saveInput) -> available artifact`, only after staging and final publication
- `recover({ accountId, operationId, slot = 'output' }) -> available artifact`

These are trusted application-only calls, with the same authenticated account
and server-owned operation/slot requirements as the storage port. There is no
recovery HTTP endpoint, queue, enumeration API, background retry or automatic
regeneration. A recovery ID is a stable locator/receipt, not authorization or a
downloadable artifact. Recovery accepts only the trusted identity tuple, never a
caller-supplied path, URL, bytes, provenance, artifact ID or metadata override.
The staging object has no public `get`. Normal authenticated GET continues to
read only the final artifact store; a stage-only record returns 404.

The pipeline snapshots and validates original bytes/specs/provenance before the
first await. Staging uses the same bounded immutable envelope, private temporary
file, file fsync, atomic create-if-absent hard link and directory fsync mechanics
as final storage. Its persisted envelope explicitly has `state: staged` and a
`staging-v1` key, never delivery-ready state. The small receipt exposes neither
bytes nor storage keys. The first durable stage must complete before final
`artifactStore.save` is attempted. Final failures leave the immutable source
intact. A fresh process can recover the exact original bytes without network or
generator access; each recovery rechecks owner, stable identity, PNG decoding,
specs, hash and provenance before publication. The returned final artifact must
match the staged source identity, hash, specs and provenance before delivery.

Exact repeated or concurrent stages and recoveries are idempotent across
processes. Different bytes or provenance for the same owner/operation/slot
conflict; they never replace the source. A conflicting final artifact also fails
closed and requires operator reconciliation. Partial, missing or corrupt source
records cannot be recovered automatically. Pending temporary files are ignored.
A failed call after a durable link/fsync may have succeeded in staging or
publishing; retry the same identity/source to reconcile. Hash verification is
not protection against a privileged writer who can replace data and its hash.

When enabled, the HTTPS ingestor automatically uses `artifactPipeline.save`
after download/validation. No source URL is persisted. For a failed final save,
call `recover` with the same trusted identity; do not redownload an expiring URL.
An ingestion retry still performs a new download and is subject to immutable
conflict checks. Direct `app.locals.artifactStore.save` remains available for
trusted compositions that deliberately do not require staging.

This closes only the **post-durable-stage, pre-final-publication** recovery gap.
It cannot recover bytes lost before the first durable write, a provider response
lost before download/staging, or the unknown-provider-submit/crash window. Those
generation execution and reconciliation concerns remain for #78. No provider
calls, generation retries, ledger state, billing readiness or recovery database
schemas are introduced. A staged receipt alone must never fulfill delivery.

Staged sources are retained indefinitely, including after successful publication,
until explicitly approved operator cleanup. There is no automatic deletion or
TTL. Budget approximately twice the committed storage (both envelopes contain
base64, plus temporary files during writes), with extra headroom for concurrency.
Operators must monitor capacity, back up both roots, stop writers before approved
cleanup and reconcile application references. Removing a staged source removes
this recovery path, even when a published artifact still exists.

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
