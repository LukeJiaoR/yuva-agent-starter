# Durable provider usage

`createAgentRuntime({ usagePort })` calls `usagePort.invoke({ invoke, options,
request, reservation, user })` inside its provider lifecycle. The optional port
keeps older consumers compatible. The starter default uses public
`createMeteredProvider` and injected `createUsageStore({ db })`; applications can
replace either through `createServer` without importing private core paths.

Every invocation awaits `store.start` before external work. Explicit retries get
new call IDs; both built-in SDK adapters use `maxRetries: 0`. Completion, refusal,
cancellation, timeout and partial errors are observed independently from billing.
If start fails, no provider is called. If completion persistence fails, the caller
receives `usage_persistence_failed` with the call ID and partial result, and the
started row remains a recovery signal. A process exit has the same durable signal;
a missing finish is never converted to zero. Financial recovery is implemented
in the later settlement/reconciliation stages.

`summary({ accountId, operationId })` returns every call plus metric aggregates;
`history({ accountId, callId })` returns immutable deduplicated observations with
timestamps. Updates can fill unknowns or promote estimates to provider facts.
Conflicting provider values/IDs fail. Original missing and estimate observations
remain queryable. A provider job belongs to one call within an operation; repeated
callbacks use that same call ID and never increment generation totals. Separately
charged queries must use separate call IDs and explicitly sourced cost facts.

Input/output/total tokens are independent observations; no missing field is
inferred. Cached input, cache write, reasoning and tool tokens are breakdowns,
never extra amounts added to totals. Image counts and integer millisecond durations
have distinct units. Requested counts are separate from observed counts; validated
artifacts belong to the fulfillment contract, and user charge quantity belongs to
the pricing policy. No usage row decides how often to charge a customer.

Costs are decimal-scale integer strings grouped by currency, never an inferred
rate. Each call retains source and observed/estimated/reconciled status. Aggregate
known costs are partial unless `costComplete` is true. Unknown cost is null; an
empty observation set is not a zero-cost success. Fixtures are synthetic evidence,
not live provider prices or media integration.

Only projected counters, IDs, model provenance, timing and failure codes are stored.
The meter does not persist prompts, text, raw provider metadata or API keys.
