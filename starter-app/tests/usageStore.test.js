import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isolatedDatabase, operationFixture, quoteFixture } from './helpers/database.js';
import { createOperationStore, grantCredits } from '@yuva/billing-core';
import { createUsageStore } from '../server/stores/usageStore.js';
import { createMeteredProvider, usageMetrics, validateMetrics, validateCost, streamProviderText, generateProviderText, normalizeSdkProviderResult, summarizeUsage } from '@yuva/ai-engine';

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
    await expect(run({})).rejects.toMatchObject({ code: 'usage_persistence_failed', reconciliationRequired: true });
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

describe('usage provenance and recovery boundaries', () => {
  let db, close, operation, store, accountId;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    ({ operation } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote: quoteFixture(0) }));
    store = createUsageStore({ db });
  });
  const cost = (currency, amount, scale = 3) => ({ currency, amount, scale, source: 'provider', status: 'observed' });
  const start = async (provider = 'fixture', requestedMetrics = {}) => {
    const callId = randomUUID();
    await store.start({ callId, operationId: operation.id, accountId, attempt: 1, provider, model: 'requested', requestedMetrics });
    return callId;
  };
  const observe = (callId, observation) => store.observe({ callId, accountId, observation: { outcome: 'succeeded', metrics: {}, ...observation } });
  const summary = () => store.summary({ accountId, operationId: operation.id });
  it('supports media without tokens, separates requested and generated quantity from validated artifacts, and deduplicates a job', async () => {
    const callId = await start('image-fixture', { images: { value: 4, unit: 'image', source: 'synthetic' } });
    const observation = { providerJobId: 'job-1', metrics: { images: { value: 3, unit: 'image', source: 'provider' } }, cost: cost('USD', '30') };
    await observe(callId, observation); await observe(callId, observation);
    const other = await start('video-fixture');
    await observe(other, { metrics: { durationMs: { value: 1250, unit: 'millisecond', source: 'provider' } }, cost: cost('EUR', '10') });
    const result = await summary();
    expect(result.calls[0].requestedMetrics.images.value).toBe(4);
    expect(result.calls[0].metrics.images.value).toBe(3);
    expect(result.calls[0].metrics.inputTokens).toBeUndefined();
    expect(result.calls[1].metrics.durationMs.value).toBe(1250);
    expect(result.costs).toEqual({ USD: { amount: '30', scale: 3 }, EUR: { amount: '10', scale: 3 } });
    expect((await store.history({ callId, accountId }))).toHaveLength(1);
    const { validateFulfillment } = await import('@yuva/billing-core');
    const delivered = validateFulfillment({ status: 'ready', resultId: 'result', accountId, ruleVersion: '1', artifacts: [1, 2].map((i) => ({
      id: `image-${i}`, accountId, type: 'image', state: 'available', storageKey: `images/${i}`, specs: { width: 1024 } })) }, accountId);
    expect(delivered.artifacts).toHaveLength(2);
    expect((await summary()).calls[0].metrics.images.value).toBe(3);
    const duplicate = await start('image-fixture');
    await expect(observe(duplicate, observation)).rejects.toMatchObject({ code: '23505' });
  });
  it('preserves every missing, synthetic, estimated and provider observation with tenant-scoped history', async () => {
    const callId = await start();
    for (const [source, value] of [['missing', null], ['synthetic', 2], ['estimate', 3], ['provider', 0]]) {
      await observe(callId, { metrics: { outputTokens: { value, source, unit: 'token' } } });
    }
    await observe(callId, { metrics: { inputTokens: { value: null, unit: 'token', source: 'missing' } } });
    const history = await store.history({ callId, accountId });
    expect(history.slice(0, 4).map((h) => h.observation.metrics.outputTokens.source)).toEqual(['missing', 'synthetic', 'estimate', 'provider']);
    expect((await summary()).calls[0].metrics.outputTokens.value).toBe(0);
    expect(await store.history({ callId, accountId: randomUUID() })).toEqual([]);
    await expect(store.observe({ callId, accountId: randomUUID(), observation: { outcome: 'succeeded', metrics: {} } })).rejects.toMatchObject({ code: 'call_not_found' });
  });
  it('retains submetrics without adding them to input/output and sums money at exact scales', async () => {
    const callId = await start();
    await observe(callId, { metrics: usageMetrics({ inputTokens: 10, cachedInputTokens: 4, cacheWriteTokens: 2, outputTokens: 8, reasoningTokens: 3, source: 'provider' }), cost: cost('USD', '123456789012345678901234', 12) });
    const second = await start();
    await observe(second, { metrics: usageMetrics({ inputTokens: 0, outputTokens: 0, source: 'provider' }), cost: cost('USD', '1', 0) });
    const result = await summary();
    expect(result.metrics.inputTokens.value).toBe('10'); expect(result.metrics.outputTokens.value).toBe('8');
    expect(result.metrics.totalTokens.value).toBeNull();
    expect(result.costs.USD).toEqual({ amount: '123456789013345678901234', scale: 12 });
    await observe(second, { cost: { ...cost('USD', '1000'), status: 'reconciled' } });
    expect((await summary()).calls[1].cost.status).toBe('reconciled');
    const raw = normalizeSdkProviderResult({ usage: { raw: { currency: 'USD', cost: '900719925474.123456789012' } } });
    expect(raw.usage.cost.amount).toBe('900719925474123456789012');
  });
  it.each(['refused', 'cancelled', 'timeout'])('records %s even with unknown or partial usage', async (kind) => {
    const controller = new AbortController();
    const invoke = async () => {
      if (kind === 'refused') return { outcome: 'safety_refusal', usage: { source: 'provider', inputTokens: 2, outputTokens: 0 } };
      controller.abort(kind === 'timeout' ? new DOMException('deadline', 'TimeoutError') : 'user_stop');
      throw Object.assign(new Error(kind), { code: 'provider_aborted' });
    };
    const run = createMeteredProvider({ store, operation, provider: 'fixture', model: 'requested', invoke });
    if (kind === 'refused') await run({}); else await expect(run({ signal: controller.signal })).rejects.toThrow(kind);
    const call = (await summary()).calls[0];
    expect(call.outcome).toBe(kind === 'cancelled' ? 'cancelled' : 'failed');
    expect(call.failureCode).toBe(kind === 'refused' ? 'provider_refusal' : kind === 'timeout' ? 'provider_timeout' : 'provider_aborted');
  });
  it('leaves an interrupted start unknown after recreating the store, then accepts a single recovered observation', async () => {
    const callId = await start();
    const recovered = createUsageStore({ db });
    let result = await recovered.summary({ operationId: operation.id, accountId });
    expect(result.complete).toBe(false); expect(result.metrics.inputTokens.value).toBeNull();
    await recovered.observe({ callId, accountId, observation: { outcome: 'unknown', metrics: usageMetrics() } });
    await observe(callId, { metrics: usageMetrics({ inputTokens: 1, outputTokens: 0, source: 'provider' }) });
    result = await summary();
    expect(result.calls).toHaveLength(1); expect(result.complete).toBe(true);
  });
  it('rejects undeclared precision, unknown units and conflicting identity without altering facts', async () => {
    const callId = await start();
    await expect(observe(callId, { metrics: { durationMs: { value: 1.25, unit: 'second', source: 'provider' } } })).rejects.toThrow();
    await observe(callId, { providerRequestId: 'id-1', model: 'actual', modelIdentitySource: 'provider_response' });
    await expect(observe(callId, { providerRequestId: 'id-2' })).rejects.toMatchObject({ code: 'provider_identity_conflict' });
    await observe(callId, { model: 'requested', modelIdentitySource: 'requested_fallback' });
    expect((await summary()).calls[0].model).toBe('actual');
  });
});

describe('SDK stream partial facts', () => {
  it.each(['stream', 'buffered'])('retains provider identity and usage from %s failures without hidden retries', async (mode) => {
    async function* chunks() {
      yield { type: 'finish-step', usage: { inputTokens: 7, outputTokens: 0 }, response: { id: 'upstream', modelId: 'observed' } };
      yield { type: 'error', error: new Error('transport failure') };
    }
    const stream = vi.fn(() => ({ fullStream: chunks() }));
    const call = mode === 'stream' ? streamProviderText : generateProviderText;
    await expect(call({ model: 'requested', stream, modelFactory: () => ({ provider: 'openai', model: {} }) })).rejects.toMatchObject({
      providerResult: { model: 'observed', modelIdentitySource: 'provider_response', requestId: 'upstream', usage: { inputTokens: 7, outputTokens: 0 } },
    });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });
  it('does not turn untrusted unlabeled counts into provider facts or empty history into zero', () => {
    expect(usageMetrics({ inputTokens: 5 }).inputTokens).toEqual({ value: null, unit: 'token', source: 'missing' });
    expect(summarizeUsage([]).metrics.inputTokens.value).toBeNull();
  });
});
