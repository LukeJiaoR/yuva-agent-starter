import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server/index.js';
import { createAiProduct } from '../server/domain/aiProduct.js';
import { chatConversationId } from '../server/domain/chatResultPersistence.js';
import { persistRecoveredChatResult } from '../server/domain/chatResultPersistence.js';
import { createChatRecoverySettlementStore } from '../server/domain/chatRecovery.js';
import { grantCredits, getCreditBalance, operationFingerprint, createFixedOperationPricingPolicy,
  createOperationRecoveryStore } from '@yuva/billing-core';
import { isolatedDatabase } from './helpers/database.js';

const runFile = promisify(execFile);
function routeHandler(app) {
  for (const layer of app._router.stack) {
    const route = layer.handle?.stack?.find((entry) => entry.route?.path === '/api/chat/stream');
    if (route) return route.route.stack[0].handle;
  }
  throw new Error('Chat route missing');
}
function response() {
  const events = [];
  return { events, setHeader: vi.fn(), write: vi.fn((value) => events.push(value)), end: vi.fn(),
    status: vi.fn().mockReturnThis(), json: vi.fn(), headersSent: false, writableEnded: false };
}

describe('atomic chat projection, ledger and recovery (real PostgreSQL)', () => {
  let db, close, userId, logger;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.query('DROP TRIGGER IF EXISTS reject_chat_messages ON messages; DROP TRIGGER IF EXISTS reject_chat_conversations ON conversations');
    userId = randomUUID(); await db.query('INSERT INTO users(id) VALUES($1)', [userId]);
    await grantCredits({ db, userId, credits: 100, creditType: 'purchased', idempotencyKey: randomUUID() });
  });
  afterEach(() => vi.restoreAllMocks());
  function compose({ activeDb = db, aiProduct, pricing, callAIStream } = {}) {
    const provider = callAIStream ?? vi.fn(async ({ onText }) => {
      await onText('Approved answer');
      return { usage: { source: 'provider', inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 } };
    });
    const handler = routeHandler(createServer({ db: activeDb, callAIStream: provider, aiProduct,
      config: { env: { AI_PROVIDER: 'mock', NODE_ENV: 'test' }, ...(pricing ? { pricing } : {}) } }));
    return { provider, send: async (requestId, extra = {}) => {
      const res = response();
      await handler({ user: { id: userId }, body: { question: 'Original question', requestId, ...extra } }, res, vi.fn());
      return res;
    } };
  }
  async function operation(requestId) {
    return (await db.query('SELECT * FROM ai_operations WHERE account_id=$1 AND client_request_id=$2', [userId, requestId])).rows[0];
  }
  const messages = async (conversationId) => (await db.query('SELECT role,content FROM messages WHERE conversation_id=$1', [conversationId])).rows;
  const expire = (id) => db.query(`UPDATE ai_operations SET lease_expires_at=clock_timestamp()-interval '1 second',
    next_recovery_at=clock_timestamp() WHERE id=$1`, [id]);
  async function recover(id) {
    const { stdout } = await runFile(process.execPath, ['scripts/recover-operations.mjs', '--apply', '--operation', id], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: db.options.connectionString }, timeout: 20000,
    });
    return JSON.parse(stdout);
  }
  async function blockMessages({ zeroRows = false } = {}) {
    await db.query(`CREATE OR REPLACE FUNCTION reject_chat_message_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${zeroRows ? 'RETURN NULL;' : "RAISE EXCEPTION 'synthetic SQL password=fixture-only host=private.invalid';"} END $$;
      CREATE TRIGGER reject_chat_messages BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION reject_chat_message_write()`);
  }
  function shortLivedProduct(options = {}) {
    const policy = createFixedOperationPricingPolicy({ credits: 2 });
    return createAiProduct({ env: { AI_PROVIDER: 'mock' }, ...options,
      policy: { ...policy, quote: (...args) => {
        const quote = policy.quote(...args);
        return { ...quote, terms: { ...quote.terms, recoveryPolicy: { version: '1', maxAgeMs: 1, onExpiry: 'waive' } } };
      } } });
  }

  it.each([{ strategy: 'fixed', credits: 2, expected: 2 }, { strategy: 'fixed', credits: 0, expected: 0 },
    { strategy: 'token', inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 }, expected: 3 }])
    ('commits one conversation and two approved messages with $strategy/$expected credits, then replays', async ({ expected, ...pricing }) => {
      const app = compose({ pricing: { ...pricing, featureKey: 'chat_fixture' } });
      const requestId = randomUUID(); const first = await app.send(requestId); const replay = await app.send(requestId);
      const row = await operation(requestId);
      const conversationId = chatConversationId({ accountId: userId, clientRequestId: requestId });
      expect(row.financial_status).toBe(expected === 0 ? 'no_charge' : 'settled');
      expect(row.fulfillment.starterChatProjection).toMatchObject({ version: 1, conversationId,
        question: 'Original question', text: 'Approved answer', writer: 'starter_chat_v1' });
      expect(await messages(conversationId)).toEqual(expect.arrayContaining([
        { role: 'user', content: 'Original question' }, { role: 'assistant', content: 'Approved answer' },
      ]));
      expect(await messages(conversationId)).toHaveLength(2);
      expect(first.events.join('')).toContain('event: done');
      expect(replay.events.join('')).toContain('"replayed":true');
      expect(replay.events.join('')).toContain(conversationId);
      expect(app.provider).toHaveBeenCalledTimes(1);
      expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 100 - expected, reserved: 0 });
    });

  it('serializes concurrent same-key requests and does not change the legacy automatic-ID fingerprint', async () => {
    const app = compose(); const requestId = randomUUID();
    await Promise.all([app.send(requestId), app.send(requestId)]);
    const row = await operation(requestId);
    expect(row.financial_status).toBe('settled');
    expect(row.input_fingerprint).toBe(operationFingerprint({ featureKey: row.feature_key, taskType: 'text', mode: 'stream', inputVersion: '1',
      input: { question: 'Original question', subject: 'Default Subject', parameters: {}, conversationId: null,
        domainKey: 'vertical-agent-saas' } }));
    expect(await messages(row.fulfillment.starterChatProjection.conversationId)).toHaveLength(2);
    expect(app.provider).toHaveBeenCalledTimes(1);
    const conflict = await app.send(requestId, { question: 'Different question' });
    expect(conflict.status).toHaveBeenCalledWith(409);
    expect(app.provider).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves an explicit owned conversation ID (already exists=$0)', async (exists) => {
    const conversationId = randomUUID();
    if (exists) await db.query('INSERT INTO conversations(id,user_id) VALUES($1,$2)', [conversationId, userId]);
    const app = compose(); const requestId = randomUUID(); const res = await app.send(requestId, { conversationId });
    expect(res.events.join('')).toContain('event: done');
    expect((await operation(requestId)).fulfillment.starterChatProjection.conversationId).toBe(conversationId);
    expect(await messages(conversationId)).toHaveLength(2);
    expect((await db.query('SELECT user_id FROM conversations WHERE id=$1', [conversationId])).rows[0].user_id).toBe(userId);
  });

  it.each(['conversations', 'messages', 'zero_messages'])('rolls back the ledger and projection on %s failure, then CLI recovers without generation', async (failure) => {
    if (failure === 'conversations') {
      await db.query(`CREATE OR REPLACE FUNCTION reject_chat_conversation_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic conversation SQL password=fixture-only'; END $$;
        CREATE TRIGGER reject_chat_conversations BEFORE INSERT ON conversations FOR EACH ROW EXECUTE FUNCTION reject_chat_conversation_write()`);
    } else await blockMessages({ zeroRows: failure === 'zero_messages' });
    const app = compose(); const requestId = randomUUID(); const failed = await app.send(requestId);
    const row = await operation(requestId); const conversationId = row.fulfillment.starterChatProjection.conversationId;
    expect(row.financial_status).toBe('reconciliation_required');
    expect(row.fulfillment_status).toBe('ready');
    expect(await messages(conversationId)).toHaveLength(0);
    expect((await db.query('SELECT id FROM conversations WHERE id=$1', [conversationId])).rows).toHaveLength(0);
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 98, reserved: 2 });
    expect(failed.events.join('')).not.toContain('event: done');
    expect(JSON.stringify([failed.events, logger.mock.calls])).not.toMatch(/password=|private\.invalid|fixture-only/);
    await db.query('DROP TRIGGER IF EXISTS reject_chat_messages ON messages; DROP TRIGGER IF EXISTS reject_chat_conversations ON conversations');
    await expire(row.id);
    expect((await recover(row.id)).outcomes[0]).toMatchObject({ action: 'settled' });
    expect((await recover(row.id)).outcomes).toHaveLength(0);
    expect(await messages(conversationId)).toHaveLength(2);
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 98, reserved: 0 });
    expect(app.provider).toHaveBeenCalledTimes(1);
  }, 30000);

  it.each([true, false])('reconciles an unknown settlement COMMIT (committed=$0) without duplicate messages or debit', async (committed) => {
    let injected = false;
    const activeDb = { query: db.query.bind(db), connect: async () => {
      const tx = await db.connect(); let wroteMessages = false;
      return { release: (error) => tx.release(error), query: async (sql, values) => {
        if (sql.includes('INSERT INTO messages')) wroteMessages = true;
        if (sql === 'COMMIT' && wroteMessages && !injected) {
          injected = true; if (committed) await tx.query(sql);
          throw Object.assign(new Error('synthetic commit acknowledgement lost'), { code: 'ECONNRESET' });
        }
        return tx.query(sql, values);
      } };
    } };
    const app = compose({ activeDb }); const requestId = randomUUID(); await app.send(requestId);
    const row = await operation(requestId); expect(injected).toBe(true);
    expect(row.financial_status).toBe(committed ? 'settled' : 'reconciliation_required');
    expect(await messages(row.fulfillment.starterChatProjection.conversationId)).toHaveLength(committed ? 2 : 0);
    if (!committed) { await expire(row.id); expect((await recover(row.id)).outcomes[0].action).toBe('settled'); }
    await app.send(requestId);
    expect(await messages(row.fulfillment.starterChatProjection.conversationId)).toHaveLength(2);
    expect((await db.query("SELECT id FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [userId])).rows).toHaveLength(1);
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 98, reserved: 0 });
    expect(app.provider).toHaveBeenCalledTimes(1);
  }, 30000);

  it('rejects an existing foreign conversation before reservation or external execution', async () => {
    const other = randomUUID(); const conversationId = randomUUID(); await db.query('INSERT INTO users(id) VALUES($1)', [other]);
    await db.query('INSERT INTO conversations(id,user_id) VALUES($1,$2)', [conversationId, other]);
    const app = compose(); const requestId = randomUUID(); const res = await app.send(requestId, { conversationId });
    expect(res.status).toHaveBeenCalledWith(403); expect(app.provider).not.toHaveBeenCalled();
    expect(await operation(requestId)).toBeUndefined(); expect(await messages(conversationId)).toHaveLength(0);
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 100, reserved: 0 });
  });

  it('treats a tenant ownership race as a zero-row transaction failure rather than charging without messages', async () => {
    const other = randomUUID(); const conversationId = randomUUID(); await db.query('INSERT INTO users(id) VALUES($1)', [other]);
    const provider = vi.fn(async ({ onText }) => {
      await db.query('INSERT INTO conversations(id,user_id) VALUES($1,$2)', [conversationId, other]);
      await onText('Approved answer'); return {};
    });
    const app = compose({ callAIStream: provider }); const requestId = randomUUID(); await app.send(requestId, { conversationId });
    expect((await operation(requestId)).financial_status).toBe('reconciliation_required');
    expect((await db.query('SELECT user_id FROM conversations WHERE id=$1', [conversationId])).rows[0].user_id).toBe(other);
    expect(await messages(conversationId)).toHaveLength(0);
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 98, reserved: 2 });
  });

  it('keeps an old staged candidate without recovery input deferred instead of inventing history', async () => {
    await blockMessages(); const app = compose(); const requestId = randomUUID(); await app.send(requestId);
    const row = await operation(requestId);
    await db.query("UPDATE ai_operations SET fulfillment=fulfillment-'starterChatProjection' WHERE id=$1", [row.id]);
    await db.query('DROP TRIGGER reject_chat_messages ON messages'); await expire(row.id);
    expect((await recover(row.id)).outcomes[0]).toMatchObject({ action: 'deferred', reason: 'chat_projection_unavailable' });
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 98, reserved: 2 });
    expect(app.provider).toHaveBeenCalledTimes(1);
    expect(await messages(row.fulfillment.starterChatProjection.conversationId)).toHaveLength(0);
  }, 30000);

  it('rolls back a failing custom writer without default fallback; CLI does not substitute an unregistered hook', async () => {
    const custom = vi.fn(async () => { throw new Error('custom writer fixture failure'); });
    const aiProduct = createAiProduct({ env: { AI_PROVIDER: 'mock' }, persistResult: custom });
    const app = compose({ aiProduct }); const requestId = randomUUID(); await app.send(requestId);
    const row = await operation(requestId);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(row.financial_status).toBe('reconciliation_required');
    expect(await messages(row.fulfillment.starterChatProjection.conversationId)).toHaveLength(0);
    expect((await db.query('SELECT assistant_text FROM credit_usage_requests WHERE id=$1', [row.ledger_request_id])).rows[0].assistant_text).toBeNull();
    await expire(row.id);
    expect((await recover(row.id)).outcomes[0]).toMatchObject({ action: 'deferred', reason: 'chat_writer_unavailable' });
    expect(custom).toHaveBeenCalledTimes(1); expect(app.provider).toHaveBeenCalledTimes(1);
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 98, reserved: 2 });
  }, 30000);

  it.each(['missing', 'unknown_version', 'custom_writer'])('preserves the original expired waiver for $0 and keeps projection review visible', async (kind) => {
    await blockMessages();
    const custom = vi.fn(async () => { throw new Error('Unavailable custom fixture'); });
    const app = compose({ aiProduct: shortLivedProduct(kind === 'custom_writer' ? { persistResult: custom } : {}) });
    const requestId = randomUUID(); await app.send(requestId); const row = await operation(requestId);
    if (kind === 'missing') await db.query("UPDATE ai_operations SET fulfillment=fulfillment-'starterChatProjection' WHERE id=$1", [row.id]);
    if (kind === 'unknown_version') await db.query("UPDATE ai_operations SET fulfillment=jsonb_set(fulfillment,'{starterChatProjection,version}','999') WHERE id=$1", [row.id]);
    await db.query('DROP TRIGGER reject_chat_messages ON messages'); await expire(row.id);
    const result = await recover(row.id);
    expect(result.outcomes[0]).toMatchObject({ action: 'released', reason: 'consumer_protection_waiver' });
    expect(result.projectionReviews).toEqual([expect.objectContaining({ operationId: row.id, financialStatus: 'released',
      projection: expect.objectContaining({ status: 'deferred', manualReview: true }) })]);
    const repeated = await recover(row.id);
    expect(repeated.outcomes).toHaveLength(0); expect(repeated.projectionReviews).toEqual(result.projectionReviews);
    const persisted = await operation(requestId);
    expect(persisted.fulfillment_status).toBe('ready');
    expect(persisted.quote).toEqual(row.quote); expect(persisted.recovery_deadline_at).toEqual(row.recovery_deadline_at);
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 100, reserved: 0 });
    expect(await messages(row.fulfillment.starterChatProjection.conversationId)).toHaveLength(0);
    const replay = await app.send(requestId); expect(replay.status).toHaveBeenCalledWith(409);
    expect(replay.events.join('')).not.toContain('event: done'); expect(app.provider).toHaveBeenCalledTimes(1);
    expect(custom).not.toHaveBeenCalled();
  }, 30000);

  it('keeps valid expired default projections on the original no-charge settlement path', async () => {
    await blockMessages(); const app = compose({ aiProduct: shortLivedProduct() }); const requestId = randomUUID(); await app.send(requestId);
    const row = await operation(requestId); await db.query('DROP TRIGGER reject_chat_messages ON messages'); await expire(row.id);
    const result = await recover(row.id);
    expect(result.outcomes[0]).toMatchObject({ action: 'no_charge', reason: 'consumer_protection_waiver' });
    expect(result.projectionReviews).toHaveLength(0);
    expect(await messages(row.fulfillment.starterChatProjection.conversationId)).toHaveLength(2);
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 100, reserved: 0 });
    expect((await app.send(requestId)).events.join('')).toContain('"replayed":true');
    expect(app.provider).toHaveBeenCalledTimes(1);
  }, 30000);

  it('uses one transaction connection and lock order for the expired recovery adapter, without nested BEGIN', async () => {
    await blockMessages(); const app = compose({ aiProduct: shortLivedProduct() }); const requestId = randomUUID(); await app.send(requestId);
    const row = await operation(requestId);
    await db.query("UPDATE ai_operations SET fulfillment=fulfillment-'starterChatProjection' WHERE id=$1", [row.id]);
    await db.query('DROP TRIGGER reject_chat_messages ON messages'); await expire(row.id);
    const claimed = await createOperationRecoveryStore({ db }).claim({ operationId: row.id });
    const sqlCalls = []; let connections = 0;
    const tracked = { query: db.query.bind(db), connect: async () => {
      connections++; const tx = await db.connect();
      return { release: (error) => tx.release(error), query: async (sql, values) => {
        sqlCalls.push(sql); const result = await tx.query(sql, values);
        if (sql === 'BEGIN') await tx.query("SET LOCAL statement_timeout='2000ms'");
        return result;
      } };
    } };
    const result = await createChatRecoverySettlementStore({ db: tracked }).apply({ operationId: row.id, accountId: userId,
      expectedEpoch: claimed.executionEpoch, fulfillment: claimed.fulfillment,
      decision: { action: 'settle', credits: 0, reason: 'consumer_protection_waiver' }, persistResult: persistRecoveredChatResult });
    expect(result.status).toBe('released'); expect(connections).toBe(1);
    expect(sqlCalls.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    expect(sqlCalls.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(sqlCalls.findIndex((sql) => sql.includes('INSERT INTO credit_accounts')))
      .toBeLessThan(sqlCalls.findIndex((sql) => sql.includes('SELECT id FROM ai_operations')));
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 100, reserved: 0 });
  }, 10000);

  it('does not trust a caller waiver reason, fake expiry timestamp or zero recovery epoch', async () => {
    await blockMessages(); const app = compose(); const requestId = randomUUID(); await app.send(requestId);
    const row = await operation(requestId);
    await db.query("UPDATE ai_operations SET fulfillment=fulfillment-'starterChatProjection' WHERE id=$1", [row.id]);
    await db.query('DROP TRIGGER reject_chat_messages ON messages'); await expire(row.id);
    const claimed = await createOperationRecoveryStore({ db }).claim({ operationId: row.id });
    const adapter = createChatRecoverySettlementStore({ db });
    const facts = { operationId: row.id, accountId: userId, expectedEpoch: claimed.executionEpoch, fulfillment: claimed.fulfillment,
      operation: { recoveryExpired: true, recoveryDeadlineAt: '2000-01-01' },
      decision: { action: 'settle', credits: 0, reason: 'consumer_protection_waiver' }, persistResult: persistRecoveredChatResult };
    await expect(adapter.apply(facts)).rejects.toMatchObject({ code: 'chat_waiver_unavailable' });
    await expect(adapter.apply({ ...facts, expectedEpoch: 0 })).rejects.toMatchObject({ code: 'recovery_lease_required' });
    expect((await operation(requestId)).financial_status).toBe('reconciliation_required');
    expect(await getCreditBalance({ db, userId })).toMatchObject({ available: 98, reserved: 2 });
    expect(app.provider).toHaveBeenCalledTimes(1);
  });
});
