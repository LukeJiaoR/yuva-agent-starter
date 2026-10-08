import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFreeFeatureUsage, completeFreeFeatureUsage, failFreeFeatureUsage,
  grantCredits, reserveFeatureCredits, settleFeatureCredits, releaseFeatureCredits } from '@yuva/billing-core';
import { isolatedDatabase } from './helpers/database.js';

const policy = Object.freeze({ featureKey: 'intro_reading', pricingStrategy: 'free', creditCost: 0, priceVersion: 'intro-free-v1' });
describe('explicit free usage lifecycle on PostgreSQL', () => {
  let database, db;
  beforeAll(async () => { database = await isolatedDatabase(); db = database.db; });
  afterAll(async () => { await database?.close(); });
  async function owner() {
    const id = randomUUID();
    await db.query('INSERT INTO users (id,email) VALUES ($1,$2)', [id, `${id}@example.invalid`]);
    await db.query('INSERT INTO credit_accounts (user_id) VALUES ($1)', [id]);
    return id;
  }
  async function finances(userId) {
    const state = {};
    for (const table of ['credit_accounts', 'credit_grants', 'credit_transactions']) {
      state[table] = (await db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY ${table === 'credit_accounts' ? 'user_id' : 'id'}`, [userId])).rows;
    }
    state.allocations = (await db.query(`SELECT a.* FROM credit_usage_allocations a JOIN credit_usage_requests r
      ON r.id=a.usage_request_id WHERE r.user_id=$1 ORDER BY a.id`, [userId])).rows;
    return state;
  }
  const start = (userId, clientRequestId = randomUUID(), extra = {}) => startFreeFeatureUsage({ db, userId, clientRequestId, policy, ...extra });
  const finish = (userId, requestId, extra = {}) => completeFreeFeatureUsage({ db, userId, requestId,
    persistResult: async client => {
      const { rows: [result] } = await client.query('UPDATE credit_usage_requests SET assistant_text=$2 WHERE id=$1 RETURNING id', [requestId, 'owned complete result']);
      return result;
    }, ...extra });

  it.each(['zero', 'signup', 'purchased', 'expired'])('starts and completes with %s Credits without financial mutations', async kind => {
    const userId = await owner();
    if (kind !== 'zero') {
      await grantCredits({ db, userId, credits: 50, creditType: kind === 'purchased' ? 'purchased' : 'membership',
        sourceType: kind === 'purchased' ? 'purchased_topup' : 'signup_grant', idempotencyKey: randomUUID(),
        expiresAt: kind === 'expired' ? '2000-01-01T00:00:00Z' : null });
    }
    const before = await finances(userId);
    const started = await start(userId);
    expect(started).toMatchObject({ kind: 'started', request: { pricing_strategy: 'free', reserved_credits: 0 },
      balance: { available: ['zero', 'expired'].includes(kind) ? 0 : 50 } });
    expect(await finances(userId)).toEqual(before);
    const completed = await finish(userId, started.request.id, { metadata: { credit_cost: 999, price_version: 'forged' } });
    expect(completed.request).toMatchObject({ status: 'settled', reserved_credits: 0, settled_credits: 0,
      metadata: { credit_cost: 0, price_version: policy.priceVersion } });
    expect(await finances(userId)).toEqual(before);
  });
  it('serializes duplicate starts and completion, runs admission and persistence once', async () => {
    const userId = await owner(), clientRequestId = randomUUID(), admit = vi.fn();
    const starts = await Promise.all([start(userId, clientRequestId, { admit }), start(userId, clientRequestId, { admit })]);
    expect(starts.map(r => r.kind).sort()).toEqual(['existing', 'started']);
    expect(starts[0].request.id).toBe(starts[1].request.id); expect(admit).toHaveBeenCalledTimes(1);
    const persistResult = vi.fn(async () => ({ id: randomUUID() }));
    const completed = await Promise.all(starts.map(r => finish(userId, r.request.id, { persistResult })));
    expect(completed.filter(r => r.replay)).toHaveLength(1); expect(persistResult).toHaveBeenCalledTimes(1);
    expect((await finances(userId)).allocations).toEqual([]);
  });
  it('rolls admission and result persistence failures back and keeps honest terminal outcomes', async () => {
    const userId = await owner(), id = randomUUID();
    await expect(start(userId, id, { admit: async () => { throw Error('quota unavailable'); } })).rejects.toThrow('quota unavailable');
    expect((await db.query('SELECT id FROM credit_usage_requests WHERE user_id=$1', [userId])).rows).toEqual([]);
    const started = await start(userId, id), before = await finances(userId);
    await expect(finish(userId, started.request.id, { persistResult: async client => {
      await client.query('UPDATE credit_usage_requests SET assistant_text=$2 WHERE id=$1', [started.request.id, 'uncommitted']);
      throw Error('result storage failed');
    } })).rejects.toThrow('result storage failed');
    const stored = (await db.query('SELECT * FROM credit_usage_requests WHERE id=$1', [started.request.id])).rows[0];
    expect(stored.status).toBe('generating'); expect(stored.assistant_text).toBeNull();
    const persistUsageEvent = vi.fn();
    const failed = await failFreeFeatureUsage({ db, userId, requestId: started.request.id, persistUsageEvent, failureClass: 'provider_failed' });
    expect(failed.request.status).toBe('failed'); expect(persistUsageEvent).toHaveBeenCalledTimes(1);
    await failFreeFeatureUsage({ db, userId, requestId: started.request.id, persistUsageEvent });
    expect(persistUsageEvent).toHaveBeenCalledTimes(1);
    await expect(finish(userId, started.request.id)).rejects.toMatchObject({ code: 'free_usage_terminal_conflict' });
    expect(await finances(userId)).toEqual(before);
  });
  it.each(['limited', 'cancelled'])('distinguishes %s from successful delivery and refunds', async outcome => {
    const userId = await owner(), started = await start(userId);
    const result = outcome === 'limited' ? await finish(userId, started.request.id, { outcome })
      : await failFreeFeatureUsage({ db, userId, requestId: started.request.id, cancelled: true });
    expect(result.request.status).toBe(outcome);
    expect((await finances(userId)).credit_transactions).toEqual([]);
  });
  it('requires explicit recovery authority and preserves identity, price and attempt history', async () => {
    const userId = await owner(), id = randomUUID(), started = await start(userId, id);
    await failFreeFeatureUsage({ db, userId, requestId: started.request.id });
    await expect(start(userId, id, { resume: true })).rejects.toMatchObject({ code: 'free_usage_recovery_authority_required' });
    await expect(start(userId, id, { resume: true, authorizeResume: async () => false })).rejects.toMatchObject({ code: 'free_usage_recovery_denied' });
    await expect(start(userId, id, { policy: { ...policy, priceVersion: 'intro-free-v2' } })).rejects.toMatchObject({ code: 'free_usage_identity_changed' });
    const resumed = await start(userId, id, { resume: true, authorizeResume: async () => true });
    expect(resumed.request).toMatchObject({ id: started.request.id, attempt_no: 2, metadata: { price_version: 'intro-free-v1' } });
    await expect(failFreeFeatureUsage({ db,userId,requestId:started.request.id,attemptNo:1 }))
      .rejects.toMatchObject({code:'free_usage_attempt_changed'});
    await expect(completeFreeFeatureUsage({ db, userId: await owner(), requestId: started.request.id,
      persistResult: async () => ({ id: randomUUID() }) })).rejects.toMatchObject({ code: 'free_usage_identity_invalid' });
  });
  it('blocks debt and ordinary positive billing APIs without changing finance', async () => {
    const userId = await owner();
    await db.query('UPDATE credit_accounts SET credit_debt=2 WHERE user_id=$1', [userId]);
    expect(await start(userId)).toMatchObject({ kind: 'debt' });
    await db.query('UPDATE credit_accounts SET credit_debt=0 WHERE user_id=$1', [userId]);
    const started = await start(userId), before = await finances(userId);
    await expect(reserveFeatureCredits({ db, userId, featureKey: policy.featureKey,
      clientRequestId: started.request.client_request_id, credits: 1 })).rejects.toMatchObject({ code: 'free_usage_requires_explicit_lifecycle' });
    await expect(settleFeatureCredits({ db, userId, requestId: started.request.id, creditsUsed: 1 })).rejects.toMatchObject({ code: 'free_usage_requires_explicit_lifecycle' });
    await expect(releaseFeatureCredits({ db, userId, requestId: started.request.id })).rejects.toMatchObject({ code: 'free_usage_requires_explicit_lifecycle' });
    await expect(reserveFeatureCredits({ db, userId, featureKey: policy.featureKey, clientRequestId: randomUUID(), credits: 0 })).rejects.toThrow('positive');
    await expect(settleFeatureCredits({ db, userId, requestId: started.request.id, creditsUsed: 0 })).rejects.toThrow('positive');
    expect(await finances(userId)).toEqual(before);
  });
  it.each([null, { ...policy, creditCost: 1 }, { ...policy, pricingStrategy: 'fixed' }, { ...policy, priceVersion: '' }])('rejects non-free policy before SQL', async badPolicy => {
    const query = vi.fn();
    await expect(startFreeFeatureUsage({ db: { query }, userId: randomUUID(), clientRequestId: randomUUID(), policy: badPolicy }))
      .rejects.toMatchObject({ code: 'free_usage_policy_required' });
    expect(query).not.toHaveBeenCalled();
  });
});
