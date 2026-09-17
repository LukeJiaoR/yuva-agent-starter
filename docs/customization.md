# Customization

Start with the domain seams. Avoid putting product terms or business rules in `packages/*`; those packages are intended to remain reusable.

## 1. Define domain input and facts

Edit `starter-app/server/domain/adapter.js`.

- Validate the incoming parameter object.
- Normalize values before calculations.
- Compute facts deterministically where possible.
- Keep the snapshot stable enough to replay and audit.
- Add tests for missing, malformed, boundary, and representative inputs.

## 2. Ground the prompts

Edit `starter-app/server/domain/prompts.js`.

- State the assistant's permitted scope.
- Distinguish computed facts from user claims.
- Tell the model how to express uncertainty.
- Define safety and escalation behavior for your vertical.
- Do not put credentials or hidden authorization decisions in prompts.

## 3. Validate complete output

Supply a `validateOutput` function to the server composition root when your vertical needs semantic checks. The server buffers generated text, validates or transforms it, and only then sends it to the client. A validator must return accepted text or reject; it must never rely on text already being visible to the browser.

## 4. Configure pricing

Edit `starter-app/server/domain/pricing.config.js`. Prices are integer credit units. Keep feature keys stable after launch because they appear in usage records.

## 5. Brand the UI

Set these values in `starter-web/.env`:

```env
VITE_APP_NAME=Support Agent
VITE_APP_DESCRIPTION=Resolve cases with grounded product knowledge.
```

Then update labels and input controls in `starter-web/src/main.jsx`. Reuse the CSS tokens in `starter-web/src/styles.css` before adding new visual primitives. Verify light, dark, keyboard, loading, empty, error, desktop, and mobile states.

## 6. Replace development access

Development guest access is convenient locally but is not production authentication. Configure Clerk JWT verification or implement an adapter using `@yuva/auth-core`, set `ALLOW_DEV_GUEST=false`, and test both new-user provisioning and rejected tokens.

## 7. Select a provider

Choose a provider in `starter-app/.env`, add only that provider's required credentials, and verify timeout, upstream failure, and malformed-output paths. The mock provider is local-only.

## Completion checklist

- Product terms exist only in the app workspaces.
- Domain inputs and output validation have tests.
- Credits settle once and release on every failure path.
- Auth, CORS, rate limits, secrets, and error redaction match the deployment.
- `npm run check` passes on Node.js 22 and 24.
# Product pricing and delivery

`createServer({config:{pricing}, aiProduct})` selects trusted application composition.
The default is fixed 2 credits. Explicit token configuration supplies integer
`inputRate` / `outputRate` objects (`credits`, `tokens`), a `featureKey`, and optional
execution `limits`. Unknown strategies fail at startup. Clients cannot select a
policy by passing a price in a request.

For custom delivery, construct `createAiProduct({configuration, evaluateFulfillment,
persistResult})` from `starter-app/server/domain/aiProduct.js` and inject it as
`aiProduct`. The evaluator returns the versioned account-owned fulfillment
contract; the persistence callback receives a transaction client. Keep uploads and
provider requests outside that transaction. Public core source stays unchanged.
Unsupported image/video capabilities remain rejected before reservation; actual
media adapters belong to Epic #14.

Two local examples use the same route and core:

```sh
export TEST_DATABASE_URL='postgresql://user:password@localhost:5432/local_database'
npm run example:fixed
# In another terminal:
npm run dev:web
```

Open http://localhost:5173. Stop the fixed API with Ctrl-C before running
`npm run example:token` on the same port 3000. Each API process creates a separate
temporary schema, applies migrations, seeds a development guest and cleans up its
schema on graceful shutdown. Only loopback PostgreSQL URLs are accepted; production
mode is rejected. An occupied API port fails instead of starting another port.

Both examples use synthetic provider fixtures without keys. The token example
explicitly enables frozen budget-ceiling estimation; displayed charges reflect
that rule, not a real provider rate or measurement. Production token mode defaults
to defer on missing actual usage. Interrupted example processes may leave their
uniquely named `example_fixed_*` / `example_token_*` schemas for operator cleanup.
