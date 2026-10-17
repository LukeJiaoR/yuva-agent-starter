# Read-only operation timeline

The starter includes an opt-in metadata workbench for issue #80. It does not grant anyone operator access, create users, install a scheduler, retry generation, settle charges, recover operations, change balances, or expose payment payloads. Default `OPERATIONS_VIEW=disabled`; set exactly `OPERATIONS_VIEW=read-only` in the server environment to mount the read routes. Authentication remains required. Unknown values remain disabled.

## Trusted authorization wiring

A verified user can inspect only their own local account through `/api/operations`. Cross-account reads require a server-side `createServer` configuration function:

```js
createServer({
  db,
  auth, // an existing trusted verifier and local profile mapper
  config: {
    env: { ...process.env, OPERATIONS_VIEW: 'read-only' },
    operationsReadCapabilities: async ({ user }) => {
      // Consult your existing trusted access-control source by LOCAL immutable user.id.
      // Do not read request headers, role strings or client-editable profile metadata.
      return await accessControl.mayReadOperations(user.id)
        ? ['operations:read:any'] : [];
    },
  },
});
```

This example requires the deployer's own `accessControl` implementation. No operator grant or grant-management endpoint is included. No default operator exists. A missing/throwing resolver or any return other than the exact one-element `['operations:read:any']` array denies operator access. Objects, truthy strings, role names, mixed/unknown capability arrays and duplicate capabilities are rejected. The resolver receives only frozen `{auth:{kind:'authenticated',userId},user:{id}}` identifiers from verified authentication/profile mapping, never the request, tokens or full profile. Authorize by local `user.id`; provider subject `auth.userId` alone is not globally unique across providers/tenants. Authentication/provider mapping itself remains the deployer's trust boundary.

## HTTP contract

All endpoints are GET-only with `Cache-Control: private, no-store`:

- `/api/operations/capabilities`: `{enabled:true,selfRead:true,operatorRead:boolean}`. UI discovery is informational; every operator endpoint checks permission again.
- `/api/operations`: own account list; accepts only `limit` (1–50, default 20) and `offset` (0–10000, default 0).
- `/api/operations/:operationId`: own account detail. Foreign and absent IDs both return 404.
- `/api/ops/operations`: operator list, with the same pagination plus optional `accountId` UUID and `status` financial-status filter (`unreserved`, `reserved`, `settled`, `no_charge`, `released`, `reconciliation_required`). Without account filter, returns operations across accounts.
- `/api/ops/operations/:operationId`: operator detail across accounts.

Disabled endpoints return 404; unauthenticated requests return 401; authenticated nonoperators on operator endpoints return 403. Unknown/duplicate parameters, malformed UUIDs, out-of-range/noninteger pagination, self-account/status overrides, and any detail query parameters return 422. Lists are ordered by created time then stable operation UUID descending. Responses contain `{items,page:{limit,offset,hasMore,nextOffset}}`; `nextOffset:null` with `hasMore:true` means the bounded offset window ended. Offset pages are live snapshots; concurrent inserts can shift page boundaries. Narrow operator filters or refresh rather than treating pages as an immutable export.

A summary contains operation/account IDs, task type, execution/financial/fulfillment states, created/updated timestamps, pending age in seconds, manual-review flag and a whitelisted reconciliation reason. Pending age is null for financially terminal operations. Age and overdue flags are diagnostics only, never a refund/waiver decision.

Detail contains:

- `operation`: the summary.
- `quote`: policy ID/version, credit unit, authorized/reserved credits, and `providerBinding:{items:[{provider,model}],truncated}` (maximum 20). No quote terms, credentials, prompt, raw limits, or request input.
- `calls:{items,truncated}`: call ID, attempt, provider/model identity, outcome/external status, typed metrics, typed cost, duration, safe failure code and timestamps. No provider request/job IDs or raw usage-observation objects. Known metric keys have `{value,unit,source}`; missing observations have null value and source `missing`.
- `artifacts:{items,truncated}`: artifact ID, type, state, allowed media type and byte size. No generated text, downloads, source URL, storage key, account metadata or raw fulfillment.
- `ledger`: linked account-matched usage request status/credit counts/times and `{transactions:{items,truncated}}` with ID, safe transaction type/status, direction, amount, credit unit and creation time. No unrelated account transactions, balances, payment references, transaction metadata or payment payloads.
- `recovery`: attempts, manual-review flag, safe reason, next recovery/deadline/lease-expiry timestamps, overdue flag and bounded events. No lease owner, mutable recovery policy or controls.
- `audits:{items,truncated}`: existing `admin_audit_logs` rows explicitly targeting this operation (`target_type='operation'`, target ID equals operation UUID), limited to audit ID, generic action `operation_audit`, status, safe error code and times. Actor/email, reasons and before/after snapshots are excluded. Legacy account/ledger-target audits are not inferred to belong to an operation. Reads never insert audits.
- `paymentEvents:{supported:false}`: payment-event timeline linkage is not implemented. This is not evidence that no payment exists.

Calls, artifacts, transactions, recovery events and audit rows each cap at 50 and signal truncation explicitly. Calls/transactions retain the first 50 chronologically; recovery/audit events retain the latest 50. Unknown persisted enums project to `unknown`; unknown failure strings to `unclassified_failure` rather than exposing arbitrary error text. Identifier-like values are bounded. No raw JSON object is passed through.

Cost retains integer-string amount, decimal scale, stated currency, source (`provider`, `estimate`, `synthetic`) and status (`observed`, `estimated`, `reconciled`). For example `amount:'123',scale:2,currency:'EUR'` means EUR 1.23. Known zero stays `'0'`. Missing/invalid cost is `{amount:null,scale:null,currency:null,source:'missing',status:'missing'}`. No guessed price, currency conversion, aggregate sum or claim that missing cost is zero. Existing `ops:inspect` legacy cost placeholder is not used to override durable call facts.

## Read isolation and verification

The read store imports no generation, funds, settlement or recovery implementation. It uses PostgreSQL `REPEATABLE READ READ ONLY` transactions with a five-second statement timeout and SELECT queries, without locks or data mutations. Existing authentication verification still runs before the view; its own provider/session behavior is outside this store. No schema migration, core package, scheduler or external provider is required by this feature.

Run only against a disposable PostgreSQL test database:

```sh
TEST_DATABASE_URL=postgresql://... npm test -- starter-app/tests/operationsRead.test.js
TEST_DATABASE_URL=postgresql://... npm run test:acceptance
npm run build
```

Verification status (2026-10-15): at the user's request, further test execution is paused. The final candidate has not completed post-freeze tests or full regression/acceptance verification. Earlier results are not proof for this revised candidate. The following describes intended test coverage, not a claim that this candidate passed.

The PG/HTTP suite is designed to cover authorization and forged roles, local-account isolation, exact resolver contract, malformed queries, limits and nested truncation, unknown/zero/estimated/provider cost, submission-unknown/storage-failure/ledger-reconciliation/overdue metadata, sensitive sentinels, READ ONLY enforcement, and identical contents of every application table before/after repeated reads. Fixtures are synthetic. The suite does not call real providers or configure real permissions.

## Recovery runner wiring remains manual

The view never invokes the recovery runner. Existing CLI entry point:

```sh
npm run ops:recover -- --dry-run --limit 20
npm run ops:recover -- --dry-run --operation <operation-uuid>
```

Run these separately only with authorized database access. `--apply` is an explicit mutation command; `--review --operation <operation-uuid>` is scoped manual review. Neither is a workbench action. The existing CLI composes the chat-compatible recovery/settlement ports and known pricing policies. A deployer must wire task-specific provider reconciliation/artifact ports and policy versions for other products; this page does not imply generic image/payment recovery support. Never infer refund eligibility from age alone.

For scheduling, deployers may separately arrange an authorized cron/systemd/job invocation of the CLI, choosing cadence, credentials, limits, overlapping-run policy, logs and alerts. The existing lease/epoch fencing must be preserved. No schedule, automatic run, external alert service or deployment is installed by enabling this view. Start with dry-run, review policy/version and reconciliation semantics, then obtain applicable authorization before apply-mode deployment.
