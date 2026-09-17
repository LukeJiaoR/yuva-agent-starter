import { randomUUID } from 'node:crypto';
import { missingProviderUsage } from './providerUsage.js';

export const usageMetricUnits = Object.freeze({ inputTokens: 'token', outputTokens: 'token', totalTokens: 'token',
  cachedInputTokens: 'token', cacheWriteTokens: 'token', reasoningTokens: 'token', toolTokens: 'token',
  images: 'image', durationMs: 'millisecond' });
const validInteger = (value) => Number.isSafeInteger(value) && value >= 0;
export function usageMetrics(usage = missingProviderUsage()) {
  usage ||= missingProviderUsage();
  const metrics = {};
  for (const [name, unit] of Object.entries(usageMetricUnits)) {
    if (!['inputTokens', 'outputTokens'].includes(name) && usage[name] === undefined) continue;
    const value = validInteger(usage[name]) && ['provider', 'estimate', 'synthetic'].includes(usage.source) ? usage[name] : null;
    metrics[name] = { value, unit, source: value === null ? 'missing' : usage.source };
  }
  return metrics;
}
export function validateMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) throw new Error('Invalid typed usage metrics');
  for (const [name, metric] of Object.entries(metrics)) {
    if (!metric || metric.unit !== usageMetricUnits[name] || !usageMetricUnits[name]
      || !['provider', 'estimate', 'synthetic', 'missing'].includes(metric.source)
      || !(metric.value === null || validInteger(metric.value))
      || ((metric.value === null) !== (metric.source === 'missing'))) throw new Error('Invalid typed usage metric');
  }
  return Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, { value: metric.value, unit: metric.unit, source: metric.source }]));
}
/** Cost is an integer string in a stated decimal scale, never a JS money float. */
export function validateCost(cost) {
  if (cost === null || cost === undefined) return null;
  if (typeof cost.amount !== 'string' || !/^[A-Z]{3,8}$/u.test(cost.currency) || !/^\d{1,30}$/u.test(cost.amount)
    || !Number.isInteger(cost.scale) || cost.scale < 0 || cost.scale > 12
    || !['provider', 'estimate', 'synthetic'].includes(cost.source)
    || !['observed', 'estimated', 'reconciled'].includes(cost.status)
    || (cost.source === 'estimate' && cost.status !== 'estimated')) throw new Error('Invalid provider cost');
  return { amount: cost.amount, scale: cost.scale, currency: cost.currency, source: cost.source, status: cost.status };
}
export function usageCost(usage = {}) {
  usage ||= {};
  if (usage.cost) return validateCost(usage.cost);
  if (usage.providerCost === null || usage.providerCost === undefined || !usage.currency
    || !['provider', 'estimate', 'synthetic'].includes(usage.source)) return null;
  // Use the decimal provider representation; never apply a guessed rate or currency.
  const value = String(usage.providerCost);
  if (!/^\d+(?:\.\d{1,12})?$/u.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return validateCost({ amount: (whole + fraction).replace(/^0+(?=\d)/u, ''), scale: fraction.length,
    currency: usage.currency, source: usage.source, status: usage.source === 'estimate' ? 'estimated' : 'observed' });
}
export function summarizeUsage(calls) {
  const metrics = {}, costs = {};
  for (const name of Object.keys(usageMetricUnits)) {
    const observations = calls.map((call) => call.metrics[name]);
    metrics[name] = {
      value: observations.length && observations.every((m) => m && m.value !== null) ? observations.reduce((sum, m) => sum + BigInt(m.value), 0n).toString() : null,
      unit: usageMetricUnits[name], sources: [...new Set(observations.map((m) => m?.source || 'missing'))],
    };
  }
  for (const call of calls) {
    const cost = call.cost;
    if (!cost) continue;
    const previous = costs[cost.currency] || { amount: '0', scale: cost.scale };
    const scale = Math.max(previous.scale, cost.scale);
    costs[cost.currency] = { amount: (BigInt(previous.amount) * 10n ** BigInt(scale - previous.scale)
      + BigInt(cost.amount) * 10n ** BigInt(scale - cost.scale)).toString(), scale };
  }
  return { calls, metrics, costs, costComplete: calls.length > 0 && calls.every((call) => call.cost != null),
    complete: calls.length > 0 && calls.every((call) => !['started', 'unknown'].includes(call.outcome)) };
}
/** Mandatory durable start before invoking provider; missing completion remains recoverable.
 * One invoke means one external call. Adapters disable hidden SDK retries; explicit retries invoke this again.
 */
export function createMeteredProvider({ store, operation, provider, model, attempt = 1, invoke, now = Date.now }) {
  return async (options = {}) => {
    const callId = randomUUID();
    await store.start({ callId, operationId: operation.id, accountId: operation.accountId, attempt, provider,
      model: options.model ?? model, executionBudget: options.executionBudget, expectedEpoch: operation.executionEpoch ?? 0 });
    const started = now();
    const observe = async (result, outcome, failureCode = null) => {
      try {
        await store.observe({ callId, accountId: operation.accountId, observation: {
          outcome, metrics: usageMetrics(result?.usage), cost: usageCost(result?.usage),
          providerRequestId: result?.requestId ?? null, providerJobId: result?.jobId ?? null,
          model: result?.model ?? model, modelIdentitySource: result?.modelIdentitySource ?? 'requested_fallback',
          durationMs: Math.max(0, now() - started), failureCode,
          externalStatus: outcome === 'succeeded' || failureCode === 'provider_refusal' ? 'completed' : 'unknown',
        } });
      } catch (cause) {
        // The start row remains the durable recovery signal. Preserve the partial fact for the caller too.
        throw Object.assign(new Error('Provider usage could not be persisted', { cause }),
          { code: 'usage_persistence_failed', callId, providerResult: result, reconciliationRequired: true });
      }
    };
    let result;
    try { options.signal?.throwIfAborted(); result = await invoke({ ...options, callId }); }
    catch (error) {
      const timeout = options.signal?.reason?.name === 'TimeoutError' || error?.name === 'TimeoutError';
      await observe(error.providerResult, options.signal?.aborted && !timeout ? 'cancelled' : 'failed',
        timeout ? 'provider_timeout' : error.code || 'provider_error');
      throw error;
    }
    await observe(result, ['safety_refusal', 'provider_error'].includes(result?.outcome) ? 'failed' : 'succeeded',
      result?.outcome === 'safety_refusal' ? 'provider_refusal' : null);
    return { ...result, callId };
  };
}
