# Image submission contract (issue #78, partial)

This is an app-owned protocol and durable-submission **contract slice**, not an enabled image product or a complete coordinator. Nothing is wired into routes, environment configuration, the model catalog, recovery runners or public APIs. It does not register a production model or bypass catalog authorization. All examples and tests use one synthetic model and synthetic PNG bytes. No vendor calls, credentials, paid calls, SDK retries or network clients are included.

## Explicit local profile

`server/domain/imageGenerationContract.js` defines `local-images-rgba8-v1`, provider `synthetic-images`, model `synthetic-rgba8-1`, one 1×1 PNG and `n=1`. The synchronous POST `/images/generations` transport accepts `model`, `prompt`, `n`, `size` and `response_format: b64_json`. This is a **local compatibility profile**, not a claim that OpenAI or arbitrary compatible vendors support this model, size, field set, PNG encoding, or usage shape. Production vendor/model compatibility must be separately reviewed and authorized.

The trusted product profile must explicitly supply fixed customer credits F (including explicit zero), exactly one call, zero retries, one image, a positive deadline no longer than 60 seconds, a bounded recovery/waiver policy, approved model/specification and synthetic-only supplier authorization. Missing/invalid settings or input fail before reservation in the contract harness. There are no environment-derived defaults. Prepared operation, request and quote snapshots are recursively frozen; unrelated profile metadata is not persisted. The operation store saves the input fingerprint, not the prompt. Changed valid prompt under the same key conflicts; unsupported model/spec or n fails pre-reservation. Future multiple approved specifications must also preserve same-key changed-spec conflict semantics.

Supplier authorization is separate from customer credits. The current explicit `synthetic-only / USD / amount 0 / scale 0` authorization means tests may execute a synthetic transport only. It is not observed supplier cost, nor a mechanism that caps a real supplier's invoice. Local call/image limits and a fixed customer charge cannot prove external cost enforcement. Actual supplier authorization, pricing, unknown-outcome exposure and upstream controls remain unresolved for production. Cost observations remain null/unknown even for this synthetic profile; missing cost is never zero and is never inferred from F.

## Injected transport boundary

`server/providers/imageGenerations.js` exports `createImageGenerationsAdapter({ transport })`. There is no default transport, global fetch, credential lookup, URL selection or text-runtime integration. Its transport contract is:

- Input: method, relative path, serialized body, signal, maxResponseBytes and profileVersion.
- Output: status, body as Buffer, optional requestId.
- Exactly one handoff; transport must disable hidden retries and redirects, bound bytes while reading, and respect local cancellation where supported.

The adapter independently bounds serialized requests (8 KiB), prompt UTF-8 bytes (4 KiB), returned response buffers (32 KiB), safe request IDs (128 ASCII characters), and image decoding through the existing strict PNG validator. It accepts exactly one canonical base64 PNG, RGBA8/noninterlaced/no ancillary chunks with CRC and bounded full inflate validation. URL output is explicitly unsupported; no download follows. Usage, if present, is the local typed `images: 1` evidence and maps to provider source; absent usage maps to missing. No output-count inference fills missing provider usage. An explicitly returned model must match the approved model and is recorded as provider-response identity; absent model is requested fallback. Returned bytes are temporary data, **not an available artifact or fulfillment**.

The adapter cannot make an arbitrary injected transport obey its byte or deadline contract: checking an already allocated Buffer does not prevent a transport's unbounded network read. A real transport and independent conformance tests are prerequisites to production. The harness passes an AbortSignal based on the operation's absolute creation-time deadline, not a new full-duration budget on restart. It checks again after durable start ACK and refuses handoff if the absolute deadline has expired, retaining the durable start for reconciliation. Signal cancellation does not guarantee the transport stops or the remote job is cancelled; an uncooperative transport can keep waiting. No remote cancellation or financial non-submission is inferred.

Only a positive, fully validated synchronous response produces completed/succeeded call evidence. Non-200/202, malformed success, invalid PNG/spec/count/usage/request ID and URL responses conservatively remain unknown. After transport handoff all exceptions, including timeout/abort and apparent rejection, are submission-unknown. They are not delivery or definitive no-charge failures. Transport exceptions are replaced with fixed safe errors without retaining original message, stack or cause.

## Durable PostgreSQL contract harness

`tests/imageSubmissionContract.test.js` exercises the existing stores, not a new application coordinator:

1. Prepare and validate the frozen contract before reservation.
2. Find/replay existing operation by account/key and fingerprint; never resubmit on restart.
3. Reserve through existing fixed pricing/operation store and ledger behavior.
4. Await `usageStore.start` through its durable transaction commit before invoking the injected transport. It enforces account, execution epoch, frozen model/spec, call ceiling, financial authorization and deadline. Any thrown start, including simulated commit-ACK loss, results in zero transport calls. The persisted operation/call must be reconciled rather than retried.
5. Persist typed call observations. `observe` intentionally accepts factual late observations without epoch fencing; this does **not** grant permission for stale-worker execution, artifact promotion or settlement. Epoch-bearing transitions remain independently fenced.
6. Unknown outcomes use existing `settlement.markReconciliation`. No automatic retry, credit charge, release or delivery is performed here. A successful provider call still leaves fulfillment pending until future durable artifact integration.

Tests use a real isolated PostgreSQL schema and a separate connection inside the transport to prove the single call is already committed and no transaction remains held. They cover duplicate/concurrent keys, changed input, restart after ambiguity, profile edits preserving frozen quote, stale epoch start refusal, duplicate observation, unknown cost, and zero transport calls after start failure/commit-ACK ambiguity. They do not claim to inject an actual PostgreSQL network ACK failure; the harness simulates the store returning an error after a real successful commit.

## Deliberately deferred

Remaining #78 work includes production catalog-driven model/spec selection, a real bounded network adapter and supplier authorization, the complete coordinator, durable artifact storage and fulfillment, artifact-copy failure/recovery, external reconciliation, late-success financial handling, settlement ACK recovery, public routes/UI and explicitly authorized real-provider acceptance. Existing #76/#77 infrastructure is not rewritten. This slice must not be used to close #78 as fully delivered.

Focused checks:

- `npx vitest run starter-app/tests/imageGenerations.test.js`
- With TEST_DATABASE_URL targeting a disposable PostgreSQL database: `npx vitest run starter-app/tests/imageSubmissionContract.test.js`
