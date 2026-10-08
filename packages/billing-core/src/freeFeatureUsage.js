import { lockCreditAccount, normalizeCreditBalance, withCreditTransaction } from './creditCore.js';

// Project spendable buckets at the database clock without posting expiry during
// a free operation. Scheduled expiry remains the ledger owner's responsibility.
export async function readFreeUsageBalance({ db, userId }) {
  const { rows: [row] } = await db.query(
    `SELECT a.credit_debt, a.reserved_credits,
      COALESCE(SUM(g.remaining_credits) FILTER (WHERE g.status = 'active'
        AND (g.expires_at IS NULL OR g.expires_at > NOW())),0)::int AS available_credits,
      COALESCE(SUM(g.remaining_credits) FILTER (WHERE g.status = 'active' AND g.credit_type = 'membership'
        AND (g.expires_at IS NULL OR g.expires_at > NOW())),0)::int AS membership_credits,
      COALESCE(SUM(g.remaining_credits) FILTER (WHERE g.status = 'active' AND g.credit_type = 'purchased'),0)::int AS purchased_credits,
      COALESCE(SUM(g.reserved_credits) FILTER (WHERE g.status <> 'revoked' AND g.credit_type = 'membership'),0)::int AS membership_reserved_credits,
      COALESCE(SUM(g.reserved_credits) FILTER (WHERE g.status <> 'revoked' AND g.credit_type = 'purchased'),0)::int AS purchased_reserved_credits
     FROM credit_accounts a LEFT JOIN credit_grants g ON g.user_id = a.user_id
     WHERE a.user_id = $1 GROUP BY a.user_id, a.credit_debt, a.reserved_credits`, [userId]);
  return normalizeCreditBalance(row);
}

function fail(code) { throw Object.assign(new Error(code), { code, status: 409 }); }
function policyFor(policy) {
  if (!policy || policy.pricingStrategy !== 'free' || policy.creditCost !== 0
    || !/^[a-z][a-z0-9_]{1,79}$/.test(policy.featureKey || '')
    || !/^[a-z][a-z0-9_.:-]{1,79}$/.test(policy.priceVersion || '')) fail('free_usage_policy_required');
  return { feature_key: policy.featureKey, price_version: policy.priceVersion, credit_cost: 0 };
}
function assertFree(request) {
  if (!request || request.pricing_strategy !== 'free'
    || Number(request.reserved_credits) !== 0 || Number(request.settled_credits) !== 0
    || Number(request.credits_released) !== 0 || request.metadata?.credit_cost !== 0
    || !request.metadata?.price_version) fail('free_usage_identity_invalid');
}

/** Explicit server-composed free policy. No expiry, grant, allocation or ledger
 * writes. Admission and recovery callbacks run under the owner's account lock.
 * Products own source/claim fencing, limits and additive schema migrations.
 */
export async function startFreeFeatureUsage({ db, userId, clientRequestId, chartId = null,
  policy, metadata = {}, admit = null, resume = false, authorizeResume = null }) {
  const frozen = policyFor(policy);
  if (!userId || !clientRequestId) fail('free_usage_identity_required');
  if (resume && typeof authorizeResume !== 'function') fail('free_usage_recovery_authority_required');
  return withCreditTransaction(db, async client => {
    const account = await lockCreditAccount(client, userId);
    const { rows: [existing] } = await client.query(
      'SELECT * FROM credit_usage_requests WHERE user_id = $1 AND feature_key = $2 AND client_request_id = $3 FOR UPDATE',
      [userId, frozen.feature_key, clientRequestId]);
    if (existing) {
      assertFree(existing);
      if (existing.chart_id !== chartId || existing.metadata.price_version !== frozen.price_version) fail('free_usage_identity_changed');
      if (!resume || !['generating', 'failed', 'cancelled'].includes(existing.status)) {
        return { kind: 'existing', request: existing, balance: await readFreeUsageBalance({ db: client, userId }) };
      }
    }
    if (Number(account.credit_debt) > 0) return { kind: 'debt', balance: await readFreeUsageBalance({ db: client, userId }) };
    if (existing && await authorizeResume(client, existing) !== true) fail('free_usage_recovery_denied');
    const balance = await readFreeUsageBalance({ db: client, userId });
    const { rows: [request] } = existing ? await client.query(
      `UPDATE credit_usage_requests SET status = 'generating', attempt_no = attempt_no + 1,
        failure_class = NULL, started_at = NOW(), completed_at = NULL, balance_after = NULL,
        updated_at = NOW() WHERE id = $1 RETURNING *`, [existing.id])
      : await client.query(
        `INSERT INTO credit_usage_requests (user_id, feature_key, chart_id, client_request_id,
          idempotency_key, pricing_strategy, status, attempt_no, reserved_credits, balance_before, started_at, metadata)
         VALUES ($1,$2,$3,$4,$5,'free','generating',1,0,$6,NOW(),$7::jsonb) RETURNING *`,
        [userId, frozen.feature_key, chartId, clientRequestId, `${frozen.feature_key}:${userId}:${clientRequestId}`,
          balance.available, JSON.stringify({ ...metadata, price_version: frozen.price_version, credit_cost: 0 })]);
    await admit?.(client, request);
    return { kind: 'started', request, balance };
  });
}

/** Complete a durable execution in the same transaction as its owned result and
 * usage facts. Financial success is represented by settled with zero Credits;
 * limited/failure/cancellation are distinct terminal outcomes, never refunds.
 */
export async function completeFreeFeatureUsage({ db, requestId, userId, outcome = 'settled',
  persistResult = null, persistUsageEvent = null, failureClass = null, metadata = {}, attemptNo = null }) {
  if (!['settled', 'limited', 'failed', 'cancelled'].includes(outcome)) fail('free_usage_outcome_invalid');
  if (['settled', 'limited'].includes(outcome) && typeof persistResult !== 'function') fail('free_usage_result_required');
  return withCreditTransaction(db, async client => {
    await lockCreditAccount(client, userId);
    const { rows: [request] } = await client.query(
      'SELECT * FROM credit_usage_requests WHERE id = $1 AND user_id = $2 FOR UPDATE', [requestId, userId]);
    assertFree(request);
    if (attemptNo !== null && request.attempt_no !== attemptNo) fail('free_usage_attempt_changed');
    if (request.status !== 'generating') {
      if (request.status !== outcome) fail('free_usage_terminal_conflict');
      return { replay: true, request, balance: await readFreeUsageBalance({ db: client, userId }) };
    }
    const result = await persistResult?.(client, request);
    if (['settled', 'limited'].includes(outcome) && !result?.id) fail('free_usage_result_required');
    await persistUsageEvent?.(client, request);
    const balance = await readFreeUsageBalance({ db: client, userId });
    // Policy fields cannot be overwritten by result telemetry or caller metadata.
    const safeMetadata = { ...metadata, price_version: request.metadata.price_version, credit_cost: 0 };
    const { rows: [completed] } = await client.query(
      `UPDATE credit_usage_requests SET status = $2, result_id = $3, balance_after = $4,
        failure_class = $5, metadata = metadata || $6::jsonb, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [request.id, outcome, result?.id || null, balance.available, failureClass, JSON.stringify(safeMetadata)]);
    return { replay: false, request: completed, result, balance };
  });
}

export function failFreeFeatureUsage(input) {
  return completeFreeFeatureUsage({ ...input, outcome: input.cancelled ? 'cancelled' : 'failed', persistResult: null });
}
