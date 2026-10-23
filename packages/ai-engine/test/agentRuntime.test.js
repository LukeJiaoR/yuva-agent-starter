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

  it('enforces validation and settlement before approved output is committed to the client', async () => {
    const emittedDeltas = [];
    const lifecycle = [];
    const mockEmitter = {
      emit: (type, data) => {
        if (type === 'text_delta') emittedDeltas.push(data.delta);
      },
    };

    const runtime = createAgentRuntime();

    const result = await runtime({
      request: { id: 'req-v' },
      user: { id: 'user-1' },
      billingPort: {
        settle: async () => {
          lifecycle.push('settled');
          return { status: 'settled' };
        },
      },
      streamPort: {
        createEmitter: () => mockEmitter,
        emitTextDelta: (em, delta) => em.emit('text_delta', { delta }),
        streamProviderText: async ({ onText }) => {
          await onText('RAW_UNVALIDATED_CHUNK');
          return { finishReason: 'stop' };
        },
      },
      validationPort: {
        createDelivery: () => ({
          push: async () => {},
          flush: async () => ({ visibleText: 'VALIDATED_SAFE_CHUNK' }),
          commit: async ({ deliveryResult, onCommit }) => {
            lifecycle.push('delivered');
            onCommit(deliveryResult.visibleText);
          },
        }),
      },
    });

    expect(result.handled).toBe(true);
    expect(result.output).toBe('VALIDATED_SAFE_CHUNK');
    expect(emittedDeltas).toEqual(['VALIDATED_SAFE_CHUNK']);
    expect(lifecycle).toEqual(['settled', 'delivered']);
  });

  it('does not commit staged output when settlement fails', async () => {
    const emittedDeltas = [];
    const release = vi.fn();
    const runtime = createAgentRuntime();

    const result = await runtime({
      request: { id: 'req-settlement-failure' },
      user: { id: 'user-1' },
      billingPort: {
        reserve: async () => ({ id: 'reservation-1' }),
        settle: async () => { throw new Error('database settlement failed'); },
        release,
      },
      streamPort: {
        createEmitter: () => ({}),
        emitTextDelta: (_emitter, delta) => emittedDeltas.push(delta),
        streamProviderText: async ({ onText }) => {
          await onText('raw');
          return { finishReason: 'stop' };
        },
      },
      validationPort: {
        createDelivery: () => ({
          push: async () => {},
          flush: async () => ({ visibleText: 'approved' }),
          commit: async ({ deliveryResult, onCommit }) => onCommit(deliveryResult.visibleText),
        }),
      },
    });

    expect(result.terminalStatus).toBe('released');
    expect(emittedDeltas).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
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

describe('runtime error diagnostic boundary', () => {
  it('keeps raw exceptions available to internal classification without copying them into default logs', async () => {
    const privateDetail = 'SYNTHETIC_PRIVATE_PROVIDER_SQL_DETAIL';
    const original = Object.assign(new Error(privateDetail), { code: privateDetail, statusCode: 503, retryable: true });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const classify = vi.fn((error, reason, phase) => classifyRuntimeError(error, reason, phase));
    const result = await createAgentRuntime({ billingPort: { getRequest: async () => { throw original; } } })({ logger, errorPort: { classify } });
    expect(classify).toHaveBeenCalledWith(original, expect.any(Function), 'preflight');
    expect(result).toMatchObject({ statusCode: 503, retryable: true, terminalStatus: 'unreserved' });
    expect(JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls])).not.toContain(privateDetail);
  });
  it('does not log private hook or reconciliation exception messages or codes', async () => {
    const privateDetail = 'SYNTHETIC_PRIVATE_HOOK_DETAIL';
    const fail = async () => { throw Object.assign(new Error(privateDetail), { code: privateDetail }); };
    const logger = { error: vi.fn(), warn: vi.fn() };
    await createAgentRuntime({ billingPort: { reserve: async () => ({}), onFailure: fail },
      validationPort: { createDelivery: () => ({ abort: fail }) }, streamPort: { streamProviderText: fail } })({ logger });
    await createAgentRuntime({ billingPort: { settle: async () => ({ status: 'settled' }) },
      memoryPort: { persistCandidate: fail }, telemetryPort: { record: fail },
      streamPort: { createEmitter: () => ({}), emitDone() { throw new Error(privateDetail); } } })({ logger });
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls])).not.toContain(privateDetail);
  });
});
