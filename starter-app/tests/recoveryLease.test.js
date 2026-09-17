import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createOperationStore, createOperationRecoveryStore, createOperationSettlementStore, grantCredits } from '@yuva/billing-core';
import { isolatedDatabase, operationFixture, quoteFixture } from './helpers/database.js';
import { createUsageStore } from '../server/stores/usageStore.js';

describe('persistent recovery ownership', () => {
  let db, close, operation, accountId, recovery, settlement;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID(); await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
    ({ operation } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote: quoteFixture() }));
    recovery = createOperationRecoveryStore({ db, maxAttempts: 2 });
    settlement = createOperationSettlementStore({ db });
  });
  const expire = () => db.query("UPDATE ai_operations SET lease_expires_at=clock_timestamp()-interval '1 second',next_recovery_at=clock_timestamp() WHERE id=$1", [operation.id]);
  const apply = (expectedEpoch = 0) => settlement.apply({ operationId: operation.id, accountId, expectedEpoch,
    decision: { action: 'settle', credits: 2, reason: 'ready' }, fulfillment: { status: 'ready', accountId,
      ruleVersion: '1', resultId: operation.id, artifacts: [{ id: operation.id, type: 'text', state: 'available', text: 'Saved', accountId }] } });
  it('does not claim an active operation and only one concurrent worker can claim after expiry', async () => {
    expect(await recovery.claim({ operationId: operation.id })).toBeNull();
    await expire();
    const claims = await Promise.all([recovery.claim({ operationId: operation.id, owner: 'one' }), recovery.claim({ operationId: operation.id, owner: 'two' })]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean).executionEpoch).toBe(1);
    expect((await settlement.read({ operationId: operation.id, accountId })).status).toBe('reserved');
  });
  it('fences the original executor and a replaced recovery worker from all financial writes', async () => {
    await expire();
    await recovery.claim({ operationId: operation.id, owner: 'one' });
    await expect(apply()).rejects.toMatchObject({ code: 'execution_fenced' });
    await expect(createUsageStore({ db }).start({ callId: randomUUID(), operationId: operation.id, accountId,
      attempt: 1, provider: 'fixture', model: 'fixture' })).rejects.toMatchObject({ code: 'execution_fenced' });
    await expire();
    await recovery.claim({ operationId: operation.id, owner: 'two' });
    await expect(apply(1)).rejects.toMatchObject({ code: 'execution_fenced' });
    await expect(recovery.heartbeat({ operationId: operation.id, owner: 'one', expectedEpoch: 1 })).rejects.toMatchObject({ code: 'execution_lease_lost' });
    expect((await apply(2)).status).toBe('settled');
    expect((await apply()).replay).toBe(true);
  });
  it('does not let a worker renew or settle an already expired lease', async () => {
    await expire(); await recovery.claim({ operationId: operation.id, owner: 'one' });
    await recovery.heartbeat({ operationId: operation.id, owner: 'one', expectedEpoch: 1 });
    await expire();
    await expect(recovery.heartbeat({ operationId: operation.id, owner: 'one', expectedEpoch: 1 })).rejects.toMatchObject({ code: 'execution_lease_lost' });
    await expect(apply(1)).rejects.toMatchObject({ code: 'execution_lease_lost' });
  });
  it('persists limited retry ownership and safe metrics without implicitly releasing money', async () => {
    for (let epoch = 1; epoch <= 2; epoch++) {
      await expire();
      await recovery.claim({ operationId: operation.id, owner: 'worker' });
      await recovery.finish({ operationId: operation.id, owner: 'worker', expectedEpoch: epoch, action: 'deferred', reason: 'external_running' });
    }
    await expire();
    expect(await recovery.claim({ operationId: operation.id })).toBeNull();
    const state = await settlement.read({ operationId: operation.id, accountId });
    expect(state.operation.manualReview).toBe(true);
    expect(state.status).toBe('reserved');
    expect((await db.query('SELECT action FROM ai_recovery_events WHERE operation_id=$1 ORDER BY id', [operation.id])).rows.map((r) => r.action))
      .toEqual(['claimed', 'deferred', 'claimed', 'manual_review']);
    expect((await recovery.metrics()).manual).toBeGreaterThanOrEqual(1);
  });
});
