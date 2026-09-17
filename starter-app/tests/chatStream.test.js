import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer } from '../server/index.js';

function getRouteHandler(app, method, path) {
  for (const layer of app._router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack[0].handle;
    }
    if (layer.name === 'router' && layer.handle?.stack) {
      for (const subLayer of layer.handle.stack) {
        if (subLayer.route && subLayer.route.path === path && subLayer.route.methods[method.toLowerCase()]) {
          return subLayer.route.stack[0].handle;
        }
      }
    }
  }
  return null;
}

function mockResponse() {
  const events = [];
  return {
    events,
    setHeader: vi.fn(),
    write: vi.fn((data) => events.push(data)),
    end: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    headersSent: false,
    writableEnded: false,
  };
}

import { randomUUID } from 'node:crypto';
import { isolatedDatabase } from './helpers/database.js';
import { grantCredits, reserveFeatureCredits, settleFeatureCredits } from '@yuva/billing-core';
import { createUsageStore } from '../server/stores/usageStore.js';

describe('Chat runtime with durable operations and usage (real PostgreSQL)', () => {
  let db, close, userId;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    userId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [userId]);
    await grantCredits({ db, userId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
  });
  function route(callAIStream, extra = {}) {
    return getRouteHandler(createServer({ db, callAIStream, ...extra }), 'POST', '/api/chat/stream');
  }
  async function send(handler, body = {}, user = { id: userId }) {
    const res = mockResponse();
    await handler({ user, body: { question: 'Hello', requestId: randomUUID(), ...body } }, res, vi.fn());
    return res;
  }
  const facts = (requestId) => db.query(`SELECT c.* FROM ai_provider_calls c JOIN ai_operations o ON o.id=c.operation_id
    WHERE o.account_id=$1 AND o.client_request_id=$2`, [userId, requestId]);
  it('persists before external execution and records actual zero and returned model before settling 2 credits', async () => {
    const provider = vi.fn(async ({ onText, callId }) => {
      expect((await db.query('SELECT outcome FROM ai_provider_calls WHERE id=$1', [callId])).rows[0].outcome).toBe('started');
      await onText('Durable response');
      return { model: 'actual-model', modelIdentitySource: 'provider_response', requestId: 'upstream-1',
        usage: { source: 'provider', inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    });
    const response = await send(route(provider), { requestId: 'metered' });
    expect(response.events.join('')).toContain('event: done');
    const call = (await facts('metered')).rows[0];
    expect(call.metrics.outputTokens).toEqual({ value: 0, unit: 'token', source: 'provider' });
    expect(call.observed_model).toBe('actual-model');
    expect(call.provider_request_id).toBe('upstream-1');
    const { rows: [ledger] } = await db.query('SELECT * FROM credit_usage_requests WHERE user_id=$1', [userId]);
    expect(ledger.settled_credits).toBe(2);
    expect(ledger.billable_tokens).toBe(0);
  });
  it('keeps missing usage unknown, including the legacy display column', async () => {
    const response = await send(route(async ({ onText }) => { await onText('No usage in response'); return {}; }), { requestId: 'missing' });
    expect(response.events.join('')).toContain('event: done');
    expect((await facts('missing')).rows[0].metrics.inputTokens.value).toBeNull();
    expect((await db.query('SELECT billable_tokens FROM credit_usage_requests WHERE user_id=$1', [userId])).rows[0].billable_tokens).toBeNull();
  });
  it('ignores client-supplied prices and policy selection', async () => {
    const response = await send(route(async ({ onText }) => { await onText('Trusted price'); return {}; }),
      { credits: 0, policyId: 'free', policyVersion: '99', quote: { terms: { credits: 0 } } });
    expect(response.events.join('')).toContain('event: done');
    expect((await db.query('SELECT settled_credits FROM credit_usage_requests WHERE user_id=$1', [userId])).rows[0].settled_credits).toBe(2);
  });
  it('passes frozen output caps to the default provider boundary', async () => {
    const provider = vi.fn(async ({ onText, options, signal }) => {
      expect(options.maxOutputTokens).toBe(1024);
      expect(options.maxOutputTokensCap).toBe(1024);
      expect(signal).toBeInstanceOf(AbortSignal);
      await onText('Bounded result'); return {};
    });
    const response = await send(route(provider));
    expect(response.events.join('')).toContain('event: done');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('runs the same route under explicit token configuration with scoped pricing and replay', async () => {
    await grantCredits({ db, userId, credits: 100, creditType: 'purchased', idempotencyKey: randomUUID() });
    const provider = vi.fn(async ({ onText }) => { await onText('Token product result');
      return { usage: { source: 'provider', inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 } }; });
    const handler = route(provider, { config: { env: { PRICING_STRATEGY: 'token' } } });
    const first = await send(handler, { requestId: 'token-product' });
    expect(first.events.join('')).toContain('"strategy":"token"');
    expect(first.events.join('')).toContain('"reserveCredits":27');
    expect(first.events.join('')).toContain('"credits_used":4');
    const replay = await send(handler, { requestId: 'token-product' });
    expect(replay.events.join('')).toContain('"credits_used":4');
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await db.query('SELECT settled_credits FROM credit_usage_requests WHERE user_id=$1', [userId])).rows[0].settled_credits).toBe(4);
  });
  it('stores failures and partial facts with unknown external outcome for reconciliation', async () => {
    const provider = vi.fn(async ({ onText }) => {
      await onText('Partial unsafe output');
      throw Object.assign(new Error('overloaded'), { code: 'provider_overloaded', providerResult: {
        requestId: 'partial-1', usage: { inputTokens: 5, outputTokens: null, source: 'provider' } } });
    });
    const response = await send(route(provider), { requestId: 'failed' });
    expect(response.events.join('')).toContain('provider_overloaded');
    expect(response.events.join('')).not.toContain('event: done');
    expect(response.events.join('')).not.toContain('Partial unsafe');
    const call = (await facts('failed')).rows[0];
    expect(call.outcome).toBe('failed');
    expect(call.metrics.inputTokens.value).toBe(5);
    expect((await db.query('SELECT financial_status FROM ai_operations WHERE account_id=$1', [userId])).rows[0].financial_status).toBe('reconciliation_required');
    expect((await db.query('SELECT status FROM credit_usage_requests WHERE user_id=$1', [userId])).rows[0].status).toBe('generating');
  });
  it('does not call the provider when the durable start write fails', async () => {
    const provider = vi.fn();
    const usageStore = { start: async () => { throw new Error('offline'); } };
    const response = await send(route(provider, { usageStore }));
    expect(response.events.join('')).toContain('event: error');
    expect(provider).not.toHaveBeenCalled();
  });
  it('retains recoverable started identity when the observation write fails', async () => {
    const store = createUsageStore({ db });
    const provider = vi.fn(async ({ onText }) => { await onText('Ready but not recorded'); return {}; });
    const response = await send(route(provider, { usageStore: { ...store, observe: async () => { throw new Error('offline'); } } }), { requestId: 'write-failure' });
    expect(response.events.join('')).not.toContain('event: done');
    expect((await facts('write-failure')).rows[0].outcome).toBe('started');
  });
  it('returns 202 during a concurrent operation, replays settled output, and rejects changed input', async () => {
    let finish, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { finish = resolve; });
    const provider = vi.fn(async ({ onText }) => { entered(); await waiting; await onText('Canonical response'); return {}; });
    const handler = route(provider);
    const first = send(handler, { requestId: 'same' });
    await started;
    const pending = await send(handler, { requestId: 'same' });
    expect(pending.status).toHaveBeenCalledWith(202);
    finish(); await first;
    expect((await send(handler, { requestId: 'same' })).events.join('')).toContain('"replayed":true');
    const conflict = await send(handler, { requestId: 'same', question: 'Different' });
    expect(conflict.status).toHaveBeenCalledWith(409);
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await facts('same')).rows).toHaveLength(1);
  });
  it('keeps legacy settled replay compatible without inventing a quote or call', async () => {
    const reserved = await reserveFeatureCredits({ db, userId, featureKey: 'deep_reasoning', clientRequestId: 'legacy', credits: 2 });
    await settleFeatureCredits({ db, userId, requestId: reserved.request.id, creditsUsed: 2,
      persistResult: (client) => client.query('UPDATE credit_usage_requests SET assistant_text=$2 WHERE id=$1', [reserved.request.id, 'Legacy reply']) });
    const provider = vi.fn();
    const res = await send(route(provider), { requestId: 'legacy' });
    expect(res.events.join('')).toContain('Legacy reply');
    expect(provider).not.toHaveBeenCalled();
    expect((await facts('legacy')).rows).toHaveLength(0);
  });
  it('replays the durable result after post-settlement SSE failure without invoking the model again', async () => {
    const provider = vi.fn(async ({ onText }) => { await onText('Saved despite disconnect'); return {}; });
    const handler = route(provider), res = mockResponse();
    res.write = vi.fn((data) => { if (data.includes('text_delta')) throw new Error('socket failed'); res.events.push(data); });
    await handler({ user: { id: userId }, body: { question: 'Hello', requestId: 'disconnect' } }, res, vi.fn());
    expect((await db.query('SELECT financial_status FROM ai_operations WHERE account_id=$1', [userId])).rows[0].financial_status).toBe('settled');
    const replay = await send(handler, { requestId: 'disconnect' });
    expect(replay.events.join('')).toContain('Saved despite disconnect');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('isolates conversation history across accounts and concurrent request streams', async () => {
    const otherId = randomUUID(), conversationId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [otherId]);
    await db.query('INSERT INTO conversations(id,user_id,domain_key) VALUES($1,$2,$3)', [conversationId, otherId, 'test']);
    await db.query("INSERT INTO messages(conversation_id,role,content) VALUES($1,'user','Private secret')", [conversationId]);
    const provider = vi.fn(async ({ messages, onText }) => { expect(JSON.stringify(messages)).not.toContain('Private secret'); await onText(messages.at(-1).content); return {}; });
    const handler = route(provider);
    const [a, b] = await Promise.all([send(handler, { question: 'Question A', conversationId }), send(handler, { question: 'Question B' })]);
    expect(a.events.join('')).toContain('Question A');
    expect(a.events.join('')).not.toContain('Question B');
    expect(b.events.join('')).toContain('Question B');
  });
  it('rejects unauthenticated and insufficient-credit requests before external calls', async () => {
    const provider = vi.fn();
    const handler = route(provider, { config: { env: { NODE_ENV: 'production', ALLOW_DEV_GUEST: 'false' } } });
    expect((await send(handler, {}, null)).status).toHaveBeenCalledWith(401);
    await db.query('UPDATE credit_accounts SET available_credits=0 WHERE user_id=$1', [userId]);
    expect((await send(handler)).status).toHaveBeenCalledWith(402);
    expect(provider).not.toHaveBeenCalled();
  });
});
