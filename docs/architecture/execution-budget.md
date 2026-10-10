# Execution budget

The default starter prepares and checks the final plain-text prompt before
reservation. `prepareBeforeReserve` is opt-in for existing runtime consumers;
`executionPort.preflight` rejects unsupported inputs before any upstream work.
The frozen quote contains provider/model paths, per-call resource ceilings,
maximum call/retry counts and a deadline relative to operation creation. Fixed
and token policies use the same budget. No execution can increase authorization.

`createBudgetedProvider` wraps `createMeteredProvider`. The PostgreSQL usage store
locks the operation briefly to check authorization, deadline, prior calls, retries
and worst-case resource holds before inserting a call. It commits before invoking
the provider. Multiple coordinators and restarts share these durable counters.
A retry names a confirmed failed call; it consumes both a call slot and a retry
slot. Successful and failed attempts retain separate usage facts. The coordinator
is a sequential invocation interface, not a workflow scheduler.

The input envelope counts UTF-8 bytes plus 256 units per message and system
framing, accepting only plain text roles. This deliberately conservative local
estimate is not provider-measured usage and does not include tool/media payloads.
The starter accepts at most 24,000 envelope units after its context allocation.
Provider-side tokenization and costs remain distinct facts. Output caps are
passed as SDK `maxOutputTokens`, with `maxRetries: 0` and the combined caller /
operation-deadline abort signal. The pinned SDK maps these to Responses
`max_output_tokens` and Anthropic `max_tokens`, tested at the fake HTTP transport.
Provider adapters are trusted server-side composition and must implement their
declared limits; unsupported capabilities fail before reservation. Compatible
gateways must honor the protocol's limit fields to be eligible for bounded use.

Core 1.5.0 also offers direct OpenAI Responses transports an explicit
`options.outputTokenPolicy: 'provider_default'` mode. It omits `maxOutputTokens`
and `max_output_tokens`, ignores `maxOutputTokensDefault`, and rejects any set
`maxOutputTokens` or `maxOutputTokensCap` (including null/zero) rather than silently
discarding a bound. Unknown policy values and Anthropic use fail before provider
invocation. With no policy, all legacy numeric/default behavior is retained.
This mode is intentionally incompatible with frozen-budget text executions:
`executionRequest` and `createBudgetedProvider` reject it during preflight,
before a usage call is created. It does not change reservations, worst-case holds,
token pricing or the default starter composition. Direct users must supply their
own cancellation/deadline and abnormal-output controls; provider/model limits
still apply. Shared retries remain disabled and the 2 MiB decoded-text safety
limit remains in force, without claiming to bound raw SSE or reasoning metadata.

Optional `maxTotalInputTokens` / `maxTotalOutputTokens` constrain aggregate
worst-case holds. Every started call retains its requested maximum even when usage
is missing, cached, failed or subsequently lower. Without aggregate fields,
`maxCalls` times the per-call ceiling is the resource bound. This is conservative
resource accounting, not an absolute dollar budget or a customer price.

Timeout/cancellation/transport errors retain `externalStatus: unknown`; they are
not evidence that the provider charged zero or stopped executing. An unfinished
or externally unknown call blocks subsequent invocation. The coordinator waits
for the adapter to terminate after abort rather than silently detaching a paid
execution. Financial terminal coordination and recovery are later stages.

Image/video fixtures share call/retry/deadline checks, with integer image counts /
milliseconds and frozen specifications instead of invented token limits. The
starter route still rejects real media. Polling does not enter this generation
coordinator; future separately charged queries need separately sourced cost facts.

References checked 2026-09-17:
- [OpenAI Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Anthropic Messages create](https://platform.claude.com/docs/en/api/messages/create)
- Installed `@ai-sdk/openai` Responses adapter and `@ai-sdk/anthropic` language
  adapter, pinned by the repository lockfile; tests assert emitted request fields.

Starter migration 4 adds budget holds, retry identity and external status. It
does not execute as a package installation side effect or change consumer schemas.
