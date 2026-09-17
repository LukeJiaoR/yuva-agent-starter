import { createHash, randomUUID } from 'node:crypto';
import { reserveFeatureCredits, lockCreditAccount, withCreditTransaction } from './creditCore.js';
import { validateOperation, validateQuote, assertCapability, invariant } from './operationContract.js';

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'invalid_input'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  invariant(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid_input');
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
/** Input must already be authorized and normalized by the product (including asset versions). */
export function operationFingerprint(operation) {
  return createHash('sha256').update(canonicalJson({
    featureKey: operation.featureKey, taskType: operation.taskType, mode: operation.mode,
    inputVersion: operation.inputVersion, input: operation.input,
  })).digest('hex');
}
export function operationFromRow(row) {
  if (!row) return null;
  return { id: row.id, accountId: row.account_id, clientRequestId: row.client_request_id,
    featureKey: row.feature_key, taskType: row.task_type, mode: row.execution_mode, createdAt: row.created_at,
    inputVersion: row.input_version, fingerprint: row.input_fingerprint, quote: row.quote,
    ledgerRequestId: row.ledger_request_id, executionStatus: row.execution_status };
}
export function createOperationStore({ db, capabilities, now = () => new Date() }) {
  async function find({ accountId, clientRequestId, operation }, client = db) {
    const { rows: [row] } = await client.query('SELECT * FROM ai_operations WHERE account_id=$1 AND client_request_id=$2', [accountId, clientRequestId]);
    if (row && operation) invariant(row.input_fingerprint === operationFingerprint(operation), 'idempotency_conflict', 409);
    return operationFromRow(row);
  }
  return {
    find,
    async reserve({ operation: supplied, quote }) {
      const operation = validateOperation({ ...supplied, id: randomUUID() });
      assertCapability(operation, capabilities);
      return withCreditTransaction(db, async (client) => {
        // Same lock order as the legacy ledger; serializes different features sharing a key.
        await lockCreditAccount(client, operation.accountId);
        const existing = await find({ accountId: operation.accountId, clientRequestId: operation.clientRequestId, operation }, client);
        if (existing) return { kind: 'existing', operation: existing };
        const { rows: [legacy] } = await client.query('SELECT * FROM credit_usage_requests WHERE user_id=$1 AND client_request_id=$2', [operation.accountId, operation.clientRequestId]);
        if (legacy) {
          invariant(legacy.feature_key === operation.featureKey, 'idempotency_conflict', 409);
          return { kind: 'legacy', request: legacy }; // Never synthesize a quote for history.
        }
        validateQuote(quote);
        invariant(Date.parse(quote.expiresAt) > now().getTime(), 'quote_expired', 409);
        const reservation = quote.reserveCredits > 0
          ? await reserveFeatureCredits({ db: client, userId: operation.accountId, featureKey: operation.featureKey,
            clientRequestId: operation.clientRequestId, credits: quote.reserveCredits,
            pricingStrategy: quote.policyId === 'token' ? 'dynamic' : 'fixed', allowRetryOnReleased: false })
          : { kind: 'reserved', request: null };
        if (reservation.kind !== 'reserved') return reservation;
        const { rows: [row] } = await client.query(`INSERT INTO ai_operations
          (id,account_id,client_request_id,feature_key,task_type,execution_mode,input_version,input_fingerprint,quote,ledger_request_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
        [operation.id, operation.accountId, operation.clientRequestId, operation.featureKey, operation.taskType, operation.mode,
          operation.inputVersion, operationFingerprint(operation), JSON.stringify(quote), reservation.request?.id || null]);
        return { ...reservation, operation: operationFromRow(row) };
      });
    },
  };
}
