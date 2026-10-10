# API reference

The host API defaults to `http://localhost:3000`. The development web server proxies these routes, so browser code can use relative paths.

## Probes

### `GET /health`

Liveness probe. Returns `200` when the Express process can serve requests.

### `GET /ready`

Readiness probe. Queries PostgreSQL and returns `200` with `{"status":"ready"}` or `503` with `{"status":"not_ready"}`.

## Domain analysis

### `POST /api/domain/analyze`

Example body:

```json
{
  "parameters": {
    "subject": "Example account",
    "priority": "high"
  }
}
```

Returns normalized deterministic facts and a snapshot identifier. Replace the example parameter contract when customizing the domain adapter.

## Agent streaming

### `POST /api/chat/stream`

Example body:

```json
{
  "requestId": "4bc8a6f0-61da-4a01-af88-0f82a239b721",
  "conversationId": "c15f466f-ef3b-48dd-9ac1-edda3e67bf5c",
  "question": "What should I investigate first?",
  "parameters": {
    "subject": "Example account",
    "priority": "high"
  }
}
```

`requestId` is the idempotency key. Use 1 to 120 URL-safe letters, numbers, dots, underscores, colons, or hyphens. Reusing a completed request returns its terminal result instead of charging twice. `conversationId`, when supplied, must be a UUID.

Persisted operations also include a server-owned input-contract version (default `'1'`). Reusing the same key after the product changes this version returns 409 `idempotency_conflict`; client version fields cannot override it. Keep the same key for retries. Use a new key only to deliberately start a new operation, which may charge again. See [product contract versioning](customization.md#version-the-input-and-prompt-contract).

The response uses Server-Sent Events. Event names include `start`, status/progress events, validated text, `usage`, `done`, and `error`. Clients must parse frames across arbitrary network chunks and stop on the terminal event. The included web client demonstrates this behavior.

## Authentication

Local development can use the seeded guest when `ALLOW_DEV_GUEST_AUTH=true`. Production clients send `Authorization: Bearer <token>`. Configure the issuer, audience, and authorized parties documented in `starter-app/.env.example`.

## Error contract

JSON endpoints return a stable public error object. Streaming endpoints emit the same safe code and message in an error event. SQL, parser, stack, provider, and raw validation details are never part of the public response; inspect server logs with the request ID instead.
# Operation settlement status

New operations store financial state independently of HTTP/SSE delivery. Successful
text replay reads the account-scoped canonical result. `settled` and `no_charge`
are successful financial terminal states; the default configuration remains 2
credits. Historical ledger-only text results keep their existing replay behavior.

An in-flight or `reconciliation_required` request returns HTTP 202 with its stable
`request_id` and `status`. A deferred live stream emits `pending` with that status,
without a successful `done`. SSE errors include `financial_status` when known.
Retry the same request identity to inspect state; do not create a new operation to
recover an unknown submission. A missing result link does not authorize charging
again; applications regenerate access URLs from an authorized stable storage key.
# Public pricing

`GET /api/pricing` returns version 1 user-facing strategy, unit, rates, bounded
reservation and enabled capabilities. It omits provider credentials and costs.
SSE `start.data.pricing` contains the accepted operation's frozen pricing facts;
`done.data.credits_used` and `financial_status` describe actual settlement. Replay
returns the same quote and charge. Fields are additive for older clients.

The web client displays the accepted quote after start and actual charge after
done. A pending response or uncertain disconnect retains the exact request ID and
input for “Check result”; it does not create a new billable operation. Confirmed
preflight rejection allows a new request. Missing usage defaults to review; partial
delivery follows the frozen fulfillment rule. Expiration rejects a new expired
quote, never reprices an accepted operation. A local cancellation is not proof of
external cancellation or a zero charge. Recovery details are in
[Operation recovery](architecture/recovery.md).
