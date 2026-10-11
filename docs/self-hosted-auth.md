# Self-hosted application authentication

This application-owned adapter uses **Better Auth 1.7.7** (MIT) and PostgreSQL.
It provides email/password signup, verification, password recovery, HttpOnly-cookie
sessions, a local developer inbox, and device/session revocation. It is not an
OAuth/OIDC issuer. Google/GitHub, external clients, MFA, passkeys, account linking,
and migration of existing Clerk users are intentionally not enabled in this slice.
Clerk remains available with `AUTH_MODE=clerk`, the backward-compatible default.

The implementation lives in `starter-app/server/auth` and `starter-web/src/auth`.
The five reusable packages, published versions, and checked-in consumer vendor
bundles are unchanged. It uses the current-source provider-neutral `verifyRequest`
and `findUser` ports; an older published auth-core artifact is not implicitly
upgraded. Use a reviewed new core release before adopting this app in a released
consumer. A local generated consumer can use an explicit `--development` bundle
for evaluation; never overwrite the published 1.5.0 tarballs with current source.

## Local quickstart

Use Node 24 and the [PostgreSQL quickstart](quickstart.md). Copy the example files,
run `npm ci`, and apply `npm run db:migrate` to your disposable development database.
In `starter-app/.env`, set:

```dotenv
AUTH_MODE=self-hosted
ALLOW_DEV_GUEST=false
BETTER_AUTH_URL=http://localhost:5173
FRONTEND_URL=http://localhost:5173
AUTH_TRUSTED_ORIGINS=http://localhost:5173
AUTH_MAIL_MODE=capture
AUTH_SIGNUP_CREDITS=25
BETTER_AUTH_SECRET=
```

Generate your own private signing secret with `openssl rand -base64 32` and put it
in `BETTER_AUTH_SECRET`. Do not commit it or reuse example/test fixtures. Missing
configuration fails startup, even in development. Nothing creates a persistent
credential or contacts an OAuth provider automatically.

Run `npm run dev` and open **http://localhost:5173** (use the exact configured
hostname). The Vite `/api` proxy preserves the same-origin cookie contract.
Choose Sign in → Create account. Open the development inbox, explicitly refresh
it, open the verification message, and confirm verification. Sign in to finish
provisioning your application profile and receive the one-time configured credit
grant. An interrupted/repeated profile request is safe to retry.

Capture mode sends no real email. It keeps at most 50 messages for 15 minutes in
memory, clears on restart, and binds the default API entrypoint to 127.0.0.1. Its
HTTP inbox additionally requires the exact configured loopback Host, loopback
socket, a custom header, and trusted origin or browser same-origin fetch metadata;
forwarded proxy headers are rejected. Do not expose this development API/Vite
server through public tunnels, reverse proxies, `--host 0.0.0.0`, or shared networks.
If you use a custom entrypoint, preserve the loopback listener restriction.

Verification and reset emails carry short-lived tokens in URL **fragments**, never
query strings. The UI immediately removes the fragment from browser history and
keeps the token only in component memory. Clicking a link does not verify an
account or change a password automatically; confirmation is explicit. Closing or
reloading a reset/verification dialog clears its in-memory token, so reopen the
email to retry. Session credentials are never stored in localStorage.

Changing accounts or losing the current session clears the previous account's
product inputs, analysis, streamed answer and pending-operation retry ID. It also
aborts outstanding requests and reloads pricing for the new identity. A delayed
response from the previous account cannot continue work in the new account.

## Production requirements

- Explicit `AUTH_MODE=self-hosted`, `NODE_ENV=production`, `ALLOW_DEV_GUEST=false`.
- One HTTPS application origin for both `BETTER_AUTH_URL` and `FRONTEND_URL`.
  Route `/api` to the API at that origin. Cross-site frontend/API deployments are
  unsupported by the host-only SameSite=Lax cookie policy.
- Set exact `AUTH_TRUSTED_ORIGINS` and `CORS_ORIGIN`; no wildcard origins.
- A private high-entropy 32+ character `BETTER_AUTH_SECRET` supplied by the operator.
- A managed PostgreSQL connection with the reviewed migration **007** applied by
  `npm run db:migrate`; startup does not run migrations or upstream CLI commands.
- `AUTH_MAIL_MODE=smtp`, `AUTH_SMTP_HOST`, `AUTH_SMTP_PORT` (465 or 587),
  `AUTH_SMTP_USER`, `AUTH_SMTP_PASSWORD`, and `AUTH_MAIL_FROM`. Port 465 uses TLS;
  587 requires STARTTLS. Certificate validation is never disabled. Configure
  sender-domain delivery policies with your mail provider before real delivery.
- Run `npm run ops:verify -- --production` with the intended environment.
  This validates configuration only, not live credentials or deliverability.

The standalone server supports SMTP and development capture. An application can
instead use `AUTH_MAIL_MODE=custom` and `createServer({ sendAuthMail: async
({to,subject,text}) => ... })` to inject its own delivery adapter. The production
CLI rejects `custom` because it cannot verify that your custom entrypoint supplies
one. No credentials, remote accounts, or mail are created by installation.

Mail runs asynchronously to avoid account-enumeration differences from SMTP
latency. Failures are recorded without message contents; `/ready` returns 503 with
`authentication: mail_unavailable` after a failure and recovers after a subsequent
successful delivery. Users may explicitly request a new email. This first adapter
has no durable mail outbox or automatic retry worker: delivery can be lost on a
process crash. Readiness also checks that the auth tables exist and all three
credential/session guards are enabled for normal origin connections (`O` or
always-enabled `A`); disabled `D` and replica-only `R` guards report
`schema_unavailable`. Only `session_replication_role=origin` is supported; `local`
and `replica` are rejected by this probe. Keep that setting consistent across the
application pool. This check observes the selected probe connection, not every
connection or the full schema/function definitions, and is not an auth-route gate.
High-reliability deployments should inject a durable queue before launch.
Do not log mail URLs, bodies, authorization headers, cookies, or passwords.
Configure reverse-proxy/application logging to exclude request bodies and cookies.

Forwarded IP headers are ignored by default; IP limits then conservatively apply
to the directly connected peer (including a reverse proxy). A product behind a
proxy should configure Express's `trust proxy` for its exact known proxy addresses
in its own entrypoint, then test spoofed forwarded headers and actual IP limits.
Never trust arbitrary internet-supplied `X-Forwarded-For` or enable blanket trust.
Capture mode must not use this production proxy setup.

## Identity, sessions, and credit ownership

`auth_users`, `auth_accounts`, `auth_sessions`, `auth_verifications`, and
`auth_rate_limits` are separate from business `users` and the existing ledger.
`identity_bindings` uniquely maps `(authority, subject)` to a business user. New
verified users explicitly POST `/api/auth/provision`; the transaction serializes
identity/email creation, inserts the binding and credit account, and grants signup
credits once with a stable ledger idempotency key. Clients cannot supply role,
credits, user ID, or binding target. New profiles also reserve the legacy external-identity columns with the self-hosted authority, so the old email-claiming Clerk helper cannot adopt them after a mode change.

An existing business user's email is **not ownership evidence**. Even an unbound
legacy profile produces 409 `identity_conflict`; its user ID, balance and history
remain unchanged. The UI directs the user to the application operator for a
separately designed recovery/linking process. This version exposes no account-link
or unlink endpoint; adding one requires fresh authentication and proof of control
of both identities, conflict checks, and protection against removing the last
login method. Ordinary signup never opens an admin role.

PostgreSQL is the session source of truth; cookie session caching and automatic
session extension are disabled. Sessions expire after seven days. Production
cookies are Secure, HttpOnly, host-only and SameSite=Lax. Sign-out, device
revocation, password reset and account disablement invalidate the next request.
Device management requires a login within five minutes. A browser receives only
safe session IDs/timestamps/user-agent labels, never a session bearer token.

Migration 007 provides two atomic credential safeguards:

1. A genuine credential password insert/change increments `credential_version`
   and deletes that auth user's sessions in the same database transaction. Token
   refresh, unchanged passwords, and business/ledger changes do not revoke them.
   Rolling back the credential write also rolls back revocation.
2. Sign-in captures the credential version **before** Better Auth checks the
   password. Session insertion locks the auth user and verifies that version,
   verification status and disabled status. Thus a login that validated an old
   password before a concurrent reset cannot create a usable session afterward.

These hooks and trigger contracts are part of the adapter, not optional DB
maintenance. Re-run their real PostgreSQL tests on every Better Auth upgrade.
Do not change an applied migration: add the next numbered migration for changes.
Password-reset identifiers are hashed in the DB, expire after 15 minutes, and are
atomically consumed once by Better Auth. Rate limits use PostgreSQL for both IP
and hashed-email keys. Infrastructure errors fail closed with 503 and no raw DB
messages in browser responses or logs.

## HTTP boundary and validation

Only a small application allowlist is mounted at `/api/auth` before Express's
JSON parser; a separate 16 KiB raw-body limit is applied. Auth writes require JSON
and a trusted Origin. Every cookie-authenticated business write also checks
Origin and Fetch Metadata; CORS alone is not CSRF protection. Non-authenticated
public routes keep the existing anonymous contract. Bad credentials return 401,
auth/provider faults 503, and a verified identity without a business profile 409.
Explicit self-hosted configuration never falls back to Clerk.

`selfHostedAuth.test.js` uses real PostgreSQL and actual HTTP to cover signup,
verification, cookie flags, concurrency and one-time grants, legacy email
conflicts, Origin/CSRF, invalid-versus-unavailable errors, reset expiry/replay and
revocation, credential rotation races/rollback, device ownership/freshness,
database faults, rate limiting, and asynchronous mail failures. It is required by
`npm run test:acceptance`, which refuses missing DB configuration or skipped tests.
The frontend tests exercise token-fragment cleanup, canceled/stale requests, and
mounted React account changes, including private-buffer cleanup, delayed streams,
pricing reloads and device-list refresh. DOM tests do not replace real-browser
layout, accessibility or desktop/narrow-screen visual checks.

```bash
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/disposable npm run test:acceptance
npm run build
npm run ops:verify
```

Use synthetic data. These checks do not claim real SMTP delivery, a production
migration, a provider OAuth callback, a deployment, or a published core release.
