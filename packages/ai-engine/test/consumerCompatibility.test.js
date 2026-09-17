import { describe, it, expect, vi } from 'vitest';
import { createAgentRuntime, generateProviderText, normalizeSdkProviderResult, createSyntheticProviderResult } from '../index.js';

describe('cross-consumer public runtime compatibility', () => {
  it('passes prior released request to the domain retry adapter and preserves staged delivery', async () => {
    const old = { id: 'prior', attempt_no: 1 }, timeline = [];
    const prepare = vi.fn(async () => ({ request: { id: 'retry' } }));
    const runtime = createAgentRuntime({ domainPort: { prepare }, billingPort: {
      getRequest: async () => ({ disposition: 'released_retry', request: old }),
      reserve: async () => ({}), settle: async () => { timeline.push('settle'); return { status: 'settled' }; },
    }, streamPort: { streamProviderText: async ({ onText }) => { await onText('result'); return {}; } },
    validationPort: { createDelivery: () => ({ push: async () => {}, flush: async () => ({ visibleText: 'ready' }),
      commit: async ({ onCommit }) => { timeline.push('commit'); onCommit('ready'); } }) } });
    const result = await runtime({ request: { id: 'retry' } });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ existingRequest: old }));
    expect(result.output).toBe('ready'); expect(timeline).toEqual(['settle', 'commit']);
  });
  it('invokes product delivery abort on upstream failure before releasing credits', async () => {
    const timeline = [];
    const runtime = createAgentRuntime({ billingPort: { reserve: async () => ({}), release: async () => timeline.push('release') },
      streamPort: { streamProviderText: async () => { throw new Error('upstream failed'); } },
      validationPort: { createDelivery: () => ({ abort: async () => timeline.push('abort') }) } });
    await runtime({ request: {} }); expect(timeline).toEqual(['abort', 'release']);
  });
  it('supports forced-stream OpenAI transports for buffered generation', async () => {
    async function* chunks() {
      yield { type: 'text-delta', text: 'buffered' };
      yield { type: 'finish-step', response: { modelId: 'observed' } };
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 4, outputTokens: 2 } };
    }
    const generate = vi.fn();
    const result = await generateProviderText({ model: 'requested', modelFactory: () => ({ provider: 'openai', model: {} }),
      stream: () => ({ fullStream: chunks() }), generate });
    expect(generate).not.toHaveBeenCalled(); expect(result.text).toBe('buffered');
    expect(result.modelIdentitySource).toBe('provider_response'); expect(result.model).toBe('observed');
    expect(normalizeSdkProviderResult({}, { model: 'requested' }).modelIdentitySource).toBe('requested_fallback');
    expect(createSyntheticProviderResult().modelIdentitySource).toBe('synthetic_explicit');
  });
});
