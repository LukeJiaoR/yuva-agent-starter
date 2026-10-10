import { describe, expect, it, vi } from 'vitest';
import {
  createBudgetedProvider, createMeteredProvider, executionRequest,
  generateProviderText, resolveMaxOutputTokens, streamProviderText,
} from '../index.js';

const policy = { outputTokenPolicy: 'provider_default' };
const calls = [
  { label: 'streamProviderText', call: streamProviderText },
  { label: 'generateProviderText', call: generateProviderText },
];
const messages = [{ role: 'user', content: 'Synthetic offline request.' }];
const success = [
  { type: 'text-delta', text: 'Synthetic response.' },
  { type: 'finish-step', response: { modelId: 'fixture-model' }, usage: { inputTokens: 4, outputTokens: 2 } },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 4, outputTokens: 2 } },
];
function fakeStream(parts = success) {
  return vi.fn(() => ({ fullStream: (async function* () { yield* parts; })() }));
}
function input(options, extra = {}) {
  return { model: 'fixture-model', provider: 'openai', messages, options,
    modelFactory: () => ({ provider: 'openai', model: {} }), ...extra };
}

describe('explicit provider-default output token policy', () => {
  it('opts out through the public resolver without falling back to a configured default', () => {
    expect(resolveMaxOutputTokens(policy)).toBeUndefined();
    expect(resolveMaxOutputTokens({ ...policy, maxOutputTokensDefault: '8192' })).toBeUndefined();
  });

  it.each([
    [{}, 1024], [{ maxOutputTokens: undefined }, 1024], [{ maxOutputTokens: null }, 1024],
    [{ maxOutputTokens: 0 }, 1024], [{ maxOutputTokens: null, maxOutputTokensDefault: '2048' }, 2048],
    [{ maxOutputTokens: 0, maxOutputTokensDefault: '2048' }, 2048],
    [{ maxOutputTokens: 6000 }, 6000], [{ maxOutputTokens: '6000', maxOutputTokensCap: '3000' }, 3000],
    [{ maxOutputTokensDefault: '2048' }, 2048], [{ maxOutputTokensCap: 500 }, 500],
  ])('preserves legacy resolver and transport options %j', async (options, expected) => {
    expect(resolveMaxOutputTokens(options)).toBe(expected);
    const stream = fakeStream();
    await streamProviderText(input(options, { stream }));
    expect(stream.mock.calls[0][0].maxOutputTokens).toBe(expected);
  });

  it('does not change the two legacy resolvers existing negative-value behavior', async () => {
    expect(resolveMaxOutputTokens({ maxOutputTokens: -1 })).toBe(-1);
    const stream = fakeStream();
    await streamProviderText(input({ maxOutputTokens: -1 }, { stream }));
    expect(stream.mock.calls[0][0].maxOutputTokens).toBe(1024);
  });

  it.each(calls)('omits SDK output cap for $label and keeps other controls', async ({ call }) => {
    const controller = new AbortController(), stream = fakeStream(), onText = vi.fn();
    const responseFormat = { type: 'json_schema', json_schema: { name: 'fixture',
      schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] } } };
    const result = await call(input({ ...policy, maxOutputTokensDefault: 1024, reasoningEffort: 'medium', responseFormat },
      { stream, onText, signal: controller.signal }));
    const options = stream.mock.calls[0][0];
    expect(Object.hasOwn(options, 'maxOutputTokens')).toBe(false);
    expect(options).toMatchObject({ maxRetries: 0, abortSignal: controller.signal,
      providerOptions: { openai: { store: false, reasoningEffort: 'medium' } } });
    expect(options.output).toBeDefined();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'success', model: 'fixture-model', usage: { outputTokens: 2 } });
    if (call === streamProviderText) expect(onText).toHaveBeenCalledWith('Synthetic response.');
    else expect(result.text).toBe('Synthetic response.');
  });

  it.each(calls)('omits the actual Responses JSON field for $label', async ({ call }) => {
    let body;
    const fetchFn = vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'synthetic stop' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    });
    await expect(call({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'synthetic-key',
      baseUrl: 'https://offline.invalid/v1', messages, fetchFn,
      options: { ...policy, maxOutputTokensDefault: '8192', reasoningEffort: 'medium' } }))
      .rejects.toMatchObject({ code: 'provider_http_error' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://offline.invalid/v1/responses');
    expect(Object.hasOwn(body, 'max_output_tokens')).toBe(false);
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', stream: true, store: false, reasoning: { effort: 'medium' } });
  });

  it.each(['maxOutputTokens', 'maxOutputTokensCap'].flatMap(key =>
    [37, '37', 0, null, -1, 'invalid'].map(value => ({ key, value }))))('rejects conflicting $key=$value', async ({ key, value }) => {
    const options = { ...policy, [key]: value }, stream = fakeStream();
    expect(() => resolveMaxOutputTokens(options)).toThrow('output_token_policy_conflict');
    await expect(streamProviderText(input(options, { stream })))
      .rejects.toMatchObject({ code: 'output_token_policy_conflict' });
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(['unlimited', '', null, false, 0])('rejects unknown policy %j without invoking a provider', async outputTokenPolicy => {
    const stream = fakeStream(), options = { outputTokenPolicy };
    expect(() => resolveMaxOutputTokens(options)).toThrow('output_token_policy_invalid');
    await expect(streamProviderText(input(options, { stream })))
      .rejects.toMatchObject({ code: 'output_token_policy_invalid' });
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(calls)('rejects Anthropic provider-default mode in $label', async ({ call }) => {
    const stream = fakeStream(), generate = vi.fn();
    await expect(call(input(policy, { provider: 'anthropic', stream, generate,
      modelFactory: () => ({ provider: 'anthropic', model: {} }) })))
      .rejects.toMatchObject({ code: 'output_token_policy_unsupported_provider' });
    expect(stream).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    [[{ type: 'text-delta', text: 'partial' }], 'incomplete_provider_stream'],
    [[{ type: 'tool-call' }], 'provider_protocol_error'],
    [[{ type: 'abort' }], 'provider_aborted'],
    [[{ type: 'reasoning-delta', text: 'private' }, ...success.slice(1)], 'provider_protocol_error'],
    [[{ type: 'text-delta', text: 'a'.repeat(2 * 1024 * 1024 + 1) }], 'provider_protocol_error'],
  ])('preserves stream safety checks', async (parts, code) => {
    const stream = fakeStream(parts);
    await expect(streamProviderText(input(policy, { stream }))).rejects.toMatchObject({ code });
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

describe('bounded executions cannot opt out of frozen output holds', () => {
  const limits = { models: ['fixture-model'], paths: [{ provider: 'openai', model: 'fixture-model' }],
    maxInputTokens: 4000, maxOutputTokens: 1000, maxCalls: 1, maxRetries: 0, deadlineMs: 60000 };
  const capabilities = { taskType: 'text', outputLimit: true, abort: true };
  const operation = { id: 'fixture-operation', taskType: 'text', createdAt: new Date().toISOString(), quote: { limits } };

  it.each(['provider_default', 'unknown'])('rejects %s during pure preflight and before usage writes', async outputTokenPolicy => {
    const request = { messages, options: { outputTokenPolicy } };
    expect(() => executionRequest({ taskType: 'text', limits, provider: 'openai', model: 'fixture-model',
      input: request, capabilities })).toThrow('execution_output_policy_unsupported');
    const store = { start: vi.fn(), observe: vi.fn() }, provider = vi.fn();
    const run = createBudgetedProvider({ operation, provider: 'openai', model: 'fixture-model', capabilities,
      invoke: createMeteredProvider({ store, operation, provider: 'openai', model: 'fixture-model', invoke: provider }) });
    await expect(run(request)).rejects.toMatchObject({ code: 'execution_output_policy_unsupported' });
    expect(store.start).not.toHaveBeenCalled(); expect(store.observe).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
});
