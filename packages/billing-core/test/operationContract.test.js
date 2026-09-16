import { describe, it, expect } from 'vitest';
import { validateOperation, validateQuote, validateDecision, validateUsageRecord, validateFulfillment, assertCapability, creditInteger } from '../index.js';

export const quoteFixture = () => ({
  contractVersion: 1, policyId: 'fixed', policyVersion: '1', unit: 'credit',
  reserveCredits: 2, authorizedCredits: 2, terms: { credits: 2, rounding: 'ceil_operation' },
  limits: { models: ['fixture'], maxCalls: 3, maxRetries: 1, deadlineMs: 30000 },
  billingScope: 'successful_calls', missingUsage: 'defer', fulfillmentVersion: '1',
  createdAt: '2026-09-17T00:00:00Z', expiresAt: '2026-09-17T00:05:00Z',
});
describe('operation contract v1', () => {
  it.each([['text', 'stream'], ['image', 'async'], ['video', 'async']])('expresses %s without a text-only envelope', (taskType, mode) => {
    const op = { id: 'op-1', accountId: 'account-1', featureKey: 'generate', clientRequestId: 'request-1', taskType, mode, inputVersion: '1', input: { assetId: 'asset-v1' } };
    expect(validateOperation(op)).toBe(op);
    const quote = validateQuote(quoteFixture());
    expect(validateDecision({ action: 'settle', credits: 2, reason: 'ready' }, quote).credits).toBe(2);
    const result = { status: 'ready', ruleVersion: '1', resultId: 'result-1', accountId: op.accountId, artifacts: [{ id: 'asset-1', type: taskType, accountId: op.accountId, state: 'available', ...(taskType === 'text' ? { text: 'Ready' } : { storageKey: 'assets/immutable-1', specs: { width: 1024 } }) }] };
    expect(validateFulfillment(result, op.accountId)).toBe(result);
    if (taskType !== 'text') expect(() => assertCapability(op)).toThrow('unsupported_operation');
    else expect(() => assertCapability(op)).not.toThrow();
  });
  it.each([NaN, Infinity, -1, 0.5, '2', 2147483648])('rejects invalid credit amount %s', (amount) => expect(() => creditInteger(amount)).toThrow());
  it('distinguishes no-charge success, release, defer and over-authorization', () => {
    const quote = quoteFixture();
    expect(validateDecision({ action: 'settle', credits: 0, reason: 'complimentary' }, quote).action).toBe('settle');
    expect(validateDecision({ action: 'release', reason: 'failed' }, quote).action).toBe('release');
    expect(validateDecision({ action: 'defer', reason: 'usage_unknown' }, quote).action).toBe('defer');
    expect(() => validateDecision({ action: 'settle', credits: 3, reason: 'ready' }, quote)).toThrow('authorization_exceeded');
  });
  it('preserves unknown versus observed zero and typed media metrics', () => {
    const record = { operationId: 'op', attempt: 1, callId: 'call', provider: 'fake', model: 'fake', outcome: 'succeeded', metrics: { inputTokens: { value: null, unit: 'token', source: 'missing' }, images: { value: 0, unit: 'image', source: 'provider' }, durationMs: { value: 5000, unit: 'millisecond', source: 'synthetic' } } };
    expect(validateUsageRecord(record)).toBe(record);
    expect(() => validateUsageRecord({ ...record, metrics: { images: { value: 1, unit: 'token', source: 'provider' } } })).toThrow('invalid_usage_unit');
  });
  it('rejects foreign results and ephemeral URLs as durable artifacts', () => {
    const result = { status: 'ready', ruleVersion: '1', accountId: 'a', resultId: 'r', artifacts: [{ id: 'i', type: 'image', accountId: 'a', state: 'available', storageKey: 'https://example.com/image?signature=expires', specs: {} }] };
    expect(() => validateFulfillment(result, 'b')).toThrow('result_forbidden');
    expect(() => validateFulfillment(result, 'a')).toThrow('unstable_artifact_reference');
  });
});
