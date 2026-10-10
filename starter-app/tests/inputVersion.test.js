import { describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ ports: null }));
vi.mock('@yuva/ai-engine', async (importOriginal) => ({
  ...await importOriginal(),
  createAgentRuntime: (ports) => { boundary.ports = ports; return vi.fn(); },
}));
import { createAiProduct } from '../server/domain/aiProduct.js';
import { createServer } from '../server/index.js';
import { createChatStreamRoutes } from '../server/routes/chatStream.routes.js';

function capture(extra = {}) {
  const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  const operationStore = { find: vi.fn().mockResolvedValue(null) };
  createServer({ db, operationStore, config: { env: { AI_PROVIDER: 'mock', NODE_ENV: 'test' } }, ...extra });
  const ports = boundary.ports;
  return { operationStore, read: async (request = {}) => {
    await ports.billingPort.getRequest({ db, user: { id: 'local-user' }, request: { requestId: 'version-key', ...request } });
    return operationStore.find.mock.lastCall[0].operation;
  } };
}

describe('server-owned product input-contract version', () => {
  it.each(['fixed', 'token'])('defaults %s products to the existing version 1', (strategy) => {
    expect(createAiProduct({ env: { PRICING_STRATEGY: strategy } }).inputVersion).toBe('1');
  });

  it.each([null, '', '   ', 1, false, {}, [], 'v'.repeat(81)])('rejects invalid version %j at composition time', (inputVersion) => {
    expect(() => createAiProduct({ inputVersion })).toThrow('invalid_input_version');
    expect(() => createServer({ db: {}, config: { inputVersion } })).toThrow('invalid_input_version');
  });

  it('accepts an explicit non-semver product contract up to the core limit', () => {
    expect(createAiProduct({ inputVersion: 'report-schema2-prompt3' }).inputVersion).toBe('report-schema2-prompt3');
    expect(createAiProduct({ inputVersion: 'v'.repeat(80) }).inputVersion).toHaveLength(80);
  });

  it('captures server configuration and ignores client-supplied versions', async () => {
    const config = { inputVersion: 'report-v2', env: { AI_PROVIDER: 'mock', NODE_ENV: 'test' } };
    const fixture = capture({ config });
    config.inputVersion = 'changed-after-start';
    expect(await fixture.read({ inputVersion: 'client-version', input_version: 'client-version',
      promptVersion: 'client-version', question: 'Fixture' })).toMatchObject({ inputVersion: 'report-v2' });
  });

  it('uses an injected product version ahead of conflicting server defaults and captures it once', async () => {
    const product = createAiProduct({ env: { AI_PROVIDER: 'mock', NODE_ENV: 'test' }, inputVersion: 'product-v3' });
    const fixture = capture({ aiProduct: product, config: { inputVersion: 'ignored-config-version' } });
    product.inputVersion = 'changed-after-start';
    expect(await fixture.read()).toMatchObject({ inputVersion: 'product-v3' });
  });

  it('preserves version 1 for existing custom product objects without this optional field', async () => {
    const product = createAiProduct({ env: { AI_PROVIDER: 'mock', NODE_ENV: 'test' } });
    delete product.inputVersion;
    expect(await capture({ aiProduct: product }).read()).toMatchObject({ inputVersion: '1' });
  });

  it('rejects a malformed injected product version at the direct route boundary', () => {
    const product = createAiProduct({ env: { AI_PROVIDER: 'mock', NODE_ENV: 'test' } });
    product.inputVersion = '';
    expect(() => createChatStreamRoutes({ db: {}, product })).toThrow('invalid_input_version');
  });
});
