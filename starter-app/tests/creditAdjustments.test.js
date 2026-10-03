import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deductAvailableCredits,
  expireCreditGrantById,
  grantCredits,
  readCreditBalance,
  reverseAdministrativeTransaction,
} from '@yuva/billing-core';
import { isolatedDatabase } from './helpers/database.js';

describe('administrative credit adjustments on PostgreSQL', () => {
  let db, close, userId;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    userId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [userId]);
  });

  const grant = (credits, creditType = 'membership', sourceType = 'admin_adjustment') => grantCredits({
    db, userId, credits, creditType, sourceType, idempotencyKey: randomUUID(), includeTransaction: true,
  });
  const expire = (grantId) => expireCreditGrantById({
    db, grantId, idempotencyKey: randomUUID(), reason: 'fixture manual expiration',
  });
  const deduct = (credits) => deductAvailableCredits({
    db, userId, credits, idempotencyKey: randomUUID(), reason: 'fixture deduction',
  });
  const reverse = (transactionId) => reverseAdministrativeTransaction({
    db, transactionId, idempotencyKey: randomUUID(), reason: 'fixture reversal',
  });
  async function snapshot() {
    const result = {};
    for (const table of ['credit_accounts', 'credit_grants', 'credit_transactions']) {
      result[table] = (await db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY ${table === 'credit_accounts' ? 'user_id' : 'id'}`, [userId])).rows;
    }
    return result;
  }

  it('expires an exact remaining membership balance once, preserving its ledger', async () => {
    const { grantId } = await grant(7);
    const result = await expire(grantId);
    expect(result.expiredCredits).toBe(7);
    expect(result.balance).toMatchObject({ available: 0, reserved: 0, debt: 0 });
    expect((await db.query('SELECT remaining_credits,status FROM credit_grants WHERE id=$1', [grantId])).rows[0])
      .toEqual({ remaining_credits: 0, status: 'expired' });
    expect((await db.query("SELECT available_delta FROM credit_transactions WHERE user_id=$1 AND transaction_type='expiration'", [userId])).rows)
      .toEqual([{ available_delta: -7 }]);
    const after = await snapshot();
    await expect(expire(grantId)).rejects.toMatchObject({ code: 'credit_grant_terminal' });
    expect(await snapshot()).toEqual(after);
  });

  it('deducts part of a grant and reverses that debit with a positive delta', async () => {
    await grant(10, 'purchased');
    const debit = await deduct(4);
    expect(debit.balance.available).toBe(6);
    const restored = await reverse(debit.transactionIds[0]);
    expect(restored.balance).toMatchObject({ available: 10, reserved: 0, debt: 0 });
    expect((await db.query('SELECT remaining_credits FROM credit_grants WHERE user_id=$1', [userId])).rows)
      .toEqual([{ remaining_credits: 10 }]);
  });

  it('reverses a positive administrative grant down to zero', async () => {
    const { transactionId } = await grant(9, 'purchased');
    const result = await reverse(transactionId);
    expect(result.balance).toMatchObject({ available: 0, reserved: 0, debt: 0 });
    expect((await db.query('SELECT remaining_credits,status FROM credit_grants WHERE user_id=$1', [userId])).rows)
      .toEqual([{ remaining_credits: 0, status: 'exhausted' }]);
  });

  it('refuses an insufficient account without changing the grant or ledger', async () => {
    const { grantId } = await grant(7);
    await db.query('UPDATE credit_accounts SET available_credits=1 WHERE user_id=$1', [userId]);
    const before = await snapshot();
    await expect(expire(grantId)).rejects.toMatchObject({ code: 'credit_reconciliation_required' });
    expect(await snapshot()).toEqual(before);
  });

  it('serializes two membership expirations without losing either debit', async () => {
    const first = await grant(3), second = await grant(4);
    const results = await Promise.all([expire(first.grantId), expire(second.grantId)]);
    expect(results.map(value => value.expiredCredits).sort()).toEqual([3, 4]);
    expect(await readCreditBalance({ db, userId })).toMatchObject({ available: 0, reserved: 0, debt: 0 });
    expect((await db.query("SELECT available_delta FROM credit_transactions WHERE user_id=$1 AND transaction_type='expiration' ORDER BY available_delta", [userId])).rows)
      .toEqual([{ available_delta: -4 }, { available_delta: -3 }]);
  });
});
