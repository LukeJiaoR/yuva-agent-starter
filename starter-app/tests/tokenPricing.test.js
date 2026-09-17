import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { createTokenPricingPolicy, createOperationBillingPort, createOperationStore, grantCredits, getCreditBalance } from '@yuva/billing-core';
import { createUsageStore } from '../server/stores/usageStore.js';
import { isolatedDatabase, operationFixture } from './helpers/database.js';

const limits = () => ({ models: ['fixture'], paths: [{ provider: 'fixture', model: 'fixture' }], maxCalls: 3,
  maxRetries: 1, deadlineMs: 30000, maxInputTokens: 4000, maxOutputTokens: 2000 });
const policy = (extra = {}) => createTokenPricingPolicy({ inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 }, ...extra });
const operation = () => ({ taskType: 'text', mode: 'stream' });
const ready = () => ({ status: 'ready', ruleVersion: '1' });
const call = (input = 2000, output = 1000, extra = {}) => ({ callId: randomUUID(), provider: 'fixture', model: 'fixture',
  outcome: 'succeeded', externalStatus: 'completed', metrics: {
    inputTokens: { value: input, unit: 'token', source: input === null ? 'missing' : 'provider' },
    outputTokens: { value: output, unit: 'token', source: output === null ? 'missing' : 'provider' },
  }, ...extra });

describe('exact token user pricing', () => {
  it('charges the synthetic 2000 input / 1000 output rate fixture exactly 4 credits', () => {
    const p = policy(), quote = p.quote(operation(), limits());
    const decision = p.decide(quote, { calls: [call()] }, ready());
    expect(decision.credits).toBe(4);
    expect(decision.audit).toMatchObject({ inputTokens: '2000', outputTokens: '1000', roundedCredits: '4' });
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });
  it('aggregates before rounding once and does not add cache or reasoning subsets', () => {
    const p = policy(), quote = p.quote(operation(), limits());
    const calls = [call(1, 0), call(1, 0), call(1, 0)];
    calls[0].metrics.cachedInputTokens = { value: 1, source: 'provider', unit: 'token' };
    calls[0].metrics.reasoningTokens = { value: 100, source: 'provider', unit: 'token' };
    expect(p.decide(quote, { calls }, ready()).credits).toBe(1);
    expect(p.decide(quote, { calls: [call(0, 0)] }, ready())).toMatchObject({ credits: 0, reason: 'zero_token_charge' });
    expect(p.decide(quote, { calls: [call(1000, 0)] }, ready()).credits).toBe(1);
    expect(p.decide(quote, { calls: [call(1001, 0)] }, ready()).credits).toBe(2);
  });
  it('excludes failed internal attempts and never uses provider cost as a user rate', () => {
    const p = policy(), quote = p.quote(operation(), limits());
    const failed = call(20000, 10000, { outcome: 'failed', cost: { amount: '999999999', currency: 'USD', scale: 2 } });
    const decision = p.decide(quote, { calls: [failed, call()] }, ready());
    expect(decision.credits).toBe(4);
    expect(decision.audit.calls[0]).toMatchObject({ eligible: false, reason: 'unsuccessful_call' });
  });
  it('uses frozen rates after global changes and rejects unsupported versions', () => {
    const quote = policy().quote(operation(), limits());
    const changed = policy({ inputRate: { credits: 9, tokens: 1000 } });
    expect(changed.decide(quote, { calls: [call()] }, ready()).credits).toBe(4);
    expect(() => changed.decide({ ...quote, policyVersion: '2' }, { calls: [call()] }, ready())).toThrow('policy_version_unavailable');
  });
  it('defaults missing/synthetic usage to defer and allows only the frozen explicit estimate basis', () => {
    const p = policy(), missing = call(null, 0);
    expect(p.decide(p.quote(operation(), limits()), { calls: [missing] }, ready()).reason).toBe('usage_missing');
    const estimated = policy({ allowEstimates: true }), quote = estimated.quote(operation(), limits());
    expect(estimated.decide(quote, { calls: [missing] }, ready()).reason).toBe('estimate_basis_missing');
    missing.budgetResources = { inputTokens: 3000, outputTokens: 2000 };
    const decision = p.decide(quote, { calls: [missing] }, ready());
    expect(decision.credits).toBe(3);
    expect(decision.audit.calls[0].metrics.inputTokens).toEqual({ value: 3000, source: 'estimate', method: 'reserved_ceiling_v1' });
    expect(missing.metrics.inputTokens.source).toBe('missing');
    const synthetic = call(1, 1); synthetic.metrics.inputTokens.source = 'synthetic';
    expect(p.decide(p.quote(operation(), limits()), { calls: [synthetic] }, ready()).action).toBe('defer');
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid metric %s', (value) => {
    const p = policy();
    expect(() => p.decide(p.quote(operation(), limits()), { calls: [call(value, 0)] }, ready())).toThrow('invalid_usage_value');
  });
  it('rejects rate overflow, media and unbounded plans; defers an over-authorized charge without clipping', () => {
    expect(() => policy({ inputRate: { credits: -1, tokens: 1 } })).toThrow('invalid_token_rate');
    expect(() => policy({ outputRate: { credits: 1, tokens: 0 } })).toThrow('invalid_token_rate');
    expect(() => policy({ inputRate: { credits: Number.MAX_SAFE_INTEGER, tokens: 1 } }).quote(operation(), limits())).toThrow('token_price_overflow');
    expect(() => policy().quote({ taskType: 'image', mode: 'async' }, limits())).toThrow('pricing_not_applicable');
    expect(() => policy().quote(operation(), { ...limits(), paths: undefined })).toThrow('unbounded_token_plan');
    const p = policy(), quote = p.quote(operation(), limits());
    const decision = p.decide(quote, { calls: [call(1000000, 0)] }, ready());
    expect(decision).toMatchObject({ action: 'defer', reason: 'authorization_exceeded' });
    expect(decision.audit.roundedCredits).toBe('1000');
  });
  it('rejects duplicate observations and unknown execution without silently summing them', () => {
    const p = policy(), quote = p.quote(operation(), limits()), one = call();
    expect(() => p.decide(quote, { calls: [one, one] }, ready())).toThrow('duplicate_usage_call');
    expect(p.decide(quote, { calls: [call(0, 0, { externalStatus: 'unknown' })] }, ready()).reason).toBe('execution_outcome_unknown');
  });
});

describe('token policy uses the shared PostgreSQL operation/usage/ledger adapter', () => {
  let db, close, accountId, usageStore, operationStore;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID(); await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    await grantCredits({ db, userId: accountId, credits: 100, creditType: 'purchased', idempotencyKey: randomUUID() });
    usageStore = createUsageStore({ db }); operationStore = createOperationStore({ db });
  });
  const adapter = (p = policy()) => createOperationBillingPort({ db, operationStore, policy: p, executionLimits: limits(), readUsage: (id) => usageStore.summary(id),
    evaluateFulfillment: ({ operation }) => ({ status: 'ready', ruleVersion: '1', accountId, resultId: operation.id,
      artifacts: [{ id: operation.id, type: 'text', state: 'available', text: 'Result', accountId }] }) });
  async function prepare() {
    const billing = adapter(), operationInput = operationFixture(accountId), user = { id: accountId };
    const request = { operationInput, clientRequestId: operationInput.clientRequestId };
    const reservation = await billing.reserve({ request, user });
    return { billing, context: { request, reservation, user } };
  }
  async function record(context, inputTokens, outputTokens) {
    const callId = randomUUID();
    await usageStore.start({ callId, accountId, operationId: context.reservation.operation.id, provider: 'fixture', model: 'fixture', attempt: 1,
      executionBudget: { kind: 'primary', retryOf: null, resources: { inputTokens: 4000, outputTokens: 2000 } } });
    await usageStore.observe({ callId, accountId, observation: { outcome: 'succeeded', metrics: call(inputTokens, outputTokens).metrics } });
    return callId;
  }
  it.each([[2000, 1000, 4, 'settled'], [0, 0, 0, 'no_charge']])('settles %i/%i using the same ledger, returning unused reservation', async (i, o, credits, status) => {
    const { billing, context } = await prepare();
    await record(context, i, o);
    const result = await billing.settle(context);
    expect(result).toMatchObject({ status, creditsUsed: credits });
    expect((await billing.settle(context)).replay).toBe(true);
    expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 100 - credits, reserved: 0 });
    expect(result.operation.decision.audit.calls).toHaveLength(1);
  });
  it('retains missing usage for later completion and does not reprice an in-flight operation', async () => {
    const { billing, context } = await prepare();
    const callId = await record(context, null, 1000);
    expect((await billing.settle(context)).status).toBe('reconciliation_required');
    await usageStore.observe({ callId, accountId, observation: { outcome: 'succeeded', metrics: call(2000, 1000).metrics } });
    const changed = adapter(policy({ inputRate: { credits: 5, tokens: 1000 } }));
    expect((await changed.settle(context)).creditsUsed).toBe(4);
    expect((await usageStore.history({ callId, accountId }))).toHaveLength(2);
  });
});
