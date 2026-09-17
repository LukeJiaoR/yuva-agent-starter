# Token user pricing

`createTokenPricingPolicy` implements the same quote/decide contract as fixed
operation pricing. It accepts text stream/sync operations with bounded provider
paths. Rates are trusted application configuration expressed as integer credits
per integer token count, independently for input and output. They are customer
rates, not provider currency costs. Media is rejected before reservation.

Quotes freeze rates, supported scope, rounding, limits and missing-usage policy.
The reservation is the ceiling of worst-case input/output across the maximum
call count, optionally constrained by aggregate execution ceilings. Calculations
use BigInt rational arithmetic. Eligible counts aggregate across calls first;
the combined rational charge rounds upward exactly once per operation. Public
audit values serialize large integers as decimal strings. Charges and reservations
must fit the existing PostgreSQL credit integer range.

Only successful calls contribute to user charges; failed internal attempts retain
usage and provider cost facts without increasing the customer fee. Cached input
and reasoning are subsets and are not added again. Unknown execution blocks a
decision. Required missing/estimated/synthetic token measurements default to defer.
Explicit `allowEstimates: true` freezes `reserved_ceiling_v1`: missing measurements
use the recorded per-call budget hold with an estimate label. Actual known zero
remains zero. The policy never overwrites the underlying observation history.
Zero-rate fields need no charge-bearing measurement; a missing call set still
defers rather than fabricating free success.

Audit details include policy version, call references and eligibility, rates,
chosen metric source/estimate method, aggregated counts, numerator, denominator
and rounded credits. Above-authorization results defer with the uncapped computed
amount for review. Zero rounds to the shared no-charge success path. All decisions
use the same operation billing adapter and atomic ledger settlement mechanism.

Tests use deliberately synthetic user rates: 2,000 input plus 1,000 output at
1/1,000 and 2/1,000 credits costs 4 credits. These are not vendor prices. Application
configuration and two runnable examples are implemented separately in #9.
