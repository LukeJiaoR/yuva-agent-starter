# Issue 89: local repair and rollout contract

Tracking: [Starter #89](https://github.com/LukeJiaoR/yuva-agent-starter/issues/89).
This document describes a local repair candidate, not an installed release.

## Changes and permanent checks

| Item | Repair | Main regression coverage |
|---|---|---|
| S01 | A revoked grant's consumed amount is historical settlement minus actual posted usage-credit restoration for that same grant. | `creditRefunds.test.js`: support refund then payment refund, expired allocations, reuse, other-grant offsets, debt, repeated refunds. |
| S02 | Account/action/key mutation identity, canonical effective input hash, saved complete result, account locking and a local transaction savepoint. | `creditAdjustments.test.js`: multi-connection concurrency, conflicting input, rollback, lost COMMIT acknowledgement, historical keys, outer admin audit. |
| S03 | Application-owned fixed public error DTO for HTTP and SSE; default logs exclude raw exception details. | `chatPublicErrors.test.js`, runtime tests: handled/thrown/preflight/stream/settlement errors, SQL/provider markers, stable provider and execution-budget codes. |
| S04 | Render retained history before the current question; prune proven paired turns atomically. | `chatUseCase.test.js`, `chatMessageOrder.test.js`: provider receives exact business order, token budget and 20-message window. |
| S05 | Conversation-local sequence, role position and durable operation identity. | `chatMessageOrder.test.js`: concurrent writers, recovery replay, rollback, migration preservation and historical ambiguity. |
| S06 | Clear known released/refunded/settled/no-charge outcomes; retain request identity for unknown/reconciliation/network outcomes. | `workspaceRequests.test.js`, `workspaceApi.test.js`: HTTP/SSE terminal outcomes and pending disconnection. |
| S07 | Invalidate preview on facts edits, validate JSON on every new request, lock pending input and synchronously prevent duplicate submission. | `workspaceRequests.test.js` plus existing identity/unmount tests. |
| S08 | Redact sensitive fields regardless of scalar/array/object shape; normalize camel-case names. | `privacyExpiry.test.js`: nested structures, nonmutation, array shape and prototype-key safety. |
| S09 | Reject invalid or expired dates and invalid token TTLs. | `privacyExpiry.test.js`: malformed dates/types and valid Date/ISO/epoch timestamps. |

The required acceptance gate includes all newly added regression suites. Use the
repository's exact lockfile with Node 24.22.1 and npm 10.9.8. The official Node
release index was checked on 2026-10-22: 24.22.1, released 2026-10-20, remains the
latest Node 24 security release. Node 22 is not a supported runtime. Root and
customer-support `.nvmrc` / `.node-version`, engines, Docker images and CI agree.
Historical 1.x release notes describe historical releases, not current support.

## Migration and deployment gate

1. Back up and validate restoration on a disposable copy. Review historical
   message ambiguity with the [read-only preflight](testing.md#chat-message-order-upgrade).
2. Stop all old application, administration and recovery writers. Apply additive
   migrations **008 then 009**; no existing migration or baseline schema checksum
   changes. No production migration is performed by this local repair work.
3. Switch all writers together. Do not mix old deductions with the new mutation
   protocol or old chat writers with stable ordering. A rollback to old writers
   is unsafe even though the new columns/tables are additive.
4. Run acceptance against isolated PostgreSQL, package-consumer acceptance,
   browser build, and the target environment's deployment/restore checks before
   resuming writes. Confirm zero duplicate ledger effects and zero unexpected
   unordered conversations.
5. Publish a **new immutable core release version** before upgrading consumers.
   Current local development bundles retain the source tree's 2.0.0 identifiers;
   they must not overwrite the existing 2.0.0 release. Release versioning,
   authenticated registry/repository publication, and deployment need their own
   authorized release step.

### Accounting compatibility

A replay returns the original complete result, including its historical balance,
not today's balance. A key found only in historical debit rows fails with
`credit_deduction_legacy_reconciliation_required`; never change the key merely to
retry the same business action. Reconcile it explicitly from the old business
and ledger facts. Pass a pool or a client already inside a transaction; await
calls sequentially on a caller-owned transaction client. Different pool
connections are supported concurrently.

This patch does not rewrite historical false-debt rows or silently compensate
balances. Such repair needs a separately reviewed reconciliation plan. The
shared S01 cause affects [Ziwei #1045](https://github.com/LukeJiaoR/ziwei/issues/1045),
but that consumer has not been upgraded by these edits. Ziwei's existing outer
admin audit already guards normal same-key deduct retries; S02 must not be
misreported as a reproduced duplicate debit through that protected route.

### History and public-boundary compatibility

The [009 migration policy](testing.md#chat-message-order-upgrade) preserves all
old content. Unprovable timestamp ties return a fixed 409 before reservation;
the caller can start a new conversation. Existing completed results can still
be replayed. Historical unique-timestamp messages preserve ordering as
singletons: their original semantic pairing is unknown, so whole-turn budget
trimming is guaranteed only for proven projected/legacy-projection pairs.

Public message text is intentionally application-owned. Private exception text,
publicMessage fields, arbitrary error codes and provider payloads are not passed
through. The shared runtime can still return internal diagnostics to its trusted
application caller; other consumers must adopt their own safe HTTP/SSE adapter.
A direct provider connection error defaults to 503 at the public adapter, but
runtime classification can already assign 500; do not infer a universal 503
transport guarantee. Refunded UI cases are contract coverage, not evidence that
a current Starter HTTP refund endpoint was added.

## Scope and remaining validation

The local validation environment is Node 24.22.1 and PostgreSQL 17.11, with
synthetic users, credits and provider responses. No paid model, real payment,
production data or credentials are needed. Exact remote-head CI, PostgreSQL 16,
container builds, production migration and release publication remain separate
gates; local passing tests do not prove these unexecuted environments.
