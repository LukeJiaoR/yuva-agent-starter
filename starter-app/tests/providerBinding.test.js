import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ ports: null, transport: vi.fn() }));
vi.mock('@yuva/ai-engine', async (importOriginal) => ({
  ...await importOriginal(),
  createAgentRuntime: (ports) => { boundary.ports = ports; return vi.fn(); },
  streamProviderText: boundary.transport,
}));
import { createChatStreamRoutes } from '../server/routes/chatStream.routes.js';
import { createAiProduct, publicQuote } from '../server/domain/aiProduct.js';

function compose(env, extra = {}) {
  const product = extra.product ?? createAiProduct({ env });
  const usageStore = { start: vi.fn(), observe: vi.fn() };
  createChatStreamRoutes({ db: {}, adapter: { domainKey: 'fixture' }, operationStore: {}, usageStore,
    env, product, ...extra });
  const quote = product.policy.quote({ taskType: 'text', mode: 'stream', featureKey: product.featureKey }, product.executionLimits);
  const invoke = (options = {}) => boundary.ports.usagePort.invoke({
    invoke: boundary.ports.streamPort.streamProviderText,
    options: { messages: [{ role: 'user', content: 'Hello' }], onText: vi.fn(), ...options },
    reservation: { operation: { id: 'fixture-operation', accountId: 'fixture-account', taskType: 'text',
      createdAt: new Date().toISOString(), quote } },
  });
  return { product, usageStore, quote, invoke };
}

beforeEach(() => {
  boundary.transport.mockReset().mockResolvedValue({ text: 'Fixture output' });
  for (const name of ['AI_PROVIDER', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']) vi.stubEnv(name, undefined);
  vi.stubEnv('NODE_ENV', 'test');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('default transport binding matches the frozen quote and usage identity', () => {
  it.each([['openai', 'gpt-4o'], ['anthropic', 'claude-3-5-sonnet-20241022']])('preserves the existing %s model default', async (provider, model) => {
    await compose({ AI_PROVIDER: provider, OPENAI_API_KEY: 'openai-fixture-key', ANTHROPIC_API_KEY: 'anthropic-fixture-key',
      OPENAI_BASE_URL: 'https://default-model-fixture.invalid' }).invoke();
    expect(boundary.transport).toHaveBeenCalledWith(expect.objectContaining({ provider, model }));
  });

  it.each(['openai', 'anthropic'])('keeps %s identity and credentials when the original env changes', async (provider) => {
    const env = { AI_PROVIDER: provider, OPENAI_MODEL: 'openai-original', ANTHROPIC_MODEL: 'anthropic-original',
      OPENAI_API_KEY: 'openai-fixture-key', ANTHROPIC_API_KEY: 'anthropic-fixture-key', OPENAI_BASE_URL: 'https://original.invalid' };
    const fixture = compose(env);
    Object.assign(env, { AI_PROVIDER: provider === 'openai' ? 'anthropic' : 'openai', OPENAI_MODEL: 'changed',
      ANTHROPIC_MODEL: 'changed', OPENAI_API_KEY: 'changed', ANTHROPIC_API_KEY: 'changed', OPENAI_BASE_URL: 'https://changed.invalid' });
    await fixture.invoke();
    const transport = boundary.transport.mock.calls[0][0];
    expect(transport).toMatchObject({ provider, model: `${provider}-original`, apiKey: `${provider}-fixture-key`, baseUrl: 'https://original.invalid' });
    expect(fixture.quote.limits.paths).toContainEqual({ provider: transport.provider, model: transport.model });
    expect(fixture.usageStore.start).toHaveBeenCalledWith(expect.objectContaining({ provider: transport.provider, model: transport.model }));
    expect(transport.options).toMatchObject({ maxOutputTokens: 1024, maxOutputTokensCap: 1024 });
    expect(JSON.stringify(publicQuote(fixture.quote))).not.toMatch(/fixture-key|original\.invalid/);
    expect(JSON.stringify(fixture.product.publicPricing)).not.toMatch(/fixture-key|original\.invalid/);
  });

  it('uses the injected product identity rather than conflicting environment identity', async () => {
    const product = createAiProduct({ env: { AI_PROVIDER: 'anthropic', ANTHROPIC_MODEL: 'product-model' } });
    const fixture = compose({ AI_PROVIDER: 'openai', OPENAI_MODEL: 'env-model', ANTHROPIC_API_KEY: 'anthropic-fixture-key' }, { product });
    await fixture.invoke();
    expect(boundary.transport).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic', model: 'product-model', apiKey: 'anthropic-fixture-key' }));
  });

  it('preserves default process.env composition without rereading changed transport values', async () => {
    vi.stubEnv('AI_PROVIDER', 'openai'); vi.stubEnv('OPENAI_MODEL', 'original-model'); vi.stubEnv('OPENAI_API_KEY', 'original-fixture-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://process-env-fixture.invalid');
    const fixture = compose(undefined);
    vi.stubEnv('OPENAI_MODEL', 'changed-model'); vi.stubEnv('OPENAI_API_KEY', 'changed-fixture-key');
    await fixture.invoke();
    expect(boundary.transport).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', model: 'original-model', apiKey: 'original-fixture-key' }));
  });

  it('keeps custom transport as an explicit trusted injection without claiming to constrain its implementation', async () => {
    const callAIStream = vi.fn().mockResolvedValue({ model: 'externally-observed-model' });
    const fixture = compose({ AI_PROVIDER: 'openai', OPENAI_MODEL: 'configured-model', OPENAI_BASE_URL: '' }, { callAIStream });
    const result = await fixture.invoke();
    expect(callAIStream).toHaveBeenCalledWith(expect.objectContaining({ model: 'configured-model' }));
    expect(result.model).toBe('externally-observed-model');
    expect(boundary.transport).not.toHaveBeenCalled();
  });

  it('does not turn a quoted local mock into a paid provider when env changes', async () => {
    const env = { AI_PROVIDER: 'mock', NODE_ENV: 'test' };
    const fixture = compose(env);
    env.AI_PROVIDER = 'openai';
    const result = await fixture.invoke();
    expect(result).toMatchObject({ provider: 'mock', model: 'starter-local' });
    expect(boundary.transport).not.toHaveBeenCalled();
  });

  it('retains the existing production mock guard even after composition', async () => {
    const env = { AI_PROVIDER: 'mock', NODE_ENV: 'test' };
    const fixture = compose(env);
    env.NODE_ENV = 'production';
    await expect(fixture.invoke()).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(boundary.transport).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic'])('freezes %s SDK environment fallbacks before the actual HTTP boundary', async (provider) => {
    const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    vi.stubEnv(keyName, 'original-global-fixture-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://original-anthropic.invalid');
    const fixture = compose({ AI_PROVIDER: provider, OPENAI_BASE_URL: 'https://original-openai.invalid' });
    vi.stubEnv(keyName, 'changed-global-fixture-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://changed-anthropic.invalid');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Offline fixture' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    const actual = await vi.importActual('@yuva/ai-engine');
    boundary.transport.mockImplementation(actual.streamProviderText);
    await expect(fixture.invoke()).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain(`https://original-${provider}.invalid/`);
    const headers = new Headers(init.headers);
    expect(headers.get(provider === 'openai' ? 'authorization' : 'x-api-key'))
      .toBe(provider === 'openai' ? 'Bearer original-global-fixture-key' : 'original-global-fixture-key');
    expect(JSON.parse(init.body).model).toBe(fixture.product.model);
    expect(fixture.quote.limits.paths).toContainEqual({ provider, model: JSON.parse(init.body).model });
    expect(fixture.usageStore.start).toHaveBeenCalledWith(expect.objectContaining({ provider, model: JSON.parse(init.body).model }));
  });

  it.each(['openai', 'anthropic'])('does not activate a missing %s credential from a later environment change', async (provider) => {
    const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    vi.stubEnv(keyName, undefined);
    const fetch = vi.fn(() => { throw new Error('Unexpected fixture fetch'); });
    vi.stubGlobal('fetch', fetch);
    const fixture = compose({ AI_PROVIDER: provider, OPENAI_BASE_URL: 'https://missing-key-fixture.invalid' });
    vi.stubEnv(keyName, 'late-global-fixture-key');
    await expect(fixture.invoke()).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(boundary.transport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps invalid transport configuration from breaking pricing-only composition', async () => {
    const fixture = compose({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: '' });
    expect(fixture.product.publicPricing.strategy).toBe('fixed');
    await expect(fixture.invoke()).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(boundary.transport).not.toHaveBeenCalled();
  });
});
