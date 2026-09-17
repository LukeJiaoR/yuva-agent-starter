import { describe, it, expect } from 'vitest';
import { createAiProduct } from '../server/domain/aiProduct.js';
import { createServer } from '../server/index.js';

describe('trusted AI product configuration', () => {
  it('preserves default fixed price and enables token pricing only explicitly', () => {
    expect(createAiProduct({ env: {} }).publicPricing).toMatchObject({ strategy: 'fixed', credits: 2 });
    const token = createAiProduct({ env: { PRICING_STRATEGY: 'token' } });
    expect(token.publicPricing).toMatchObject({ strategy: 'token', inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 } });
    expect(token.publicPricing.reserveCredits).toBe(27);
    expect(token.publicPricing.missingUsage).toBe('defer');
    expect(createAiProduct({ configuration: { strategy: 'token', featureKey: 'estimate_example',
      inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 }, allowEstimates: true } }).publicPricing.missingUsage).toBe('estimate');
  });
  it('supports distinct product feature keys and frozen configuration without shared mutation', () => {
    const configuration = { strategy: 'fixed', featureKey: 'report_result', credits: 5 };
    const product = createAiProduct({ env: {}, configuration });
    configuration.credits = 99;
    expect(product.featureKey).toBe('report_result');
    expect(product.publicPricing.credits).toBe(5);
    expect(product.policy.quote({}, product.executionLimits).reserveCredits).toBe(5);
  });
  it('rejects unknown strategy, invalid amount and production mock at composition time', () => {
    expect(() => createServer({ config: { env: { PRICING_STRATEGY: 'free' } } })).toThrow('invalid_pricing_configuration');
    expect(() => createAiProduct({ configuration: { strategy: 'fixed', featureKey: 'test_feature', credits: '2' } })).toThrow('invalid_credits');
    expect(() => createAiProduct({ env: { AI_PROVIDER: 'mock', NODE_ENV: 'production' } })).toThrow('mock_provider_forbidden');
  });
  it('projects only user rates and capabilities, excluding provider configuration', () => {
    const product = createAiProduct({ env: { OPENAI_API_KEY: 'secret-fixture', OPENAI_BASE_URL: 'https://private.invalid' } });
    const json = JSON.stringify(product.publicPricing);
    expect(json).not.toContain('secret-fixture'); expect(json).not.toContain('private.invalid');
    expect(product.publicPricing.capabilities).toEqual([{ taskType: 'text', mode: 'stream' }]);
  });
});
