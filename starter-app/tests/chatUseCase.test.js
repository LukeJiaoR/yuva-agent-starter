import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { createServer } from '../server/index.js';
import { createChatUseCase } from '../server/application/chatUseCase.js';
import { DomainKnowledgeAdapter } from '../server/domain/adapter.js';
import { createAiProduct } from '../server/domain/aiProduct.js';

const user = { id: '11111111-1111-4111-8111-111111111111' };
const request = { requestId: 'golden-chat', question: 'Summarize the synthetic material.',
  conversationId: '22222222-2222-4222-8222-222222222222', parameters: { material: 'Synthetic public material.' } };
const env = { NODE_ENV: 'test', AI_PROVIDER: 'mock' };
function normalize(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => key === 'expiresAt' ? '<expiry>' : item));
}
function response(order) {
  const res = new EventEmitter();
  return Object.assign(res, {
    headersSent: false, writableEnded: false, destroyed: false, statusCode: 200, headers: {}, events: [], body: null,
    status(status) { this.statusCode = status; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    flushHeaders() { this.headersSent = true; order.push('flush_headers'); },
    write(frame) {
      const event = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
      this.events.push(event); order.push('event:' + event.type);
    },
    json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this; },
    end() { this.writableEnded = true; },
  });
}
function fixture(mode = 'success', history = []) {
  const order = [], res = response(order);
  const product = createAiProduct({ env });
  const operation = { id: '33333333-3333-4333-8333-333333333333', accountId: user.id,
    clientRequestId: request.requestId, taskType: 'text', createdAt: new Date(),
    quote: product.policy.quote({ taskType: 'text', mode: 'stream', featureKey: product.featureKey }, product.executionLimits) };
  const operationStore = { async find() {
    order.push('lookup');
    return mode === 'replay' ? { ...operation, financialStatus: 'settled', decision: { credits: 2 },
      fulfillment: { status: 'ready', starterChatProjection: { conversationId: request.conversationId, text: 'Approved answer' } } } : null;
  } };
  const db = { async query(sql) {
    if (sql.includes('SELECT * FROM credit_usage_requests')) return { rows: [] };
    if (sql.includes('AS forbidden')) return { rows: [{ forbidden: false }] };
    if (sql.includes('SELECT m.role')) return { rows: history.slice().reverse() };
    throw new Error('Unexpected SQL in transport-only fixture');
  } };
  const usageStore = { async start() { order.push('usage_start'); }, async observe() { order.push('usage_observe'); } };
  product.createBilling = () => ({
    async reserve() { order.push('reserve'); return { kind: 'reserved', operation, request: { id: 'fixture-ledger', attempt_no: 1 } }; },
    async settle({ output }) { order.push('settle:' + output); return mode === 'pending'
      ? { status: 'reconciliation_required' } : { status: 'settled', creditsUsed: 2 }; },
    async onFailure({ error }) { order.push('failure:' + error.code); return { status: 'released' }; },
    async release() { order.push('release'); return { status: 'released' }; },
  });
  const callAIStream = async ({ onText, signal }) => {
    order.push('provider');
    if (mode === 'disconnect') {
      res.destroyed = true; res.emit('close');
      expect(signal.aborted).toBe(true);
      throw Object.assign(new Error('synthetic cancellation'), { code: 'provider_aborted' });
    }
    await onText('RAW answer');
    expect(res.events.some(event => event.type === 'text_delta')).toBe(false);
    return { usage: { source: 'provider', inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
  };
  const validateOutput = () => { order.push('validate'); return { valid: mode !== 'unsafe', visibleText: 'Approved answer' }; };
  return { order, res, options: { db, aiProduct: product, operationStore, usageStore, callAIStream, validateOutput, config: { env } } };
}
async function runHttp(mode) {
  const f = fixture(mode);
  const app = createServer(f.options);
  const route = app._router.stack.flatMap(layer => layer.handle?.stack || []).find(layer => layer.route?.path === '/api/chat/stream');
  const req = Object.assign(new EventEmitter(), { user, body: mode === 'invalid' ? { ...request, question: '' } : request });
  await route.route.stack[0].handle(req, f.res, () => {});
  expect(req.listenerCount('aborted')).toBe(0); expect(f.res.listenerCount('close')).toBe(0);
  return normalize({ status: f.res.statusCode, headers: f.res.headers, events: f.res.events, body: f.res.body, order: f.order });
}

// Captured on the pre-extraction route. Storage/billing below are deterministic port
// fixtures; the existing live PostgreSQL suites remain the financial correctness gate.
const golden = {
  "success": {
    "status": 200,
    "headers": {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    },
    "events": [
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 0,
        "type": "start",
        "data": {
          "conversation_id": "22222222-2222-4222-8222-222222222222",
          "pricing": {
            "version": 1,
            "strategy": "fixed",
            "policyVersion": "1",
            "unit": "credit",
            "reserveCredits": 2,
            "authorizedCredits": 2,
            "credits": 2,
            "expiresAt": "<expiry>",
            "missingUsage": "defer"
          }
        }
      },
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 1,
        "type": "text_delta",
        "data": {
          "text": "Approved answer"
        }
      },
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 2,
        "type": "done",
        "data": {
          "delivery_status": "delivered",
          "stop_reason": "complete",
          "credits_used": 2,
          "financial_status": "settled"
        }
      }
    ],
    "body": null,
    "order": [
      "lookup",
      "reserve",
      "flush_headers",
      "event:start",
      "usage_start",
      "provider",
      "usage_observe",
      "validate",
      "settle:Approved answer",
      "event:text_delta",
      "event:done"
    ]
  },
  "replay": {
    "status": 200,
    "headers": {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    },
    "events": [
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 0,
        "type": "start",
        "data": {
          "conversation_id": "22222222-2222-4222-8222-222222222222",
          "pricing": {
            "version": 1,
            "strategy": "fixed",
            "policyVersion": "1",
            "unit": "credit",
            "reserveCredits": 2,
            "authorizedCredits": 2,
            "credits": 2,
            "expiresAt": "<expiry>",
            "missingUsage": "defer"
          }
        }
      },
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 1,
        "type": "text_delta",
        "data": {
          "text": "Approved answer"
        }
      },
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 2,
        "type": "done",
        "data": {
          "delivery_status": "delivered",
          "stop_reason": "complete",
          "replayed": true,
          "credits_used": 2,
          "financial_status": "settled"
        }
      }
    ],
    "body": null,
    "order": [
      "lookup",
      "flush_headers",
      "event:start",
      "event:text_delta",
      "event:done"
    ]
  },
  "pending": {
    "status": 200,
    "headers": {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    },
    "events": [
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 0,
        "type": "start",
        "data": {
          "conversation_id": "22222222-2222-4222-8222-222222222222",
          "pricing": {
            "version": 1,
            "strategy": "fixed",
            "policyVersion": "1",
            "unit": "credit",
            "reserveCredits": 2,
            "authorizedCredits": 2,
            "credits": 2,
            "expiresAt": "<expiry>",
            "missingUsage": "defer"
          }
        }
      },
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 1,
        "type": "pending",
        "data": {
          "status": "reconciliation_required"
        }
      }
    ],
    "body": null,
    "order": [
      "lookup",
      "reserve",
      "flush_headers",
      "event:start",
      "usage_start",
      "provider",
      "usage_observe",
      "validate",
      "settle:Approved answer",
      "event:pending"
    ]
  },
  "unsafe": {
    "status": 200,
    "headers": {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    },
    "events": [
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 0,
        "type": "start",
        "data": {
          "conversation_id": "22222222-2222-4222-8222-222222222222",
          "pricing": {
            "version": 1,
            "strategy": "fixed",
            "policyVersion": "1",
            "unit": "credit",
            "reserveCredits": 2,
            "authorizedCredits": 2,
            "credits": 2,
            "expiresAt": "<expiry>",
            "missingUsage": "defer"
          }
        }
      },
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 1,
        "type": "error",
        "data": {
          "code": "unsafe_output",
          "message": "The generated response did not pass validation.",
          "retryable": false,
          "financial_status": "released"
        }
      }
    ],
    "body": null,
    "order": [
      "lookup",
      "reserve",
      "flush_headers",
      "event:start",
      "usage_start",
      "provider",
      "usage_observe",
      "validate",
      "failure:unsafe_output",
      "event:error"
    ]
  },
  "invalid": {
    "status": 400,
    "headers": {},
    "events": [],
    "body": {
      "error": "invalid_request",
      "code": "invalid_request",
      "message": "The request is invalid. Review the submitted fields and try again.",
      "retryable": false
    },
    "order": []
  },
  "disconnect": {
    "status": 200,
    "headers": {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    },
    "events": [
      {
        "version": "1.0",
        "request_id": "golden-chat",
        "event_index": 0,
        "type": "start",
        "data": {
          "conversation_id": "22222222-2222-4222-8222-222222222222",
          "pricing": {
            "version": 1,
            "strategy": "fixed",
            "policyVersion": "1",
            "unit": "credit",
            "reserveCredits": 2,
            "authorizedCredits": 2,
            "credits": 2,
            "expiresAt": "<expiry>",
            "missingUsage": "defer"
          }
        }
      }
    ],
    "body": null,
    "order": [
      "lookup",
      "reserve",
      "flush_headers",
      "event:start",
      "usage_start",
      "provider",
      "usage_observe",
      "failure:provider_aborted"
    ]
  }
};
describe('unchanged chat transport golden contract', () => {
  it.each(['success', 'replay', 'pending', 'unsafe', 'invalid', 'disconnect'])('%s keeps events and execution order', async mode => {
    const actual = await runHttp(mode);
    expect(actual).toEqual(golden[mode]);
  });
});


describe('application chat without HTTP', () => {
  it.each(['success', 'replay', 'pending', 'unsafe'])('%s uses the same runtime and business ordering', async mode => {
    const f = fixture(mode), events = [];
    const emit = (type, data) => { events.push({ type, data }); f.order.push('event:' + type); };
    const deliveryPort = {
      createEmitter: () => ({ emit }),
      emitStart: (sink, { request }) => sink.emit('start', { conversationId: request.conversationId }),
      emitTextDelta: (sink, text) => sink.emit('text_delta', { text }),
      emitDone: (sink, { settlement }) => sink.emit('done', settlement),
      emitPending: (sink, { settlement }) => sink.emit('pending', settlement),
      emitError: (sink, error) => sink.emit('error', { code: error.code }),
      async replayExisting({ existing }) {
        emit('start', { conversationId: existing.conversation_id });
        emit('text_delta', { text: existing.assistant_text });
        emit('done', { replayed: true, creditsUsed: existing.creditsUsed });
        return { handled: true, streamed: true, replayed: true };
      },
    };
    const execute = createChatUseCase({ ...f.options, product: f.options.aiProduct, env,
      adapter: new DomainKnowledgeAdapter('vertical-agent-saas'), deliveryPort });
    // No req/res, Express router, HTTP server, response mock or second runtime.
    const result = await execute({ request, user });
    expect(f.order).toEqual(golden[mode].order.filter(step => step !== 'flush_headers'));
    expect(events.map(event => event.type)).toEqual(golden[mode].events.map(event => event.type));
    expect(result.handled).toBe(true);
    if (['success', 'replay'].includes(mode)) expect(events.find(event => event.type === 'text_delta').data.text).toBe('Approved answer');
    if (mode === 'success') expect(result.settlement).toMatchObject({ status: 'settled', creditsUsed: 2 });
    if (mode === 'replay') expect(result.replayed).toBe(true);
    if (mode === 'pending') expect(result.terminalStatus).toBe('reconciliation_required');
    if (mode === 'unsafe') expect(events.at(-1)).toEqual({ type: 'error', data: { code: 'unsafe_output' } });
  });
  it('normalizes invalid input before runtime side effects and requires an explicit delivery port', async () => {
    const f = fixture();
    expect(() => createChatUseCase({ ...f.options, product: f.options.aiProduct })).toThrow('deliveryPort');
    const execute = createChatUseCase({ ...f.options, product: f.options.aiProduct, deliveryPort: {} });
    expect(() => execute({ request: { ...request, question: '' }, user })).toThrow('Question must contain');
    expect(f.order).toEqual([]);
  });
});


describe('provider conversation order and atomic history budgets', () => {
  async function promptFor(history) {
    const f = fixture('success', history);
    f.options.callAIStream = vi.fn(f.options.callAIStream);
    const execute = createChatUseCase({ ...f.options, product: f.options.aiProduct, env,
      adapter: new DomainKnowledgeAdapter('vertical-agent-saas'), deliveryPort: {} });
    const result = await execute({ request, user });
    expect(result.terminalStatus).toBe('settled');
    return f.options.callAIStream.mock.calls[0][0].messages;
  }
  it.each([0, 1, 3])('renders %i complete history turns before the current required question', async (turns) => {
    const history = Array.from({ length: turns }, (_, i) => [
      { role: 'user', content: `old question ${i}`, turn_sequence: String(i + 1) },
      { role: 'assistant', content: `old answer ${i}`, turn_sequence: String(i + 1) },
    ]).flat();
    expect(await promptFor(history)).toEqual([...history.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: request.question }]);
  });
  it('prunes a turn as a unit while keeping retained order and the current question last', async () => {
    const history = [
      { role: 'user', content: 'too large ' + 'word '.repeat(6000), turn_sequence: '1' },
      { role: 'assistant', content: 'do not keep an orphan answer', turn_sequence: '1' },
      { role: 'user', content: 'small older question', turn_sequence: '2' },
      { role: 'assistant', content: 'small older answer', turn_sequence: '2' },
    ];
    expect(await promptFor(history)).toEqual([
      { role: 'user', content: 'small older question' }, { role: 'assistant', content: 'small older answer' },
      { role: 'user', content: request.question },
    ]);
  });
});
