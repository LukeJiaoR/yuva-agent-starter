/** Metadata-only projection. No generation, settlement, recovery or funds dependencies. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const isOperationUuid = (value) => typeof value === 'string' && UUID.test(value);
export const financialStatuses = ['unreserved', 'reserved', 'settled', 'no_charge', 'released', 'reconciliation_required'];
const terminal = new Set(['settled', 'no_charge', 'released']);
const enumValue = (value, values) => values.includes(value) ? value : 'unknown';
const identifier = (value, max = 160) => typeof value === 'string' && value.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/u.test(value) ? value : null;
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const safeReasons = new Set(['submission_unknown', 'provider_timeout', 'provider_error', 'provider_refusal', 'provider_unavailable',
  'usage_persistence_failed', 'result_unavailable', 'artifact_unavailable', 'artifact_storage_failed', 'artifact_transfer_failed',
  'artifact_storage_unsafe', 'artifact_publish_mismatch', 'artifact_invalid_image', 'artifact_spec_mismatch',
  'artifact_remote_unavailable', 'artifact_staging_configuration_invalid', 'image_artifact_invalid', 'image_deadline_exceeded', 'image_reconciliation_required', 'image_recovery_expired',
  'ledger_reconciled', 'ledger_request_missing', 'ledger_state_conflict', 'reservation_missing', 'result_identity_conflict',
  'fulfillment_version_mismatch', 'consumer_protection_waiver', 'recovery_expired', 'missing_usage', 'incomplete_usage',
  'policy_version_unavailable', 'no_external_call_started', 'confirmed_execution_failed', 'execution_or_delivery_unknown', 'recovery_failed',
  'execution_fenced', 'execution_lease_lost', 'manual_review', 'reconciliation_required', 'no_charge_success']);
const reason = (value) => value == null ? null : safeReasons.has(value) ? value : 'unclassified_failure';
const bounded = (rows, project, limit = 50) => ({ items: rows.slice(0, limit).map(project), truncated: rows.length > limit });
const metricUnits = { inputTokens: 'token', outputTokens: 'token', totalTokens: 'token', cachedInputTokens: 'token',
  cacheWriteTokens: 'token', reasoningTokens: 'token', toolTokens: 'token', images: 'image', durationMs: 'millisecond' };
function metrics(value) {
  return Object.fromEntries(Object.entries(metricUnits).map(([name, unit]) => {
    const metric = value?.[name];
    const known = metric?.unit === unit && integer(metric.value) !== null && ['provider', 'estimate', 'synthetic'].includes(metric.source);
    return [name, { value: known ? metric.value : null, unit, source: known ? metric.source : 'missing' }];
  }));
}
function cost(value) {
  if (!value || typeof value.amount !== 'string' || !/^\d{1,30}$/u.test(value.amount)
    || typeof value.currency !== 'string' || !/^[A-Z]{3,8}$/u.test(value.currency)
    || !Number.isInteger(value.scale) || value.scale < 0 || value.scale > 12
    || !['provider', 'estimate', 'synthetic'].includes(value.source)
    || !['observed', 'estimated', 'reconciled'].includes(value.status)
    || value.source === 'estimate' && value.status !== 'estimated') {
    return { status: 'missing', source: 'missing', amount: null, currency: null, scale: null };
  }
  return { amount: value.amount, currency: value.currency, scale: value.scale, source: value.source, status: value.status };
}
const summaryColumns = `id,account_id,task_type,execution_status,financial_status,fulfillment_status,created_at,updated_at,
  manual_review,reconciliation_reason`;
const columns = `${summaryColumns},quote,fulfillment,ledger_request_id,recovery_attempts,recovery_error,
  next_recovery_at,recovery_deadline_at,lease_expires_at`;
function summary(row, now) {
  return { operationId: row.id, accountId: row.account_id, taskType: enumValue(row.task_type, ['text', 'image', 'video']),
    executionStatus: enumValue(row.execution_status, ['pending', 'running', 'succeeded', 'failed', 'cancelled', 'submission_unknown']),
    financialStatus: enumValue(row.financial_status, financialStatuses),
    fulfillmentStatus: enumValue(row.fulfillment_status, ['pending', 'partial', 'ready', 'failed']),
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    pendingAgeSeconds: terminal.has(row.financial_status) ? null : Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 1000)),
    manualReview: row.manual_review === true, reconciliationReason: reason(row.reconciliation_reason) };
}
async function readonly(db, read) {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const { rows: [clock] } = await client.query('SELECT CURRENT_TIMESTAMP AS now');
    const result = await read(client, new Date(clock.now).getTime());
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
export function createOperationsReadStore({ db }) {
  return {
    list({ accountId = null, status = null, limit = 20, offset = 0 }) {
      return readonly(db, async (client, now) => {
        const { rows } = await client.query(`SELECT ${summaryColumns} FROM ai_operations
          WHERE ($1::uuid IS NULL OR account_id=$1) AND ($2::text IS NULL OR financial_status=$2)
          ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`, [accountId, status, limit + 1, offset]);
        const hasMore = rows.length > limit;
        return { items: rows.slice(0, limit).map((row) => summary(row, now)),
          page: { limit, offset, hasMore, nextOffset: hasMore && offset + limit <= 10000 ? offset + limit : null } };
      });
    },
    detail({ operationId, accountId = null }) {
      return readonly(db, async (client, now) => {
        const { rows: [row] } = await client.query(`SELECT ${columns} FROM ai_operations WHERE id=$1 AND ($2::uuid IS NULL OR account_id=$2)`, [operationId, accountId]);
        if (!row) return null;
        const { rows: calls } = await client.query(`SELECT id,attempt,provider,model,observed_model,outcome,external_status,
          metrics,cost,duration_ms,failure_code,started_at,observed_at FROM ai_provider_calls
          WHERE operation_id=$1 ORDER BY started_at,id LIMIT 51`, [row.id]);
        const { rows: requests } = await client.query(`SELECT id,status,reserved_credits,settled_credits,credits_released,started_at,completed_at
          FROM credit_usage_requests WHERE id=$1 AND user_id=$2`, [row.ledger_request_id, row.account_id]);
        const { rows: transactions } = await client.query(`SELECT id,transaction_type,direction,amount,status,created_at FROM credit_transactions
          WHERE usage_request_id=$1 AND user_id=$2 ORDER BY created_at,id LIMIT 51`, [row.ledger_request_id, row.account_id]);
        const { rows: events } = await client.query(`SELECT id,action,reason,created_at FROM ai_recovery_events
          WHERE operation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 51`, [row.id]);
        const { rows: audits } = await client.query(`SELECT id,action,status,error_code,created_at,finished_at FROM admin_audit_logs
          WHERE target_type='operation' AND target_id=$1 ORDER BY created_at DESC,id DESC LIMIT 51`, [row.id]);
        const quote = row.quote || {}, request = requests[0];
        return {
          operation: summary(row, now),
          quote: { policyId: identifier(quote.policyId), policyVersion: identifier(quote.policyVersion, 80), unit: quote.unit === 'credit' ? 'credit' : null,
            reserveCredits: integer(quote.reserveCredits), authorizedCredits: integer(quote.authorizedCredits),
            providerBinding: bounded(Array.isArray(quote.limits?.paths) ? quote.limits.paths : [],
              (binding) => ({ provider: identifier(binding?.provider, 80), model: identifier(binding?.model) }), 20) },
          calls: bounded(calls, (call) => ({ callId: call.id, attempt: integer(call.attempt), provider: identifier(call.provider, 80),
            model: identifier(call.observed_model || call.model), outcome: enumValue(call.outcome, ['started', 'succeeded', 'failed', 'cancelled', 'unknown']),
            externalStatus: enumValue(call.external_status, ['unknown', 'completed']), metrics: metrics(call.metrics), cost: cost(call.cost),
            durationMs: integer(call.duration_ms), failureCode: reason(call.failure_code), startedAt: timestamp(call.started_at), observedAt: timestamp(call.observed_at) })),
          artifacts: bounded(Array.isArray(row.fulfillment?.artifacts) ? row.fulfillment.artifacts : [], (artifact) => ({
            artifactId: identifier(artifact?.id, 120), type: enumValue(artifact?.type, ['text', 'image', 'video']),
            state: enumValue(artifact?.state, ['available', 'pending', 'staged', 'failed', 'unavailable']),
            mimeType: enumValue(artifact?.specs?.mediaType, ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'text/plain']),
            byteSize: integer(artifact?.specs?.sizeBytes) })),
          ledger: { request: request ? { requestId: request.id,
            status: enumValue(request.status, ['generating', 'reserved', 'settled', 'released', 'refunded', 'reconciliation_required', 'failed']),
            reservedCredits: integer(request.reserved_credits), settledCredits: integer(request.settled_credits), releasedCredits: integer(request.credits_released),
            startedAt: timestamp(request.started_at), completedAt: timestamp(request.completed_at) } : null,
            transactions: bounded(transactions, (tx) => ({ transactionId: tx.id,
              type: enumValue(tx.transaction_type, ['usage_reserve', 'usage_charge', 'usage_release', 'usage_refund', 'expiration', 'admin_adjustment',
                'admin_reversal', 'refund_reversal', 'purchase_grant', 'subscription_grant', 'signup_grant', 'feedback_reward']),
              direction: enumValue(tx.direction, ['debit', 'credit']), amount: integer(tx.amount), unit: 'credit',
              status: enumValue(tx.status, ['posted', 'pending', 'reversed']), createdAt: timestamp(tx.created_at) })) },
          recovery: { attempts: integer(row.recovery_attempts), manualReview: row.manual_review === true, reason: reason(row.recovery_error),
            nextRecoveryAt: timestamp(row.next_recovery_at), deadlineAt: timestamp(row.recovery_deadline_at), leaseExpiresAt: timestamp(row.lease_expires_at),
            overdue: !terminal.has(row.financial_status) && timestamp(row.recovery_deadline_at) !== null
              && new Date(row.recovery_deadline_at).getTime() <= now,
            events: bounded(events, (event) => ({ eventId: String(event.id), action: enumValue(event.action, ['claimed', 'manual_claimed', 'settled', 'no_charge', 'released', 'deferred', 'manual_review']),
              reason: reason(event.reason), createdAt: timestamp(event.created_at) })) },
          audits: bounded(audits, (audit) => ({ auditId: audit.id, action: 'operation_audit',
            status: enumValue(audit.status, ['pending', 'succeeded', 'failed', 'needs_reconciliation']), errorCode: reason(audit.error_code),
            createdAt: timestamp(audit.created_at), finishedAt: timestamp(audit.finished_at) })),
          paymentEvents: { supported: false },
        };
      });
    },
  };
}
