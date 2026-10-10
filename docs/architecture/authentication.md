# Authentication adapters

Status: source-level implementation for the identity portion of issue #50.
This change does not publish a core release, change existing consumer pins, or
make the Clerk SDK an optional dependency. Consumers need an artifact containing
this change before using the new options; existing released artifacts may ignore
unknown options. Usage-store ownership and independent-consumer acceptance remain
separate work.

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
