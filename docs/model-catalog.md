# Local model catalog foundation

The starter application owns this optional configuration. Core billing and AI-engine
packages do not import it. Supply `createServer({ config: { modelCatalog } })` or
`createAiProduct({ modelCatalog, configuration: pricing })` from trusted server code.
Do not pass HTTP request bodies as configuration. When `modelCatalog` is omitted,
existing `AI_PROVIDER`, model environment defaults, pricing, and transport behavior
are unchanged. `null`, malformed catalogs, and missing feature bindings fail closed.

```js
const modelCatalog = {
  version: 1,
  connections: [{
    id: 'openai-main', provider: 'openai',
    credentialRef: 'env:OPENAI_API_KEY', status: 'enabled',
  }],
  models: [{
    id: 'approved-text', connectionId: 'openai-main', model: 'your-approved-model-id',
    provenance: { source: 'manual', recordedAt: '2026-10-15T00:00:00.000Z' },
    status: 'enabled',
    capabilities: [{ taskType: 'text', mode: 'stream', status: 'verified' }],
  }],
  bindings: [{
    featureKey: 'deep_reasoning', version: 'text-v1', modelId: 'approved-text',
    taskType: 'text', mode: 'stream', parameters: { maxOutputTokens: 1024 },
    budget: { maxInputTokens: 24000, deadlineMs: 60000, maxCredits: 30 },
  }],
};
```

This example is a shape, not a claim that a particular model has been validated.
`verified` is an explicit operator approval assertion. There is no verification
service or paid test call. Never derive it from a model name or discovery result.

## Strict schema and executable scope

`validateModelCatalog` returns a recursively frozen private copy;
`resolveFeatureBinding(catalog, featureKey)` is a pure validating resolver. All
objects reject missing and unknown fields, including arbitrary credentials and
endpoint fields. Duplicate IDs/features, multiple connections for one provider,
dangling references, invalid timestamps, parameters, or budgets are rejected.
Errors do not echo configuration values.

- Connections: exactly `mock` (`credentialRef: null`), `openai`
  (`env:OPENAI_API_KEY`), or `anthropic` (`env:ANTHROPIC_API_KEY`). Status is
  `enabled` or `disabled`. References deliberately map to the existing transport's
  environment key selection, not arbitrary environment names or secret stores.
- Models: explicit model ID, connection, `enabled`/`disabled` status, provenance
  (`manual`/`discovered` and canonical UTC ISO timestamp), and capability records.
  An inventory model may have no capabilities or `unverified`/`disabled`
  capabilities. The mock executor only accepts `starter-local`.
- Capabilities: explicit task type (`text`, `image`, `video`, `tool`), mode
  (`sync`, `stream`, `async`), and status (`verified`, `unverified`, `disabled`).
  Inventory labels do not create executors. **Only verified text/stream may be
  bound.** Image/video/tool bindings fail at composition, before reservation and
  provider invocation, even if labeled verified.
- Bindings: one active binding per feature, with a nonempty explicit version.
  Only `maxOutputTokens` is supported as a parameter; no temperature, tools,
  fallback, retry configuration, or arbitrary SDK options. Each binding has
  positive integer input/output limits and deadline, and a nonnegative integer
  `maxCredits` ceiling (all integers at most 2,147,483,647). Calls are fixed at one,
  retries at zero. The ceiling checks the pricing policy's authorized credits on
  every quote; it is not a provider-currency spending limit. A simultaneous
  `pricing.limits` override is rejected rather than silently overriding the binding.

Different features can resolve different approved models by creating products with
matching `configuration.featureKey` values. The default server still exposes its
one text product; this is not a new multi-feature HTTP router.

## Versioning, replay, and connection limitations

Recompose/restart with a new binding version for changes. This release has no
hot-reload mechanism and no registry enforcing version uniqueness across restarts.
The resolver copy cannot be changed by mutating the supplied object. New quotes
contain a private `modelBinding` snapshot (binding version, resolved provider/model,
connection ID, parameters and budget); the existing quote limits freeze the actual
provider/model path and execution caps. The public quote/rates omit this metadata
and never include credentials.

Binding versions are intentionally not product `inputVersion`: replay identity
remains unchanged. Settled operations replay saved output and their saved quote;
in-flight operations remain pending/recoverable through the existing recovery
flow, not re-executed on a newly selected model. The executor rejects a mismatching
old quote path before usage writes or provider calls. Settlement uses the persisted
quote, not a new quote generated from the current binding.

There is at most one connection per provider. Existing environment endpoint and
credential resolution is retained and frozen by the transport at composition time.
Neither credential values nor endpoint identity are persisted in quotes. This is
**not** durable credential/endpoint versioning, multi-account routing, or a promise
to resume a paid call across credential changes. Custom injected transports remain
trusted application extensions; the catalog cannot attest to their implementation.

## Not implemented

No remote discovery adapters, automatic catalog fetching, management UI/CRUD,
credential management, gateway, new SDK, media/tool executor, automatic fallback,
production deployment, or live-provider validation is included. Providers without
a directory API can be manually imported as unverified inventory with no binding;
approval and an executable capability must be explicit before binding.

## Tests

`modelCatalog.test.js` covers strict validation, immutable copies, different feature
models, budgets, and quote snapshots. `providerBinding.test.js` exercises synthetic
transport composition, existing env defaults, server wiring, saved replay and
changed-path rejection. `modelCatalogPersistence.test.js` requires an isolated
PostgreSQL test database and checks durable quote/binding retention. No test needs
real provider credentials or makes paid model calls. Run the existing execution
budget, operation-store, settlement and recovery suites against disposable
PostgreSQL as the financial regression gate; mocked port tests are not a substitute.
