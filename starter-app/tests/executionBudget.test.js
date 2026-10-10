import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { createOperationStore, grantCredits } from '@yuva/billing-core';
import { createBudgetedProvider, createMeteredProvider, executionRequest, streamProviderText } from '@yuva/ai-engine';
import { createUsageStore } from '../server/stores/usageStore.js';
import { isolatedDatabase, operationFixture, quoteFixture } from './helpers/database.js';

const capabilities = { taskType: 'text', outputLimit: true, abort: true };
const limits = () => ({ models: ['fixture'], paths: [{ provider: 'fixture', model: 'fixture' }],
  maxCalls: 3, maxRetries: 1, maxInputTokens: 1000, maxOutputTokens: 50, deadlineMs: 10000 });
const input = () => ({ messages: [{ role: 'user', content: 'Hello' }] });

describe('durable execution budget', () => {
  let db, close, accountId, store;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
    store = createUsageStore({ db });
  });
  async function setup({ policyId = 'fixed', overrides = {}, invoke = async () => ({ usage: { source: 'provider', inputTokens: 3, outputTokens: 2 } }) } = {}) {
    const quote = { ...quoteFixture(), policyId, limits: { ...limits(), ...overrides } };
    const { operation } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote });
    const run = () => createBudgetedProvider({ operation, provider: 'fixture', model: 'fixture', capabilities,
      invoke: createMeteredProvider({ store, operation, provider: 'fixture', model: 'fixture', invoke }) });
    return { operation, run: run(), recreate: run, summary: () => store.summary({ operationId: operation.id, accountId }) };
  }
  it.each(['fixed', 'token'])('limits %s calls and records a failure, retry and success one-to-one', async (policyId) => {
    const invoke = vi.fn().mockResolvedValueOnce({ outcome: 'safety_refusal' }).mockResolvedValue({ usage: { source: 'provider', inputTokens: 1, outputTokens: 1 } });
    const { run, summary } = await setup({ policyId, invoke });
    const first = await run(input());
    await run({ ...input(), retryOf: first.callId });
    await run(input());
    await expect(run(input())).rejects.toMatchObject({ code: 'execution_calls_exceeded' });
    expect(invoke).toHaveBeenCalledTimes(3);
    const facts = (await summary()).calls;
    expect(facts.map((c) => c.callKind)).toEqual(['primary', 'retry', 'primary']);
    expect(facts[0].outcome).toBe('failed');
    expect(facts[1].retryOf).toBe(first.callId);
    expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(0);
  });
  it('enforces aggregate worst-case holds even when usage is missing', async () => {
    const invoke = vi.fn(async () => ({}));
    const { run, recreate, summary } = await setup({ overrides: { maxTotalOutputTokens: 75 }, invoke });
    await run(input());
    await expect(recreate()(input())).rejects.toMatchObject({ code: 'execution_resources_exceeded' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((await summary()).calls[0].budgetResources.outputTokens).toBe(50);
    expect((await summary()).calls[0].metrics.outputTokens.value).toBeNull();
  });
  it('rejects provider-default output policy before durable usage or provider invocation', async () => {
    const invoke = vi.fn(async () => ({}));
    const { run, summary } = await setup({ invoke });
    await expect(run({ ...input(), options: { outputTokenPolicy: 'provider_default' } }))
      .rejects.toMatchObject({ code: 'execution_output_policy_unsupported' });
    expect(invoke).not.toHaveBeenCalled();
    expect((await summary()).calls).toEqual([]);
    await run(input());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((await summary()).calls[0].budgetResources.outputTokens).toBe(50);
  });
  it('checks context growth, model fallback, retries and frozen authorization before upstream', async () => {
    const invoke = vi.fn(async () => ({ outcome: 'safety_refusal' }));
    const { run, summary, operation } = await setup({ invoke, overrides: { maxRetries: 0 } });
    await expect(run({ messages: [{ role: 'user', content: 'x'.repeat(2000) }] })).rejects.toMatchObject({ code: 'execution_input_exceeded' });
    await expect(run({ ...input(), model: 'bigger' })).rejects.toMatchObject({ code: 'execution_model_forbidden' });
    await expect(run({ ...input(), options: { maxOutputTokens: 51 } })).rejects.toMatchObject({ code: 'execution_output_exceeded' });
    const failed = await run(input());
    await expect(run(input())).rejects.toMatchObject({ code: 'execution_retry_required' });
    await expect(run({ ...input(), retryOf: failed.callId })).rejects.toMatchObject({ code: 'execution_retries_exceeded' });
    expect((await summary()).calls).toHaveLength(1);
    await expect(store.start({ callId: randomUUID(), operationId: operation.id, accountId, provider: 'fixture', model: 'fixture', attempt: 1 }))
      .rejects.toMatchObject({ code: 'execution_authorization_missing' });
    await db.query("UPDATE credit_usage_requests SET status='released' WHERE id=$1", [operation.ledgerRequestId]);
    await expect(run(input())).rejects.toMatchObject({ code: 'execution_authorization_missing' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent coordinators through durable starts without a provider-time transaction', async () => {
    let unblock, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const wait = new Promise((resolve) => { unblock = resolve; });
    const invoke = vi.fn(async () => { entered(); await wait; return {}; });
    const { run, recreate, operation } = await setup({ invoke });
    const first = run(input());
    await started;
    try {
      await expect(recreate()(input())).rejects.toMatchObject({ code: 'execution_outcome_unknown' });
      // A second connection can acquire the operation lock while the provider is running.
      const client = await db.connect();
      try { await client.query('BEGIN'); await client.query('SELECT id FROM ai_operations WHERE id=$1 FOR UPDATE NOWAIT', [operation.id]); }
      finally { await client.query('ROLLBACK'); client.release(); }
    } finally { unblock(); await first; }
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('retains unknown external outcome after timeout and prevents resubmission after restart', async () => {
    const invoke = vi.fn(async ({ signal }) => {
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('timeout'), { code: 'provider_aborted' });
    });
    const { run, recreate, summary } = await setup({ invoke, overrides: { deadlineMs: 1000 } });
    await expect(run(input())).rejects.toThrow('timeout');
    const call = (await summary()).calls[0];
    expect(call.externalStatus).toBe('unknown');
    expect(call.metrics.inputTokens.value).toBeNull();
    await expect(recreate()(input())).rejects.toMatchObject({ code: 'execution_deadline_exceeded' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('does not treat local cancellation as a confirmed zero-cost external failure', async () => {
    const invoke = vi.fn(async ({ signal }) => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { code: 'provider_aborted' });
    });
    const controller = new AbortController();
    const { run, recreate, summary } = await setup({ invoke });
    await expect(run({ ...input(), signal: controller.signal })).rejects.toThrow('aborted');
    expect((await summary()).calls[0].externalStatus).toBe('unknown');
    await expect(recreate()(input())).rejects.toMatchObject({ code: 'execution_outcome_unknown' });
  });
  it.each(['image', 'video'])('runs bounded %s fixtures through the same durable coordinator', async (taskType) => {
    const quote = { ...quoteFixture(), limits: { ...limits(), maxImages: 3, maxDurationMs: 1500, specs: { width: 1024 }, maxCalls: 1, maxRetries: 0 } };
    delete quote.limits.maxInputTokens; delete quote.limits.maxOutputTokens;
    const { operation } = await createOperationStore({ db, capabilities: [{ taskType, mode: 'async' }] })
      .reserve({ operation: operationFixture(accountId, randomUUID(), taskType), quote });
    const invoke = vi.fn(async () => ({}));
    const run = createBudgetedProvider({ operation, provider: 'fixture', model: 'fixture', capabilities: { taskType, outputLimit: true, abort: true },
      invoke: createMeteredProvider({ store, operation, provider: 'fixture', model: 'fixture', invoke }) });
    const media = { [taskType === 'image' ? 'images' : 'durationMs']: 2, specs: { width: 1024 } };
    await run(media);
    await expect(run(media)).rejects.toMatchObject({ code: 'execution_calls_exceeded' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('budget capability and adapter contracts', () => {
  it.each([['openai', 'max_output_tokens'], ['anthropic', 'max_tokens']])('maps %s output limits through the installed SDK transport', async (provider, field) => {
    const requests = [];
    const fetchFn = vi.fn(async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    });
    await expect(streamProviderText({ provider, model: provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-20250514',
      apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1', fetchFn, messages: input().messages,
      options: { maxOutputTokens: 37 } })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(requests[0][field]).toBe(37);
  });
  it.each(['image', 'video'])('validates %s quantity and frozen specifications without token limits', (taskType) => {
    const mediaLimits = { ...limits(), maxImages: 3, maxDurationMs: 1500, specs: { width: 1024 } };
    delete mediaLimits.maxInputTokens; delete mediaLimits.maxOutputTokens;
    const field = taskType === 'image' ? 'images' : 'durationMs';
    const args = { taskType, limits: mediaLimits, provider: 'fixture', model: 'fixture',
      input: { [field]: 2, specs: { width: 1024 } }, capabilities: { taskType, outputLimit: true, abort: true } };
    expect(executionRequest(args)[field]).toBe(2);
    expect(() => executionRequest({ ...args, input: { ...args.input, [field]: 5000 } })).toThrow('execution_media_exceeded');
    expect(() => executionRequest({ ...args, input: { ...args.input, specs: { width: 2048 } } })).toThrow('execution_specs_forbidden');
    expect(() => executionRequest({ ...args, capabilities: { taskType, outputLimit: false, abort: true } })).toThrow('execution_capability_unsupported');
  });
  it('passes the frozen output limit, disables SDK retries and propagates deadline cancellation', async () => {
    const controller = new AbortController();
    async function* chunks() {
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'finish-step', usage: {}, response: {} };
      yield { type: 'finish', finishReason: 'stop' };
    }
    const stream = vi.fn(() => ({ fullStream: chunks() }));
    await streamProviderText({ provider: 'openai', model: 'fixture', messages: input().messages, signal: controller.signal,
      options: { maxOutputTokens: 37, maxOutputTokensCap: 37 }, modelFactory: () => ({ provider: 'openai', model: {} }), stream });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 37, maxRetries: 0, abortSignal: controller.signal }));
  });
});
