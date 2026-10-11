# Knowledge assistant starter example

A runnable **given-material question-answer template**, not a retrieval system or
RAG implementation. All acceptance data is synthetic. It accepts a question and
`parameters.material` (1–800 characters), then validates an `Answer: ...` response.
The product owns the material schema, prompt and `knowledge-answer-v1` contract.

## Generate and verify independently

From a clean committed starter checkout on Node 24.x / npm 10.9.8:

```sh
npm run release:pack -- --output ../local-core-bundle
node examples/create-consumer.mjs knowledge-assistant ../knowledge-demo ../local-core-bundle
cd ../knowledge-demo
TEST_DATABASE_URL=postgresql://localhost/starter_test npm test
npm run core:verify
```

Use an empty target outside the starter and a disposable local PostgreSQL 16
database. Packing is local: this does not publish npm packages or change existing
vendor artifacts. The generated app installs version/integrity-pinned tarballs,
contains no editable core packages, and can run without the source repository.
Tests create and remove an isolated schema; no paid model or real credentials are
needed. `npm test` fails if the database is unavailable; it never skips acceptance.

## Product composition

Import `createExampleServer` from `starter-app/server/product.js` in your host.
Supply `db` and `auth: { verifyRequest, findUser }`. Verification and tenant-scoped
local-user mapping are server-owned; the test-only opaque credential fixture in
`acceptance` is not a production login adapter. There is no automatic CLI listener
because an unwired authentication adapter must not silently become guest access.
The unchanged starter web is a shell, not a complete enterprise-login UI.

The explicit no-user-billing policy is fixed price **0**, with no starter grants.
The existing operation and ledger schemas remain installed for durable execution;
this is not a claim that the billing storage component has been removed. Acceptance
checks the entire financial row snapshot, no ledger request/allocation, `no_charge`
settlement, result replay and exactly one provider call.

No-charge is not unlimited upstream use: one call, no retries, a conservative
2,000-token input envelope, 128 output tokens and a 1-second deadline remain enforced.
The input envelope is deliberately conservative, not provider-measured token usage.
Acceptance also checks over-budget rejection, propagated deadline cancellation and
no automatic resubmission after timeout. A provider must honor output limits and
abort; local cancellation alone never proves that an upstream bill was zero.

Set a real supported provider in trusted `env` and use its normal adapter only when
you are ready to incur costs. The acceptance suite instead injects a deterministic
local provider and supplies no Clerk/OpenAI/Anthropic credentials. Clerk is absent
from this consumer's installed dependency tree.
