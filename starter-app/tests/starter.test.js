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

describe('Vertical AI Agent SaaS Starter Application', () => {
  it('GET /health returns domain status', async () => {
    const app = createServer();
    const mockRes = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };

    const handler = getRouteHandler(app, 'GET', '/health');
    expect(handler).toBeDefined();

    await handler({}, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        domain: 'vertical-agent-saas',
      }),
    );
  });

  it('POST /api/analyze computes deterministic domain facts & fingerprint', async () => {
    const app = createServer();
    const mockRes = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };

    const handler = getRouteHandler(app, 'POST', '/api/analyze');
    expect(handler).toBeDefined();

    await handler(
      {
        body: {
          input: {
            subject: 'Legal Clause 42',
            parameters: { jurisdiction: 'US-CA', term_years: 5 },
            query: 'Explain indemnity clause',
          },
        },
      },
      mockRes,
      vi.fn(),
    );

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        fingerprint: expect.any(String),
        facts: expect.objectContaining({
          subject: 'Legal Clause 42',
        }),
        pricing: expect.objectContaining({
          credits: 1,
        }),
      }),
    );
  });
});
