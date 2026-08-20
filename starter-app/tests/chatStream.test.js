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

describe('Chat Stream Route & Agent Runtime Integration', () => {
  it('POST /api/chat/stream executes AgentRuntime and streams SSE events', async () => {
    const writtenEvents = [];
    const mockRes = {
      setHeader: vi.fn(),
      write: vi.fn((data) => writtenEvents.push(data)),
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      headersSent: false,
    };

    const callAIStream = vi.fn(async ({ onText }) => {
      await onText('Hello from vertical agent!');
      return {
        provider: 'openai',
        model: 'gpt-4o',
        finishReason: 'stop',
        billableTokens: 50,
      };
    });

    const mockDb = {
      query: vi.fn(async (sql) => {
        if (sql.includes('FROM credit_balances')) {
          return { rows: [{ available: 10, reserved: 0, debt: 0 }] };
        }
        if (sql.includes('FROM credit_usage_requests')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    const app = createServer({ db: mockDb, callAIStream });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    expect(handler).toBeDefined();

    await handler(
      {
        user: { id: '00000000-0000-0000-0000-000000000001' },
        body: {
          question: 'Analyze current market trends',
          requestId: 'req-test-1',
        },
      },
      mockRes,
      vi.fn(),
    );

    expect(callAIStream).toHaveBeenCalled();
    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    const combined = writtenEvents.join('');
    expect(combined).toContain('event: start\n');
    expect(combined).toContain('event: text_delta\n');
    expect(combined).toContain('event: done\n');
    expect(mockRes.end).toHaveBeenCalled();
  });

  it('POST /api/chat/stream returns 402 when credits are insufficient', async () => {
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      headersSent: false,
    };

    const mockDb = {
      query: vi.fn(async (sql) => {
        if (sql.includes('FROM credit_balances')) {
          return { rows: [{ available: 0, reserved: 0, debt: 0 }] };
        }
        return { rows: [] };
      }),
    };

    const app = createServer({ db: mockDb });
    const handler = getRouteHandler(app, 'POST', '/api/chat/stream');
    expect(handler).toBeDefined();

    await handler(
      {
        user: { id: '00000000-0000-0000-0000-000000000001' },
        body: {
          question: 'Need deep consultation',
          requestId: 'req-poor-1',
        },
      },
      mockRes,
      vi.fn(),
    );

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'insufficient_credits',
      }),
    );
  });
});
