# Local MOCK image product

This opt-in development demo produces one **magenta 1×1 PNG**, irrespective of the prompt. It is not visual image generation and never contacts a supplier. It exercises authenticated submission, a committed provider-call record, durable bytes, account-isolated delivery, fixed-credit settlement and restart recovery. No real provider credentials, model catalog entries or text-stream runtime are involved.

## Explicit local configuration

Use the existing database and authenticated development setup (see [self-hosted auth](self-hosted-auth.md)). No guest submission is allowed. Pre-create two disjoint absolute directories owned by the service UID, with mode 0700, following [artifact storage](artifact-storage.md). Do not put either directory under a public/static web root. Preserve both across restarts.

Set the following in your development environment. The example price of **2 demo credits is an explicit operator choice**, not a production price or supplier cost. No text-price fallback exists.

```dotenv
NODE_ENV=development
MOCK_IMAGE_GENERATION=local-development
ARTIFACT_STORAGE=local
ARTIFACT_DIRECTORY=/absolute/private/artifacts
ARTIFACT_STAGING=local
ARTIFACT_STAGING_DIRECTORY=/absolute/private/artifact-staging
MOCK_IMAGE_PROFILE={"version":"local-images-rgba8-v1","provider":"synthetic-images","model":"synthetic-rgba8-1","specs":{"width":1,"height":1,"mediaType":"image/png"},"fixedCredits":2,"maxCalls":1,"maxRetries":0,"maxImages":1,"deadlineMs":30000,"recoveryPolicy":{"version":"1","maxAgeMs":86400000,"onExpiry":"waive"},"supplierAuthorization":{"kind":"synthetic-only","currency":"USD","amount":"0","scale":0}}
```

Alternatively pass the same trusted profile as `createServer({config:{env,imageProfile}})`; request bodies cannot select it. The feature defaults to disabled. Enabling it requires `NODE_ENV=development` or `test`; production and other values fail startup. The normal server entrypoint binds loopback while enabled, and image routes additionally require the actual socket peer to be loopback (forwarded headers do not grant access). Do not expose this local demo through a public reverse proxy. The configuration creates no directories, secrets, migrations or environment changes for you.

## HTTP interface

Use your existing authenticated session/token. Cookie requests retain the existing trusted-origin/CSRF requirements. Example request from the development frontend:

```js
const response = await fetch('/api/images', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: crypto.randomUUID(), prompt: 'Demo pixel' })
});
const image = await response.json();
```

- `POST /api/images`: accepts exactly `requestId` (nonempty, at most 120 characters) and `prompt` (nonblank, at most 4096 UTF-8 bytes). The authenticated user supplies the owner. Model, count, dimensions and quote are server-controlled.
- `GET /api/images/:operationId`: returns the current owner's sanitized operation state.
- `POST /api/images/:operationId/recover`: empty body only; checks this owner's image operation, then attempts normal due/lease-based recovery. It neither steals a live lease nor overrides manual review/backoff. It never generates another image. Poll the query route to inspect progress; recovery is explicit, not a background scheduler.
- `GET /api/artifacts/:id`: returns the PNG only when the same owner's immutable canonical fulfillment is ready and financially settled/no-charge, and every stored artifact identity/hash/key matches. Knowing an artifact ID or having bytes on disk is insufficient.

Responses contain `mock: true`, `operationId`, execution/financial/fulfillment status, fixed pricing (`credits`, `chargedCredits`) and either a small `artifact` reference (`id`, dimensions, MIME type, `downloadUrl`) or null. They never contain prompts, call metadata, supplier identifiers, credentials or internal recovery metrics. Input conflicts use HTTP 409 with the existing sanitized public error shape. Authentication failures are 401; inaccessible operations/artifacts are 404. Post-reservation ambiguity returns the canonical pending state, not a claim that submission failed safely.

Reusing the same request ID with the same prompt replays the existing operation without another call. A changed prompt conflicts. Editing the configured price does not change old quotes. Use a genuinely new request ID only for an intentionally new demo operation.

## Failure and recovery guarantees

A call's durable start must acknowledge COMMIT before transport. A lost/failed start acknowledgement invokes nothing and does not retry submission. After transport handoff, uncertain execution retains the reservation for reconciliation. Successful bytes are validated, written to private staging, then published to immutable final storage before ready fulfillment and fixed-credit settlement. A failed final publication can recover from staging after restart without another call, using matching committed successful call facts and artifact provenance/specs. The quote stored with the operation determines the charge.

The initial worker has the core's deadline-plus-grace lease; recovery must wait for its expiry. Recovery claims increment the execution epoch and heartbeat their lease. A stale worker may leave external bytes on disk, but cannot stage a canonical ready result or settle after takeover. Delivery independently checks canonical settlement, including after `MOCK_IMAGE_GENERATION` is disabled or the process restarts. Historical valid settled images remain downloadable; unsettled, unreferenced or late-waived bytes remain inaccessible. Standalone non-mock storage retains its original behavior when the product is disabled.

At the frozen recovery expiry, the core waives unresolved liability. An already canonical ready result can become a zero-charge success and remain downloadable. A released unknown result can never become deliverable or chargeable through late success. Settlement acknowledgement loss is reconciled from the ledger; replay never adds a second debit.

The filesystem and PostgreSQL do not share a transaction: a crash before durable staging can lose returned bytes permanently. Such an operation remains unknown until expiry/waiver; recovery does not regenerate. Directory validation happens before a new reservation, but disk exhaustion/permission changes after validation remain possible and are handled as reconciliation failures. This slice deliberately excludes real-provider submission, paid supplier calls, URL fetching, deployment and production pricing.
