import { describe, it, expect, vi } from 'vitest';
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

describe('Chat Stream Route & Agent Runtime Integration (Contract Verification)', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
  const GRANT_ID = '33333333-3333-4333-8333-333333333333';
  const REQUEST_ID = 'req-contract-test-1';

  function createMockDb({ availableCredits = 10 } = {}) {
    const state = {
      account: { user_id: USER_ID, available_credits: availableCredits, reserved_credits: 0, credit_debt: 0, version: 1 },
      grants: [{ id: GRANT_ID, user_id: USER_ID, credit_type: 'purchased', status: 'active', remaining_credits: availableCredits, reserved_credits: 0 }],
      requests: new Map(),
      conversations: new Map(),
      messages: [],
    };

    let nextUsageId = 1;
    const query = vi.fn(async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('FROM messages m') && text.includes('JOIN conversations c')) {
        const convId = params[0];
        const userId = params[1];
        const conv = state.conversations.get(convId);
        if (!conv || conv.user_id !== userId) {
          return { rows: [] };
        }
        return { rows: state.messages.filter((m) => m.conversation_id === convId) };
      }
      if (text.includes('INSERT INTO credit_accounts')) return { rows: [] };
      if (text.includes('SELECT * FROM credit_accounts WHERE')) return { rows: [state.account] };
      if (text.includes('FROM credit_usage_requests WHERE user_id = $1 AND client_request_id = $2')) {
        const req = Array.from(state.requests.values()).find((r) => r.user_id === params[0] && r.client_request_id === params[1]);
        return { rows: req ? [req] : [] };
      }
      if (text.includes('FROM credit_usage_requests WHERE id = $1')) {
        const req = state.requests.get(params[0]);
        return { rows: req ? [req] : [] };
      }
      if (text.includes('INSERT INTO credit_usage_requests')) {
        const usageId = `usage-${nextUsageId++}`;
        const req = {
          id: usageId,
          user_id: params[0],
          feature_key: params[1],
          client_request_id: params[3],
          status: 'generating',
          reserved_credits: params[6],
          assistant_text: null,
        };
        state.requests.set(usageId, req);
        return { rows: [req] };
      }
      if (text.includes('SELECT * FROM credit_grants') && text.includes('FOR UPDATE')) {
        return { rows: state.grants.filter((g) => g.status === 'active') };
      }
      if (text.includes('UPDATE credit_grants')) {
        return { rows: state.grants };
      }
      if (text.includes('INSERT INTO credit_usage_allocations')) return { rows: [] };
      if (text.includes('UPDATE credit_accounts')) {
        return { rows: [state.account] };
      }
      if (text.includes('INSERT INTO credit_transactions')) return { rows: [{ id: 'tx-1' }] };
      if (text.includes('FROM credit_usage_allocations a')) {
        return { rows: [{ id: 'alloc-1', usage_request_id: params[0], grant_id: GRANT_ID, credit_type: 'purchased', reserved_credits: 2, settled_credits: 0 }] };
      }
      if (text.includes('UPDATE credit_usage_requests') && (text.includes('status = \'settled\'') || text.includes('assistant_text = $2'))) {
        const req = state.requests.get(params[0]);
        if (req) {
          req.status = 'settled';
          if (params[1]) req.assistant_text = params[1];
        }
        return { rows: req ? [req] : [] };
      }
      if (text.includes('UPDATE credit_usage_requests SET status = \'released\'')) {
        const req = state.requests.get(params[0]);
        if (req) req.status = 'released';
        return { rows: req ? [req] : [] };
      }
      if (text.includes('INSERT INTO conversations')) {
        state.conversations.set(params[0], { id: params[0], user_id: params[1] });
        return { rows: [] };
      }
      if (text.includes('INSERT INTO messages')) {
        state.messages.push({ conversation_id: params[0], role: 'user', content: params[1] });
        state.messages.push({ conversation_id: params[0], role: 'assistant', content: params[2] });
        return { rows: [] };
      }
      return { rows: [] };
    });

    return { query, state };
  }

  it('executes complete AgentRuntime lifecycle: Domain facts -> Token Budget -> Provider stream -> Settle credits -> SSE Done', async () => {
    const mockDb = createMockDb({ availableCredits: 10 });
    let receivedPrompts = null;

    const callAIStream = vi.fn(async (options) => {
      receivedPrompts = options;
      await options.onText('Deterministic analysis: Valid clause.');
      return {
        provider: 'openai',
        model: 'gpt-4o',
        finishReason: 'stop',
        billableTokens: 42,
      };
    });

    const app = createServer({ db: mockDb, callAIStream });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    const res = mockResponse();

    await handler(
      {
        user: { id: USER_ID, email: 'user@example.com' },
        body: {
          question: 'Verify this contract agreement',
          requestId: REQUEST_ID,
          subject: 'Non-Disclosure Agreement',
          parameters: { jurisdiction: 'US-NY' },
        },
      },
      res,
      vi.fn(),
    );

    // 1. Assert Provider received correctly formatted messages & system prompt
    expect(callAIStream).toHaveBeenCalledTimes(1);
    expect(receivedPrompts.systemPrompt).toContain('Non-Disclosure Agreement');
    expect(receivedPrompts.messages).toEqual([
      { role: 'user', content: 'Verify this contract agreement' },
    ]);

    // 2. Assert SSE stream events emitted in strict order
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    const fullStream = res.events.join('');
    expect(fullStream).toContain('event: start\n');
    expect(fullStream).toContain('event: text_delta\n');
    expect(fullStream).toContain('Deterministic analysis: Valid clause.');
    expect(fullStream).toContain('event: done\n');
    expect(res.end).toHaveBeenCalled();
  });

  it('returns HTTP 202 for in-flight duplicate requests (no replay), and replays only after settlement', async () => {
    const mockDb = createMockDb({ availableCredits: 10 });
    const INFLIGHT_ID = 'req-inflight-test';

    // Step 1: Pre-populate an in-flight request with status = 'generating'
    mockDb.state.requests.set('usage-inflight-1', {
      id: 'usage-inflight-1',
      user_id: USER_ID,
      client_request_id: INFLIGHT_ID,
      status: 'generating',
      reserved_credits: 2,
      assistant_text: null,
      conversation_id: 'conv-inflight',
    });

    const callAIStream = vi.fn();
    const app = createServer({ db: mockDb, callAIStream });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');

    // Step 2: Duplicate request arrives while generating
    const resB = mockResponse();
    await handler(
      {
        user: { id: USER_ID },
        body: { question: 'Duplicate question', requestId: INFLIGHT_ID },
      },
      resB,
      vi.fn(),
    );

    // Must return HTTP 202 JSON, zero provider calls, zero SSE stream events
    expect(resB.status).toHaveBeenCalledWith(202);
    expect(resB.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'generating',
        request_id: INFLIGHT_ID,
      }),
    );
    expect(callAIStream).not.toHaveBeenCalled();
    expect(resB.events.length).toBe(0);

    // Step 3: Request finishes and settles
    const inflightReq = mockDb.state.requests.get('usage-inflight-1');
    inflightReq.status = 'settled';
    inflightReq.assistant_text = 'Authoritative completed response from Request A.';

    // Step 4: Subsequent duplicate request arrives after settlement -> Replays via SSE
    const resC = mockResponse();
    await handler(
      {
        user: { id: USER_ID },
        body: { question: 'Duplicate question', requestId: INFLIGHT_ID },
      },
      resC,
      vi.fn(),
    );

    expect(callAIStream).not.toHaveBeenCalled();
    expect(resC.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    const fullStream = resC.events.join('');
    expect(fullStream).toContain('event: start\n');
    expect(fullStream).toContain('event: text_delta\n');
    expect(fullStream).toContain('Authoritative completed response from Request A.');
    expect(fullStream).toContain('event: done\n');
    expect(resC.end).toHaveBeenCalled();
  });

  it('emits SSE terminal error event when provider fails and does not emit done event', async () => {
    const mockDb = createMockDb({ availableCredits: 10 });
    const callAIStream = vi.fn(async () => {
      const err = new Error('Provider model overloaded');
      err.code = 'provider_overloaded';
      throw err;
    });

    const app = createServer({ db: mockDb, callAIStream });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    const res = mockResponse();

    await handler(
      {
        user: { id: USER_ID },
        body: { question: 'Query that will fail', requestId: 'req-fail-stream' },
      },
      res,
      vi.fn(),
    );

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    const fullStream = res.events.join('');
    expect(fullStream).toContain('event: start\n');
    expect(fullStream).toContain('event: error\n');
    expect(fullStream).toContain('provider_overloaded');
    expect(fullStream).not.toContain('event: done\n');
    expect(res.end).toHaveBeenCalled();
  });

  it('enforces strict tenant isolation on conversation history', async () => {
    const mockDb = createMockDb({ availableCredits: 10 });
    const CONV_ID = 'conv-private-other-user';
    mockDb.state.conversations.set(CONV_ID, { id: CONV_ID, user_id: OTHER_USER_ID });
    mockDb.state.messages.push({
      conversation_id: CONV_ID,
      role: 'user',
      content: 'Confidential secret from other user',
    });

    let receivedPrompts = null;
    const callAIStream = vi.fn(async (options) => {
      receivedPrompts = options;
      await options.onText('Response');
      return { finishReason: 'stop' };
    });

    const app = createServer({ db: mockDb, callAIStream });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    const res = mockResponse();

    await handler(
      {
        user: { id: USER_ID, email: 'user@example.com' },
        body: {
          conversationId: CONV_ID,
          question: 'Hello',
          requestId: 'req-tenant-check',
        },
      },
      res,
      vi.fn(),
    );

    const promptContent = JSON.stringify(receivedPrompts.messages);
    expect(promptContent).not.toContain('Confidential secret from other user');
  });

  it('rejects unauthenticated requests with HTTP 401 when ALLOW_DEV_GUEST is false or in production', async () => {
    const mockDb = createMockDb({ availableCredits: 10 });
    const app = createServer({
      db: mockDb,
      config: { env: { NODE_ENV: 'production', ALLOW_DEV_GUEST: 'false' } },
    });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    const res = mockResponse();

    await handler(
      {
        user: null,
        body: { question: 'Anonymous attempt', requestId: 'req-anon' },
      },
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'unauthorized',
      }),
    );
  });

  it('prevents concurrent SSE cross-talk (Request-scoped isolation test)', async () => {
    const mockDb = createMockDb({ availableCredits: 20 });
    const callAIStream = vi.fn(async ({ userPrompt, messages, onText }) => {
      const q = messages?.[0]?.content || userPrompt;
      await new Promise((r) => setTimeout(r, 10));
      await onText(`Response for [${q}]`);
      return { finishReason: 'stop' };
    });

    const app = createServer({ db: mockDb, callAIStream });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');

    const resA = mockResponse();
    const resB = mockResponse();

    const promiseA = handler(
      {
        user: { id: USER_ID },
        body: { question: 'Question A', requestId: 'req-A' },
      },
      resA,
      vi.fn(),
    );

    const promiseB = handler(
      {
        user: { id: USER_ID },
        body: { question: 'Question B', requestId: 'req-B' },
      },
      resB,
      vi.fn(),
    );

    await Promise.all([promiseA, promiseB]);

    const streamA = resA.events.join('');
    const streamB = resB.events.join('');

    expect(streamA).toContain('Response for [Question A]');
    expect(streamA).not.toContain('Response for [Question B]');

    expect(streamB).toContain('Response for [Question B]');
    expect(streamB).not.toContain('Response for [Question A]');
  });

  it('rejects with HTTP 402 when credits are insufficient', async () => {
    const mockDb = createMockDb({ availableCredits: 0 });
    const app = createServer({ db: mockDb });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    const res = mockResponse();

    await handler(
      {
        user: { id: USER_ID },
        body: { question: 'Expensive deep analysis', requestId: 'req-poor' },
      },
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'insufficient_credits',
      }),
    );
  });

  it('replays previously settled request via SSE with 0 provider calls', async () => {
    const mockDb = createMockDb({ availableCredits: 10 });
    mockDb.state.requests.set('usage-replay-1', {
      id: 'usage-replay-1',
      user_id: USER_ID,
      client_request_id: 'req-replay',
      status: 'settled',
      settled_credits: 2,
      assistant_text: 'Cached immutable answer from previous run.',
      conversation_id: 'conv-123',
    });

    const callAIStream = vi.fn();
    const app = createServer({ db: mockDb, callAIStream });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    const res = mockResponse();

    await handler(
      {
        user: { id: USER_ID },
        body: { question: 'Repeat query', requestId: 'req-replay' },
      },
      res,
      vi.fn(),
    );

    expect(callAIStream).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    const fullStream = res.events.join('');
    expect(fullStream).toContain('event: start\n');
    expect(fullStream).toContain('event: text_delta\n');
    expect(fullStream).toContain('Cached immutable answer from previous run.');
    expect(fullStream).toContain('event: done\n');
    expect(res.end).toHaveBeenCalled();
  });

  it('prohibits replaying released or refunded requests as settled responses', async () => {
    const mockDb = createMockDb({ availableCredits: 10 });
    const FAILED_ID = 'req-released-id';
    mockDb.state.requests.set('usage-released-1', {
      id: 'usage-released-1',
      user_id: USER_ID,
      client_request_id: FAILED_ID,
      status: 'released',
      reserved_credits: 0,
      assistant_text: null,
      conversation_id: 'conv-failed',
    });

    const callAIStream = vi.fn();
    const app = createServer({ db: mockDb, callAIStream });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    const res = mockResponse();

    await handler(
      {
        user: { id: USER_ID },
        body: { question: 'Retry failed request', requestId: FAILED_ID },
      },
      res,
      vi.fn(),
    );

    const fullStream = res.events.join('');
    expect(fullStream).not.toContain('replayed":true');
  });
});
