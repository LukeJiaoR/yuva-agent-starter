import { describe, it, expect, vi } from 'vitest';
import {
  countUnicodeTokens,
  normalizeText,
  resolveOpenAIChatModel,
  resolveReasoningEffort,
  assertReasoningEffort,
  normalizeSdkProviderResult,
  missingProviderUsage,
  createSyntheticProviderResult,
  createStreamEmitter,
  writeSseEvent,
  setSseHeaders,
  StreamDisconnectedError,
} from '../index.js';

describe('@yuva/ai-engine', () => {
  describe('tokenizer primitives', () => {
    it('normalizes unicode text and counts tokens accurately', () => {
      const text = '  Hello World! 你好世界  ';
      const normalized = normalizeText(text);
      expect(normalized).toBe('Hello World! 你好世界');

      const count = countUnicodeTokens(text);
      expect(count).toBeGreaterThan(0);
      expect(countUnicodeTokens('')).toBe(0);
      expect(countUnicodeTokens(null)).toBe(0);
    });
  });

  describe('modelConfig primitives', () => {
    it('resolves model configs with defaults and environment overrides', () => {
      const defaultModel = resolveOpenAIChatModel({});
      expect(defaultModel).toBe('');

      const customModel = resolveOpenAIChatModel({ OPENAI_CHAT_MODEL: 'custom-llm-v1' });
      expect(customModel).toBe('custom-llm-v1');

      const effort = resolveReasoningEffort({}, 'REASONING_EFFORT', 'medium');
      expect(effort).toBe('medium');
      expect(assertReasoningEffort('high')).toBe('high');
    });

    it('throws error for invalid reasoning effort', () => {
      expect(() => resolveReasoningEffort({ REASONING_EFFORT: 'invalid_effort' })).toThrow();
      expect(() => assertReasoningEffort('invalid_effort')).toThrow();
    });
  });

  describe('providerUsage primitives', () => {
    it('provides default structure for missing provider usage', () => {
      const missing = missingProviderUsage();
      expect(missing.inputTokens).toBeNull();
      expect(missing.outputTokens).toBeNull();
      expect(missing.source).toBe('missing');
    });

    it('normalizes sdk provider results correctly', () => {
      const normalized = normalizeSdkProviderResult(
        {
          text: 'Assistant response',
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 20 },
        },
        { provider: 'openai', model: 'gpt-5.6' },
      );

      expect(normalized.text).toBe('Assistant response');
      expect(normalized.provider).toBe('openai');
      expect(normalized.outcome).toBe('success');
      expect(normalized.usage.inputTokens).toBe(50);
      expect(normalized.usage.outputTokens).toBe(20);
      expect(normalized.usage.source).toBe('provider');
    });

    it('creates synthetic provider result for testing and fallback', () => {
      const synthetic = createSyntheticProviderResult({
        text: 'Fallback text',
        provider: 'synthetic-test',
      });
      expect(synthetic.provider).toBe('synthetic-test');
      expect(synthetic.outcome).toBe('success');
      expect(synthetic.usage.source).toBe('synthetic');
    });
  });

  describe('streamEmitter primitives', () => {
    it('emits lifecycle events and tracks stream state', () => {
      const events = [];
      const emitter = createStreamEmitter({
        version: '1.0',
        requestId: 'req-12345',
        write: (evt) => events.push(evt),
      });

      emitter.emit('start', { status: 'running' });
      emitter.emit('text_delta', { text: 'Hello' });
      emitter.emit('done', { status: 'completed' });

      expect(emitter.started).toBe(true);
      expect(emitter.terminal).toBe(true);
      expect(events.length).toBe(3);
      expect(events[0].type).toBe('start');
      expect(events[0].request_id).toBe('req-12345');
    });

    it('handles disconnection error when stream is closed', () => {
      const emitter = createStreamEmitter({
        write: () => {},
        isOpen: () => false,
      });

      expect(() => {
        emitter.emit('start', { status: 'running' });
      }).toThrow(StreamDisconnectedError);
    });
  });
});
