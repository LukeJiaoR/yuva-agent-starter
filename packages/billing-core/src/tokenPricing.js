import { creditInteger, invariant, validateLimits, validateQuote, validateDecision, MAX_CREDITS } from './operationContract.js';

function rate(value) {
  invariant(value && Number.isSafeInteger(value.credits) && value.credits >= 0
    && Number.isSafeInteger(value.tokens) && value.tokens > 0, 'invalid_token_rate');
  return { credits: value.credits, tokens: value.tokens };
}
function charge(input, output, rates) {
  const denominator = BigInt(rates.input.tokens) * BigInt(rates.output.tokens);
  const numerator = input * BigInt(rates.input.credits) * BigInt(rates.output.tokens)
    + output * BigInt(rates.output.credits) * BigInt(rates.input.tokens);
  return { numerator, denominator, rounded: (numerator + denominator - 1n) / denominator };
}
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;

/** User credit rates are independent of provider currency/cost. BigInt stays internal. */
export function createTokenPricingPolicy({ inputRate, outputRate, fulfillmentVersion = '1',
  allowEstimates = false, now = Date.now, ttlMs = 300000 }) {
  const configuredRates = { input: rate(inputRate), output: rate(outputRate) };
  invariant(typeof allowEstimates === 'boolean');
  return {
    id: 'token', version: '1',
    quote(operation, limits) {
      invariant(operation.taskType === 'text' && ['stream', 'sync'].includes(operation.mode), 'pricing_not_applicable', 422);
      validateLimits(limits);
      invariant(limits.paths?.length > 0 && Number.isSafeInteger(limits.maxInputTokens) && Number.isSafeInteger(limits.maxOutputTokens), 'unbounded_token_plan');
      const input = BigInt(limits.maxInputTokens) * BigInt(limits.maxCalls);
      const output = BigInt(limits.maxOutputTokens) * BigInt(limits.maxCalls);
      const bound = charge(limits.maxTotalInputTokens ? (BigInt(limits.maxTotalInputTokens) < input ? BigInt(limits.maxTotalInputTokens) : input) : input,
        limits.maxTotalOutputTokens ? (BigInt(limits.maxTotalOutputTokens) < output ? BigInt(limits.maxTotalOutputTokens) : output) : output, configuredRates);
      invariant(bound.rounded <= BigInt(MAX_CREDITS), 'token_price_overflow');
      const created = now();
      return validateQuote({ contractVersion: 1, policyId: 'token', policyVersion: '1', unit: 'credit',
        reserveCredits: Number(bound.rounded), authorizedCredits: Number(bound.rounded),
        terms: { taskType: 'text', rates: structuredClone(configuredRates), rounding: 'ceil_operation',
          eligible: 'successful_calls', estimateMethod: allowEstimates ? 'reserved_ceiling_v1' : null },
        limits: structuredClone(limits), billingScope: 'successful_calls', missingUsage: allowEstimates ? 'estimate' : 'defer',
        fulfillmentVersion, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + ttlMs).toISOString() });
    },
    decide(quote, usage, fulfillment) {
      validateQuote(quote);
      invariant(quote.policyId === 'token' && quote.policyVersion === '1', 'policy_version_unavailable', 409);
      invariant(quote.terms.taskType === 'text' && quote.terms.rounding === 'ceil_operation'
        && quote.terms.eligible === 'successful_calls', 'pricing_not_applicable', 422);
      invariant(fulfillment.ruleVersion === quote.fulfillmentVersion, 'fulfillment_version_mismatch', 409);
      const rates = { input: rate(quote.terms.rates?.input), output: rate(quote.terms.rates?.output) };
      const audit = { policyId: 'token', policyVersion: '1', billingScope: quote.billingScope,
        rates, rounding: quote.terms.rounding, calls: [] };
      const defer = (reason) => ({ action: 'defer', reason, audit });
      if (fulfillment.status === 'failed') return { action: 'release', reason: 'fulfillment_failed', audit };
      if (fulfillment.status !== 'ready') return defer('fulfillment_pending');
      if (!Array.isArray(usage?.calls) || !usage.calls.length) return defer('usage_missing');
      const seen = new Set();
      let input = 0n, output = 0n;
      for (const call of usage.calls) {
        invariant(typeof call.callId === 'string' && !seen.has(call.callId), 'duplicate_usage_call');
        seen.add(call.callId);
        if (call.operationId !== undefined) invariant(call.operationId === usage.calls[0].operationId, 'usage_operation_mismatch');
        if (['started', 'unknown'].includes(call.outcome) || call.externalStatus === 'unknown') {
          audit.calls.push({ callId: call.callId, eligible: null, reason: 'execution_outcome_unknown' });
          return defer('execution_outcome_unknown');
        }
        if (call.outcome !== 'succeeded') {
          invariant(['failed', 'cancelled'].includes(call.outcome), 'invalid_usage_outcome');
          audit.calls.push({ callId: call.callId, eligible: false, reason: 'unsuccessful_call' }); continue;
        }
        if (!quote.limits.paths.some((path) => path.provider === call.provider && path.model === (call.requestedModel ?? call.model))) return defer('usage_path_mismatch');
        const evidence = { callId: call.callId, eligible: true, metrics: {} };
        audit.calls.push(evidence);
        for (const [name, rateName] of [['inputTokens', 'input'], ['outputTokens', 'output']]) {
          const metric = call.metrics?.[name];
          if (metric?.value != null) invariant(validCount(metric.value) && metric.unit === 'token', 'invalid_usage_value');
          let value, source, method;
          if (metric?.source === 'provider' && metric.value != null) { value = metric.value; source = 'provider'; }
          else if (rates[rateName].credits === 0) { value = 0; source = 'not_billed'; }
          else if (quote.missingUsage === 'estimate' && quote.terms.estimateMethod === 'reserved_ceiling_v1') {
            value = call.budgetResources?.[name]; source = 'estimate'; method = 'reserved_ceiling_v1';
            if (!validCount(value)) return defer('estimate_basis_missing');
          } else return defer('usage_missing');
          evidence.metrics[name] = { value, source, ...(method ? { method } : {}) };
          if (name === 'inputTokens') input += BigInt(value); else output += BigInt(value);
        }
      }
      if (!audit.calls.some((call) => call.eligible)) return defer('eligible_usage_missing');
      const amount = charge(input, output, rates);
      Object.assign(audit, { inputTokens: input.toString(), outputTokens: output.toString(),
        numerator: amount.numerator.toString(), denominator: amount.denominator.toString(), roundedCredits: amount.rounded.toString() });
      if (amount.rounded > BigInt(quote.authorizedCredits) || amount.rounded > BigInt(quote.reserveCredits)) return defer('authorization_exceeded');
      return validateDecision({ action: 'settle', credits: creditInteger(Number(amount.rounded)),
        reason: amount.rounded === 0n ? 'zero_token_charge' : 'token_usage', audit }, quote);
    },
  };
}
