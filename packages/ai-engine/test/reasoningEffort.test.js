import { describe, expect, it, vi } from 'vitest';
import { assertReasoningEffort, resolveReasoningEffort, streamOpenAIResponses } from '../index.js';

describe('new Responses reasoning efforts', () => {
  it.each(['xhigh', 'max'])('accepts %s in environment and explicit configuration', effort => {
    expect(resolveReasoningEffort({ REASONING_EFFORT: effort })).toBe(effort);
    expect(assertReasoningEffort(effort)).toBe(effort);
  });

  it.each(['gpt-6-luna', 'gpt-6.1-sol'])('passes max to %s without extra retries or storage', async model => {
    async function* chunks() {
      yield { type: 'text-delta', text: 'Synthetic response.' };
      yield { type: 'finish-step', response: { modelId: model } };
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 4, outputTokens: 2 } };
    }
    const stream = vi.fn(() => ({ fullStream: chunks() }));
    const onText = vi.fn();
    const result = await streamOpenAIResponses({ model, systemPrompt: 'Synthetic', messages: [],
      options: { reasoningEffort: 'max', maxOutputTokens: 1000 }, stream, onText,
      modelFactory: () => ({ provider: 'openai', model: {} }) });
    expect(result.model).toBe(model);
    expect(onText).toHaveBeenCalledWith('Synthetic response.');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0][0]).toMatchObject({ maxRetries: 0, maxOutputTokens: 1000,
      providerOptions: { openai: { reasoningEffort: 'max', store: false } } });
  });
});
