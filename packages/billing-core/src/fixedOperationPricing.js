import { creditInteger, invariant, validateQuote, validateDecision } from './operationContract.js';

/** Product configuration is trusted; request bodies never select prices. */
export function createFixedOperationPricingPolicy({ credits, fulfillmentVersion = '1', now = Date.now, ttlMs = 300000 }) {
  creditInteger(credits);
  return {
    id: 'fixed', version: '1',
    quote(operation, executionLimits) {
      const created = now();
      return validateQuote({ contractVersion: 1, policyId: 'fixed', policyVersion: '1', unit: 'credit',
        reserveCredits: credits, authorizedCredits: credits, terms: { credits }, limits: structuredClone(executionLimits),
        billingScope: 'successful_calls', missingUsage: 'defer', fulfillmentVersion,
        createdAt: new Date(created).toISOString(), expiresAt: new Date(created + ttlMs).toISOString() });
    },
    decide(quote, usage, fulfillment) {
      validateQuote(quote);
      invariant(quote.policyId === 'fixed' && quote.policyVersion === '1', 'policy_version_unavailable', 409);
      creditInteger(quote.terms.credits);
      invariant(fulfillment.ruleVersion === quote.fulfillmentVersion, 'fulfillment_version_mismatch', 409);
      invariant(['ready', 'failed', 'pending', 'partial'].includes(fulfillment.status));
      return validateDecision(fulfillment.status === 'ready'
        ? { action: 'settle', credits: quote.terms.credits, reason: 'fixed_operation_ready' }
        : fulfillment.status === 'failed'
          ? { action: 'release', reason: 'fulfillment_failed' }
          : { action: 'defer', reason: 'fulfillment_pending' }, quote);
    },
  };
}
