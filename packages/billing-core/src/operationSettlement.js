import { lockCreditAccount, withCreditTransaction, settleFeatureCredits, releaseFeatureCredits } from './creditCore.js';
import { invariant, validateDecision, validateFulfillment } from './operationContract.js';
import { operationFromRow, canonicalJson } from './operationStore.js';

const terminal = (state) => ['settled', 'no_charge', 'released'].includes(state);
function result(row, replay = false) {
  return { status: row.financial_status, creditsUsed: row.financial_status === 'settled' ? row.decision?.credits : 0,
    operation: operationFromRow(row), fulfillment: row.fulfillment, decision: row.decision, replay };
}

/** Short atomic transition over the existing ledger and a product-independent canonical result. */
export function createOperationSettlementStore({ db }) {
  const read = async ({ operationId, accountId }) => {
    const { rows: [row] } = await db.query('SELECT * FROM ai_operations WHERE id=$1 AND account_id=$2', [operationId, accountId]);
    invariant(row, 'operation_not_found', 404);
    return result(row, terminal(row.financial_status));
  };
  async function transact(identity, callback) {
    return withCreditTransaction(db, async (client) => {
      await lockCreditAccount(client, identity.accountId);
      const { rows: [row] } = await client.query('SELECT * FROM ai_operations WHERE id=$1 AND account_id=$2 FOR UPDATE', [identity.operationId, identity.accountId]);
      invariant(row, 'operation_not_found', 404);
      if (terminal(row.financial_status)) return result(row, true);
      return callback(client, row);
    }, { trackCommitOutcome: true });
  }
  return {
    read,
    async stage({ operationId, accountId, fulfillment }) {
      return transact({ operationId, accountId }, async (client, row) => {
        validateFulfillment(fulfillment, accountId);
        invariant(fulfillment.ruleVersion === row.quote.fulfillmentVersion, 'fulfillment_version_mismatch', 409);
        if (row.fulfillment_status === 'ready') invariant(canonicalJson(row.fulfillment) === canonicalJson(fulfillment), 'result_identity_conflict', 409);
        const { rows: [updated] } = await client.query(`UPDATE ai_operations SET fulfillment=$2,fulfillment_status=$3,
          execution_status=CASE WHEN $3::varchar='ready' THEN 'succeeded' ELSE execution_status END,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [row.id, fulfillment, fulfillment.status]);
        return result(updated);
      });
    },
    async markReconciliation({ operationId, accountId, reason = 'reconciliation_required' }) {
      return transact({ operationId, accountId }, async (client, row) => {
        const { rows: [updated] } = await client.query(`UPDATE ai_operations SET financial_status='reconciliation_required',
          reconciliation_reason=$2,execution_status=CASE WHEN execution_status='running' THEN 'submission_unknown' ELSE execution_status END,
          updated_at=NOW() WHERE id=$1 RETURNING *`, [row.id, reason.slice(0, 160)]);
        return result(updated);
      });
    },
    async apply({ operationId, accountId, decision, fulfillment, persistResult, metadata = {} }) {
      return transact({ operationId, accountId }, async (client, row) => {
        validateDecision(decision, row.quote);
        validateFulfillment(fulfillment, accountId);
        invariant(fulfillment.ruleVersion === row.quote.fulfillmentVersion, 'fulfillment_version_mismatch', 409);
        if (row.fulfillment_status === 'ready') invariant(canonicalJson(row.fulfillment) === canonicalJson(fulfillment), 'result_identity_conflict', 409);
        invariant(decision.action !== 'settle' || fulfillment.status === 'ready', 'result_unavailable', 409);
        let status = 'reconciliation_required';
        if (decision.action === 'settle') {
          const persist = async (client, ledgerRequest) => {
            if (persistResult) await persistResult({ client, ledgerRequest, fulfillment, decision, operation: operationFromRow(row) });
            return { id: fulfillment.resultId };
          };
          if (decision.credits > 0) {
            invariant(row.ledger_request_id, 'reservation_missing', 409);
            const settled = await settleFeatureCredits({ db: client, userId: accountId, requestId: row.ledger_request_id,
              creditsUsed: decision.credits, persistResult: persist, metadata });
            invariant(settled.request.status === 'settled' && settled.request.settled_credits === decision.credits, 'ledger_state_conflict', 409);
            status = 'settled';
          } else {
            if (row.ledger_request_id) {
              const released = await releaseFeatureCredits({ db: client, userId: accountId, requestId: row.ledger_request_id, failureClass: 'no_charge_success' });
              invariant(released.request.status === 'released', 'ledger_state_conflict', 409);
            }
            await persist(client, { id: row.ledger_request_id ?? row.id });
            status = 'no_charge';
          }
        } else if (decision.action === 'release') {
          if (row.ledger_request_id) {
            const released = await releaseFeatureCredits({ db: client, userId: accountId, requestId: row.ledger_request_id, failureClass: decision.reason });
            invariant(released.request.status === 'released', 'ledger_state_conflict', 409);
          }
          status = 'released';
        }
        const executionStatus = fulfillment.status === 'ready' ? 'succeeded' : fulfillment.status === 'failed' ? 'failed' : row.execution_status;
        const { rows: [updated] } = await client.query(`UPDATE ai_operations SET financial_status=$2,
          fulfillment_status=$3,fulfillment=$4,decision=$5,execution_status=$6,reconciliation_reason=$7,updated_at=NOW()
          WHERE id=$1 RETURNING *`, [row.id, status, fulfillment.status, fulfillment, decision, executionStatus,
          status === 'reconciliation_required' ? decision.reason : null]);
        return result(updated);
      });
    },
  };
}
