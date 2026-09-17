import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { createFixedOperationPricingPolicy, createOperationBillingPort, createOperationStore, grantCredits } from '@yuva/billing-core';
import { isolatedDatabase, operationFixture, limitsFixture } from './helpers/database.js';

describe('fixed operation policy and ledger adapter', () => {
  let db, close, user, operationStore;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    user = { id: randomUUID() };
    await db.query('INSERT INTO users(id) VALUES($1)', [user.id]);
    await grantCredits({ db, userId: user.id, credits: 30, creditType: 'purchased', idempotencyKey: randomUUID() });
    operationStore = createOperationStore({ db, capabilities: [{ taskType: 'text', mode: 'stream' }, { taskType: 'image', mode: 'async' }] });
  });
  const fulfillment = ({ operation }) => ({ status: 'ready', ruleVersion: '1', accountId: operation.accountId,
    resultId: operation.id, artifacts: [{ id: operation.id, accountId: operation.accountId, type: 'text', state: 'available', text: 'Result' }] });
  const port = (credits = 2, extra = {}) => createOperationBillingPort({ db, operationStore,
    policy: createFixedOperationPricingPolicy({ credits }), executionLimits: limitsFixture(), evaluateFulfillment: fulfillment,
    persistResult: async ({ client, ledgerRequest }) => {
      await client.query('UPDATE credit_usage_requests SET assistant_text=$2 WHERE id=$1', [ledgerRequest.id, 'Result']);
      return { id: ledgerRequest.id };
    }, ...extra });
  async function reserve(adapter, taskType = 'text') {
    const operationInput = operationFixture(user.id, randomUUID(), taskType);
    operationInput.featureKey = 'product_report';
    const request = { operationInput, clientRequestId: operationInput.clientRequestId };
    const reserved = await adapter.reserve({ request, user });
    return { request, user, reservation: { ...reserved, reservationId: reserved.request?.id } };
  }
  const ledger = async (context) => (await db.query('SELECT * FROM credit_usage_requests WHERE id=$1', [context.reservation.request.id])).rows[0];
  it.each([2000, 8000])('charges 2 once with %i tokens and multiple internal calls', async (tokens) => {
    const persistResult = vi.fn(async ({ ledgerRequest }) => ({ id: ledgerRequest.id }));
    const adapter = port(2, { persistResult });
    const context = await reserve(adapter);
    context.usage = { calls: [{ outcome: 'failed' }, { outcome: 'failed' }, { outcome: 'succeeded', totalTokens: tokens }] };
    const results = await Promise.all([adapter.settle(context), adapter.settle(context)]);
    expect(results.map((r) => r.creditsUsed)).toEqual([2, 2]);
    expect(results.filter((r) => r.replay)).toHaveLength(1);
    expect(persistResult).toHaveBeenCalledTimes(1);
    expect((await ledger(context)).settled_credits).toBe(2);
    expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [user.id])).rows).toHaveLength(1);
  });
  it('uses persisted terms after global price changes and ignores a tampered reservation quote', async () => {
    const context = await reserve(port(2));
    context.reservation.operation.quote.terms.credits = 25;
    const updated = port(5);
    expect((await updated.settle(context)).creditsUsed).toBe(2);
    const next = await reserve(updated);
    expect((await updated.settle(next)).creditsUsed).toBe(5);
  });
  it('accepts product-owned media artifacts without requiring token facts', async () => {
    const adapter = port(7, { evaluateFulfillment: ({ operation }) => ({ ...fulfillment({ operation }), artifacts: [
      { id: 'image', accountId: operation.accountId, type: 'image', state: 'available', storageKey: 'results/image', specs: { width: 1024 } },
    ] }) });
    const context = await reserve(adapter, 'image');
    expect((await adapter.settle(context)).creditsUsed).toBe(7);
    expect((await ledger(context)).feature_key).toBe('product_report');
  });
  it('releases confirmed failed fulfillment but does not report success', async () => {
    const adapter = port(2, { evaluateFulfillment: ({ operation }) => ({ ...fulfillment({ operation }), status: 'failed', artifacts: [] }) });
    const context = await reserve(adapter);
    await expect(adapter.settle(context)).rejects.toMatchObject({ code: 'fulfillment_failed' });
    expect((await ledger(context)).status).toBe('released');
  });
  it.each(['partial', 'pending'])('leaves %s fulfillment reserved with an explicit deferred error', async (status) => {
    const adapter = port(2, { evaluateFulfillment: ({ operation }) => ({ ...fulfillment({ operation }), status, artifacts: [] }) });
    const context = await reserve(adapter);
    await expect(adapter.settle(context)).rejects.toMatchObject({ code: 'settlement_deferred' });
    await expect(adapter.release({ ...context, error: { code: 'settlement_deferred' } })).rejects.toMatchObject({ code: 'settlement_deferred' });
    expect((await ledger(context)).status).toBe('generating');
    expect((await ledger(context)).reserved_credits).toBe(2);
  });
  it('rejects unknown policy versions and fulfillment versions without charging', async () => {
    const context = await reserve(port());
    await expect(port(2, { resolvePolicy: () => null }).settle(context)).rejects.toMatchObject({ code: 'policy_version_unavailable' });
    await expect(port(2, { evaluateFulfillment: ({ operation }) => ({ ...fulfillment({ operation }), ruleVersion: '2' }) }).settle(context))
      .rejects.toMatchObject({ code: 'fulfillment_version_mismatch' });
    expect((await ledger(context)).settled_credits).toBe(0);
  });
  it.each([-1, '2', NaN, Infinity, 2147483648, 3])('rejects invalid or unauthorized decision %s before ledger mutation', async (credits) => {
    const context = await reserve(port());
    const policy = { ...createFixedOperationPricingPolicy({ credits: 2 }), decide: () => ({ action: 'settle', credits, reason: 'test' }) };
    await expect(port(2, { policy }).settle(context)).rejects.toThrow();
    expect((await ledger(context)).settled_credits).toBe(0);
  });
  it('validates zero-fee decisions but refuses unsupported execution', async () => {
    const adapter = port(0);
    const context = await reserve(adapter);
    await expect(adapter.settle(context)).rejects.toMatchObject({ code: 'no_charge_unsupported' });
    expect((await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type=\'usage_charge\'', [user.id])).rows).toHaveLength(0);
  });
  it('rejects another account, swapped reservation and foreign artifacts', async () => {
    const adapter = port();
    const first = await reserve(adapter), second = await reserve(adapter);
    await expect(adapter.settle({ ...first, reservation: second.reservation })).rejects.toMatchObject({ code: 'reservation_mismatch' });
    await expect(adapter.settle({ ...first, user: { id: randomUUID() } })).rejects.toMatchObject({ code: 'operation_not_found' });
    await expect(port(2, { evaluateFulfillment: ({ operation }) => ({ ...fulfillment({ operation }), accountId: randomUUID() }) }).settle(first))
      .rejects.toMatchObject({ code: 'result_forbidden' });
  });
  it('rolls back charges when product result persistence fails', async () => {
    const adapter = port(2, { persistResult: async () => { throw new Error('result storage unavailable'); } });
    const context = await reserve(adapter);
    await expect(adapter.settle(context)).rejects.toThrow('result storage unavailable');
    expect((await ledger(context)).status).toBe('generating');
    expect((await ledger(context)).settled_credits).toBe(0);
  });
});
