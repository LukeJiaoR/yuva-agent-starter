# Local synthetic checkout orders

This product-owned demo records synthetic orders only. It has **no real payment, vendor, API key, webhook, payment event, fee, subscription, or credit grant path**. The fixed pack is `synthetic-credit-pack-v1`: 100 illustrative minor units, USD, 10 illustrative credits. These are test values, not a sellable price or an entitlement. A return page or query string can never mark an order paid. Balance is unchanged.

## Explicit local configuration

Off by default. An operator may enable the demo only with all of:

- `NODE_ENV=development` or `test`
- `MOCK_CHECKOUT=local-development`
- `MOCK_CHECKOUT_DISPOSABLE_DB=acknowledged`
- `MOCK_CHECKOUT_TRUSTED_ORIGIN=http://localhost:5173` (or another exact HTTP(S) loopback origin, no trailing slash)

Before enabling, independently verify that `DATABASE_URL` points to a disposable development database. The acknowledgement is an operator declaration, **not technical proof of isolation**. A development environment flag alone does not isolate the database. Never point this demo at production/shared financial data. No database was configured or accessed as part of implementing this slice.

The entrypoint binds to `127.0.0.1` while enabled. Every API checks the actual socket peer (never forwarded headers), verified authenticated account, and uses private/no-store responses. Guests cannot access it. Mutations additionally require the exact configured `Origin`, including under Clerk/custom authentication; existing self-hosted CSRF middleware remains intact. Origin-less writes are rejected. Use the local same-origin frontend proxy. This is not a public/production checkout.

## HTTP contract

All routes are under `/api/mock-checkout`. When disabled, no routes are mounted (ordinary 404, potentially non-JSON).

- `GET /products`: `{mock:true,products:[product]}`.
- `POST /orders`: exactly `{productId,requestId}`. `requestId` must be a UUID. Reject client amount, currency, credit count, account, provider, redirect, and any other fields. Responds with an order, including on replay.
- `GET /orders?limit=20&offset=0`: `{mock:true,orders:[],page:{limit,offset,hasMore}}`. Limit 1–50; offset 0–10000. Most-recent-first by creation timestamp then ID. Offset pagination is bounded and may shift when concurrent orders are added; it is not an exhaustive export facility.
- `GET /orders/:orderId`: owned synthetic order or 404.
- `POST /orders/:orderId/cancel`: empty body or `{}`; only pending transitions to cancelled. Already-cancelled is idempotent. Unknown states return conflict and remain unchanged.

Product fields: `id`, `label`, `amountMinor`, `currency`, `credits`, `synthetic:true`. Order fields: `mock:true`, `orderId`, `requestId`, `status`, frozen `product`, `createdAt`, nullable `cancelledAt`, `creditsGranted:0`. Recognized states are `pending` and `cancelled`; all other stored statuses project as `reconciliation_required`, never successful payment.

Success responses are HTTP 200. Errors have sanitized `{error,message}` (early authentication/socket/origin guards may return only `error`). Invalid input is 422; missing/foreign order is 404 `invalid_request:order_not_found`; changed product on an existing request is 409 `invalid_request:idempotency_conflict`; unknown-state cancellation is 409 `invalid_request:order_not_pending`. Uncertain write acknowledgement is 503 `checkout_outcome_unknown`.

## Persistence and retry safety

Uses the existing `payments` table without migrations or billing-core changes. Rows are `type='other'`, `provider='synthetic-checkout'`, with `metadata.synthetic=true`, `metadata.schema='synthetic-checkout/v1'`, normalized request UUID, request fingerprint, full immutable-quote fingerprint, and immutable product snapshot. The v1 quote is immutable: changes require a new product/schema version, never edits to v1 terms. Malformed or inconsistent snapshots fail closed with 409 `invalid_request:order_reconciliation_required`, without reflecting untrusted metadata. Every read/update scopes account, provider, type, marker and schema. Public DTOs do not expose provider references or internal metadata.

A deterministic SHA-256 reference namespaces account plus request UUID and uses the existing unique provider-reference constraint. Concurrent duplicate creates converge using one atomic autocommit INSERT ON CONFLICT and a fresh-snapshot SELECT. No price is accepted from the client; the versioned server product ID defines the frozen snapshot. Replays use stored snapshots, never current pricing.

On timeout, lost acknowledgement, or 503, **retain the same account-scoped request UUID and product ID**. Retry create with that identity (or read/list the durable order). Do not automatically generate a new identity: the first write may already have committed. Cancellation can likewise be retried/read; its conditional update changes pending only. No confirmation, settlement, reconciliation worker, browser-return grant, or credit mutation is implemented.

Test source is included in `starter-app/tests/mockCheckout.test.js` for later use. Per the user's pause, tests, builds, live database access and runtime verification were not performed for this implementation. This document does not claim runtime acceptance.
