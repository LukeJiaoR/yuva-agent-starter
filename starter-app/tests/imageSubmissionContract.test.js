import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationStore, createOperationSettlementStore, grantCredits } from '@yuva/billing-core';
import { createUsageStore } from '../server/stores/usageStore.js';
import { prepareImageGeneration, missingImageObservation, IMAGE_PROVIDER, IMAGE_MODEL } from '../server/domain/imageGenerationContract.js';
import { createImageGenerationsAdapter } from '../server/providers/imageGenerations.js';
import { isolatedDatabase } from './helpers/database.js';
import { imageProfile, imageInput, imageResponse } from './fixtures/imageGeneration.js';

// CONTRACT HARNESS ONLY: intentionally not imported into application composition.
// Existing operations never invoke again, even if their durable start ACK was lost.
async function submit({ db, accountId, key, input = imageInput(), profile = imageProfile(), transport, start, beforeStart, now = Date.now }) {
  const prepared = prepareImageGeneration({ profile, accountId, clientRequestId: key, input });
  const operations = createOperationStore({ db, capabilities: [{ taskType: 'image', mode: 'sync' }] });
  const existing = await operations.find({ accountId, clientRequestId: key, operation: prepared.operation });
  if (existing) return { existing };
  const reservation = await operations.reserve(prepared);
  if (reservation.kind !== 'reserved') return { existing: reservation.operation };
  const operation = reservation.operation, callId = randomUUID(), usage = createUsageStore({ db });
  const identity = { operationId: operation.id, accountId, expectedEpoch: operation.executionEpoch };
  await beforeStart?.(operation);
  // This must resolve after COMMIT, before any transport handoff. A thrown start is never retried.
  await (start ?? usage.start)({ ...identity, callId, attempt: 1, provider: IMAGE_PROVIDER, model: IMAGE_MODEL,
    requestedMetrics: { images: { value: 1, unit: 'image', source: 'estimate' } },
    executionBudget: { kind: 'primary', resources: { images: 1, specs: operation.quote.limits.specs } } });
  let result;
  try {
    const remainingMs = new Date(operation.createdAt).getTime() + operation.quote.limits.deadlineMs - now();
    if (remainingMs <= 0) throw Object.assign(new Error('image_deadline_exceeded'), { code: 'image_deadline_exceeded' });
    result = await createImageGenerationsAdapter({ transport })({ request: prepared.request,
      signal: AbortSignal.timeout(remainingMs) });
    await usage.observe({ callId, accountId, observation: result.observation });
  } catch (error) {
    await usage.observe({ callId, accountId, observation: error.observation ?? missingImageObservation() });
    await createOperationSettlementStore({ db }).markReconciliation({ ...identity, reason: 'image_submission_unknown' });
    throw error;
  }
  // Bytes are not fulfillment. Storage and settlement are outside this slice.
  return { operation, callId, result };
}

describe('real PostgreSQL image submission contract', () => {
  let db, close, accountId, key;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID(); key = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
  });
  const run = (extra = {}) => submit({ db, accountId, key, transport: async () => imageResponse(), ...extra });
  it('commits exactly one call before transport and persists only the input fingerprint', async () => {
    const transport = vi.fn(async () => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT c.* FROM ai_provider_calls c JOIN ai_operations o ON o.id=c.operation_id WHERE o.account_id=$1', [accountId]);
        expect(rows).toHaveLength(1); expect(rows[0].outcome).toBe('started');
        await client.query('SELECT id FROM ai_operations WHERE account_id=$1 FOR UPDATE NOWAIT', [accountId]);
      } finally { await client.query('ROLLBACK'); client.release(); }
      return imageResponse();
    });
    const first = await run({ transport });
    expect(first.result.observation.externalStatus).toBe('completed');
    expect((await run({ transport })).existing.id).toBe(first.operation.id);
    expect(transport).toHaveBeenCalledTimes(1);
    const row = (await db.query('SELECT * FROM ai_operations WHERE id=$1', [first.operation.id])).rows[0];
    expect(row.input_fingerprint).toMatch(/^[a-f0-9]{64}$/u); expect(JSON.stringify(row)).not.toContain('Synthetic pixel');
    expect(row.fulfillment_status).not.toBe('ready'); expect(row.financial_status).toBe('reserved');
    expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(0);
  });
  it('blocks concurrent duplicate and changed input; original quote survives profile price edits', async () => {
    let enter, finish; const entered = new Promise((resolve) => { enter = resolve; }); const pending = new Promise((resolve) => { finish = resolve; });
    const transport = vi.fn(async () => { enter(); await pending; return imageResponse(); });
    const first = run({ transport }); await entered;
    try {
      const replay = await run({ transport, profile: { ...imageProfile(), fixedCredits: 9 } });
      expect(replay.existing.quote.reserveCredits).toBe(2);
      await expect(run({ transport, input: { ...imageInput(), prompt: 'different' } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    } finally { finish(); await first; }
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['throw', 'committed ACK lost'])('makes zero transport calls when start %s', async (mode) => {
    const transport = vi.fn();
    const start = async (args) => {
      if (mode === 'committed ACK lost') await createUsageStore({ db }).start(args);
      throw new Error('start ACK unavailable');
    };
    await expect(run({ transport, start })).rejects.toThrow('start ACK unavailable');
    expect((await run({ transport })).existing).toBeTruthy(); expect(transport).not.toHaveBeenCalled();
    const { rows } = await db.query('SELECT c.* FROM ai_provider_calls c JOIN ai_operations o ON o.id=c.operation_id WHERE o.account_id=$1', [accountId]);
    expect(rows).toHaveLength(mode === 'throw' ? 0 : 1);
  });
  it('refuses expired absolute deadline after a delayed durable start ACK', async () => {
    const transport = vi.fn();
    let acknowledgedAt;
    const start = async (args) => {
      await createUsageStore({ db }).start(args);
      // Simulate the caller receiving the ACK only after its absolute deadline.
      const { rows: [row] } = await db.query('SELECT created_at FROM ai_operations WHERE id=$1', [args.operationId]);
      acknowledgedAt = new Date(row.created_at).getTime() + imageProfile().deadlineMs;
    };
    await expect(run({ transport, start, now: () => acknowledgedAt }))
      .rejects.toMatchObject({ code: 'image_deadline_exceeded' });
    expect(transport).not.toHaveBeenCalled();
    const replay = await run({ transport });
    expect(replay.existing.executionStatus).toBe('submission_unknown');
    expect(replay.existing.financialStatus).toBe('reconciliation_required');
  });
  it('rejects stale epoch before invocation', async () => {
    const transport = vi.fn();
    await expect(run({ transport, beforeStart: async (operation) => db.query('UPDATE ai_operations SET execution_epoch=execution_epoch+1 WHERE id=$1', [operation.id]) }))
      .rejects.toMatchObject({ code: 'execution_fenced' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'abort', 'malformed'])('retains %s as unknown and blocks restart resubmission', async (mode) => {
    const transport = vi.fn(async () => {
      if (mode === 'malformed') return { status: 200, body: Buffer.from('{}') };
      throw Object.assign(new Error(mode), { name: mode === 'timeout' ? 'TimeoutError' : 'AbortError' });
    });
    await expect(run({ transport })).rejects.toMatchObject({ observation: { outcome: 'unknown' } });
    const replay = await run({ transport });
    expect(replay.existing.executionStatus).toBe('submission_unknown');
    expect(replay.existing.financialStatus).toBe('reconciliation_required');
    expect(transport).toHaveBeenCalledTimes(1);
    const summary = await createUsageStore({ db }).summary({ operationId: replay.existing.id, accountId });
    expect(summary.calls[0]).toMatchObject({ outcome: 'unknown', externalStatus: 'unknown', cost: null });
    expect(summary.costComplete).toBe(false);
  });
  it('deduplicates observations and allows late facts without authorizing stale-worker actions', async () => {
    const result = await run(), usage = createUsageStore({ db });
    await db.query('UPDATE ai_operations SET execution_epoch=1 WHERE id=$1', [result.operation.id]);
    await usage.observe({ callId: result.callId, accountId, observation: result.result.observation });
    expect(await usage.history({ callId: result.callId, accountId })).toHaveLength(1);
    expect((await usage.summary({ operationId: result.operation.id, accountId })).costComplete).toBe(false);
    await expect(createOperationSettlementStore({ db }).markReconciliation({ operationId: result.operation.id, accountId, expectedEpoch: 0 })).rejects.toMatchObject({ code: 'execution_fenced' });
  });
  it('rejects configuration/input before reserving any credits or calls', async () => {
    const transport = vi.fn();
    await expect(run({ transport, profile: { ...imageProfile(), supplierAuthorization: undefined } })).rejects.toThrow();
    await expect(run({ transport, input: { ...imageInput(), n: 2 } })).rejects.toThrow();
    expect((await db.query('SELECT * FROM ai_operations WHERE account_id=$1', [accountId])).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM credit_usage_requests WHERE user_id=$1', [accountId])).rows).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();
  });
});
