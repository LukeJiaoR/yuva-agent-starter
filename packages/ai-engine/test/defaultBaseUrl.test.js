import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderModel, streamProviderText } from '../index.js';

beforeEach(() => {
  vi.stubEnv('OPENAI_BASE_URL', undefined);
  vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
});
afterEach(() => vi.unstubAllEnvs());

function offlineFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Offline fixture' } }), {
    status: 400, headers: { 'content-type': 'application/json' },
  }));
}
async function request({ baseUrl, fetchFn = offlineFetch(), modelFactory } = {}) {
  await expect(streamProviderText({ provider: 'openai', apiKey: 'synthetic-fixture-key', model: 'gpt-4o',
    baseUrl, fetchFn, modelFactory, messages: [{ role: 'user', content: 'Fixture' }], onText: vi.fn() }))
    .rejects.toMatchObject({ name: 'AskProviderStreamError' });
  return fetchFn;
}

describe('OpenAI base URL defaults and explicit override precedence', () => {
  it.each([undefined, null, '', '   '])('uses the official endpoint when explicit URL is %s', async (baseUrl) => {
    const fetch = await request({ baseUrl });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.openai.com/v1/responses');
  });

  it.each(['', '   '])('treats blank environment URL %s as unconfigured', async (value) => {
    vi.stubEnv('OPENAI_BASE_URL', value);
    const fetch = await request();
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.openai.com/v1/responses');
  });

  it.each([undefined, null, '', '   '])('uses a configured environment endpoint when explicit URL is %s', async (baseUrl) => {
    vi.stubEnv('OPENAI_BASE_URL', ' https://environment.invalid/v1/responses/ ');
    const fetch = await request({ baseUrl });
    expect(String(fetch.mock.calls[0][0])).toBe('https://environment.invalid/v1/responses');
  });

  it.each(['https://explicit.invalid/v1', ' https://explicit.invalid/v1/// ',
    'https://explicit.invalid/v1/responses/', 'https://explicit.invalid/v1/chat/completions/'])
    ('preserves explicit endpoint normalization and priority: %s', async (baseUrl) => {
      vi.stubEnv('OPENAI_BASE_URL', 'https://environment.invalid/v1');
      const fetch = await request({ baseUrl });
      expect(String(fetch.mock.calls[0][0])).toBe('https://explicit.invalid/v1/responses');
    });

  it.each(['explicit', 'environment'])('does not silently replace a malformed nonempty %s URL with the official endpoint', async (source) => {
    if (source === 'environment') vi.stubEnv('OPENAI_BASE_URL', 'not-a-url');
    const fetchFn = vi.fn(async (url) => { new Request(url); throw new Error('Unexpected valid fixture URL'); });
    await request({ baseUrl: source === 'explicit' ? 'not-a-url' : undefined, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toBe('not-a-url/responses');
  });

  it.each(['/', '///', '/responses', '/chat/completions'].flatMap((value) =>
    ['explicit', 'environment'].map((source) => ({ value, source }))))
    ('does not convert invalid $source URL $value into the official default during normalization', ({ value, source }) => {
      if (source === 'environment') vi.stubEnv('OPENAI_BASE_URL', value);
      expect(() => createProviderModel({ provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-fixture-key',
        baseUrl: source === 'explicit' ? value : undefined })).toThrow('baseURL must be a non-empty string');
    });

  it('resolves environment URL once when the model is constructed', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://original.invalid/v1');
    const fetchFn = offlineFetch();
    const config = createProviderModel({ provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-fixture-key', fetchFn });
    vi.stubEnv('OPENAI_BASE_URL', 'https://changed.invalid/v1');
    await request({ fetchFn, modelFactory: () => config });
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://original.invalid/v1/responses');
  });

  it('does not apply OpenAI URL defaults to Anthropic', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai-only.invalid/v1');
    const fetchFn = offlineFetch();
    await expect(streamProviderText({ provider: 'anthropic', model: 'claude-fixture', apiKey: 'synthetic-fixture-key',
      fetchFn, messages: [{ role: 'user', content: 'Fixture' }], onText: vi.fn() }))
      .rejects.toMatchObject({ name: 'AskProviderStreamError' });
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://api.anthropic.com/v1/messages');
  });
});
