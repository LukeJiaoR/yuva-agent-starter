import { settleFeatureCredits, releaseFeatureCredits } from './creditCore.js';
import { invariant, validateQuote, validateDecision, validateFulfillment } from './operationContract.js';

/** Owns policy/ledger orchestration; result SQL and delivery rules remain product-owned. */
export function createOperationBillingPort({ db, operationStore, policy, executionLimits,
  resolvePolicy = (id, version) => id === policy.id && version === policy.version ? policy : null,
  evaluateFulfillment, persistResult, metadata = () => ({}) }) {
  async function load({ request, reservation, user }) {
    const operation = await operationStore.find({ accountId: user.id, clientRequestId: request.clientRequestId,
      operation: request.operationInput });
    invariant(operation && operation.accountId === user.id, 'operation_not_found', 404);
    invariant(operation.id === reservation.operation?.id
      && operation.ledgerRequestId === (reservation.reservationId ?? reservation.request?.id ?? null), 'reservation_mismatch', 409);
    validateQuote(operation.quote);
    return operation;
  }
  return {
    async reserve({ request, user }) {
      invariant(request.operationInput.accountId === user.id, 'operation_forbidden', 403);
      const quote = policy.quote(request.operationInput, executionLimits);
      validateQuote(quote);
      invariant(quote.policyId === policy.id && quote.policyVersion === policy.version, 'policy_version_unavailable', 409);
      return operationStore.reserve({ operation: request.operationInput, quote });
    },
    async settle(context) {
      const operation = await load(context);
      const quote = structuredClone(operation.quote);
      const selected = resolvePolicy(quote.policyId, quote.policyVersion);
      invariant(selected?.id === quote.policyId && selected?.version === quote.policyVersion, 'policy_version_unavailable', 409);
      const fulfillment = validateFulfillment(await evaluateFulfillment({ ...context, operation, quote: structuredClone(quote) }), operation.accountId);
      invariant(fulfillment.ruleVersion === quote.fulfillmentVersion, 'fulfillment_version_mismatch', 409);
      const decision = validateDecision(await selected.decide(structuredClone(quote), context.usage, fulfillment), quote);
      // Until reliable settlement supports these states, leave funds reserved and return an explicit error.
      invariant(decision.action !== 'defer', 'settlement_deferred', 409);
      invariant(decision.action !== 'settle' || decision.credits !== 0, 'no_charge_unsupported', 409);
      if (decision.action === 'release') {
        await releaseFeatureCredits({ db, userId: operation.accountId, requestId: operation.ledgerRequestId, failureClass: decision.reason });
        invariant(false, 'fulfillment_failed', 422);
      }
      invariant(typeof persistResult === 'function', 'result_persistence_required');
      const result = await settleFeatureCredits({ db, userId: operation.accountId, requestId: operation.ledgerRequestId,
        creditsUsed: decision.credits, metadata: metadata(context),
        persistResult: (client, ledgerRequest) => persistResult({ ...context, client, ledgerRequest, operation, fulfillment, decision }) });
      invariant(result.request?.status === 'settled', 'settlement_not_completed', 409);
      return { ...result, status: 'settled', creditsUsed: result.request.settled_credits, decision };
    },
    async release(context) {
      invariant(!['settlement_deferred', 'no_charge_unsupported', 'policy_version_unavailable', 'fulfillment_version_mismatch']
        .includes(context.error?.code), 'settlement_deferred', 409);
      const operation = await load(context);
      return releaseFeatureCredits({ db, userId: operation.accountId, requestId: operation.ledgerRequestId,
        failureClass: context.failureClass || context.error?.failureClass || 'unknown_failure' });
    },
  };
}
