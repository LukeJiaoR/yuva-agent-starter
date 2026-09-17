import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { isolatedDatabase, quoteFixture, operationFixture } from './helpers/database.js';
import { migrateDatabase } from '../../scripts/migrations.mjs';
import { createOperationStore, grantCredits, getCreditBalance, reserveFeatureCredits } from '@yuva/billing-core';

describe('operation identity, immutable quote and incremental migration', () => {
  let db, close, userId, store;
  beforeAll(async () => {
    ({ db, close } = await isolatedDatabase({ migrate: false }));
    // Real legacy v1 database and financial state before upgrading.
    await db.query(await fs.readFile(new URL('../../scripts/schema.sql', import.meta.url), 'utf8'));
    userId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES ($1)', [userId]);
    await grantCredits({ db, userId, credits: 30, creditType: 'purchased', idempotencyKey: randomUUID() });
    await reserveFeatureCredits({ db, userId, featureKey: 'test_operation', clientRequestId: 'legacy', credits: 2 });
    await Promise.all([migrateDatabase(db), migrateDatabase(db)]);
    store = createOperationStore({ db, capabilities: [{ taskType: 'text', mode: 'stream' }, { taskType: 'image', mode: 'async' }, { taskType: 'video', mode: 'async' }] });
  });
  afterAll(async () => close?.());
  it('adopts old schema once without changing identity or existing balance', async () => {
    expect((await getCreditBalance({ db, userId })).available).toBe(28);
    expect((await db.query('SELECT * FROM starter_migrations ORDER BY version')).rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await store.reserve({ operation: operationFixture(userId, 'legacy'), quote: quoteFixture() })).kind).toBe('legacy');
    expect((await db.query("SELECT * FROM ai_operations WHERE client_request_id='legacy'")).rows).toHaveLength(0);
  });
  it('serializes concurrent retries and freezes quote across restart/configuration changes', async () => {
    const operation = operationFixture(userId);
    const quote = quoteFixture();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.reserve({ operation, quote })));
    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
    expect(new Set(results.map((r) => r.operation.id)).size).toBe(1);
    const restarted = createOperationStore({ db });
    const repeated = await restarted.reserve({ operation, quote: quoteFixture(5) });
    expect(repeated.operation.quote).toEqual(quote);
    await expect(db.query('UPDATE ai_operations SET quote=$2 WHERE id=$1', [repeated.operation.id, quoteFixture(5)])).rejects.toThrow('immutable');
    await expect(store.reserve({ operation: { ...operation, input: { question: 'different' } }, quote })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(store.reserve({ operation: { ...operation, featureKey: 'different' }, quote })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await store.find({ accountId: randomUUID(), clientRequestId: operation.clientRequestId })).toBeNull();
  });
  it.each(['image', 'video'])('stores %s without text or token fields and rejects changed specifications', async (taskType) => {
    const operation = operationFixture(userId, randomUUID(), taskType);
    const first = await store.reserve({ operation, quote: quoteFixture() });
    expect(first.operation.taskType).toBe(taskType);
    await expect(store.reserve({ operation: { ...operation, input: { ...operation.input, durationMs: 10000 } }, quote: quoteFixture() })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('rejects expired and unsupported quotes before reservation; insufficient funds leave no runnable operation', async () => {
    const operation = operationFixture(userId);
    await expect(store.reserve({ operation, quote: { ...quoteFixture(), createdAt: '2020-01-01', expiresAt: '2020-01-02' } })).rejects.toMatchObject({ code: 'quote_expired' });
    await expect(createOperationStore({ db }).reserve({ operation: operationFixture(userId, 'image-rejected', 'image'), quote: quoteFixture() })).rejects.toMatchObject({ code: 'unsupported_operation' });
    expect((await store.reserve({ operation, quote: quoteFixture(100) })).kind).toBe('insufficient');
    expect(await store.find({ accountId: userId, clientRequestId: operation.clientRequestId })).toBeNull();
  });
  it('rolls reservation back if operation persistence fails', async () => {
    const before = await getCreditBalance({ db, userId });
    const proxy = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: (sql, args) => {
        if (sql.includes('INSERT INTO ai_operations')) throw new Error('injected persistence failure');
        return client.query(sql, args);
      } };
    } };
    await expect(createOperationStore({ db: proxy }).reserve({ operation: operationFixture(userId), quote: quoteFixture() })).rejects.toThrow('injected');
    expect(await getCreditBalance({ db, userId })).toEqual(before);
  });
  it('detects changed checksums instead of silently replaying migrations', async () => {
    await db.query("UPDATE starter_migrations SET checksum=repeat('0',64) WHERE version=2");
    await expect(migrateDatabase(db)).rejects.toThrow('checksum');
  });
});
