import { createOperationSettlementStore, withCreditTransaction, lockCreditAccount, invariant } from '@yuva/billing-core';
import { chatRecoveryProjectionIssue } from './chatResultPersistence.js';

const terminal = (status) => ['settled', 'no_charge', 'released'].includes(status);

/** Preserve the frozen financial expiry policy without pretending a chat was saved. */
export function createChatRecoverySettlementStore({ db }) {
  const store = createOperationSettlementStore({ db });
  return { ...store, async apply(facts) {
    if (facts.decision?.reason !== 'consumer_protection_waiver') return store.apply(facts);
    return withCreditTransaction(db, async (client) => {
      await lockCreditAccount(client, facts.accountId);
      await client.query('SELECT id FROM ai_operations WHERE id=$1 AND account_id=$2 FOR UPDATE', [facts.operationId, facts.accountId]);
      const locked = createOperationSettlementStore({ db: client });
      const state = await locked.read(facts);
      if (terminal(state.status)) return locked.apply(facts);
      invariant(Number.isSafeInteger(facts.expectedEpoch) && facts.expectedEpoch > 0
        && facts.expectedEpoch === state.operation.executionEpoch && state.operation.leaseOwner,
      'recovery_lease_required', 409);
      // recoveryExpired comes from clock_timestamp() in the locked database read,
      // never a caller timestamp or the decision's reason string.
      invariant(state.operation.recoveryExpired && state.operation.recoveryPolicy?.version === '1'
        && state.operation.recoveryPolicy.onExpiry === 'waive', 'chat_waiver_unavailable', 409);
      const ready = state.fulfillment?.status === 'ready';
      invariant(ready ? facts.decision.action === 'settle' && facts.decision.credits === 0
        : facts.decision.action === 'release', 'chat_waiver_decision_invalid', 409);
      const issue = ready ? chatRecoveryProjectionIssue(state.fulfillment, state.operation) : null;
      if (!issue) return locked.apply(facts);
      return locked.apply({ ...facts, decision: { action: 'release', reason: 'consumer_protection_waiver',
        starterChatProjection: { status: 'deferred', reason: issue, manualReview: true } } });
    }, { trackCommitOutcome: true });
  } };
}

/** Terminal financial operations remain visible for independent projection review. */
export async function listChatProjectionReviews({ db, operationId = null, limit = 20 }) {
  invariant(Number.isInteger(limit) && limit > 0 && limit <= 100);
  const { rows } = await db.query(`SELECT id,financial_status,decision FROM ai_operations
    WHERE financial_status='released' AND fulfillment_status='ready'
      AND decision->>'reason'='consumer_protection_waiver'
      AND decision->'starterChatProjection'->>'status'='deferred'
      AND ($1::uuid IS NULL OR id=$1) ORDER BY updated_at DESC,id LIMIT $2`, [operationId, limit]);
  return rows.map((row) => ({ operationId: row.id, financialStatus: row.financial_status,
    projection: row.decision.starterChatProjection }));
}
