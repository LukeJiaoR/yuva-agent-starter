import { createHash } from 'node:crypto';
import { canonicalJson, invariant, withCreditTransaction } from '@yuva/billing-core';
import { validateMetrics, validateCost, summarizeUsage } from '@yuva/ai-engine';

const rank = { missing: 0, synthetic: 1, estimate: 2, provider: 3 };
const fromRow = (row) => ({ contractVersion: 1, callId: row.id, operationId: row.operation_id, attempt: row.attempt,
  provider: row.provider, requestedModel: row.model, model: row.observed_model || row.model,
  modelIdentitySource: row.model_identity_source || 'requested_fallback', outcome: row.outcome,
  requestedMetrics: row.requested_metrics, metrics: row.metrics, cost: row.cost,
  providerRequestId: row.provider_request_id, providerJobId: row.provider_job_id,
  durationMs: row.duration_ms, failureCode: row.failure_code, startedAt: row.started_at, observedAt: row.observed_at });
function bounded(value, max) {
  invariant(value == null || (typeof value === 'string' && value.length > 0 && value.length <= max));
  return value ?? null;
}
function sameCost(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return a.currency === b.currency && BigInt(a.amount) * 10n ** BigInt(scale - a.scale) === BigInt(b.amount) * 10n ** BigInt(scale - b.scale);
}
export function createUsageStore({ db }) {
  return {
    async start({ callId, operationId, accountId, attempt, provider, model, requestedMetrics = {} }) {
      invariant(Number.isSafeInteger(attempt) && attempt > 0);
      invariant(bounded(provider, 80) && bounded(model, 160));
      const requested = validateMetrics(requestedMetrics);
      const { rowCount } = await db.query(`INSERT INTO ai_provider_calls(id,operation_id,attempt,provider,model,requested_metrics)
        SELECT $1,o.id,$4,$5,$6,$7 FROM ai_operations o WHERE o.id=$2 AND o.account_id=$3
        ON CONFLICT (id) DO NOTHING`, [callId, operationId, accountId, attempt, provider, model, requested]);
      invariant(rowCount === 1, 'call_identity_conflict', 409);
    },
    async observe({ callId, accountId, observation }) {
      invariant(['succeeded', 'failed', 'cancelled', 'unknown'].includes(observation.outcome));
      const metrics = validateMetrics(observation.metrics);
      const cost = validateCost(observation.cost);
      const safe = { contractVersion: 1, outcome: observation.outcome, metrics, cost,
        providerRequestId: bounded(observation.providerRequestId, 255), providerJobId: bounded(observation.providerJobId, 255),
        model: bounded(observation.model, 160), modelIdentitySource: observation.modelIdentitySource ?? null,
        durationMs: observation.durationMs ?? null, failureCode: bounded(observation.failureCode, 80) };
      invariant(safe.modelIdentitySource === null || ['provider_response', 'requested_fallback', 'synthetic_explicit'].includes(safe.modelIdentitySource));
      invariant(safe.durationMs === null || (Number.isSafeInteger(safe.durationMs) && safe.durationMs >= 0 && safe.durationMs <= 2147483647));
      const digest = createHash('sha256').update(canonicalJson(safe)).digest('hex');
      return withCreditTransaction(db, async (client) => {
        const { rows: [current] } = await client.query(`SELECT c.* FROM ai_provider_calls c JOIN ai_operations o ON o.id=c.operation_id
          WHERE c.id=$1 AND o.account_id=$2 FOR UPDATE OF c`, [callId, accountId]);
        invariant(current, 'call_not_found', 404);
        const { rowCount } = await client.query('INSERT INTO ai_usage_observations(call_id,digest,observation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [callId, digest, safe]);
        if (!rowCount) return fromRow(current);
        invariant(['started', 'unknown', safe.outcome].includes(current.outcome) || safe.outcome === 'unknown', 'call_outcome_conflict', 409);
        for (const [name, metric] of Object.entries(metrics)) {
          const old = current.metrics[name];
          if (old?.source === 'provider' && metric.source === 'provider' && old.value !== metric.value) invariant(false, 'provider_usage_conflict', 409);
          if (!old || rank[metric.source] >= rank[old.source]) current.metrics[name] = metric;
        }
        for (const [column, value] of [['provider_request_id', safe.providerRequestId], ['provider_job_id', safe.providerJobId]]) {
          invariant(!current[column] || !value || current[column] === value, 'provider_identity_conflict', 409);
        }
        if (current.cost?.source === 'provider' && cost?.source === 'provider') invariant(sameCost(current.cost, cost), 'provider_cost_conflict', 409);
        const mergedCost = cost && (!current.cost || rank[cost.source] >= rank[current.cost.source])
          && !(current.cost?.status === 'reconciled' && cost.status !== 'reconciled') ? cost : current.cost;
        const outcome = safe.outcome === 'unknown' && current.outcome !== 'started' ? current.outcome : safe.outcome;
        const replaceModel = safe.model && (current.model_identity_source !== 'provider_response' || safe.modelIdentitySource === 'provider_response');
        if (current.model_identity_source === 'provider_response' && safe.modelIdentitySource === 'provider_response') {
          invariant(current.observed_model === safe.model, 'provider_model_conflict', 409);
        }
        const { rows: [updated] } = await client.query(`UPDATE ai_provider_calls SET outcome=$2,metrics=$3,cost=$4,
          provider_request_id=COALESCE(provider_request_id,$5),provider_job_id=COALESCE(provider_job_id,$6),duration_ms=COALESCE($7,duration_ms),
          observed_model=$8,model_identity_source=$9,failure_code=COALESCE($10,failure_code),observed_at=NOW()
          WHERE id=$1 RETURNING *`, [callId, outcome, current.metrics, mergedCost, safe.providerRequestId, safe.providerJobId, safe.durationMs,
          replaceModel ? safe.model : current.observed_model, replaceModel ? safe.modelIdentitySource : current.model_identity_source, safe.failureCode]);
        return fromRow(updated);
      });
    },
    async history({ callId, accountId }) {
      const { rows } = await db.query(`SELECT h.digest,h.observation,h.observed_at AS "observedAt" FROM ai_usage_observations h
        JOIN ai_provider_calls c ON c.id=h.call_id JOIN ai_operations o ON o.id=c.operation_id
        WHERE c.id=$1 AND o.account_id=$2 ORDER BY h.observed_at,h.digest`, [callId, accountId]);
      return rows;
    },
    async summary({ operationId, accountId }) {
      const { rows } = await db.query(`SELECT c.* FROM ai_provider_calls c JOIN ai_operations o ON o.id=c.operation_id
        WHERE o.id=$1 AND o.account_id=$2 ORDER BY c.started_at,c.id`, [operationId, accountId]);
      return summarizeUsage(rows.map(fromRow));
    },
  };
}
