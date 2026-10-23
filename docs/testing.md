# Testing

## Full gate

```bash
npm run check
```

The gate runs:

1. Vitest unit and integration suites.
2. Boundary validation preventing app/domain imports from reusable packages.
3. The Vite web production build. The API runs directly as Node.js source.

## Epic #1 acceptance gate

```bash
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/test_database npm run test:acceptance
npm run build
npm run ops:verify
```

`test:acceptance` invokes the existing `npm test` (including boundary validation),
reads Vitest's structured report and requires all 14 acceptance suites to contain
passed assertions. Any failed or skipped test, absent suite, missing report or
missing explicit database URL fails the command. CI uses this command on Node 24 with its PostgreSQL 16 service and also builds
both portable containers.
The command uses a temporary report directory and removes it afterward.

The acceptance matrix below names executable assertions. All provider responses,
costs and artifacts are local deterministic fixtures; provider-sourced test metrics
simulate an adapter response and do not claim a real paid provider measurement.

| Requirement | Automated evidence |
| --- | --- |
| Default charge 2; insufficient funds never call upstream | `httpContract.test.js`: `charges the default operation exactly 2 credits, then replays without a new call`; `chatStream.test.js`: `rejects unauthenticated and insufficient-credit requests before external calls` |
| Same mechanism for fixed/token products, explicit selection | `productComposition.test.js`: default/explicit configuration; `product-examples.test.js`: both runnable examples settle/replay/clean up; `chatStream.test.js`: explicit token configuration |
| Multiple calls/retry retain costs, one bill | `epicAcceptance.test.js`: `%s %s product retains all retry cost facts and settles one frozen bill` (fixed/token, stream/sync); three call records, exact summed cost, failed attempt excluded from token bill, one ledger charge |
| Frozen token rates, scope, aggregation and one rounding | `tokenPricing.test.js`: `aggregates before rounding once`, `excludes failed internal attempts`, frozen rates and unused reservation tests |
| Expired grant remainder is not restored as spendable credits | `epicAcceptance.test.js`: `does not restore expired membership remainder when actual charge is below reservation`; reserve 5, charge 2, expire remaining 3, replay makes no new charge |
| Concurrent same-key identity, different-input conflict, tenant isolation | `operationStore.test.js`: concurrent retry/frozen identity; `chatStream.test.js`: concurrent 202/replay/conflict; `fixedPricing.test.js`: foreign account/reservation/artifact rejection |
| Restart/config change retains accepted quote | `fixedPricing.test.js`: persisted terms/tampered quote; `recoveryRunner.test.js`: token usage recovery after process restart with changed configured rates |
| Missing, zero, synthetic, estimated and provider sources stay distinct | `usageStore.test.js`: source history, missing versus zero, unlabeled data rejection; `tokenPricing.test.js`: missing/synthetic defer and frozen estimate basis |
| Budget blocks subsequent calls; invalid authorization cannot execute or overcharge | `executionBudget.test.js`: aggregate holds, context/model/retry checks and concurrent durable starts; `fixedPricing.test.js`: invalid/unauthorized decision rejection; `operationStore.test.js`: expired/unsupported preflight |
| Confirmed failure/cancellation, partial fulfillment and zero success | `recoveryRunner.test.js`: confirmed external failure and cancellation/completion history; `executionBudget.test.js`: local cancellation remains unknown; `reliableSettlement.test.js`: partial defer and text/image/video no-charge replay |
| Crash after reservation, generation and durable result | `epicAcceptance.test.js`: real child-process SIGKILL at `reserved`, `generated`, `ready`; release only when no call started, otherwise recover original result without another invocation |
| Result persistence rollback preserves candidate | `reliableSettlement.test.js`: durable candidate after projection rollback; `fixedPricing.test.js`: result persistence failure rolls back charge; `recoveryRunner.test.js`: concurrent restart recovery of candidate |
| Real COMMIT succeeds but ACK is lost; rollback differs | `reliableSettlement.test.js`: `distinguishes unknown COMMIT acknowledgment (committed=%s) from known rollback`; committed branch executes actual PostgreSQL COMMIT before injecting transport error, then verifies one charge |
| Disconnect after settlement preserves charged result | `chatStream.test.js`: `replays the durable result after post-settlement SSE failure without invoking the model again` |
| Concurrent workers, expired lease, replacement and late observations | `recoveryLease.test.js`: concurrent claim and stale executor/worker fencing; `recoveryRunner.test.js`: takeover during query, active provider deferral and immutable terminal bill after late usage |
| Safe recovery statistics distinguish failures from ordinary pending | `recoveryRunner.test.js`: dry-run/release/running counters; `counts failed reconciliation without exposing the provider payload or releasing funds` |
| New schema matches upgraded schema; financial history unchanged | `epicAcceptance.test.js`: legacy settled history snapshots compare users, accounts, grants, requests, allocations and transactions; new/upgraded column definitions match; historical HTTP replay calls no model. `operationStore.test.js`: concurrent migration/checksum checks |
| Media contract recovery shares ledger, requires no token/SSE/text field | `epicAcceptance.test.js`: image/video async fixture unknown submission, external running, concurrent completion recovery, duplicate callbacks and stable artifact replay; same fixed policy and one charge. Sync/stream products above use the same billing adapter |
| Ephemeral signed URL is not durable delivery evidence | `operationContract.test.js`: foreign/ephemeral artifact rejection; media acceptance validates stable account-owned storage keys and rejects expired signed URL references |
| Unsupported media rejected before reservation or call | `httpContract.test.js`: `releases failed validation and refuses unsupported media before provider or reservation` |

The async media fixture's submit/query/complete sequence validates contracts and
recovery coordination only. It is not a production media executor, callback server,
object store or live image/video integration. Those completion criteria remain in
Epic #14. Text stream execution does not require a background queue. No production
migration, consumer upgrade or paid model/payment request belongs to this gate.
Its product input boundary strips access URLs while preserving asset ID/version
and specifications; renewed URLs replay, but changed versions/specifications
conflict. Completed generation with unsaved artifacts stays partial and reserved;
recovery uses the existing job's saved artifacts before settling the frozen fee.

Local acceptance evidence on 2026-09-17, Node 24.14.0 / PostgreSQL: 27 files,
222 passed, zero skipped; `npm run build` and `npm run ops:verify` passed.
Negative checks: invoking `test:acceptance` without `TEST_DATABASE_URL` failed
immediately; running `httpContract.test.js` with an explicit unreachable loopback
database failed its setup instead of returning success. Current PRs must
independently pass this same gate on Node 24 before merge.

## PostgreSQL-backed HTTP contracts

`starter-app/tests/httpContract.test.js` applies the real schema to an isolated schema, starts the actual Express app on an ephemeral port, and verifies probes, headers, safe parsing errors, auth provisioning, admin audit lifecycle, and that rejected model output is not streamed.

Set a dedicated database when needed:

```bash
TEST_DATABASE_URL=postgresql://starter:starter@localhost:5432/starter_agent npm test
```

Without a reachable database, some local PostgreSQL-dependent tests skip and other suites fail. The acceptance gate requires an explicit `TEST_DATABASE_URL` and fails on skipped or missing acceptance coverage; CI treats absence as failure. Never point tests at a production database.

## Runtime matrix

Node.js 24.x is the only supported runtime for local development, generated products, CI, and containers. CI runs tests, boundary checks, and builds on Node.js 24. Engine checks reject Node.js 22 and other Node majors; those versions are not compatibility targets.

## Manual browser smoke

- Start from an empty database and complete the first prompt.
- Verify the readiness badge transitions correctly.
- Verify light and dark themes persist after reload.
- Exercise malformed JSON parameters and API/provider errors.
- Check keyboard focus and narrow mobile layout.
- Retry the same request ID through an API client and confirm it does not charge twice.

## Before release

Also build both container images and validate `docker compose config`. For provider or auth changes, run a smoke test against the same provider mode and issuer configuration used by the target environment.

## Operations and migrations

`operationStore.test.js` tests the original v1 schema upgrade, concurrent migration,
account/key races, frozen quotes, media input conflicts, rollback of reservation
and checksum tampering using isolated PostgreSQL schemas. These tests require an
accessible test database and fail if unavailable. New database initialization is
also exercised by the HTTP contract suite.

`npm run db:migrate` applies the immutable v1 baseline followed by ordered files
in `scripts/migrations/`. Applied files are checksum-verified under a schema-scoped
advisory lock. Legacy v1 installs are adopted without re-running their baseline.
Do not edit applied files: add the next numbered migration. Application rollback
requires a schema-compatible release; migrations are not automatically reversed.

The default chat route persists new operations and frozen quotes through the injected
operation store; it does not fabricate quotes for historical requests. Failed reservation creates
no runnable operation. An accepted operation retains its original quote on retry.

## Product composition examples

`productComposition.test.js` checks explicit strategy selection, default fixed
2-credit compatibility, immutable configuration, invalid configuration and safe
public pricing. The PostgreSQL chat suite verifies token reservation, actual
settlement and replay through the composed application.

Run `npm run example:fixed` and `npm run example:token` sequentially with a local
`TEST_DATABASE_URL` to exercise independent temporary schemas. Both use synthetic
provider fixtures; the token example explicitly prices frozen ceiling estimates.
Use `EXAMPLE_PORT` and matching `VITE_API_PROXY_TARGET` when selecting another port.
Verify `/api/pricing`, submit a request, replay the same request ID, and stop each
example with SIGTERM to verify schema cleanup. See [Customization](customization.md).
`scripts/product-examples.test.js` automates those runnable-process checks against
PostgreSQL and asserts that importing the app factory starts no listener.

## Durable usage

`fixedPricing.test.js` verifies frozen prices across configuration changes,
concurrent idempotent settlement, independent token/call counts, media artifacts,
strict decision validation, version and tenant checks, and rollback on product
result-write failure against PostgreSQL. Chat tests reject client price selection
while preserving the default 2-credit response and replay behavior.

`usageStore.test.js` verifies call-before-provider persistence, failed and partial
usage, missing versus zero, repeated observations, source history, scoped reads
and storage failures. The default route injects `createUsageStore` through the
runtime `usagePort`; `chatStream.test.js` exercises that actual path on PostgreSQL.
Consumers can inject their own operation and usage stores through `createServer`. A started call without
a completion remains unknown after restart. No output-length token estimate is
substituted for provider measurements. Costs use integer strings and decimal
scale, grouped by currency; cached/reasoning metrics remain subsets.

Self-hosted authentication adds `selfHostedAuth.test.js` to the required real-PostgreSQL gate; see [auth validation](self-hosted-auth.md#http-boundary-and-validation).

## Chat message order upgrade

Migration `009-chat-message-order.sql` adds conversation-local turn sequences,
role positions and operation identity. New normal and recovery writers acquire
one conversation row lock and insert an entire user/assistant turn in the same
settlement transaction. Replaying that projection does not allocate another
sequence or add messages. Context selects the newest complete turns within 20
messages, preserves their business order, prunes whole turns for the token budget,
and appends the required current question last. Concurrent turns are ordered by
successful projection serialization, not provider start time or random UUIDs.

Stop old application and recovery writers before applying the migration and
restart only compatible writers afterward. No deployed migration is edited.
Test the upgrade on a disposable copy first. The migration preserves all message
IDs, content, metadata and timestamps, and does not update operations or financial
history. Its historical compatibility rules are deliberately conservative:

- A message with a unique, non-null timestamp in its conversation retains that
  provable chronological position (`legacy_timestamp`). This is a singleton
  history group; it does not claim a recovered request/response pairing. Whole-turn
  trimming is guaranteed for proven projected pairs, not these historical
  singletons; their message ordering is preserved, but their original semantic
  turn boundary remains unknown.
- A tied timestamp is recovered as one user/assistant turn only when exactly two
  messages match exactly one settled/no-charge durable projection, and that
  projection matches no other group (`legacy_projection`).
- Other ties, duplicate projection matches and null timestamps remain unchanged
  with no assigned sequence (`legacy_unknown`). Random IDs are never treated as
  evidence of question/answer order.

A conversation containing any unresolved message returns HTTP 409 with code
`conversation_history_order_unavailable` before reserving credits or calling the
provider. The public message explains that the original messages are preserved
and asks the user to start a new conversation. Historical completed request
replay still works without reading conversation history. This is a compatibility
change for ambiguous old conversations; it does not silently omit their history.

Before upgrading, this read-only query estimates the timestamp groups requiring
review (projection matching may resolve some of them):

```sql
SELECT COUNT(*) AS groups_needing_review, COALESCE(SUM(message_count),0) AS messages_needing_review
FROM (
  SELECT conversation_id, created_at, COUNT(*) AS message_count
  FROM messages GROUP BY conversation_id, created_at
  HAVING COUNT(*) > 1 OR created_at IS NULL
) uncertain;
```

After applying the migration to that disposable copy, this read-only query gives
the exact unresolved counts. Review them before deciding when to upgrade:

```sql
SELECT COUNT(*) AS unresolved_messages,
       COUNT(DISTINCT conversation_id) AS affected_conversations
FROM messages WHERE turn_sequence IS NULL;
```

Do not repair uncertainty by changing financial state or assigning arbitrary
sequence numbers. A separately reviewed data repair needs actual source evidence;
otherwise keep the originals and start a new conversation.

`chatMessageOrder.test.js` verifies equal timestamps, concurrent writers,
projection replay, rollback, the 20-message boundary, and fresh/upgraded schemas
with uniquely matched, missing, duplicated and differently timestamped history.
`chatPublicErrors.test.js` injects private synthetic failure details into each
HTTP/SSE phase; `chatUseCase.test.js` checks the final provider message sequence.
