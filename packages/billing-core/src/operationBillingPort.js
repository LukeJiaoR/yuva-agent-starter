import { invariant, validateQuote, validateDecision, validateFulfillment } from './operationContract.js';
import { createOperationSettlementStore } from './operationSettlement.js';

/** Owns policy/ledger orchestration; result SQL and delivery rules remain product-owned. */
export function createOperationBillingPort({ db, operationStore, policy, executionLimits,
  resolvePolicy = (id, version) => id === policy.id && version === policy.version ? policy : null,
  evaluateFulfillment, persistResult, readUsage, metadata = () => ({}), settlementStore = createOperationSettlementStore({ db }) }) {
  async function load({ request, reservation, user }) {
    const operation = await operationStore.find({ accountId: user.id, clientRequestId: request.clientRequestId,
      operation: request.operationInput });
    invariant(operation && operation.accountId === user.id, 'operation_not_found', 404);
    invariant(operation.id === reservation.operation?.id
      && operation.ledgerRequestId === (reservation.reservationId ?? reservation.request?.id ?? null), 'reservation_mismatch', 409);
    validateQuote(operation.quote);
    return operation;
  }
  const identity = (operation) => ({ operationId: operation.id, accountId: operation.accountId });
  const terminal = (state) => ['settled', 'no_charge', 'released'].includes(state.status);
  const mark = async (operation, reason) => settlementStore.markReconciliation({ ...identity(operation), reason });
  return {
    async state(context) { return settlementStore.read(identity(await load(context))); },
    async reserve({ request, user }) {
      invariant(request.operationInput.accountId === user.id, 'operation_forbidden', 403);
      const quote = policy.quote(request.operationInput, executionLimits);
      validateQuote(quote);
      invariant(quote.policyId === policy.id && quote.policyVersion === policy.version, 'policy_version_unavailable', 409);
      return operationStore.reserve({ operation: request.operationInput, quote });
    },
    async settle(context) {
      const operation = await load(context);
      const existing = await settlementStore.read(identity(operation));
      if (terminal(existing)) return existing;
      const quote = structuredClone(operation.quote);
      const selected = resolvePolicy(quote.policyId, quote.policyVersion);
      invariant(selected?.id === quote.policyId && selected?.version === quote.policyVersion, 'policy_version_unavailable', 409);
      const fulfillment = validateFulfillment(await evaluateFulfillment({ ...context, operation, quote: structuredClone(quote) }), operation.accountId);
      invariant(fulfillment.ruleVersion === quote.fulfillmentVersion, 'fulfillment_version_mismatch', 409);
      const usage = readUsage ? await readUsage(identity(operation)) : context.usage;
      const decision = validateDecision(await selected.decide(structuredClone(quote), usage, fulfillment), quote);
      // Persist a candidate so storage/settlement can recover without another paid generation.
      await settlementStore.stage({ ...identity(operation), fulfillment });
      try {
        return await settlementStore.apply({ ...identity(operation), decision, fulfillment, metadata: metadata(context),
          persistResult: persistResult ? (facts) => persistResult({ ...context, ...facts }) : undefined });
      } catch (error) {
        await mark(operation, error.code === 'commit_outcome_unknown' ? error.code : 'result_persistence_failed').catch(() => {});
        throw error;
      }
    },
    async release(context) {
      const operation = await load(context);
      const current = await settlementStore.read(identity(operation));
      if (terminal(current)) return current;
      if (current.status === 'reconciliation_required' || current.fulfillment?.status === 'ready') return mark(operation, 'release_requires_reconciliation');
      return settlementStore.apply({ ...identity(operation), decision: { action: 'release', reason: context.failureClass || 'confirmed_failure' },
        fulfillment: { accountId: operation.accountId, ruleVersion: operation.quote.fulfillmentVersion, status: 'failed', artifacts: [] } });
    },
    async onFailure(context) {
      const operation = await load(context);
      const current = await settlementStore.read(identity(operation));
      if (terminal(current)) return current;
      const usage = readUsage ? await readUsage(identity(operation)) : null;
      const uncertain = context.phase === 'settlement' || context.error?.reconciliationRequired
        || current.status === 'reconciliation_required' || current.fulfillment?.status === 'ready'
        || usage?.calls?.some((call) => call.outcome === 'started' || call.externalStatus === 'unknown');
      if (uncertain) return mark(operation, context.error?.code || 'execution_outcome_unknown');
      return settlementStore.apply({ ...identity(operation), decision: { action: 'release', reason: context.error?.code || 'confirmed_failure' },
        fulfillment: { accountId: operation.accountId, ruleVersion: operation.quote.fulfillmentVersion, status: 'failed', artifacts: [] } });
    },
  };
}
