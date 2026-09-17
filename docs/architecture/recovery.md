# Operation recovery

The recovery runner queries existing operations and repairs financial state. It
has no generation interface and never automatically resubmits a paid task.

Migration 6 adds a monotonically increasing execution epoch, lease owner/expiry,
next recovery time, attempt count, bounded error code and manual-review flag.
Initial ownership lasts through the frozen execution deadline plus a minute for
settlement. Expired records can be claimed once under a short PostgreSQL lock;
claiming never releases funds or resubmits provider work.

The recovery store exposes list/claim/heartbeat/finish/metrics. Heartbeats cannot
revive expired ownership. Financial transitions compare the expected epoch under
the same operation lock used by settlement. Terminal states remain immutable and
replayable. Usage starts also compare epochs, while late observations can still
record historical provider facts independently of charging.

The billing adapter retains the epoch from the original reservation. It must not
silently adopt a newly read epoch after another worker has claimed ownership.
Recovery workers pass their claimed epoch explicitly. After eight attempts,
records move to manual review and stop ordinary automatic claims. The immutable
per-operation recovery policy defaults to a seven-day consumer-protection deadline;
trusted products may freeze `terms.recoveryPolicy` with version `1`, `maxAgeMs`
(up to one year) and `onExpiry: 'waive'`. At that deadline, even manual-review rows
are eligible for a final consumer-protection pass: a ready result becomes no-charge
success; otherwise the reservation is released with `consumer_protection_waiver`.
External execution facts remain unknown/running, not fabricated as failed. Any
supplier cost is borne by the product; later usage never reopens a closed bill.
No command is scheduled by installation, so operators must run the command for
deadlines to be acted upon. Financial/usage/audit evidence is retained indefinitely
by this implementation; product retention exports/purges require a separate policy.

`recoveryLease.test.js` uses real PostgreSQL to verify active lease protection,
concurrent claims, stale executor fencing, expired heartbeats and persistent retry
limits. `recoveryRunner.test.js` covers read-only preview, lease-expired external
running jobs, durable result recovery, ledger-first repair, concurrent runs,
deadline waivers, manual retry and real CLI execution against isolated PostgreSQL.

## Operator commands

Use the selected environment's DATABASE_URL without printing it. No migration or
provider configuration is run implicitly by these commands.

```sh
npm run ops:recover -- --dry-run --limit 20
npm run ops:recover -- --dry-run --operation <uuid>
npm run ops:recover -- --apply --operation <uuid>
npm run ops:recover -- --review --operation <uuid>
npm run ops:recover -- --review --apply --operation <uuid>
```

Dry-run is the default: no lease claims, writes or external callbacks. Manual
review requires an explicit operation and still respects active leases; each
claim is audited. JSON output contains operation IDs, bounded action/reason codes,
pending count, oldest age, expired leases and manual count. It excludes prompts,
outputs, credentials and provider error payloads. Inspect `ai_recovery_events`
for attempts and outcomes using a tenant-authorized operational connection.

The CLI resolves fixed/1 and token/1 implementations; both read the stored quote's
terms rather than current prices. Custom versions require an application runner
with an explicit resolver. The CLI has no external query adapter, so unknown calls
remain pending until facts arrive, manual review is performed, or waiver is due.

Applications inject `inspectExecution({operation,calls})`, returning status
unknown/running/failed/completed, optional observations for existing call IDs and
optional validated fulfillment. It must query existing provider job/request IDs
or recover existing artifacts, never submit a generation. Calls happen outside
database transactions while heartbeat renews ownership. Failure loses progress
but cannot bypass epoch checks; bounded codes and attempts remain for review.
Returned observations go through the same provenance store. A ready candidate can
be settled using the original policy without another provider call; a known ledger
terminal status wins before any policy or external query.

Before manual execution, examine ledger state, canonical fulfillment, call outcome
and provider identity. Do not infer cancellation from a lease expiry. Unknown
commits require fresh database reads; committed ledger results are never debited
again. If required policy/usage/artifacts remain unavailable, retain pending state
and its deadline rather than inventing evidence. Media adapters here are fixtures;
real async submission, storage transfer and callbacks belong to #14.
