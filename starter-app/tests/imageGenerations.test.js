import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareImageGeneration, IMAGE_BOUNDS } from '../server/domain/imageGenerationContract.js';
import { createImageGenerationsAdapter } from '../server/providers/imageGenerations.js';
import { imageInput, imageProfile, imageResponse } from './fixtures/imageGeneration.js';
const prepare = (profile = imageProfile(), input = imageInput()) => prepareImageGeneration({ profile, input, accountId: 'account', clientRequestId: 'key' });
afterEach(() => vi.unstubAllGlobals());

describe('local synchronous Images protocol', () => {
  it('requires injected transport and never calls global fetch', async () => {
    const fetch = vi.fn(() => { throw new Error('forbidden'); }); vi.stubGlobal('fetch', fetch);
    expect(() => createImageGenerationsAdapter({})).toThrow('image_transport_required');
    const transport = vi.fn(async () => imageResponse());
    const result = await createImageGenerationsAdapter({ transport })({ request: prepare().request });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toMatchObject({ method: 'POST', path: '/images/generations', maxResponseBytes: IMAGE_BOUNDS.responseBytes });
    expect(JSON.parse(transport.mock.calls[0][0].body)).toMatchObject({ n: 1, response_format: 'b64_json', size: '1x1' });
    expect(result.observation).toMatchObject({ outcome: 'succeeded', externalStatus: 'completed', cost: null,
      metrics: { images: { value: null, source: 'missing' } } });
    expect(result.artifact).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not serialize caller-controlled toJSON hooks', async () => {
    const request = { ...prepare().request };
    Object.defineProperty(request, 'toJSON', { value: () => ({ model: 'wrong', n: 99 }) });
    const transport = vi.fn(async () => imageResponse());
    await createImageGenerationsAdapter({ transport })({ request });
    expect(JSON.parse(transport.mock.calls[0][0].body)).toEqual(prepare().request);
  });
  it('records explicit approved response model identity', async () => {
    const result = await createImageGenerationsAdapter({ transport: async () => imageResponse({ model: imageInput().model }) })({ request: prepare().request });
    expect(result.observation.modelIdentitySource).toBe('provider_response');
    expect(result.observation.model).toBe(imageInput().model);
  });
  it('records only explicit image usage, never infers cost from fixed credits', async () => {
    const result = await createImageGenerationsAdapter({ transport: async () => imageResponse({ usage: { images: 1 } }) })({ request: prepare().request });
    expect(result.observation.metrics.images).toEqual({ value: 1, unit: 'image', source: 'provider' });
    expect(result.observation.cost).toBeNull();
  });
  it.each([
    ['status', (r) => ({ ...r, status: 202 })],
    ['body size', (r) => ({ ...r, body: Buffer.alloc(IMAGE_BOUNDS.responseBytes + 1) })],
    ['malformed JSON', (r) => ({ ...r, body: Buffer.from('{') })],
    ['zero images', () => imageResponse({ data: [] })],
    ['two images', () => imageResponse({ data: [{ b64_json: '' }, { b64_json: '' }] })],
    ['URL', () => imageResponse({ data: [{ url: 'https://fixture.invalid/image' }] })],
    ['bad base64', () => imageResponse({ data: [{ b64_json: 'bad!' }] })],
    ['not PNG', () => imageResponse({ data: [{ b64_json: Buffer.from('not PNG').toString('base64') }] })],
    ['request ID injection', (r) => ({ ...r, requestId: 'id\nsecret' })],
    ['long ID', (r) => ({ ...r, requestId: 'x'.repeat(129) })],
    ['model mismatch', () => imageResponse({ model: 'unexpected-model' })],
    ['usage', () => imageResponse({ usage: { images: 2 } })],
  ])('treats %s as unknown rather than delivery', async (_, change) => {
    const transport = vi.fn(async () => change(imageResponse()));
    await expect(createImageGenerationsAdapter({ transport })({ request: prepare().request })).rejects.toMatchObject({ observation: { outcome: 'unknown', externalStatus: 'unknown', cost: null } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['AbortError', 'TimeoutError', 'Error'])('never retries or claims remote cancellation after %s', async (name) => {
    const transport = vi.fn(async () => { throw Object.assign(new Error('fixture'), { name }); });
    await expect(createImageGenerationsAdapter({ transport })({ request: prepare().request })).rejects.toMatchObject({ code: 'image_submission_unknown' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('redacts transport details and does not persist extra profile metadata', async () => {
    const secret = 'SYNTHETIC-SECRET-DO-NOT-PERSIST';
    const p = imageProfile(); p.supplierAuthorization.token = secret; p.recoveryPolicy.debug = secret;
    const prepared = prepare(p); expect(JSON.stringify(prepared)).not.toContain(secret);
    expect(() => { prepared.request.prompt = 'changed'; }).toThrow();
    const run = createImageGenerationsAdapter({ transport: async () => { throw new Error(secret); } });
    try { await run({ request: prepared.request }); throw new Error('expected rejection'); }
    catch (error) { expect(error.code).toBe('image_submission_unknown'); expect(inspect(error)).not.toContain(secret); expect(JSON.stringify(error)).not.toContain(secret); }
  });
  it('does not invoke transport on an already aborted signal or invalid request', async () => {
    const transport = vi.fn(); const run = createImageGenerationsAdapter({ transport });
    await expect(run({ request: prepare().request, signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(run({ request: { ...prepare().request, n: 2 } })).rejects.toThrow('image_request_invalid');
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('pre-reservation image authorization', () => {
  it.each(['version', 'provider', 'model', 'specs', 'fixedCredits', 'maxCalls', 'maxRetries', 'maxImages', 'deadlineMs', 'recoveryPolicy', 'supplierAuthorization'])('requires explicit %s', (field) => {
    const profile = imageProfile(); delete profile[field]; expect(() => prepare(profile)).toThrow();
  });
  it.each([{ fixedCredits: -1 }, { fixedCredits: 1.5 }, { maxCalls: 2 }, { maxRetries: 1 }, { maxImages: 2 },
    { deadlineMs: 0 }, { deadlineMs: 60001 }, { recoveryPolicy: { version: '1', maxAgeMs: 1, onExpiry: 'waive' } },
    { supplierAuthorization: { kind: 'real', amount: '100', currency: 'USD', scale: 0 } }])('rejects invalid configuration %j', (change) => {
    expect(() => prepare({ ...imageProfile(), ...change })).toThrow();
  });
  it.each([{ model: 'unapproved' }, { n: 2 }, { specs: { width: 2, height: 1, mediaType: 'image/png' } },
    { prompt: '' }, { prompt: 'x'.repeat(4097) }, { extra: true }])('rejects invalid input %j', (change) => {
    expect(() => prepare(imageProfile(), { ...imageInput(), ...change })).toThrow();
  });
  it('snapshots fixed quote, request, recovery and supplier authorization independently', () => {
    const profile = imageProfile(), input = imageInput(), prepared = prepare(profile, input);
    profile.fixedCredits = 99; profile.specs.width = 20; profile.recoveryPolicy.maxAgeMs = 10;
    input.prompt = 'changed'; input.specs.width = 2;
    expect(prepared.quote.reserveCredits).toBe(2); expect(prepared.quote.limits.specs.width).toBe(1);
    expect(prepared.quote.terms.recoveryPolicy.maxAgeMs).toBe(60000); expect(prepared.request.prompt).toBe('Synthetic pixel');
  });
});
