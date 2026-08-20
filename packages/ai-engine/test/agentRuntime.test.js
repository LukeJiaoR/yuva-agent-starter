import { describe, it, expect, vi } from 'vitest';
import {
  createAgentRuntime,
  AgentRuntimeError,
  classifyRuntimeError,
} from '../index.js';

describe('@yuva/ai-engine AgentRuntime', () => {
  it('executes full streaming lifecycle via injected ports', async () => {
    const events = [];
    const mockEmitter = {
      emit: (type, data) => events.push({ type, data }),
    };

    const runtime = createAgentRuntime();

    const result = await runtime({
      request: { id: 'req-1', clientRequestId: 'req-1', pipelineRunId: 'pipe-1' },
      user: { id: 'user-1' },
      db: {},
      billingPort: {
        reserve: vi.fn().mockResolvedValue({ id: 'res-1', credits: 1 }),
        settle: vi.fn().mockResolvedValue({ status: 'settled', settledCredits: 1 }),
        release: vi.fn(),
      },
      contextPort: {
        resolveContext: vi.fn().mockResolvedValue({ userFacts: [] }),
        allocateBudget: vi.fn().mockReturnValue({ diagnostics: {} }),
      },
      promptPort: {
        composePrompt: vi.fn().mockResolvedValue({ messages: [{ role: 'user', content: 'hello' }] }),
      },
      streamPort: {
        createEmitter: () => mockEmitter,
        emitStart: (em) => em.emit('start', { status: 'started' }),
        emitTextDelta: (em, delta) => em.emit('text_delta', { delta }),
        emitDone: (em) => em.emit('done', { status: 'delivered' }),
        streamProviderText: async ({ onText }) => {
          await onText('Hello ');
          await onText('World');
          return { finishReason: 'stop', usage: { totalTokens: 10 } };
        },
      },
      memoryPort: {
        persistCandidate: vi.fn().mockResolvedValue(true),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.streamed).toBe(true);
    expect(result.output).toBe('Hello World');
    expect(result.settlement.status).toBe('settled');
    expect(events.length).toBe(4); // start, 2 deltas, done
  });

  it('enforces validation-before-delivery: raw text is buffered and only approved chunks are committed to client', async () => {
    const emittedDeltas = [];
    const mockEmitter = {
      emit: (type, data) => {
        if (type === 'text_delta') emittedDeltas.push(data.delta);
      },
    };

    const runtime = createAgentRuntime();

    const result = await runtime({
      request: { id: 'req-v' },
      user: { id: 'user-1' },
      streamPort: {
        createEmitter: () => mockEmitter,
        emitTextDelta: (em, delta) => em.emit('text_delta', { delta }),
        streamProviderText: async ({ onText }) => {
          await onText('RAW_UNVALIDATED_CHUNK');
          return { finishReason: 'stop' };
        },
      },
      validationPort: {
        createDelivery: ({ onCommit }) => ({
          push: async (rawDelta) => {
            // Buffer/validate and commit sanitised/rewritten delta
            onCommit(rawDelta.replace('RAW_UNVALIDATED', 'VALIDATED_SAFE'));
          },
          flush: async () => {},
        }),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.output).toBe('VALIDATED_SAFE_CHUNK');
    expect(emittedDeltas).toEqual(['VALIDATED_SAFE_CHUNK']);
  });

  it('guarantees zero-commit rejection: authoritative output is empty and raw text never leaks to settlement or memory', async () => {
    const emittedDeltas = [];
    const mockEmitter = {
      emit: (type, data) => {
        if (type === 'text_delta') emittedDeltas.push(data.delta);
      },
    };
    const settleMock = vi.fn().mockResolvedValue({ status: 'settled' });
    const memoryMock = vi.fn().mockResolvedValue(true);

    const runtime = createAgentRuntime();

    const result = await runtime({
      request: { id: 'req-rejected' },
      user: { id: 'user-1' },
      billingPort: {
        settle: settleMock,
      },
      memoryPort: {
        persistCandidate: memoryMock,
      },
      streamPort: {
        createEmitter: () => mockEmitter,
        emitTextDelta: (em, delta) => em.emit('text_delta', { delta }),
        streamProviderText: async ({ onText }) => {
          await onText('HIGHLY_UNSAFE_PROMPT_INJECTION_TEXT');
          return { finishReason: 'stop' };
        },
      },
      validationPort: {
        createDelivery: () => ({
          push: async () => {
            // Rejects all text, never calls onCommit
          },
          flush: async () => {},
        }),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.output).toBe('');
    expect(emittedDeltas).toEqual([]);
    expect(settleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        output: '',
      }),
    );
    expect(memoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        output: '',
      }),
    );
  });


  it('guarantees billing invariant: settle() success NEVER triggers release() even on subsequent errors', async () => {
    const releaseMock = vi.fn();
    const runtime = createAgentRuntime();

    const result = await runtime({
      request: { id: 'req-settle-guard' },
      user: { id: 'user-1' },
      billingPort: {
        reserve: vi.fn().mockResolvedValue({ id: 'res-guard' }),
        settle: vi.fn().mockResolvedValue({ status: 'settled' }),
        release: releaseMock,
      },
      streamPort: {
        streamProviderText: async () => ({ finishReason: 'stop' }),
        emitDone: () => {
          throw new Error('Socket closed during terminal event emission');
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('passes context budget calculation explicitly to prompt composition', async () => {
    const composePromptMock = vi.fn().mockResolvedValue({ messages: [] });
    const runtime = createAgentRuntime();

    await runtime({
      request: { id: 'req-budget' },
      user: { id: 'user-1' },
      contextPort: {
        resolveContext: vi.fn().mockResolvedValue({ rawData: '123' }),
        allocateBudget: vi.fn().mockReturnValue({
          context: { budgetedData: '123' },
          diagnostics: { budget_tokens: 5000 },
        }),
      },
      promptPort: {
        composePrompt: composePromptMock,
      },
      streamPort: {
        streamProviderText: async () => ({ finishReason: 'stop' }),
      },
    });

    expect(composePromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { budgetedData: '123' },
        budget: expect.objectContaining({
          diagnostics: { budget_tokens: 5000 },
        }),
      }),
    );
  });

  it('handles reservation rejection without invoking provider', async () => {
    const runtime = createAgentRuntime();
    const streamProviderText = vi.fn();

    const result = await runtime({
      request: { id: 'req-2' },
      user: { id: 'user-1' },
      billingPort: {
        reserve: vi.fn().mockResolvedValue({ rejected: true, status: 402, code: 'insufficient_credits' }),
      },
      streamPort: {
        streamProviderText,
      },
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(402);
    expect(result.code).toBe('insufficient_credits');
    expect(streamProviderText).not.toHaveBeenCalled();
  });

  it('releases reserved credits on stream error when not settled', async () => {
    const releaseMock = vi.fn();
    const runtime = createAgentRuntime();

    const result = await runtime({
      request: { id: 'req-3' },
      user: { id: 'user-1' },
      billingPort: {
        reserve: vi.fn().mockResolvedValue({ id: 'res-3' }),
        release: releaseMock,
      },
      streamPort: {
        streamProviderText: async () => {
          throw new Error('Connection timeout to LLM provider');
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.error).toBeDefined();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('classifies runtime error accurately based on abort reason', () => {
    const stopError = classifyRuntimeError(new Error('Interrupted'), 'user_stop', 'generation');
    expect(stopError.failureClass).toBe('user_stop');
    expect(stopError.status).toBe(200);

    const clientDisconnect = classifyRuntimeError(new Error('Closed'), 'client_disconnect', 'generation');
    expect(clientDisconnect.failureClass).toBe('client_disconnect');
    expect(clientDisconnect.retryable).toBe(true);
  });
});
