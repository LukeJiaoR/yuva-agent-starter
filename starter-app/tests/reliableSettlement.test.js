import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { createOperationStore, createOperationSettlementStore, grantCredits, getCreditBalance } from '@yuva/billing-core';
import { createAgentRuntime } from '@yuva/ai-engine';
import { isolatedDatabase, operationFixture, quoteFixture } from './helpers/database.js';

describe('reliable operation settlement', () => {
  let db, close, accountId, store, operation;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
    ({ operation } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote: quoteFixture(5) }));
    store = createOperationSettlementStore({ db });
  });
  const id = () => ({ operationId: operation.id, accountId });
  const fulfillment = (type = 'text') => ({ status: 'ready', ruleVersion: '1', accountId, resultId: operation.id,
    artifacts: [{ id: operation.id, accountId, type, state: 'available', ...(type === 'text'
      ? { text: 'Canonical reply' } : { storageKey: `results/${type}`, specs: { width: 1024 } }) }] });
  const settle = (credits = 2, type = 'text') => ({ ...id(), decision: { action: 'settle', credits, reason: 'ready' }, fulfillment: fulfillment(type) });
  const release = () => ({ ...id(), decision: { action: 'release', reason: 'failed' }, fulfillment: { status: 'failed', ruleVersion: '1', accountId, artifacts: [] } });
  it.each(['text', 'image', 'video'])('atomically persists and replays %s artifacts with unused reservation returned', async (type) => {
    const persistResult = vi.fn(async ({ client, ledgerRequest }) => {
      await client.query('UPDATE credit_usage_requests SET assistant_text=$2 WHERE id=$1', [ledgerRequest.id, 'Projection']);
    });
    const [first, second] = await Promise.all([store.apply({ ...settle(2, type), persistResult }), store.apply({ ...settle(2, type), persistResult })]);
    expect(first.status).toBe('settled'); expect(second.status).toBe('settled');
    expect(persistResult).toHaveBeenCalledTimes(1);
    expect((await store.read(id())).fulfillment).toEqual(fulfillment(type));
    expect((await getCreditBalance({ db, userId: accountId }))).toMatchObject({ available: 18, reserved: 0 });
    expect((await store.apply(release())).status).toBe('settled');
    await expect(store.read({ ...id(), accountId: randomUUID() })).rejects.toMatchObject({ code: 'operation_not_found' });
  });
  it.each(['text', 'image', 'video'])('records %s no-charge success and releases a positive reservation exactly once', async (type) => {
    const [first, second] = await Promise.all([store.apply(settle(0, type)), store.apply(settle(0, type))]);
    expect([first.status, second.status]).toEqual(['no_charge', 'no_charge']);
    expect((await store.read(id())).fulfillment.artifacts[0].type).toBe(type);
    expect((await getCreditBalance({ db, userId: accountId }))).toMatchObject({ available: 20, reserved: 0 });
    expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(0);
  });
  it('coordinates competing release and settlement without contradictory terminal states', async () => {
    const result = await Promise.all([store.apply(release()), store.apply(settle())]);
    expect(result[0].status).toBe(result[1].status);
    const financial = await store.read(id());
    expect(['released', 'settled']).toContain(financial.status);
    const balance = await getCreditBalance({ db, userId: accountId });
    expect(balance.available).toBe(financial.status === 'settled' ? 18 : 20);
    expect(balance.reserved).toBe(0);
  });
  it('retains a durable candidate after result projection rollback, without charging', async () => {
    await store.stage({ ...id(), fulfillment: fulfillment() });
    await expect(store.apply({ ...settle(), persistResult: async () => { throw new Error('result-write-failed'); } })).rejects.toThrow('result-write-failed');
    expect((await store.read(id())).status).toBe('reserved');
    expect((await store.read(id())).fulfillment).toEqual(fulfillment());
    expect((await getCreditBalance({ db, userId: accountId }))).toMatchObject({ available: 15, reserved: 5 });
    expect((await store.apply(settle())).status).toBe('settled');
  });
  it('keeps partial delivery deferred and rejects changing an already staged ready result', async () => {
    const partial = { ...fulfillment('image'), status: 'partial', artifacts: [] };
    expect((await store.apply({ ...id(), decision: { action: 'defer', reason: 'artifact_missing' }, fulfillment: partial })).status).toBe('reconciliation_required');
    expect((await getCreditBalance({ db, userId: accountId })).reserved).toBe(5);
    await store.stage({ ...id(), fulfillment: fulfillment('image') });
    await expect(store.stage({ ...id(), fulfillment: fulfillment('video') })).rejects.toMatchObject({ code: 'result_identity_conflict' });
  });
  it.each([true, false])('distinguishes unknown COMMIT acknowledgment (committed=%s) from known rollback', async (committed) => {
    let injected = false;
    const faultyDb = { query: db.query.bind(db), connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: async (sql, values) => {
        if (sql === 'COMMIT' && !injected) {
          injected = true;
          if (committed) await client.query(sql);
          throw Object.assign(new Error('ack lost'), { code: 'ECONNRESET' });
        }
        return client.query(sql, values);
      } };
    } };
    await expect(createOperationSettlementStore({ db: faultyDb }).apply(settle())).rejects.toMatchObject({ code: 'commit_outcome_unknown', reconciliationRequired: true });
    const marked = await store.markReconciliation({ ...id(), reason: 'commit_outcome_unknown' });
    expect(marked.status).toBe(committed ? 'settled' : 'reconciliation_required');
    const result = await store.apply(settle());
    expect(result.status).toBe('settled');
    expect((await getCreditBalance({ db, userId: accountId }))).toMatchObject({ available: 18, reserved: 0 });
    expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(1);
  });
});

describe('runtime reports persistent financial facts', () => {
  it.each(['settled', 'no_charge', 'reconciliation_required'])('returns %s after delivery or settlement errors without blind release', async (status) => {
    const release = vi.fn();
    const onFailure = vi.fn(async () => ({ status }));
    const runtime = createAgentRuntime({ billingPort: { reserve: async () => ({}),
      settle: async () => { if (status === 'reconciliation_required') throw new Error('commit unknown'); return { status }; }, release, onFailure },
      streamPort: { streamProviderText: async () => ({}) },
      validationPort: { createDelivery: async () => ({ flush: async () => ({ visibleText: 'saved' }), commit: async () => { throw new Error('socket closed'); } }) } });
    const result = await runtime({ request: {}, user: {} });
    expect(result.terminalStatus).toBe(status);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });
  it('does not emit done or commit delivery for deferred settlement', async () => {
    const commit = vi.fn(), emitDone = vi.fn();
    const runtime = createAgentRuntime({ billingPort: { reserve: async () => ({}), settle: async () => ({ status: 'reconciliation_required' }) },
      streamPort: { createEmitter: () => ({}), emitDone }, validationPort: { createDelivery: async () => ({ flush: async () => ({}), commit }) } });
    expect((await runtime({ request: {}, user: {} })).terminalStatus).toBe('reconciliation_required');
    expect(commit).not.toHaveBeenCalled(); expect(emitDone).not.toHaveBeenCalled();
  });
});
