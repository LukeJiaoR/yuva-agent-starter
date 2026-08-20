export const MAX_ENTITLEMENT_PERIODS_PER_RUN = 12;

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label}`);
  return date;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Invalid entitlement cursor');
  }
  return parsed;
}

function anchoredUtcMonth(anchor, offset) {
  const absoluteMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + offset;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(anchor.getUTCDate(), lastDay),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  ));
}

/**
 * Generic recurring entitlement period planner.
 * Calculates upcoming entitlement intervals without tying to specific products or point amounts.
 */
export function planRecurringEntitlements({
  currentPeriodStart,
  currentPeriodEnd,
  nextEntitlementPeriod,
  now = new Date(),
  maxPeriods = MAX_ENTITLEMENT_PERIODS_PER_RUN,
}) {
  const anchor = validDate(currentPeriodStart, 'entitlement period start');
  const paidThrough = validDate(currentPeriodEnd, 'entitlement period end');
  const observedAt = validDate(now, 'entitlement observation time');
  if (paidThrough <= anchor) throw new Error('Invalid entitlement period');

  const limit = positiveInteger(maxPeriods, MAX_ENTITLEMENT_PERIODS_PER_RUN);
  let cursor = nonNegativeInteger(nextEntitlementPeriod);
  const periods = [];

  while (periods.length < limit) {
    const start = anchoredUtcMonth(anchor, cursor);
    if (start >= paidThrough || start > observedAt) break;
    const naturalEnd = anchoredUtcMonth(anchor, cursor + 1);
    const end = naturalEnd < paidThrough ? naturalEnd : paidThrough;
    if (end <= start) break;
    periods.push({
      index: cursor,
      start: start.toISOString(),
      end: end.toISOString(),
      expired: end <= observedAt,
    });
    cursor += 1;
  }

  const naturalNext = anchoredUtcMonth(anchor, cursor);
  const next = naturalNext < paidThrough ? naturalNext : paidThrough;
  return {
    periods,
    nextEntitlementPeriod: cursor,
    nextEntitlementAt: next.toISOString(),
    bounded: periods.length === limit && next < paidThrough && next <= observedAt,
  };
}

export const planAnnualMembershipEntitlements = planRecurringEntitlements;
