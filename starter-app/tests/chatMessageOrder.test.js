import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../scripts/migrations.mjs';
import { persistChatProjection, withChatProjection } from '../server/domain/chatResultPersistence.js';
import { createChatUseCase } from '../server/application/chatUseCase.js';
import { createAiProduct } from '../server/domain/aiProduct.js';
import { isolatedDatabase } from './helpers/database.js';

const env = { AI_PROVIDER: 'mock', NODE_ENV: 'test' };
const adapter = { domainKey: 'fixture', computeFacts: async () => ({}),
  createSnapshot: () => ({ facts: {} }), buildContext: () => ({}) };
function projection(accountId, conversationId, i) {
  const operation = { id: randomUUID(), accountId, clientRequestId: randomUUID() };
  return { operation, fulfillment: withChatProjection({}, { operation,
    request: { conversationId, question: `question ${i}`, domainKey: 'fixture' }, output: `answer ${i}` }) };
}
async function transaction(db, fn) {
  const client = await db.connect();
  try { await client.query('BEGIN'); await fn(client); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function messagesFor(db, accountId, conversationId) {
  const product = createAiProduct({ env });
  const operation = { id: randomUUID(), accountId, taskType: 'text', createdAt: new Date(),
    quote: product.policy.quote({ taskType: 'text', mode: 'stream' }, product.executionLimits) };
  product.createBilling = () => ({ reserve: async () => ({ kind: 'reserved', operation }),
    settle: async () => ({ status: 'settled' }), onFailure: async () => ({ status: 'released' }) });
  let messages;
  const execute = createChatUseCase({ db, product, adapter, operationStore: {},
    usageStore: { start: async () => {}, observe: async () => {} }, deliveryPort: {}, env,
    callAIStream: async options => { messages = options.messages; await options.onText('new answer'); return {}; } });
  const result = await execute({ user: { id: accountId }, request: { conversationId, question: 'current question' }, logger: { error() {} } });
  return { result, messages };
}

describe('stable chat business order (real PostgreSQL)', () => {
  let db, close;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  async function identity() { const accountId = randomUUID(), conversationId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [accountId]); return { accountId, conversationId }; }
  it('preserves same-timestamp turns and retains exactly the newest ten complete turns for the provider', async () => {
    const { accountId, conversationId } = await identity();
    await transaction(db, async client => {
      for (let i = 0; i < 12; i++) await persistChatProjection({ client, ...projection(accountId, conversationId, i) });
    });
    const rows = (await db.query('SELECT * FROM messages WHERE conversation_id=$1 ORDER BY turn_sequence,role_order', [conversationId])).rows;
    expect(new Set(rows.map(row => row.created_at.toISOString())).size).toBe(1);
    expect(rows.map(row => row.content)).toEqual(Array.from({ length: 12 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat());
    const prompt = await messagesFor(db, accountId, conversationId);
    expect(prompt.result.terminalStatus).toBe('settled');
    expect(prompt.messages.map(message => message.content)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => [`question ${i + 2}`, `answer ${i + 2}`]).flat(), 'current question',
    ]);
  });
  it('serializes concurrent turn writers and makes recovery replay a no-op', async () => {
    const { accountId, conversationId } = await identity();
    const facts = Array.from({ length: 8 }, (_, i) => projection(accountId, conversationId, i));
    await Promise.all(facts.map(value => transaction(db, client => persistChatProjection({ client, ...value }))));
    const before = (await db.query('SELECT role,content,turn_sequence,source_operation_id FROM messages WHERE conversation_id=$1 ORDER BY turn_sequence,role_order', [conversationId])).rows;
    expect(before).toHaveLength(16);
    for (let i = 0; i < 8; i++) {
      expect(before[i * 2].turn_sequence).toBe(String(i + 1));
      expect(before[i * 2 + 1].turn_sequence).toBe(String(i + 1));
      expect(before[i * 2].role).toBe('user'); expect(before[i * 2 + 1].role).toBe('assistant');
      expect(before[i * 2].source_operation_id).toBe(before[i * 2 + 1].source_operation_id);
    }
    await Promise.all(facts.map(value => transaction(db, client => persistChatProjection({ client, ...value }))));
    const after = (await db.query('SELECT role,content,turn_sequence,source_operation_id FROM messages WHERE conversation_id=$1 ORDER BY turn_sequence,role_order', [conversationId])).rows;
    expect(after).toEqual(before);
    expect((await db.query('SELECT next_turn_sequence FROM conversations WHERE id=$1', [conversationId])).rows[0].next_turn_sequence).toBe('9');
  });
  it('rolls back sequence allocation and both messages atomically', async () => {
    const { accountId, conversationId } = await identity(); const first = projection(accountId, conversationId, 0);
    await expect(transaction(db, async client => { await persistChatProjection({ client, ...first }); throw new Error('rollback fixture'); })).rejects.toThrow('rollback fixture');
    await transaction(db, client => persistChatProjection({ client, ...first }));
    expect((await db.query('SELECT turn_sequence FROM messages WHERE conversation_id=$1', [conversationId])).rows.map(row => row.turn_sequence)).toEqual(['1', '1']);
  });
});

describe('legacy chat order migration (real PostgreSQL)', () => {
  let db, close, directory;
  beforeAll(async () => {
    ({ db, close } = await isolatedDatabase({ migrate: false }));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'starter-before-chat-order-'));
    for (const name of await fs.readdir('scripts/migrations')) if (Number(name.slice(0, 3)) < 9) {
      await fs.copyFile(path.join('scripts/migrations', name), path.join(directory, name));
    }
    await migrateDatabase(db, { directory });
  });
  afterAll(async () => { await close?.(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
  it('recovers only provable old order, preserves ambiguous data, and leaves financial records unchanged', async () => {
    const accountId = randomUUID(); await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    const conversations = Object.fromEntries(['projection', 'missing', 'duplicate', 'repeated_messages', 'timestamps', 'null_timestamp'].map(key => [key, randomUUID()]));
    for (const id of Object.values(conversations)) await db.query('INSERT INTO conversations(id,user_id) VALUES($1,$2)', [id, accountId]);
    async function pair(key, stamp = '2026-01-01T00:00:00Z') {
      await db.query(`INSERT INTO messages(conversation_id,role,content,created_at) VALUES
        ($1,'assistant','old answer',$2),($1,'user','old question',$2)`, [conversations[key], stamp]);
    }
    for (const key of ['projection', 'missing', 'duplicate', 'repeated_messages']) await pair(key);
    await db.query(`INSERT INTO messages(conversation_id,role,content,created_at) VALUES
      ($1,'user','old question','2026-01-01T00:00:00Z'),($1,'assistant','old answer','2026-01-01T00:00:01Z')`, [conversations.timestamps]);
    await pair('null_timestamp', null);
    await pair('repeated_messages', '2026-01-01T00:00:01Z');
    async function oldOperation(key) {
      const facts = projection(accountId, conversations[key], 0);
      facts.fulfillment.starterChatProjection.question = 'old question'; facts.fulfillment.starterChatProjection.text = 'old answer';
      await db.query(`INSERT INTO ai_operations(id,account_id,client_request_id,feature_key,task_type,execution_mode,input_version,
        input_fingerprint,quote,financial_status,fulfillment_status,fulfillment)
        VALUES($1,$2,$3,'fixture','text','stream','1',$4,'{}','settled','ready',$5)`,
      [facts.operation.id, accountId, facts.operation.clientRequestId, '0'.repeat(64), facts.fulfillment]);
    }
    await oldOperation('projection'); await oldOperation('duplicate'); await oldOperation('duplicate'); await oldOperation('repeated_messages');
    const financialBefore = (await db.query('SELECT * FROM ai_operations ORDER BY id')).rows;
    const messagesBefore = (await db.query('SELECT id,conversation_id,role,content,metadata,created_at FROM messages ORDER BY id')).rows;
    await migrateDatabase(db);
    expect((await db.query('SELECT * FROM ai_operations ORDER BY id')).rows).toEqual(financialBefore);
    expect((await db.query('SELECT id,conversation_id,role,content,metadata,created_at FROM messages ORDER BY id')).rows).toEqual(messagesBefore);
    for (const [key, source] of [['projection', 'legacy_projection'], ['timestamps', 'legacy_timestamp']]) {
      const rows = (await db.query('SELECT role,ordering_source FROM messages WHERE conversation_id=$1 ORDER BY turn_sequence,role_order', [conversations[key]])).rows;
      expect(rows).toEqual([{ role: 'user', ordering_source: source }, { role: 'assistant', ordering_source: source }]);
      expect((await messagesFor(db, accountId, conversations[key])).messages.map(message => message.content)).toEqual(['old question', 'old answer', 'current question']);
    }
    for (const key of ['missing', 'duplicate', 'repeated_messages', 'null_timestamp']) {
      expect((await db.query('SELECT turn_sequence,ordering_source FROM messages WHERE conversation_id=$1', [conversations[key]])).rows)
        .toEqual(Array.from({ length: key === 'repeated_messages' ? 4 : 2 }, () => ({ turn_sequence: null, ordering_source: 'legacy_unknown' })));
      expect((await messagesFor(db, accountId, conversations[key])).result.code).toBe('conversation_history_order_unavailable');
    }
    await migrateDatabase(db); // Applied checksum verification and rerun are safe.
  });
});
