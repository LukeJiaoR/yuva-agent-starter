import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStreamRoutes } from '../server/routes/chatStream.routes.js';

const user = { id: '00000000-0000-4000-8000-000000000001' };
const conversationId = '00000000-0000-4000-8000-000000000002';
const rawFailure = 'fixture SQL failure password=fixture-only postgresql://fixture.invalid/private';
let logged;
beforeEach(() => { logged = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

function setup({ history = [], failHistory = false, existing = null } = {}) {
  const db = { query: vi.fn(async (sql) => {
    if (sql.includes('AS forbidden')) return { rows: [{ forbidden: false }] };
    if (sql.includes('FROM messages')) {
      if (failHistory) throw new Error(rawFailure);
      return { rows: history };
    }
    if (sql.includes('FROM credit_usage_requests')) return { rows: [] };
    throw new Error('Unexpected fixture SQL');
  }) };
  const operationStore = { find: vi.fn().mockResolvedValue(existing), reserve: vi.fn().mockResolvedValue({
    kind: 'insufficient', balance: { available: 0 },
  }) };
  const callAIStream = vi.fn();
  const adapter = { domainKey: 'fixture', computeFacts: vi.fn().mockResolvedValue({}),
    createSnapshot: vi.fn().mockReturnValue({ facts: {} }), buildContext: vi.fn().mockReturnValue({}) };
  const router = createChatStreamRoutes({ db, adapter, callAIStream, operationStore, usageStore: {}, env: { AI_PROVIDER: 'mock', NODE_ENV: 'test' } });
  const handler = router.stack.find((layer) => layer.route?.path === '/api/chat/stream').route.stack[0].handle;
  const response = { events: [], status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(),
    write: vi.fn(function (event) { this.events.push(event); }), end: vi.fn(), headersSent: false, writableEnded: false };
  const send = () => handler({ user, body: { question: 'Hello', requestId: 'history-fixture', conversationId } }, response, vi.fn());
  return { db, operationStore, callAIStream, adapter, response, send, restoreHistory: () => { failHistory = false; } };
}

describe('conversation history read failure is not empty history', () => {
  it('returns a fixed retryable failure before any reservation or provider call, without raw database details', async () => {
    const fixture = setup({ failHistory: true });
    await fixture.send();
    expect(fixture.response.status).toHaveBeenCalledWith(503);
    expect(fixture.response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'conversation_history_unavailable', error: 'Conversation history is temporarily unavailable. Please try again.',
    }));
    expect(fixture.operationStore.reserve).not.toHaveBeenCalled();
    expect(fixture.callAIStream).not.toHaveBeenCalled();
    expect(fixture.adapter.computeFacts).not.toHaveBeenCalled();
    expect(fixture.response.write).not.toHaveBeenCalled();
    const exposed = JSON.stringify([fixture.response.json.mock.calls, logged.mock.calls]);
    expect(exposed).not.toContain(rawFailure);
    expect(exposed).not.toMatch(/fixture-only|fixture\.invalid|password=/);
  });

  it('allows the same request to retry normally once history storage recovers', async () => {
    const fixture = setup({ failHistory: true });
    await fixture.send();
    expect(fixture.operationStore.reserve).not.toHaveBeenCalled();
    fixture.restoreHistory();
    await fixture.send();
    expect(fixture.response.status.mock.calls.map(([status]) => status)).toEqual([503, 402]);
    expect(fixture.operationStore.reserve).toHaveBeenCalledTimes(1);
    expect(fixture.operationStore.reserve.mock.calls[0][0].operation.clientRequestId).toBe('history-fixture');
    expect(fixture.callAIStream).not.toHaveBeenCalled();
  });

  it.each([{ history: [] }, { history: [{ role: 'assistant', content: 'newer' }, { role: 'user', content: 'older' }] }])(
    'continues successful history reads through the existing credit gate', async ({ history }) => {
      const fixture = setup({ history });
      await fixture.send();
      expect(fixture.response.status).toHaveBeenCalledWith(402);
      expect(fixture.operationStore.reserve).toHaveBeenCalledTimes(1);
      expect(fixture.callAIStream).not.toHaveBeenCalled();
      expect(fixture.adapter.buildContext).toHaveBeenCalledWith({}, history.slice().reverse(), 'Hello');
      const [sql, params] = fixture.db.query.mock.calls.find(([sql]) => sql.includes('FROM messages'));
      expect(sql).toContain('c.user_id = $2'); expect(sql).toContain('LIMIT 20');
      expect(params).toEqual([conversationId, user.id]);
    },
  );

  it('replays an already settled durable result without querying failed history or creating a new reservation', async () => {
    const fixture = setup({ failHistory: true, existing: { financialStatus: 'settled', clientRequestId: 'history-fixture',
      quote: { policyId: 'fixed', policyVersion: '1', unit: 'credit', reserveCredits: 2, authorizedCredits: 2,
        terms: { credits: 2 }, missingUsage: 'ignore' }, decision: { credits: 2 },
      fulfillment: { status: 'ready', artifacts: [{ type: 'text', text: 'Already settled fixture' }] } } });
    await fixture.send();
    expect(fixture.response.events.join('')).toContain('Already settled fixture');
    expect(fixture.response.events.join('')).toContain('"replayed":true');
    expect(fixture.db.query).not.toHaveBeenCalled();
    expect(fixture.operationStore.reserve).not.toHaveBeenCalled();
    expect(fixture.callAIStream).not.toHaveBeenCalled();
  });
});
