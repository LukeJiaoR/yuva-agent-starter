import { createHash } from 'node:crypto';
import { canonicalJson, invariant, withCreditTransaction } from '../../../packages/billing-core/index.js';
import { validateMetrics, validateCost, summarizeUsage } from '../../../packages/ai-engine/index.js';

const rank = { missing: 0, synthetic: 1, estimate: 2, provider: 3 };
const fromRow = (row) => ({ callId: row.id, operationId: row.operation_id, attempt: row.attempt,
  provider: row.provider, model: row.model, outcome: row.outcome, billable: row.billable,
  metrics: row.metrics, cost: row.cost, providerRequestId: row.provider_request_id, providerJobId: row.provider_job_id });
export function createUsageStore({ db }) {
  return {
    async start({ callId, operationId, accountId, attempt, provider, model, billable = true }) {
      invariant(Number.isSafeInteger(attempt) && attempt > 0 && typeof billable === 'boolean');
      const { rowCount } = await db.query(`INSERT INTO ai_provider_calls(id,operation_id,attempt,provider,model,billable)
        SELECT $1,o.id,$4,$5,$6,$7 FROM ai_operations o WHERE o.id=$2 AND o.account_id=$3
        ON CONFLICT (id) DO NOTHING`, [callId, operationId, accountId, attempt, provider, model, billable]);
      invariant(rowCount === 1, 'call_identity_conflict', 409);
    },
    async observe({ callId, accountId, observation }) {
      invariant(['succeeded', 'failed', 'cancelled', 'unknown'].includes(observation.outcome));
      const metrics = validateMetrics(observation.metrics);
      const cost = validateCost(observation.cost);
      const safe = { outcome: observation.outcome, metrics, cost,
        providerRequestId: observation.providerRequestId || null, providerJobId: observation.providerJobId || null,
        durationMs: observation.durationMs ?? null };
      invariant(safe.durationMs === null || (Number.isSafeInteger(safe.durationMs) && safe.durationMs >= 0 && safe.durationMs <= 2147483647));
      const digest = createHash('sha256').update(canonicalJson(safe)).digest('hex');
      return withCreditTransaction(db, async (client) => {
        const { rows: [current] } = await client.query(`SELECT c.* FROM ai_provider_calls c JOIN ai_operations o ON o.id=c.operation_id
          WHERE c.id=$1 AND o.account_id=$2 FOR UPDATE OF c`, [callId, accountId]);
        invariant(current, 'call_not_found', 404);
        const { rowCount } = await client.query('INSERT INTO ai_usage_observations(call_id,digest,observation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [callId, digest, safe]);
        if (!rowCount) return fromRow(current);
        invariant(['started', 'unknown', safe.outcome].includes(current.outcome), 'call_outcome_conflict', 409);
        for (const [name, metric] of Object.entries(metrics)) {
          const old = current.metrics[name];
          if (old?.source === 'provider' && metric.source === 'provider' && old.value !== metric.value) invariant(false, 'provider_usage_conflict', 409);
          if (!old || rank[metric.source] >= rank[old.source]) current.metrics[name] = metric;
        }
        if (current.cost?.source === 'provider' && cost?.source === 'provider') invariant(canonicalJson(current.cost) === canonicalJson(cost), 'provider_cost_conflict', 409);
        const mergedCost = cost && (!current.cost || rank[cost.source] >= rank[current.cost.source]) ? cost : current.cost;
        const { rows: [updated] } = await client.query(`UPDATE ai_provider_calls SET outcome=$2,metrics=$3,cost=$4,
          provider_request_id=COALESCE(provider_request_id,$5),provider_job_id=COALESCE(provider_job_id,$6),duration_ms=COALESCE($7,duration_ms),observed_at=NOW()
          WHERE id=$1 RETURNING *`, [callId, safe.outcome, current.metrics, mergedCost, safe.providerRequestId, safe.providerJobId, safe.durationMs]);
        return fromRow(updated);
      });
    },
    async summary({ operationId, accountId }) {
      const { rows } = await db.query(`SELECT c.* FROM ai_provider_calls c JOIN ai_operations o ON o.id=c.operation_id
        WHERE o.id=$1 AND o.account_id=$2 ORDER BY c.started_at,c.id`, [operationId, accountId]);
      return summarizeUsage(rows.map(fromRow));
    },
  };
}
