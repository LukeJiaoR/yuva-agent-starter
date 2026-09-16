import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isolatedDatabase, operationFixture, quoteFixture } from './helpers/database.js';
import { createOperationStore, grantCredits } from '../../packages/billing-core/index.js';
import { createUsageStore } from '../server/stores/usageStore.js';
import { createMeteredProvider, usageMetrics, validateMetrics, validateCost, streamProviderText } from '../../packages/ai-engine/index.js';

describe('durable usage observations', () => {
  let db, close, accountId, operation, store;
  beforeAll(async () => {
    ({ db, close } = await isolatedDatabase()); accountId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    await grantCredits({ db, userId: accountId, credits: 10, creditType: 'purchased', idempotencyKey: randomUUID() });
    ({ operation } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote: quoteFixture() }));
    store = createUsageStore({ db });
  });
  afterAll(async () => close?.());
  it('records all calls, failures and zero usage without generating charge entries', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ usage: { inputTokens: 10, outputTokens: 0, source: 'provider' } })
      .mockRejectedValueOnce(Object.assign(new Error('failed'), { providerResult: { usage: { inputTokens: 5, outputTokens: null, source: 'provider' } } }))
      .mockResolvedValueOnce({ usage: { inputTokens: 3, outputTokens: 2, source: 'provider' } });
    const run = createMeteredProvider({ store, operation, provider: 'fixture', model: 'fixture', invoke });
    await run({}); await expect(run({})).rejects.toThrow('failed'); await run({});
    const summary = await store.summary({ operationId: operation.id, accountId });
    expect(summary.calls).toHaveLength(3);
    expect(summary.metrics.inputTokens.value).toBe('18');
    expect(summary.metrics.outputTokens.value).toBeNull();
    expect(summary.calls.some((c) => c.metrics.outputTokens.value === 0)).toBe(true);
    expect(summary.costComplete).toBe(false);
    expect((await db.query("SELECT id FROM credit_transactions WHERE transaction_type='usage_charge'")).rows).toHaveLength(0);
  });
  it('keeps provenance when missing/estimated observations are filled and duplicate callbacks do not aggregate twice', async () => {
    const callId = randomUUID();
    await store.start({ callId, operationId: operation.id, accountId, attempt: 1, provider: 'fixture', model: 'fixture' });
    const observe = (metrics, cost) => store.observe({ callId, accountId, observation: { outcome: 'succeeded', metrics, cost } });
    await observe(usageMetrics());
    await observe(usageMetrics({ images: 3, source: 'estimate' }));
    const facts = { images: { value: 3, unit: 'image', source: 'provider' } };
    const cost = { currency: 'USD', amount: '20', scale: 3, source: 'provider', status: 'observed' };
    await observe(facts, cost); await observe(facts, cost);
    expect((await db.query('SELECT * FROM ai_usage_observations WHERE call_id=$1', [callId])).rows).toHaveLength(3);
    expect((await store.summary({ operationId: operation.id, accountId })).costs.USD).toEqual({ amount: '20', scale: 3 });
    await expect(observe({ images: { value: 2, unit: 'image', source: 'provider' } }, cost)).rejects.toMatchObject({ code: 'provider_usage_conflict' });
    expect((await store.summary({ operationId: operation.id, accountId: randomUUID() })).calls).toHaveLength(0);
  });
  it('retains a started call when completion persistence fails; start failure prevents upstream call', async () => {
    const invoke = vi.fn(async () => ({}));
    const run = createMeteredProvider({ store: { ...store, observe: async () => { throw new Error('storage unavailable'); } }, operation, provider: 'fixture', model: 'fixture', invoke });
    await expect(run({})).rejects.toThrow('storage unavailable');
    expect((await store.summary({ operationId: operation.id, accountId })).calls.some((c) => c.outcome === 'started')).toBe(true);
    const denied = createMeteredProvider({ store: { start: async () => { throw new Error('no storage'); } }, operation, provider: 'fixture', model: 'fixture', invoke });
    await expect(denied({})).rejects.toThrow('no storage');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('keeps observed partial usage when the SDK stream ends without a terminal finish', async () => {
    async function* chunks() { yield { type: 'finish-step', usage: { inputTokens: 7, outputTokens: 0 }, response: {} }; }
    try {
      await streamProviderText({ provider: 'fixture', model: 'fixture', stream: () => ({ fullStream: chunks() }), modelFactory: () => ({ provider: 'fixture', model: {} }), onText: () => {} });
      throw new Error('expected failure');
    } catch (error) {
      expect(error.code).toBe('incomplete_provider_stream');
      expect(error.providerResult.usage.inputTokens).toBe(7);
      expect(error.providerResult.usage.outputTokens).toBe(0);
    }
  });
  it('rejects fractional metrics and invalid money and distinguishes zero from unknown', () => {
    expect(() => validateMetrics({ durationMs: { value: 1.5, unit: 'millisecond', source: 'provider' } })).toThrow();
    expect(() => validateCost({ currency: 'USD', amount: 0.2, scale: 2, source: 'provider', status: 'observed' })).toThrow();
    expect(usageMetrics({ inputTokens: 0, source: 'provider' }).inputTokens.value).toBe(0);
    expect(usageMetrics({}).inputTokens.value).toBeNull();
    expect(usageMetrics(null).inputTokens.value).toBeNull();
  });
});
