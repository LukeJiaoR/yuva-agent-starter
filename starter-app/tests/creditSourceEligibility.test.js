import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { grantCredits, reserveFeatureCredits, settleFeatureCredits, releaseFeatureCredits,
  getCreditBalance, reconcileCreditAccount } from '@yuva/billing-core';
import { isolatedDatabase } from './helpers/database.js';

const paidSources = ['purchased_topup', 'subscription_grant'];

describe('Credit grant source eligibility on real PostgreSQL', () => {
  let database;
  let db;
  beforeAll(async () => { database = await isolatedDatabase(); db = database.db; });
  afterAll(async () => { await database?.close(); });

  async function user() {
    const id = randomUUID();
    await db.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.invalid`]);
    return id;
  }

  function grant(userId, credits, sourceType = 'signup_grant', creditType = 'purchased', extra = {}) {
    return grantCredits({ db, userId, credits, sourceType, creditType, idempotencyKey: randomUUID(), ...extra });
  }

  function reserve(userId, clientRequestId = randomUUID(), extra = {}) {
    return reserveFeatureCredits({ db, userId, clientRequestId, featureKey: 'paid_feature', credits: 20,
      allowedGrantSourceTypes: paidSources, ...extra });
  }

  async function snapshot(userId) {
    const result = {};
    for (const table of ['credit_accounts', 'credit_grants', 'credit_usage_requests', 'credit_transactions']) {
      result[table] = (await db.query(`SELECT * FROM ${table} WHERE user_id = $1 ORDER BY ${table === 'credit_accounts' ? 'user_id' : 'id'}`, [userId])).rows;
    }
    result.allocations = (await db.query(`SELECT a.* FROM credit_usage_allocations a
      JOIN credit_usage_requests r ON r.id = a.usage_request_id WHERE r.user_id = $1 ORDER BY a.id`, [userId])).rows;
    return result;
  }

  it('rejects a fresh paid reservation backed only by Signup Credits without any mutations', async () => {
    const userId = await user();
    await grant(userId, 50);
    const before = await snapshot(userId);
    expect(await reserve(userId)).toMatchObject({ kind: 'insufficient', reason: 'eligible_grant_sources',
      balance: { available: 50, reserved: 0 } });
    expect(await snapshot(userId)).toEqual(before);
  });

  it('leaves a released request and its result untouched when retry has no eligible Credits', async () => {
    const userId = await user();
    await grant(userId, 50);
    const request = await reserve(userId, 'released-retry', { allowedGrantSourceTypes: null });
    await releaseFeatureCredits({ db, userId, requestId: request.request.id, failureClass: 'synthetic_failure' });
    await db.query('UPDATE credit_usage_requests SET assistant_text = $2, metadata = $3 WHERE id = $1',
      [request.request.id, 'preserve released result', { old_attempt: true }]);
    const before = await snapshot(userId);
    const resetResult = vi.fn();
    expect(await reserve(userId, 'released-retry', { resetResult })).toMatchObject({
      kind: 'insufficient', reason: 'eligible_grant_sources',
    });
    expect(resetResult).not.toHaveBeenCalled();
    expect(await snapshot(userId)).toEqual(before);
  });

  it('spends only allowed sources in normal membership-first order and settles without Signup or reward debit', async () => {
    const userId = await user();
    await grant(userId, 50);
    await grant(userId, 30, 'feedback_reward', 'membership', { expiresAt: new Date(Date.now() + 3600000) });
    await grant(userId, 12, 'subscription_grant', 'membership', { expiresAt: new Date(Date.now() + 7200000) });
    await grant(userId, 8, 'purchased_topup');
    const result = await reserve(userId, 'mixed');
    expect(result).toMatchObject({ kind: 'reserved', balance: { available: 80, reserved: 20 } });
    const allocations = (await db.query(`SELECT g.source_type, a.reserved_credits FROM credit_usage_allocations a
      JOIN credit_grants g ON g.id = a.grant_id WHERE a.usage_request_id = $1 ORDER BY g.credit_type`, [result.request.id])).rows;
    expect(allocations).toEqual([
      { source_type: 'subscription_grant', reserved_credits: 12 },
      { source_type: 'purchased_topup', reserved_credits: 8 },
    ]);
    const settled = await settleFeatureCredits({ db, userId, requestId: result.request.id, creditsUsed: 20 });
    expect(settled.balance).toMatchObject({ available: 80, reserved: 0 });
    const untouched = (await db.query("SELECT source_type, remaining_credits FROM credit_grants WHERE user_id = $1 AND source_type IN ('signup_grant', 'feedback_reward') ORDER BY source_type", [userId])).rows;
    expect(untouched).toEqual([{ source_type: 'feedback_reward', remaining_credits: 30 }, { source_type: 'signup_grant', remaining_credits: 50 }]);
    expect(await reconcileCreditAccount({ db, userId })).toMatchObject({ ok: true });
  });

  it('serializes competing paid reservations without falling back to free Credits', async () => {
    const userId = await user();
    await grant(userId, 50);
    await grant(userId, 20, 'purchased_topup');
    const results = await Promise.all([reserve(userId, 'race-a'), reserve(userId, 'race-b')]);
    expect(results.map(result => result.kind).sort()).toEqual(['insufficient', 'reserved']);
    expect(results.find(result => result.kind === 'insufficient')).toMatchObject({ reason: 'eligible_grant_sources' });
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 50, reserved: 20 });
    const state = await snapshot(userId);
    expect(state.credit_usage_requests).toHaveLength(1);
    expect(state.allocations).toHaveLength(1);
    expect(state.credit_transactions.filter(row => row.transaction_type === 'usage_reserve')).toHaveLength(1);
  });

  it('replays an active or settled request without rechecking or spending exhausted eligible grants', async () => {
    const userId = await user();
    await grant(userId, 50);
    await grant(userId, 20, 'purchased_topup');
    const first = await reserve(userId, 'same');
    const before = await snapshot(userId);
    expect(await reserve(userId, 'same')).toMatchObject({ kind: 'existing', request: { id: first.request.id } });
    expect(await snapshot(userId)).toEqual(before);
    await settleFeatureCredits({ db, userId, requestId: first.request.id, creditsUsed: 20 });
    const settled = await snapshot(userId);
    expect(await reserve(userId, 'same')).toMatchObject({ kind: 'existing', request: { status: 'settled' } });
    expect(await snapshot(userId)).toEqual(settled);
  });

  it('retries a released eligible reservation on the same request and preserves attempt ledger history', async () => {
    const userId = await user();
    await grant(userId, 20, 'purchased_topup');
    const first = await reserve(userId, 'retry');
    await releaseFeatureCredits({ db, userId, requestId: first.request.id });
    const resetResult = vi.fn();
    const second = await reserve(userId, 'retry', { resetResult });
    expect(second).toMatchObject({ kind: 'reserved', request: { id: first.request.id, attempt_no: 2 },
      balance: { available: 0, reserved: 20 } });
    expect(resetResult).toHaveBeenCalledTimes(1);
    const state = await snapshot(userId);
    expect(state.allocations.map(row => row.attempt_no).sort()).toEqual([1, 2]);
    expect(state.credit_transactions.filter(row => row.transaction_type === 'usage_reserve')).toHaveLength(2);
  });

  it.each([[], 'purchased_topup', [''], ['bad-source'], [null], [{}]].map(allowedGrantSourceTypes => ({ allowedGrantSourceTypes })))('rejects invalid filter $allowedGrantSourceTypes before touching the database', async ({ allowedGrantSourceTypes }) => {
    const query = vi.fn();
    await expect(reserveFeatureCredits({ db: { query }, userId: randomUUID(), featureKey: 'paid_feature',
      clientRequestId: 'invalid', credits: 20, allowedGrantSourceTypes })).rejects.toThrow(/grant source filter/iu);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('keeps unrestricted legacy reservations for an optional filter %s', async allowedGrantSourceTypes => {
    const userId = await user();
    await grant(userId, 20);
    expect(await reserve(userId, randomUUID(), { allowedGrantSourceTypes })).toMatchObject({
      kind: 'reserved', balance: { available: 0, reserved: 20 },
    });
  });

  it('rolls a released retry back if the transaction-local result reset fails', async () => {
    const userId = await user();
    await grant(userId, 20, 'purchased_topup');
    const first = await reserve(userId, 'reset-rollback');
    await releaseFeatureCredits({ db, userId, requestId: first.request.id });
    const before = await snapshot(userId);
    await expect(reserve(userId, 'reset-rollback', { resetResult: async (client, request) => {
      await client.query('UPDATE credit_usage_requests SET assistant_text = $2 WHERE id = $1', [request.id, 'uncommitted']);
      throw new Error('synthetic reset failure');
    } })).rejects.toThrow('synthetic reset failure');
    expect(await snapshot(userId)).toEqual(before);
  });

  it('rolls grant, request and balance changes back when settlement result persistence fails', async () => {
    const userId = await user();
    await grant(userId, 20, 'purchased_topup');
    const first = await reserve(userId, 'settlement-rollback');
    const before = await snapshot(userId);
    await expect(settleFeatureCredits({ db, userId, requestId: first.request.id, creditsUsed: 20,
      persistResult: async () => { throw new Error('synthetic persist failure'); } })).rejects.toThrow('synthetic persist failure');
    expect(await snapshot(userId)).toEqual(before);
  });

  it('preserves Signup posted ledger confirmation and idempotent replay', async () => {
    const userId = await user();
    const idempotencyKey = randomUUID();
    const first = await grant(userId, 50, 'signup_grant', 'purchased', { idempotencyKey });
    expect(first).toMatchObject({ created: true, amount: 50 });
    expect(first.transactionId).toBeTruthy();
    const before = await snapshot(userId);
    expect(await grant(userId, 50, 'signup_grant', 'purchased', { idempotencyKey }))
      .toMatchObject({ created: false, amount: 50, transactionId: first.transactionId, grantId: first.grantId });
    expect(await snapshot(userId)).toEqual(before);
    expect(before.credit_transactions).toContainEqual(expect.objectContaining({
      id: first.transactionId, amount: 50, status: 'posted', transaction_type: 'signup_grant',
    }));
  });

  it('fails closed with 503 when Signup grant replay lacks its posted ledger confirmation', async () => {
    const userId = await user();
    const idempotencyKey = randomUUID();
    const first = await grant(userId, 50, 'signup_grant', 'purchased', { idempotencyKey });
    await db.query('DELETE FROM credit_transactions WHERE id = $1', [first.transactionId]);
    const before = await snapshot(userId);
    await expect(grant(userId, 50, 'signup_grant', 'purchased', { idempotencyKey }))
      .rejects.toMatchObject({ code: 'credit_grant_ledger_unconfirmed', status: 503 });
    expect(await snapshot(userId)).toEqual(before);
  });
});
