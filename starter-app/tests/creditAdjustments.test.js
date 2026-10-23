import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deductAvailableCredits,
  expireCreditGrantById,
  grantCredits,
  readCreditBalance,
  reconcileCreditAccount,
  reverseAdministrativeTransaction,
  withCreditTransaction,
} from '@yuva/billing-core';
import { beginAdminAction, finishAdminAction } from '@yuva/admin-core';
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
    for (const table of ['credit_accounts', 'credit_grants', 'credit_transactions', 'credit_mutations']) {
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

  it('replays the exact deduction result after restart and subsequent balance changes', async () => {
    await grant(100, 'purchased');
    const input = { db, userId, credits: 10, idempotencyKey: randomUUID(), reason: 'same deduction',
      metadata: { nested: { one: 1, two: 2 }, values: ['a', 'b'] } };
    const first = await deductAvailableCredits(input);
    expect(first.balance.available).toBe(90);
    await grant(7, 'purchased');
    const before = await snapshot();
    const restarted = { connect: () => db.connect() };
    const second = await deductAvailableCredits({ ...input, db: restarted,
      metadata: { values: ['a', 'b'], nested: { two: 2, one: 1 } } });
    expect(second).toEqual(first);
    expect(await snapshot()).toEqual(before);
    expect((await readCreditBalance({ db, userId })).available).toBe(97);
  });

  it.each([
    { credits: 11 }, { creditType: 'purchased' }, { reason: 'changed reason' },
    { referenceId: 'different-reference' }, { sourceId: 'different-source' }, { metadata: { changed: true } },
  ])('rejects same-key changed input %j before any further mutations', async (change) => {
    await grant(100, 'purchased');
    const input = { db, userId, credits: 10, idempotencyKey: randomUUID(), reason: 'original reason' };
    await deductAvailableCredits(input);
    const before = await snapshot();
    await expect(deductAvailableCredits({ ...input, ...change }))
      .rejects.toMatchObject({ code: 'credit_deduction_idempotency_conflict', status: 409 });
    expect(await snapshot()).toEqual(before);
  });

  it('deduplicates concurrent deductions across two explicitly distinct PostgreSQL connections', async () => {
    await grant(100, 'purchased');
    const clients = await Promise.all([db.connect(), db.connect()]);
    const input = { userId, credits: 10, idempotencyKey: randomUUID(), reason: 'concurrent deduction' };
    try {
      const pids = await Promise.all(clients.map(async (client) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      expect(pids[0]).not.toBe(pids[1]);
      const results = await Promise.all(clients.map((client) => deductAvailableCredits({ ...input,
        db: { connect: async () => ({ query: (...args) => client.query(...args), release() {} }) } })));
      expect(results[1]).toEqual(results[0]);
      expect(results[0].balance.available).toBe(90);
      expect((await db.query('SELECT * FROM credit_mutations WHERE user_id=$1', [userId])).rows).toHaveLength(1);
      expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND direction='debit'", [userId])).rows).toHaveLength(1);
    } finally { clients.forEach((client) => client.release()); }
  });

  it('scopes the key to the target account and action', async () => {
    await grant(100, 'purchased');
    const otherUserId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [otherUserId]);
    await grantCredits({ db, userId: otherUserId, credits: 100, creditType: 'purchased',
      sourceType: 'admin_adjustment', idempotencyKey: randomUUID() });
    const input = { db, userId, credits: 10, idempotencyKey: randomUUID(), reason: 'scoped deduction' };
    await db.query(`INSERT INTO credit_mutations (id,user_id,action,idempotency_key,input_hash,result)
      VALUES ($1,$2,'another_action',$3,repeat('0',64),'{}')`, [randomUUID(), userId, input.idempotencyKey]);
    const first = await deductAvailableCredits(input);
    const second = await deductAvailableCredits({ ...input, userId: otherUserId });
    expect(first.balance.available).toBe(90);
    expect(second.balance.available).toBe(90);
    expect(second.transactionIds).not.toEqual(first.transactionIds);
  });

  it('replays a multi-grant deduction even when a grant is exhausted', async () => {
    await grant(3, 'membership');
    await grant(10, 'purchased');
    const input = { db, userId, credits: 8, idempotencyKey: randomUUID(), reason: 'multi-grant deduction' };
    const first = await deductAvailableCredits(input);
    expect(first.grantIds).toHaveLength(2);
    expect(first.transactionIds).toHaveLength(2);
    expect(first.balance).toMatchObject({ available: 5, membership: 0, purchased: 5 });
    expect(await deductAvailableCredits(input)).toEqual(first);
    expect(await reconcileCreditAccount({ db, userId })).toMatchObject({ ok: true, available: 5 });
  });

  it('leaves no committed mutation on insufficient funds and allows a later funded retry', async () => {
    await grant(3, 'purchased');
    const input = { db, userId, credits: 10, idempotencyKey: randomUUID(), reason: 'insufficient deduction' };
    const before = await snapshot();
    await expect(deductAvailableCredits(input)).rejects.toMatchObject({ code: 'credit_insufficient_available' });
    expect(await snapshot()).toEqual(before);
    await grant(10, 'purchased');
    const result = await deductAvailableCredits(input);
    expect(result.balance.available).toBe(3);
    expect(await deductAvailableCredits(input)).toEqual(result);
  });

  it.each(['INSERT INTO credit_transactions', 'INSERT INTO credit_mutations'])('rolls back every debit if %s fails', async (failurePoint) => {
    await grant(3, 'membership');
    await grant(10, 'purchased');
    const before = await snapshot();
    const input = { db, userId, credits: 8, idempotencyKey: randomUUID(), reason: 'rollback deduction' };
    const faultyDb = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: (sql, args) => {
        if (sql.includes(failurePoint)) throw new Error('injected deduction persistence failure');
        return client.query(sql, args);
      } };
    } };
    await expect(deductAvailableCredits({ ...input, db: faultyDb })).rejects.toThrow('injected');
    expect(await snapshot()).toEqual(before);
    expect((await deductAvailableCredits(input)).balance.available).toBe(5);
  });

  it('participates in the caller transaction without committing it and can retry after rollback', async () => {
    await grant(100, 'purchased');
    const client = await db.connect();
    const input = { db, userId, credits: 10, idempotencyKey: randomUUID(), reason: 'outer audit transaction' };
    const before = await snapshot();
    try {
      await client.query('BEGIN');
      const first = await deductAvailableCredits({ ...input, db: client });
      expect(await deductAvailableCredits({ ...input, db: client })).toEqual(first);
      expect((await readCreditBalance({ db, userId })).available).toBe(100);
      expect((await db.query('SELECT * FROM credit_mutations WHERE user_id=$1', [userId])).rows).toHaveLength(0);
      await client.query('ROLLBACK');
      expect(await snapshot()).toEqual(before);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await deductAvailableCredits(input)).balance.available).toBe(90);
  });

  it('fails closed on a legacy deduction key without a mutation record', async () => {
    await grant(100, 'purchased');
    const input = { db, userId, credits: 10, idempotencyKey: 'legacy:%_:' + randomUUID(), reason: 'legacy deduction' };
    const first = await deductAvailableCredits(input);
    // Synthetic pre-upgrade state: the old API wrote only this per-grant key.
    await db.query('DELETE FROM credit_mutations WHERE user_id=$1', [userId]);
    await db.query('UPDATE credit_transactions SET idempotency_key=$2 WHERE id=$1',
      [first.transactionIds[0], `${input.idempotencyKey}:${first.grantIds[0]}:0`]);
    const before = await snapshot();
    await expect(deductAvailableCredits(input)).rejects.toMatchObject({ code: 'credit_deduction_legacy_reconciliation_required' });
    expect(await snapshot()).toEqual(before);
    // Prefixes and SQL pattern characters do not claim unrelated keys.
    const different = await deductAvailableCredits({ ...input, idempotencyKey: input.idempotencyKey + ':another' });
    expect(different.balance.available).toBe(80);
  });

  it('supports full-length keys without overflowing ledger keys and rejects truncation aliases', async () => {
    await grant(100, 'purchased');
    const input = { db, userId, credits: 10, idempotencyKey: 'k'.repeat(255), reason: 'long key' };
    const first = await deductAvailableCredits(input);
    expect(await deductAvailableCredits(input)).toEqual(first);
    await expect(deductAvailableCredits({ ...input, idempotencyKey: input.idempotencyKey + 'x' }))
      .rejects.toMatchObject({ code: 'credit_deduction_idempotency_invalid' });
    expect((await readCreditBalance({ db, userId })).available).toBe(90);
  });


  it('keeps the outer administrative audit replay authoritative without a second core deduction', async () => {
    await grant(100, 'purchased');
    const idempotencyKey = randomUUID();
    let deductionCalls = 0;
    const run = () => withCreditTransaction(db, async (client) => {
      const audit = await beginAdminAction({ db: client,
        actor: { id: 'fixture-admin', email: 'fixture-admin@example.test', role: 'support' },
        action: 'deduct_credits', targetType: 'user', targetId: userId,
        reason: 'Synthetic audited deduction', idempotencyKey, payload: { credits: 10 }, environment: 'test' });
      if (audit.replayed) return audit;
      deductionCalls += 1;
      const result = await deductAvailableCredits({ db: client, userId, credits: 10,
        idempotencyKey, reason: 'Synthetic audited deduction' });
      return finishAdminAction({ db: client, requestId: audit.requestId, status: 'succeeded',
        resultSummary: { outcome: 'deducted', creditAmount: result.deductedCredits, transactionIds: result.transactionIds } });
    });
    const first = await run();
    const before = await snapshot();
    const second = await run();
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, requestId: first.requestId, resultSummary: first.resultSummary });
    expect(deductionCalls).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect((await readCreditBalance({ db, userId })).available).toBe(90);
  });

  it('replays a committed deduction after its COMMIT acknowledgment is lost', async () => {
    await grant(100, 'purchased');
    const input = { db, userId, credits: 10, idempotencyKey: randomUUID(), reason: 'lost commit acknowledgment' };
    const uncertainDb = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: async (sql, args) => {
        const result = await client.query(sql, args);
        if (sql === 'COMMIT') throw new Error('synthetic commit acknowledgment loss');
        return result;
      } };
    } };
    await expect(deductAvailableCredits({ ...input, db: uncertainDb })).rejects.toThrow('acknowledgment loss');
    const saved = (await db.query('SELECT result FROM credit_mutations WHERE user_id=$1', [userId])).rows[0].result;
    const before = await snapshot();
    expect(await deductAvailableCredits(input)).toEqual(saved);
    expect(await snapshot()).toEqual(before);
    expect(saved.balance.available).toBe(90);
  });

  it('fails closed instead of committing an unlogged debit when the ledger insert conflicts', async () => {
    await grant(100, 'purchased');
    const before = await snapshot();
    const conflictingDb = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: (sql, args) =>
        sql.includes('INSERT INTO credit_transactions') ? { rows: [] } : client.query(sql, args) };
    } };
    await expect(deductAvailableCredits({ db: conflictingDb, userId, credits: 10,
      idempotencyKey: randomUUID(), reason: 'synthetic ledger conflict' }))
      .rejects.toMatchObject({ code: 'credit_reconciliation_required' });
    expect(await snapshot()).toEqual(before);
  });


  it.each(['client', 'query-only'])('rejects a %s connection without an active transaction before changing money', async (kind) => {
    await grant(100, 'purchased');
    const before = await snapshot();
    const client = await db.connect();
    try {
      const connection = kind === 'client' ? client : { query: (...args) => client.query(...args) };
      await expect(deductAvailableCredits({ db: connection, userId, credits: 10,
        idempotencyKey: randomUUID(), reason: 'requires an outer transaction' }))
        .rejects.toMatchObject({ code: 'credit_deduction_transaction_required' });
      expect((await client.query('SELECT 1 AS usable')).rows[0].usable).toBe(1);
      expect(await snapshot()).toEqual(before);
    } finally { client.release(); }
  });

  it('rolls back its savepoint if a caller catches a late error and commits unrelated outer work', async () => {
    await grant(100, 'purchased');
    const before = await snapshot();
    const client = await db.connect();
    const input = { db, userId, credits: 10, idempotencyKey: randomUUID(), reason: 'caught outer error' };
    try {
      await client.query('BEGIN');
      await client.query("UPDATE users SET display_name='Unrelated outer work' WHERE id=$1", [userId]);
      const faultyClient = { release() {}, query: (sql, args) => {
        if (sql.includes('INSERT INTO credit_mutations')) throw new Error('synthetic late application error');
        return client.query(sql, args);
      } };
      await expect(deductAvailableCredits({ ...input, db: faultyClient })).rejects.toThrow('synthetic late');
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await snapshot()).toEqual(before);
    expect((await db.query('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0].display_name).toBe('Unrelated outer work');
    expect((await deductAvailableCredits(input)).balance.available).toBe(90);
  });

  it('freezes metadata before waiting for a connection and hashes the frozen ledger input', async () => {
    await grant(100, 'purchased');
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const input = { db, userId, credits: 10, idempotencyKey: randomUUID(), reason: 'frozen input',
      metadata: { nested: { value: 'original' } } };
    const pending = deductAvailableCredits({ ...input, db: { connect: async () => { await gate; return db.connect(); } } });
    input.metadata.nested.value = 'mutated while waiting';
    unblock();
    const first = await pending;
    expect((await db.query('SELECT metadata FROM credit_transactions WHERE id=$1', [first.transactionIds[0]])).rows[0].metadata)
      .toEqual({ nested: { value: 'original' } });
    expect(await deductAvailableCredits({ ...input, metadata: { nested: { value: 'original' } } })).toEqual(first);
    await expect(deductAvailableCredits(input)).rejects.toMatchObject({ code: 'credit_deduction_idempotency_conflict' });
  });


  it('does not confuse the new ledger namespace with a historical caller key', async () => {
    await grant(100, 'purchased');
    await deduct(10);
    const result = await deductAvailableCredits({ db, userId, credits: 10,
      idempotencyKey: 'credit-deduction', reason: 'namespace is an ordinary caller key' });
    expect(result.balance.available).toBe(80);
  });

});
