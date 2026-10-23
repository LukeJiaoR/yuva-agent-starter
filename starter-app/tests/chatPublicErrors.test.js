import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatStreamRoutes } from '../server/routes/chatStream.routes.js';
import { createDatabasePool } from '../server/db/index.js';
import { createAiProduct } from '../server/domain/aiProduct.js';
import { publicChatError, toPublicError } from '../server/http/errors.js';

const marker = 'SYNTHETIC_PRIVATE_DATABASE_PROVIDER_DETAIL';
const user = { id: '11111111-1111-4111-8111-111111111111' };
const env = { AI_PROVIDER: 'mock', NODE_ENV: 'test' };
function error(code, status = 503) {
  return Object.assign(new Error(marker), { code, status, retryable: true, publicMessage: marker, privateBody: marker });
}
afterEach(() => vi.restoreAllMocks());
function fixture(phase, injected = error('provider_unavailable')) {
  const logs = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
  const product = createAiProduct({ env });
  const operation = { id: '22222222-2222-4222-8222-222222222222', accountId: user.id,
    createdAt: new Date(), taskType: 'text', quote: product.policy.quote({ taskType: 'text', mode: 'stream' }, product.executionLimits) };
  const db = { query: vi.fn(async sql => {
    if (sql.includes('AS forbidden')) return { rows: [{ forbidden: false, unordered: phase === 'legacy_order' }] };
    if (phase === 'history' && sql.includes('FROM messages')) throw injected;
    return { rows: [] };
  }) };
  const operationStore = { find: vi.fn(async () => { if (phase === 'find') throw injected;
    if (phase === 'released') return { financialStatus: 'released' }; return null; }) };
  const billing = {
    reserve: vi.fn(async () => { if (phase === 'reserve') throw injected;
      return { kind: 'reserved', operation, request: { id: 'fixture', attempt_no: 1 } }; }),
    settle: vi.fn(async () => { if (phase === 'settle') throw injected; return { status: 'settled', creditsUsed: 2 }; }),
    onFailure: vi.fn(async () => { if (phase === 'reconcile') throw injected; return { status: 'released' }; }),
  };
  product.createBilling = () => billing;
  const provider = vi.fn(async ({ onText }) => { if (['provider', 'reconcile'].includes(phase)) throw injected;
    await onText('Approved answer'); return {}; });
  const router = createChatStreamRoutes({ db, product, operationStore,
    usageStore: { start: async () => {}, observe: async () => {} },
    adapter: { domainKey: 'fixture', computeFacts: async () => { if (phase === 'prepare') throw injected; return {}; },
      createSnapshot: () => ({ facts: {} }), buildContext: () => ({}) }, callAIStream: provider, env });
  const handler = router.stack.find(layer => layer.route?.path === '/api/chat/stream').route.stack[0].handle;
  const res = { statusCode: 200, headersSent: false, writableEnded: false, events: [],
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; this.headersSent = true; return this; },
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    write(frame) { this.events.push(JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6))); },
    end() { this.writableEnded = true; } };
  return { res, provider, billing, logs, send: () => handler({ user, body: { requestId: 'error-fixture', question: 'Question' } }, res, vi.fn()) };
}

describe('shared safe HTTP and SSE error boundary', () => {
  it.each(['find', 'prepare', 'reserve', 'provider', 'settle', 'reconcile', 'history'])
    ('redacts private exception fields and public logs from %s failures', async phase => {
      const f = fixture(phase); await f.send();
      const body = f.res.body ?? f.res.events.at(-1)?.data;
      expect(body.code).toBe(phase === 'history' ? 'conversation_history_unavailable' : 'provider_unavailable');
      expect(body.retryable).toBe(true);
      expect(body.financial_status).toBe(['provider', 'settle'].includes(phase) ? 'released'
        : phase === 'reconcile' ? 'reconciliation_required' : 'unreserved');
      expect(JSON.stringify([f.res.body, f.res.events, ...f.logs.map(log => log.mock.calls)])).not.toContain(marker);
      if (['provider', 'settle', 'reconcile'].includes(phase)) {
        expect(f.res.events.at(-1).type).toBe('error');
        expect(f.res.events.filter(event => event.type === 'error')).toHaveLength(1);
        expect(f.res.events.some(event => event.type === 'done')).toBe(false);
      } else { expect(f.res.statusCode).toBe(503); expect(f.provider).not.toHaveBeenCalled(); }
    });
  it('redacts the original unclassified preflight failure regression', async () => {
    const f = fixture('find', new Error(marker)); await f.send();
    expect(f.res.statusCode).toBe(500);
    expect(f.res.body).toMatchObject({ code: 'runtime_error', retryable: false, financial_status: 'unreserved' });
    expect(JSON.stringify([f.res.body, ...f.logs.map(log => log.mock.calls)])).not.toContain(marker);
  });
  it('does not log raw database pool failures', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = createDatabasePool({ databaseUrl: 'postgresql://fixture@localhost/fixture' });
    pool.emit('error', error(marker));
    expect(logged).toHaveBeenCalled(); expect(JSON.stringify(logged.mock.calls)).not.toContain(marker);
    await pool.end();
  });
  it('retains idempotency status/code without copying a handled runtime message', async () => {
    const f = fixture('find', error('idempotency_conflict', 409)); await f.send();
    expect(f.res.statusCode).toBe(409);
    expect(f.res.body).toMatchObject({ error: 'idempotency_conflict', code: 'idempotency_conflict', financial_status: 'unreserved' });
    expect(JSON.stringify(f.res.body)).not.toContain(marker);
  });
  it('returns the trusted released status on durable terminal rejection', async () => {
    const f = fixture('released'); await f.send();
    expect(f.res.statusCode).toBe(409);
    expect(f.res.body).toMatchObject({ code: 'request_released', financial_status: 'released' });
    expect(f.billing.reserve).not.toHaveBeenCalled();
  });
  it('preserves unknown-order history and clearly requires a new conversation before charging', async () => {
    const f = fixture('legacy_order'); await f.send();
    expect(f.res.statusCode).toBe(409);
    expect(f.res.body).toMatchObject({ code: 'conversation_history_order_unavailable', financial_status: 'unreserved' });
    expect(f.res.body.message).toMatch(/Start a new conversation/);
    expect(f.billing.reserve).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });
  it.each(['provider_' + marker.toLowerCase(), 'runtime_' + marker.toLowerCase(), marker])
    ('does not regard an arbitrary code or publicMessage as trusted: %s', code => {
      expect(JSON.stringify(toPublicError(error(code)))).not.toContain(marker.toLowerCase());
      expect(JSON.stringify(publicChatError(error(code)))).not.toContain(marker);
      expect(toPublicError(error(code))).toMatchObject({ status: 503, code: 'internal_server_error' });
    });
});


describe('provider adapter public compatibility', () => {
  it.each([['provider_http_error', 429, 429], ['provider_connection_error', undefined, 503]])(
    'preserves fixed local %s code and safe status', (code, status, expectedStatus) => {
      const result = publicChatError(Object.assign(new Error(marker), { code, status, retryable: true }));
      expect(result.status).toBe(expectedStatus);
      expect(result.body).toMatchObject({ code, error: code, retryable: true });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(result.body.message).toContain('provider');
    });
});

it.each(['execution_input_exceeded', 'execution_output_exceeded', 'execution_media_exceeded',
  'execution_model_forbidden', 'execution_call_active', 'execution_capability_unsupported',
  'execution_output_policy_unsupported', 'execution_limits_invalid', 'execution_or_delivery_unknown'])(
  'preserves the bounded execution contract code %s without private detail', (code) => {
    const result = publicChatError(error(code, 409));
    expect(result).toMatchObject({ status: 409, body: { code, error: code } });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
