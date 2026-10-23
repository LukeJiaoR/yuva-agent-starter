import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expireCreditGrants,
  grantCredits,
  readCreditBalance,
  reconcileCreditAccount,
  refundSettledUsage,
  reserveFeatureCredits,
  revokeCreditGrant,
  settleFeatureCredits,
} from '@yuva/billing-core';
import { isolatedDatabase } from './helpers/database.js';

// These exercise the actual PostgreSQL schema and core API, including immutable
// historical allocations. A request's "refunded" status is not a monetary fact.
describe('payment revocation after support refunds on PostgreSQL', () => {
  let db, close, userId;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    userId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [userId]);
  });
  async function grant(credits, extra = {}) {
    const paymentReference = randomUUID();
    const result = await grantCredits({ db, userId, credits, creditType: 'purchased',
      sourceType: 'purchased_topup', idempotencyKey: randomUUID(), paymentReference, ...extra });
    return { ...result, paymentReference: extra.paymentReference || paymentReference };
  }
  async function use(credits) {
    const { request } = await reserveFeatureCredits({ db, userId, featureKey: 'refund_fixture',
      clientRequestId: randomUUID(), credits });
    await settleFeatureCredits({ db, userId, requestId: request.id, creditsUsed: credits });
    return request.id;
  }
  const refund = (usageRequestId, extra = {}) => refundSettledUsage({ db, usageRequestId,
    idempotencyKey: randomUUID(), reason: 'Synthetic support refund', ...extra });
  const revoke = (payment, extra = {}) => revokeCreditGrant({ db, userId,
    paymentReference: payment.paymentReference, refundReference: randomUUID(), ...extra });
  async function snapshot() {
    const result = {};
    for (const table of ['credit_accounts', 'credit_grants', 'credit_transactions', 'credit_usage_requests']) {
      result[table] = (await db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY ${table === 'credit_accounts' ? 'user_id' : 'id'}`, [userId])).rows;
    }
    result.allocations = (await db.query(`SELECT a.* FROM credit_usage_allocations a
      JOIN credit_usage_requests r ON r.id=a.usage_request_id WHERE r.user_id=$1 ORDER BY a.id`, [userId])).rows;
    return result;
  }

  it.each([0, 50])('does not create phantom debt or consume an unrelated %i-credit grant', async (otherCredits) => {
    const payment = await grant(100);
    const usageRequestId = await use(20);
    const allocationBefore = (await snapshot()).allocations;
    expect((await refund(usageRequestId)).restoredCredits).toBe(20);
    if (otherCredits) await grant(otherCredits);
    const result = await revoke(payment);
    expect(result).toMatchObject({ grantRevoked: 100, offsetRevoked: 0, debtCreated: 0,
      balance: { available: otherCredits, debt: 0 } });
    expect((await snapshot()).allocations).toEqual(allocationBefore);
    expect(await reconcileCreditAccount({ db, userId })).toMatchObject({ ok: true, available: otherCredits, debt: 0 });
  });

  it('replays identical and new refund references without new deductions', async () => {
    const payment = await grant(100);
    await refund(await use(20));
    const refundReference = randomUUID();
    await revoke(payment, { refundReference });
    const before = await snapshot();
    expect(await revoke(payment, { refundReference })).toMatchObject({ created: false, reason: 'replayed' });
    expect(await revoke(payment)).toMatchObject({ created: false, reason: 'already_revoked' });
    expect(await snapshot()).toEqual(before);
  });

  it('counts credits spent again after a support refund as new net consumption', async () => {
    const payment = await grant(100);
    await refund(await use(20));
    await use(15);
    expect(await revoke(payment)).toMatchObject({ grantRevoked: 85, offsetRevoked: 0, debtCreated: 15,
      balance: { available: 0, debt: 15 } });
    expect((await snapshot()).allocations.map((row) => row.settled_credits).sort((a, b) => a - b)).toEqual([15, 20]);
  });

  it('does not subtract a support refund belonging to a different grant', async () => {
    const original = await grant(20);
    await use(20);
    const unrelated = await grant(100);
    await refund(await use(10));
    expect(await revoke(original)).toMatchObject({ grantRevoked: 0, offsetRevoked: 20, debtCreated: 0,
      balance: { available: 80, debt: 0 } });
    expect((await db.query('SELECT remaining_credits FROM credit_grants WHERE id=$1', [unrelated.grantId])).rows[0].remaining_credits).toBe(80);
  });

  it('retains consumption when the usage refund cannot restore an expired membership grant', async () => {
    const payment = await grant(100, { creditType: 'membership', sourceType: 'subscription_grant',
      expiresAt: new Date(Date.now() + 60000) });
    const usageRequestId = await use(20);
    await db.query("UPDATE credit_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [payment.grantId]);
    await expireCreditGrants({ db, userId });
    expect(await refund(usageRequestId)).toMatchObject({ restoredCredits: 0, expiredCredits: 20 });
    expect(await revoke(payment)).toMatchObject({ grantRevoked: 0, offsetRevoked: 0, debtCreated: 20,
      balance: { available: 0, debt: 20 } });
    expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_refund'", [userId])).rows).toHaveLength(0);
  });

  it('accounts for partial restoration of a usage request spanning two grants independently', async () => {
    const expired = await grant(10, { creditType: 'membership', sourceType: 'subscription_grant',
      expiresAt: new Date(Date.now() + 60000) });
    const purchased = await grant(100);
    const usageRequestId = await use(20);
    await db.query("UPDATE credit_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.grantId]);
    expect(await refund(usageRequestId)).toMatchObject({ restoredCredits: 10, expiredCredits: 10 });
    expect(await revoke(expired)).toMatchObject({ grantRevoked: 0, offsetRevoked: 10, debtCreated: 0,
      balance: { available: 90, debt: 0 } });
    expect(await revoke(purchased)).toMatchObject({ grantRevoked: 90, offsetRevoked: 0, debtCreated: 10,
      balance: { available: 0, debt: 10 } });
    expect(await reconcileCreditAccount({ db, userId })).toMatchObject({ ok: true });
  });

  it('does not create debt for credits restored before expiring without being consumed again', async () => {
    const payment = await grant(100, { creditType: 'membership', sourceType: 'subscription_grant',
      expiresAt: new Date(Date.now() + 60000) });
    await refund(await use(20));
    await db.query("UPDATE credit_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [payment.grantId]);
    await expireCreditGrants({ db, userId });
    expect(await revoke(payment)).toMatchObject({ grantRevoked: 0, offsetRevoked: 0, debtCreated: 0,
      balance: { available: 0, debt: 0 } });
  });

  it('preserves prior debt repaid by the refunded purchase', async () => {
    const original = await grant(20);
    await use(20);
    await revoke(original);
    const payment = await grant(100);
    expect(payment.balance).toMatchObject({ available: 80, debt: 0 });
    await refund(await use(20));
    expect(await revoke(payment)).toMatchObject({ grantRevoked: 80, offsetRevoked: 0, debtCreated: 20,
      balance: { available: 0, debt: 20 } });
  });

  it('preserves offsets already taken from this grant to revoke a different purchase', async () => {
    const original = await grant(20);
    await use(20);
    const payment = await grant(100);
    await revoke(original);
    await refund(await use(20));
    expect(await revoke(payment)).toMatchObject({ grantRevoked: 80, offsetRevoked: 0, debtCreated: 20,
      balance: { available: 0, debt: 20 } });
  });

  it('requires reconciliation for a support refund after payment revocation without changing history', async () => {
    const payment = await grant(100);
    const usageRequestId = await use(20);
    await revoke(payment);
    const before = await snapshot();
    await expect(refund(usageRequestId)).rejects.toMatchObject({ code: 'credit_usage_reconciliation_required' });
    expect(await snapshot()).toEqual(before);
    expect(await readCreditBalance({ db, userId })).toMatchObject({ available: 0, debt: 20 });
  });

  it('reconciles all grants belonging to the same payment without double-counting restored usage', async () => {
    const payment = await grant(10, { creditType: 'membership', sourceType: 'subscription_grant' });
    await grant(90, { paymentReference: payment.paymentReference });
    await refund(await use(20));
    const result = await revoke(payment);
    expect(result.revokedGrantIds).toHaveLength(2);
    expect(result).toMatchObject({ grantRevoked: 100, offsetRevoked: 0, debtCreated: 0,
      balance: { available: 0, debt: 0 } });
  });

  it('keeps a repeated support refund from adding another restoration fact', async () => {
    const payment = await grant(100);
    const usageRequestId = await use(20);
    const idempotencyKey = randomUUID();
    await refund(usageRequestId, { idempotencyKey });
    const before = await snapshot();
    await expect(refund(usageRequestId, { idempotencyKey })).rejects.toMatchObject({ code: 'credit_usage_already_refunded' });
    await expect(refund(usageRequestId)).rejects.toMatchObject({ code: 'credit_usage_already_refunded' });
    expect(await snapshot()).toEqual(before);
    expect(await revoke(payment)).toMatchObject({ grantRevoked: 100, debtCreated: 0 });
  });

});
