import { randomUUID } from 'node:crypto';
import { missingProviderUsage } from './providerUsage.js';

const metricUnits = Object.freeze({ inputTokens: 'token', outputTokens: 'token', cachedInputTokens: 'token', reasoningTokens: 'token', images: 'image', durationMs: 'millisecond' });
const validInteger = (value) => Number.isSafeInteger(value) && value >= 0;
export function usageMetrics(usage = missingProviderUsage()) {
  const metrics = {};
  for (const [name, unit] of Object.entries(metricUnits)) {
    if (!['inputTokens', 'outputTokens'].includes(name) && usage[name] === undefined) continue;
    const value = validInteger(usage[name]) ? usage[name] : null;
    metrics[name] = { value, unit, source: value === null ? 'missing' : ['provider', 'estimate', 'synthetic'].includes(usage.source) ? usage.source : 'provider' };
  }
  return metrics;
}
export function validateMetrics(metrics) {
  for (const [name, metric] of Object.entries(metrics)) {
    if (!metric || metric.unit !== metricUnits[name] || !metricUnits[name]
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
    || !['observed', 'estimated', 'reconciled'].includes(cost.status)) throw new Error('Invalid provider cost');
  return { amount: cost.amount, scale: cost.scale, currency: cost.currency, source: cost.source, status: cost.status };
}
export function usageCost(usage = {}) {
  if (usage.cost) return validateCost(usage.cost);
  if (usage.providerCost === null || usage.providerCost === undefined || !usage.currency) return null;
  // Normalize the SDK's decimal representation without inventing a rate/currency.
  const value = String(usage.providerCost);
  if (!/^\d+(?:\.\d{1,12})?$/u.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return validateCost({ amount: (whole + fraction).replace(/^0+(?=\d)/u, ''), scale: fraction.length,
    currency: usage.currency, source: usage.source === 'synthetic' ? 'synthetic' : 'provider', status: 'observed' });
}
export function summarizeUsage(calls) {
  const metrics = {}, costs = {};
  for (const name of Object.keys(metricUnits)) {
    const observations = calls.map((call) => call.metrics[name]);
    metrics[name] = {
      value: observations.every((m) => m && m.value !== null) ? observations.reduce((sum, m) => sum + BigInt(m.value), 0n).toString() : null,
      unit: metricUnits[name], sources: [...new Set(observations.map((m) => m?.source || 'missing'))],
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
  return { calls, metrics, costs, costComplete: calls.every((call) => call.cost !== null), complete: calls.every((call) => call.outcome !== 'started' && call.outcome !== 'unknown') };
}
/** Mandatory durable start before invoking provider; missing completion remains recoverable. */
export function createMeteredProvider({ store, operation, provider, model, attempt = 1, invoke, now = Date.now }) {
  return async (options) => {
    const callId = randomUUID();
    await store.start({ callId, operationId: operation.id, accountId: operation.accountId, attempt, provider, model });
    const started = now();
    let result;
    try { result = await invoke({ ...options, callId }); }
    catch (error) {
      const partial = error.providerResult || {};
      await store.observe({ callId, accountId: operation.accountId, observation: {
        outcome: options.signal?.aborted ? 'cancelled' : 'failed', metrics: usageMetrics(partial.usage), cost: usageCost(partial.usage),
        providerRequestId: partial.requestId || null, durationMs: Math.max(0, now() - started),
      } });
      throw error;
    }
    await store.observe({ callId, accountId: operation.accountId, observation: {
      outcome: result?.outcome === 'safety_refusal' ? 'failed' : 'succeeded',
      metrics: usageMetrics(result?.usage), cost: usageCost(result?.usage), providerRequestId: result?.requestId || null,
      durationMs: Math.max(0, now() - started),
    } });
    return { ...result, callId };
  };
}
