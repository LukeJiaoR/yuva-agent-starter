import { describe, expect, it } from 'vitest';
import { createFixedOperationPricingPolicy } from '@yuva/billing-core';
import { validateModelCatalog, resolveFeatureBinding } from '../server/domain/modelCatalog.js';
import { createAiProduct, publicQuote } from '../server/domain/aiProduct.js';
import { catalogFixture } from './fixtures/modelCatalog.js';

const resolve = (catalog) => resolveFeatureBinding(catalog, 'deep_reasoning');
describe('application-owned model catalog', () => {
  it.each(['mock', 'openai', 'anthropic'])('resolves explicit %s approval without model calls', (provider) => {
    const result = resolve(catalogFixture(provider));
    expect(result.provider).toBe(provider);
    expect(result.executionLimits.paths).toEqual([{ provider, model: result.model }]);
    expect(result.executionLimits).toMatchObject({ maxCalls: 1, maxRetries: 0, maxOutputTokens: 512 });
  });
  it('rejects an array provider in unbound inventory during validation', () => {
    const catalog = catalogFixture('openai');
    catalog.connections[0].provider = ['openai'];
    catalog.bindings = [];
    expect(() => validateModelCatalog(catalog)).toThrow('invalid_model_catalog');
  });
  it('copies and recursively freezes configuration and resolution', () => {
    const input = catalogFixture(); const catalog = validateModelCatalog(input); const result = resolve(input);
    input.bindings[0].parameters.maxOutputTokens = 999;
    expect(catalog.bindings[0].parameters.maxOutputTokens).toBe(512);
    expect(() => { result.snapshot.parameters.maxOutputTokens = 999; }).toThrow(TypeError);
    expect(() => { result.executionLimits.paths[0].model = 'changed'; }).toThrow(TypeError);
  });
  it('imports discovered and manual unverified inventory without authorizing execution', () => {
    for (const source of ['manual', 'discovered']) {
      const c = catalogFixture(); c.models[0].provenance.source = source; c.models[0].capabilities[0].status = 'unverified';
      expect(() => resolve(c)).toThrow('model_capability_unverified');
      c.bindings = []; expect(validateModelCatalog(c).models[0].provenance.source).toBe(source);
      expect(() => resolve(c)).toThrow('model_binding_missing');
    }
  });
  const invalid = {
    'duplicate connection': c => c.connections.push(c.connections[0]),
    'duplicate provider connections': c => c.connections.push({ ...c.connections[0], id: 'second' }),
    'duplicate model': c => c.models.push(c.models[0]),
    'duplicate binding': c => c.bindings.push(c.bindings[0]),
    'dangling connection': c => { c.models[0].connectionId = 'missing'; },
    'dangling model': c => { c.bindings[0].modelId = 'missing'; },
    'array provider': c => { c.connections[0].provider = ['mock']; c.bindings = []; },
    'unknown provider': c => { c.connections[0].provider = 'unknown'; },
    'disabled model': c => { c.models[0].status = 'disabled'; },
    'disabled connection': c => { c.connections[0].status = 'disabled'; },
    'disabled capability': c => { c.models[0].capabilities[0].status = 'disabled'; },
    'unverified capability': c => { c.models[0].capabilities[0].status = 'unverified'; },
    'absent capability': c => { c.models[0].capabilities = []; },
    'duplicate capability': c => c.models[0].capabilities.push(c.models[0].capabilities[0]),
    'invalid timestamp': c => { c.models[0].provenance.recordedAt = '2026-02-31T00:00:00.000Z'; },
    'unsupported source': c => { c.models[0].provenance.source = 'assumed'; },
    'missing version': c => { delete c.bindings[0].version; },
    'blank version': c => { c.bindings[0].version = ''; },
    'unknown root field': c => { c.endpoint = 'fixture-secret'; },
    'credential value': c => { c.connections[0].apiKey = 'fixture-secret'; },
    'arbitrary credential ref': c => { c.connections[0].credentialRef = 'fixture-secret'; },
    'endpoint override': c => { c.connections[0].baseUrl = 'https://fixture.invalid'; },
    'extra provenance field': c => { c.models[0].provenance.apiKey = 'fixture-secret'; },
    'extra capability field': c => { c.models[0].capabilities[0].verified = true; },
    'extra binding field': c => { c.bindings[0].secret = 'fixture-secret'; },
    'temperature unsupported': c => { c.bindings[0].parameters.temperature = 0.7; },
    'unknown budget': c => { c.bindings[0].budget.maxCalls = 2; },
    'negative tokens': c => { c.bindings[0].parameters.maxOutputTokens = -1; },
    'string tokens': c => { c.bindings[0].parameters.maxOutputTokens = '512'; },
    'fractional input': c => { c.bindings[0].budget.maxInputTokens = 2.5; },
    'zero deadline': c => { c.bindings[0].budget.deadlineMs = 0; },
    'infinite budget': c => { c.bindings[0].budget.maxCredits = Infinity; },
    'unsupported mock model': c => { c.models[0].model = 'other'; },
  };
  it.each(Object.entries(invalid))('fails closed: %s', (_, mutate) => {
    const c = catalogFixture(); mutate(c);
    expect(() => resolve(c)).toThrow();
    try { resolve(c); } catch (error) { expect(error.message).not.toContain('fixture-secret'); }
  });
  it.each(['image', 'video', 'tool'])('rejects even verified %s bindings without an executor', (taskType) => {
    const c = catalogFixture(); c.bindings[0].taskType = taskType; c.models[0].capabilities[0].taskType = taskType;
    expect(() => createAiProduct({ modelCatalog: c })).toThrow('unsupported_model_capability');
  });
  it('selects different models for two independently priced features', () => {
    const c = catalogFixture('openai');
    c.models.push({ ...structuredClone(c.models[0]), id: 'second', model: 'other-approved-model' });
    c.bindings.push({ ...structuredClone(c.bindings[0]), featureKey: 'report_result', modelId: 'second', version: 'v2' });
    const report = createAiProduct({ modelCatalog: c, configuration: { strategy: 'fixed', featureKey: 'report_result', credits: 4 } });
    const chat = createAiProduct({ modelCatalog: c });
    expect([chat.model, report.model]).toEqual(['fixture-model', 'other-approved-model']);
    expect([chat.publicPricing.credits, report.publicPricing.credits]).toEqual([2, 4]);
  });
  it('limits credit authorization, rejects competing limits, and retains production mock guard', () => {
    const c = catalogFixture(); c.bindings[0].budget.maxCredits = 1;
    expect(() => createAiProduct({ modelCatalog: c })).toThrow('model_binding_budget_exceeded');
    expect(() => createAiProduct({ modelCatalog: catalogFixture(), configuration: { strategy: 'fixed', featureKey: 'deep_reasoning', credits: 2, limits: {} } })).toThrow('catalog_limits_conflict');
    expect(() => createAiProduct({ env: { NODE_ENV: 'production' }, modelCatalog: catalogFixture() })).toThrow('mock_provider_forbidden');
  });
  it('preserves prototype policy interfaces and method receivers', () => {
    class CustomPolicy {
      #base = createFixedOperationPricingPolicy({ credits: 2 });
      #decision = { action: 'release', reason: 'custom' };
      get id() { return this.#base.id; }
      get version() { return this.#base.version; }
      quote(...args) { return this.#base.quote(...args); }
      decide() { return this.#decision; }
    }
    const policy = new CustomPolicy();
    const product = createAiProduct({ modelCatalog: catalogFixture(), policy });
    expect(product.policy.quote({}, product.executionLimits).modelBinding.version).toBe('v1');
    expect(product.policy.decide()).toEqual({ action: 'release', reason: 'custom' });
    expect(() => createAiProduct({ modelCatalog: catalogFixture(), policy: { id: 'fixed', decide() {} } })).toThrow('invalid_pricing_configuration');
  });
  it('records binding versions in private quote snapshots without changing input identity or public pricing', () => {
    const c = catalogFixture('openai'); const before = createAiProduct({ modelCatalog: c });
    const quote = before.policy.quote({}, before.executionLimits);
    c.bindings[0].version = 'v2'; c.bindings[0].parameters.maxOutputTokens = 256; c.models[0].model = 'changed-model';
    const after = createAiProduct({ modelCatalog: c });
    const next = after.policy.quote({}, after.executionLimits);
    expect(quote.modelBinding).toMatchObject({ version: 'v1', model: 'fixture-model', parameters: { maxOutputTokens: 512 } });
    expect(next.modelBinding).toMatchObject({ version: 'v2', model: 'changed-model' });
    expect(before.policy.quote({}, before.executionLimits).modelBinding.version).toBe('v1');
    expect(after.inputVersion).toBe(before.inputVersion);
    expect(JSON.stringify(publicQuote(quote))).not.toMatch(/modelBinding|credentialRef|fixture-model/);
  });
});
