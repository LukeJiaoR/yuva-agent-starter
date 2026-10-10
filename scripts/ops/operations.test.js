import { describe, it, expect } from 'vitest';
import { verifyStack, productionProblems } from './config.mjs';
import { inspectDatabase, probe } from './inspect.mjs';
import { createAiProduct } from '../../starter-app/server/domain/aiProduct.js';

describe('operations configuration and metadata-only monitoring', () => {
  const configured = { NODE_ENV: 'production', ALLOW_DEV_GUEST: 'false', DATABASE_URL: 'postgresql://example/db', CORS_ORIGIN: 'https://app.example.test',
    CLERK_AUTHORIZED_PARTIES: 'https://app.example.test', CLERK_JWT_KEY: 'fixture-key', AUTH_TOKEN_SECRET: 'a'.repeat(40),
    AI_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://provider.example.test/v1', OPENAI_MODEL: 'fixture', OPENAI_API_KEY: 'fixture-key' };
  it('registers owners, extension seams and service maturity without secret values', async () => {
    const registry = await verifyStack();
    expect(registry.components).toHaveLength(5);
    expect(registry.services.find((s) => s.id === 'media').status).toBe('deferred');
    expect(registry.services.find((s) => s.id === 'payments').status).toBe('product-owned');
  });
  it('rejects unsafe or placeholder production configuration without printing values', () => {
    expect(productionProblems(configured)).toEqual([]);
    const problems = productionProblems({ ...configured, ALLOW_DEV_GUEST: 'true', AI_PROVIDER: 'mock', CORS_ORIGIN: '*', OPENAI_API_KEY: '<key>' });
    expect(problems.length).toBeGreaterThan(2);
    expect(problems.join()).not.toContain(configured.AUTH_TOKEN_SECRET);
  });
  it.each(['openai', 'anthropic', 'mock', 'deepseek', 'ollama', 'unknown'])('matches the production application provider support for %s', (provider) => {
    const env = { ...configured, AI_PROVIDER: provider, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_MODEL: 'fixture' };
    const supported = ['openai', 'anthropic'].includes(provider);
    const providerProblems = productionProblems(env).filter((problem) => problem.startsWith('AI_PROVIDER:'));
    expect(providerProblems.length === 0).toBe(supported);
    if (supported) {
      expect(createAiProduct({ env }).provider).toBe(provider);
      expect(productionProblems(env)).toEqual([]);
    } else {
      expect(() => createAiProduct({ env })).toThrow(provider === 'mock' ? 'mock_provider_forbidden' : 'unsupported_provider');
    }
  });
  it('reports unknown provider cost distinctly and only queries aggregate request metadata', async () => {
    const result = await inspectDatabase({ query: async (sql) => {
      expect(sql).not.toMatch(/assistant_text|prompt|email|password/iu);
      return { rows: [{ active_requests: 2, released_requests: 1, reconciliation_requests: 1, oldest_active_seconds: 120 }] };
    } });
    expect(result.providerCost.status).toBe('unavailable');
    expect(result.active_requests).toBe(2);
  });
  it('checks liveness/readiness without leaking upstream response data', async () => {
    const statuses = await probe('https://app.example.test', async (url) => ({ ok: url.pathname === '/health', status: url.pathname === '/health' ? 200 : 503 }));
    expect(statuses.health.ok).toBe(true); expect(statuses.ready.ok).toBe(false);
    await expect(probe('https://user:secret@app.example.test')).rejects.toThrow('credential-free');
  });
});
