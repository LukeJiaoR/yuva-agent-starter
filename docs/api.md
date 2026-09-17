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
