# Token content tool starter example

A runnable starter composition for turning supplied synthetic material into a
small JSON content card. It is an integration example, not a launched product.
The product owns its material schema, prompt, output validation and
`content-card-v1` input-contract version. Cards have exactly `title` and `summary`.

## Generate and verify independently

From a clean committed starter checkout on Node 24.x / npm 10.9.8:

```sh
npm run release:pack -- --output ../local-core-bundle
node examples/create-consumer.mjs token-content-tool ../content-demo ../local-core-bundle
cd ../content-demo
TEST_DATABASE_URL=postgresql://localhost/starter_test npm test
npm run core:verify
```

If the same verified local bundle already exists, reuse it rather than packing over
it. Targets must be empty and outside the source repository. The generated consumer
owns its app code and installs immutable, integrity-pinned core tarballs, with no
editable core source. Local packing is not a package publication or vendor upgrade.
Tests require disposable local PostgreSQL 16, create an isolated schema, and fail
rather than skip if prerequisites are missing. No provider network calls are made.

## Product composition and contracts

Import `createExampleServer` from `starter-app/server/product.js`; supply your pool
and trusted `auth: { verifyRequest, findUser }`. Local-user mapping must bind the
verified issuer/tenant/subject to the intended product account. The acceptance
credential adapter is test-only, not a deployable identity provider. No default
CLI listener is provided before this composition is wired, and the starter web
remains a shell rather than a complete custom-login interface.

Rates are 1 credit per 1,000 input tokens and 2 per 1,000 output tokens, rounded once
per operation. One call, no retries, input/output bounds and a deadline are frozen
with the quote. Reported usage is required (`allowEstimates: false`). The deterministic
acceptance provider **simulates** provider-reported metrics to test provenance and
billing; these are not observations from a paid model.

Acceptance verifies a 3-credit reservation, a 2-credit settlement from fixture usage,
unchanged historical quotes after price changes, no extra execution/charge on replay,
and recovery of a staged result after a simulated SQL outage in a separate process.
It also verifies invalid output is never delivered or charged.

Bump the input version when changing the product's prompt, material schema or output
contract. The client cannot pick this version. Reusing an old key under a new version
returns 409 without an additional charge; deliberately executing a new contract
requires a new key. Do not automatically retry conflicts with a fresh key. Existing
operations keep their quote and version; a deployment/version change does not cancel
already-running operations. Core package version and pricing version are separate.

Real provider credentials are needed only when you intentionally wire a real provider;
the synthetic acceptance suite needs none, and Clerk is not installed.
