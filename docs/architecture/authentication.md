# Authentication adapters

Status: source-level implementation for the identity portion of issue #50.
This change does not publish a core release or change existing consumer pins.
Consumers need an artifact containing these changes before using the new options;
existing released artifacts may ignore unknown options or still require the Clerk
SDK. Usage-store ownership and independent-consumer acceptance remain separate work.

## Optional Clerk dependency

Current-source `@yuva/auth-core` declares `@clerk/backend` as an optional peer and
loads its verification module only when Clerk credential verification is needed.
Following [npm's optional-peer contract](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#peerdependenciesmeta),
a consumer that uses its own request verifier does not need to install Clerk.
Importing the package root, security helpers, or the custom authentication
middleware does not load the SDK.

The default starter application explicitly depends on `@clerk/backend`, preserving
its Clerk setup. When adopting a future artifact with this dependency boundary,
existing Clerk consumers must declare a compatible SDK directly in their own
application (`@clerk/backend: ^3.16.3`) and update their lockfile. Do not remove it
from a Clerk consumer merely because auth-core's peer is optional. Existing
published versions and consumer vendor pins are unchanged by this source work.

A non-Clerk generated application can remove its direct Clerk dependency after
supplying trusted `auth.verifyRequest` and `auth.findUser` composition. Keep the
application's other required dependencies. Omitting the SDK does not enable guest
access or disable credential checks: selecting Clerk with a credential while the
SDK is absent returns 503 `authentication_unavailable`, with an operator-facing
adapter-unavailable diagnostic. Missing/invalid credentials retain their existing
required/optional authentication behavior. An injected token-level Clerk verifier
still selects the Clerk adapter and requires the SDK for its verification/error
contract; use the request-level port for a different identity system.

## Two trusted server ports

`createRequireAuth` and `createOptionalAuth` keep Clerk as their default. A product
can instead supply both:

- `verifyRequest(req)`: verify the request using the product's authentication
  mechanism and return one of the results below. The core does not read Clerk
  settings, call the Clerk token verifier, or interpret a bearer token in this mode.
- `findUser(userId, db, auth)`: map that verified external identity to the product's
  local user/account profile. The third argument is the complete verified result,
  so a product can scope its lookup by provider and tenant. Return the local user
  object with a nonempty string `id`, or `null` if no profile exists; throw when
  the lookup is unavailable. No default SQL runs for
  a custom verifier.

The existing `db` argument is passed through. The mapper decides whether it uses
that database or another store. The product owns authorization, account linking,
profile provisioning, and the local `user.id` required by application routes.
Providing a custom verifier without an explicit mapper fails at construction.

| Verifier result | Required middleware | Optional middleware |
| --- | --- | --- |
| `{ kind: 'authenticated', userId: 'external-subject', ...verifiedContext }` | Map user, then continue; missing profile gives 409 | Map user, then continue; missing custom profile gives 409 |
| `{ kind: 'missing' }` | 401 `authentication_required` | Continue anonymously |
| `{ kind: 'invalid' }` | 401 `authentication_required` | 401 `authentication_required` |
| `{ kind: 'unavailable' }`, unknown/malformed result, or verifier throws | 503 `authentication_unavailable` | 503 `authentication_unavailable` |

An authenticated result requires a nonempty string `userId`. A mapper failure is
503 `user_profile_unavailable`; required authentication with no local profile is
409 `user_profile_required`. Malformed custom profiles (including missing/empty/non-string `id`) also fail
with 503 `user_profile_unavailable`. Existing custom profile error strings/codes
remain supported. Downstream route errors are not reclassified as authentication errors.

The middleware sets `req.auth` to the verified result and `req.user` to the mapped
local profile. It clears stale authentication/profile fields before verification.
An authenticated custom subject without a local profile is rejected even by
optional middleware, preventing fallback to a shared development guest. The
default Clerk optional middleware retains its existing missing-profile behavior.
The default Clerk path also preserves `req.clerkAuth`; the custom path leaves it
`null` so other code cannot mistake a different provider for Clerk.

## Server composition

The app's `createServer` accepts the same two ports under `auth`:

```js
const app = createServer({
  db,
  config: { env: { ...process.env, ALLOW_DEV_GUEST: 'false' } },
  auth: {
    verifyRequest: enterpriseIdentity.verifyRequest,
    findUser: (subject, database, verified) => profiles.findByExternalIdentity({
      database,
      provider: verified.provider,
      tenantId: verified.tenantId,
      subject,
    }),
  },
});
```

`enterpriseIdentity` and `profiles` above are trusted product-owned adapters,
not modules supplied by an HTTP request. The verifier must actually validate
credentials or consume an already verified server-owned identity context. Merely
decoding a JWT, copying request headers/body fields, or trusting a client-provided
user/tenant ID is not verification. A failed verification must never return
`missing` to gain anonymous access. Authenticated profile lookup failures must
never map to another account or a development guest.

Use `createRequireAuth({ verifyRequest, findUser, db })` directly where every
request requires a mapped profile. `createServer` retains its existing optional
middleware and route-level access policy. Production consumers must keep
`ALLOW_DEV_GUEST=false`; this seam does not add a no-billing strategy or change
billing/account rules.

## Clerk compatibility

Without `verifyRequest`, the factories still call `verifyClerkRequest` and default
to `findMappedClerkUser`. Existing `env`, `tokenVerifier`, and `findUser` options
continue to work. In particular, `tokenVerifier` remains a Clerk token-level hook
and still requires Clerk configuration; it is not the provider-neutral port.
`verifyClerkRequest`, `requireClerkAuth`, and other existing exports stay available.

## Design reference and verification

[Passport's strategy and verify-function contract](https://www.passportjs.org/concepts/authentication/strategies/)
separates credential verification from application-owned storage and distinguishes
invalid credentials from infrastructure failures. This starter applies those
boundaries through existing factory injection, without adopting Passport or a
strategy registry.

`packages/auth-core/test/requestAuth.test.js` covers the factory contract, invalid
and malformed results, exceptions, profile failures, trusted mapping context, and
legacy Clerk behavior. `starter-app/tests/authComposition.test.js` uses real HTTP
requests with deterministic local identity fixtures, no credentials or paid
providers. It checks that rejected verification never reaches guest, database, or
model execution. Live external identity-provider verification is product-specific
and is not claimed by these fixtures.

The release artifact test packs current source into temporary local tarballs and
installs a separate consumer through npm. It asserts that Clerk is absent from
both the lockfile and installed tree, imports all public roots, copies the
product-owned application server, and exercises custom authentication plus
missing-SDK fail-closed responses over real loopback HTTP. This is local artifact
validation, not a release or a live identity-provider test. Installed-SDK tests
separately preserve reason-code classification and signature-only JWKS fallback.
