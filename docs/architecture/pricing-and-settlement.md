# Pricing, operations and settlement contract

Status: version 1 contract; implementation and acceptance tracked by Epic #1.

## Authority and boundaries

`packages/billing-core/src/operationContract.js` defines executable validation. A
policy implements `quote(operation, executionLimits)` and
`decide(quote, usage, fulfillment)`. It receives immutable facts, no database or
provider client, and never changes balances. An adapter validates ownership,
quote association, amounts and state before calling the existing ledger.

The account-scoped Operation represents the customer's logical request. Its
server-generated ID persists across attempts. Each external invocation has a
separate call ID; polling an existing job is not another generation. Three
internal calls in one operation can cost the product three times while charging
one fixed fee. Three distinct operations can charge three fees.

Input identity includes feature, input schema version, task/mode, product input,
model/specification choices and stable input asset versions. Access URLs are
transport credentials, not asset identity. The application checks asset ownership
before constructing this identity. Same account/key with different input conflicts.

## Contract fields and units

| Object | Fields and meaning |
| --- | --- |
| Operation | id, accountId, featureKey, clientRequestId, taskType (text/image/video), mode (sync/stream/async), inputVersion, normalized input |
| Quote | contractVersion, policyId/version, unit=credit, reserveCredits, authorizedCredits, terms, limits, billingScope, missingUsage, fulfillmentVersion, createdAt/expiresAt |
| Execution limits | Allowed models, maxCalls, maxRetries, deadlineMs; type-specific maxInputTokens/maxOutputTokens, maxImages or maxDurationMs |
| UsageRecord | operationId, attempt, callId, provider/model, outcome, typed metrics with integer value or null, unit and source |
| Decision | action=settle/release/defer, reason, credits for settle; zero means successful no-charge, not failed execution |
| FulfillmentResult | status, ruleVersion, accountId, stable resultId, artifacts with identity, type, state, owner and content or stable storageKey/specs |

Credits are integers in [0, 2147483647], matching PostgreSQL INT. Invalid numeric
coercion, negative amounts and overflow must fail before the ledger. Token rates
will use integer ratios, aggregate eligible input/output separately and round up
once per operation. Reasoning and cache tokens are subsets, not additions to total
input/output. Unknown usage is null/missing; estimates never overwrite provider
facts. Media time uses integer milliseconds. Different units/currencies cannot be
summed. Provider cost and user rates are separate facts.

Quotes freeze terms, rounding, model/call/output limits, eligibility and missing
usage rules. Expiration prevents starting a new quoted operation; it does not
reprice an already accepted one. Old policy versions remain addressable or the
operation defers. A newer global price never replaces an in-flight quote.

## State and recovery

Execution: pending/running/submission_unknown/succeeded/failed/cancelled.
Financial: unreserved/reserved/settled/no_charge/released/reconciliation_required.
Fulfillment: pending/partial/ready/failed. These states have different owners.

Ready means application-validated, durably stored, owned and recoverable; it is
not an HTTP status or an SSE write. A client disconnect does not reverse a charge.
Text or JSON can be stored with the result; media uses immutable object identity,
not an expiring URL. Object transfer happens outside financial transactions.

Default fixed policy charges on ready, releases on confirmed failed delivery and
defers on pending/partial. Cancellation only releases after the execution outcome
and the frozen product rule permit it. Internal failed retries are excluded from
customer token charges but count against product budgets. Unknown required usage
defers; estimation requires an explicit frozen rule and provenance. A zero-fee
success persists a replayable result and releases any reservation using the ledger.

Transaction rollback is distinct from unknown COMMIT acknowledgment. Unknown
outcomes require database reconciliation. A worker lease expires ownership, not
an external provider job. Recovery must fence old workers, inspect existing jobs,
and never blindly resubmit a possibly accepted paid generation. Financial recovery
is implemented by #13; actual media execution and storage belong to #14.

## Observed legacy behavior and migration

At baseline 275733b, the default deep_reasoning route reserves and charges 2
credits regardless of token count. Duplicate generating requests return 202;
settled ones replay SSE without calling the provider. Failed validation prevents
text delivery and releases the reservation.

The current `reserveFeatureCredits` and `settleFeatureCredits` reject zero.
Settlement above reservation throws; repeated positive settlement returns the
existing settled request without another debit. Both functions coerce through the
legacy integer helper, so the new adapter must validate amounts strictly first.
The ledger preserves grant expiry and attempt-specific allocation history.

New chat operations now use account-scoped input fingerprints, frozen quotes and
durable per-call usage (#5/#6). Existing legacy results replay without invented quotes.
Unknown usage remains null; output length is never substituted for provider usage.

Fixed pricing now uses `createFixedOperationPricingPolicy` and
`createOperationBillingPort` from the public billing-core entry point. The product
injects its price, limits, fulfillment evaluator and transaction-local result
writer. The adapter reloads the persisted operation, verifies reservation ownership,
resolves the exact policy version and validates the decision against the frozen
authorization before calling the existing ledger. Provider call count and tokens
do not determine a fixed operation's fee. Historical `fixed/1` quotes remain valid.

`createOperationSettlementStore` stages validated candidates, then atomically
persists the final fulfillment, decision and financial status with the ledger.
Positive charges use the existing settle mechanism; zero-charge success returns
any reservation via the release mechanism and stores `no_charge`. Product result
writers run transaction-locally; upload/download work must finish before this call.
Text, JSON and stable media references share this path. Best-effort conversations
remain projections; replay uses the canonical account-scoped fulfillment.

Pending/partial fulfillment returns `reconciliation_required` and retains funds.
The runtime emits no successful done/delivery for it. Failures reconcile through
the injected `onFailure` port; unknown execution or settlement does not trigger a
blind release. Legacy runtime consumers retain their release hook. A successful
post-commit delivery error reads the persisted terminal status and leaves charges
unchanged. Terminal operations reject overwrites from later executors.

COMMIT transport failure is explicitly unknown; server-reported rollback differs.
The adapter marks nonterminal operations for reconciliation, or observes an already
committed terminal result. A retry can settle the durable candidate without model
execution. Recovery worker leases/fencing and operational reconciliation commands
are implemented by #13 (see [Recovery](recovery.md)); policy/input limits are enforced separately by #10/#12.

Validators and characterization tests preserve the old billingPort API. Stores,
policies, budgets and recovery are connected through application composition.
Unsupported task/mode is rejected before credits
or provider calls. Text remains realtime. Media contract fixtures establish
extensibility, not a working image/video provider or storage implementation.

## Verification

`npm run check` runs validators, existing route behavior, real PostgreSQL ledger
boundaries and production build. Set TEST_DATABASE_URL explicitly for database
checks; CI fails rather than skips if it is unavailable. [Testing](../testing.md)
maps fault injection and upgrade acceptance to executable test assertions.
