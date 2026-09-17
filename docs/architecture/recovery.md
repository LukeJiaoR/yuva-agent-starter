# Operation recovery (in development)

Issue #13 is not complete. The current branch establishes durable ownership and
fencing before implementing the recovery runner and operational commands.

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
Recovery workers pass their claimed epoch explicitly. After the configured attempt
limit, records move to manual review and stop automatic claims. This alone is not
a complete retention/consumer-protection policy; that policy, external-status
querying, terminal-ledger repair, runner, dry-run CLI and runbook remain required
before #13 can merge.

`recoveryLease.test.js` uses real PostgreSQL to verify active lease protection,
concurrent claims, stale executor fencing, expired heartbeats and persistent retry
limits. These tests do not claim that operational recovery is complete.
