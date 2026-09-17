import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { createOperationStore, createOperationRecoveryStore, createOperationSettlementStore,
  createRecoveryRunner, createFixedOperationPricingPolicy, createTokenPricingPolicy, grantCredits, getCreditBalance } from '@yuva/billing-core';
import { createUsageStore } from '../server/stores/usageStore.js';
import { isolatedDatabase, quoteFixture, operationFixture } from './helpers/database.js';

describe('operation recovery runner', () => {
  let db, close, accountId, operation, recovery, settlement, usage;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID(); await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    await grantCredits({ db, userId: accountId, credits: 10, creditType: 'purchased', idempotencyKey: randomUUID() });
    ({ operation } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote: quoteFixture() }));
    recovery = createOperationRecoveryStore({ db }); settlement = createOperationSettlementStore({ db }); usage = createUsageStore({ db });
  });
  const expire = () => db.query("UPDATE ai_operations SET lease_expires_at=clock_timestamp()-interval '1 second',next_recovery_at=clock_timestamp() WHERE id=$1", [operation.id]);
  const identity = () => ({ operationId: operation.id, accountId });
  const result = () => ({ status: 'ready', ruleVersion: '1', accountId, resultId: operation.id,
    artifacts: [{ id: 'artifact', accountId, type: 'text', state: 'available', text: 'Recovered result' }] });
  const runner = (inspectExecution = vi.fn(async () => ({ status: 'unknown' }))) => createRecoveryRunner({
    recoveryStore: recovery, settlementStore: settlement, usageStore: usage, inspectExecution,
    resolvePolicy: (id, version) => id === 'fixed' && version === '1' ? createFixedOperationPricingPolicy({ credits: 9 }) : null });
  async function start() {
    const callId = randomUUID();
    await usage.start({ ...identity(), callId, provider: 'fixture', model: 'fixture', attempt: 1 });
    return callId;
  }
  it('defaults to read-only preview with no lease, external query or balance change', async () => {
    await start(); await expire();
    const inspect = vi.fn();
    const preview = await runner(inspect).run({ operationId: operation.id });
    expect(preview.outcomes[0]).toMatchObject({ dryRun: true, action: 'defer' });
    expect(preview.counts).toEqual({ released: 0, reconciliationFailures: 0 });
    expect(inspect).not.toHaveBeenCalled();
    expect((await settlement.read(identity())).operation.executionEpoch).toBe(0);
    expect((await getCreditBalance({ db, userId: accountId })).reserved).toBe(2);
  });
  it('safely releases a reservation when no external invocation ever started', async () => {
    await expire();
    const output = await runner().run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0].action).toBe('released');
    expect(output.counts).toEqual({ released: 1, reconciliationFailures: 0 });
    expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 10, reserved: 0 });
  });
  it('retains funds when the lease expires but the provider is still running', async () => {
    await start(); await expire();
    const inspect = vi.fn(async () => ({ status: 'running' }));
    const output = await runner(inspect).run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0].action).toBe('deferred');
    expect(output.counts).toEqual({ released: 0, reconciliationFailures: 0 });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect((await settlement.read(identity())).status).toBe('reconciliation_required');
    expect((await getCreditBalance({ db, userId: accountId })).reserved).toBe(2);
  });
  it('recovers an existing completed job result without generation and charges the frozen fee', async () => {
    const callId = await start(); await expire();
    const inspect = vi.fn(async () => ({ status: 'completed', fulfillment: result(), observations: [{ callId,
      observation: { outcome: 'succeeded', externalStatus: 'completed', metrics: {}, providerJobId: 'existing-job' } }] }));
    const output = await runner(inspect).run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0].action).toBe('settled');
    expect((await settlement.read(identity())).creditsUsed).toBe(2);
    expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 8, reserved: 0 });
    expect((await runner(inspect).run({ dryRun: false, operationId: operation.id })).outcomes).toHaveLength(0);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('counts failed reconciliation without exposing the provider payload or releasing funds', async () => {
    await start(); await expire();
    const output = await runner(async () => { throw new Error('secret upstream payload'); })
      .run({ dryRun: false, operationId: operation.id });
    expect(output.counts).toEqual({ released: 0, reconciliationFailures: 1 });
    expect(output.outcomes[0]).toMatchObject({ action: 'deferred', failed: true, reason: 'recovery_failed' });
    expect(JSON.stringify(output)).not.toContain('secret upstream payload');
    expect((await getCreditBalance({ db, userId: accountId })).reserved).toBe(2);
  });
  it('settles a durable ready candidate after restart without querying or generating again', async () => {
    await settlement.stage({ ...identity(), fulfillment: result() }); await expire();
    const inspect = vi.fn();
    const outputs = await Promise.all([runner(inspect).run({ dryRun: false, operationId: operation.id }), runner(inspect).run({ dryRun: false, operationId: operation.id })]);
    expect(outputs.flatMap((output) => output.outcomes).filter((o) => o.action === 'settled')).toHaveLength(1);
    expect(inspect).not.toHaveBeenCalled();
    expect((await settlement.read(identity())).status).toBe('settled');
  });
  it('repairs an already committed ledger before evaluating a changed policy or external state', async () => {
    await settlement.apply({ ...identity(), fulfillment: result(), decision: { action: 'settle', credits: 2, reason: 'ready' } });
    await db.query("UPDATE ai_operations SET financial_status='reconciliation_required' WHERE id=$1", [operation.id]);
    await expire(); const inspect = vi.fn();
    const output = await runner(inspect).run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0].action).toBe('settled');
    expect(inspect).not.toHaveBeenCalled();
    expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(1);
  });
  it.each([false, true])('waives overdue unresolved charges with ready result=%s and preserves external uncertainty', async (ready) => {
    const quote = quoteFixture();
    quote.terms.recoveryPolicy = { version: '1', maxAgeMs: 1, onExpiry: 'waive' };
    ({ operation } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote }));
    await start();
    if (ready) await settlement.stage({ ...identity(), fulfillment: result() });
    await db.query('UPDATE ai_operations SET manual_review=true WHERE id=$1', [operation.id]);
    await expire();
    const inspect = vi.fn();
    const output = await runner(inspect).run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0]).toMatchObject({ action: ready ? 'no_charge' : 'released', reason: 'consumer_protection_waiver' });
    expect(inspect).not.toHaveBeenCalled();
    expect((await usage.summary(identity())).calls[0].externalStatus).toBe('unknown');
    const state = await settlement.read(identity());
    expect(state.operation.executionStatus).not.toBe('failed');
    await expect(db.query("UPDATE ai_operations SET recovery_policy='{}' WHERE id=$1", [operation.id])).rejects.toThrow('immutable');
  });
  it('runs the documented CLI with scoped dry-run and explicit apply', async () => {
    await expire();
    const exec = promisify(execFile);
    const command = ['scripts/recover-operations.mjs', '--operation', operation.id];
    const options = { cwd: new URL('../../', import.meta.url), env: { ...process.env, DATABASE_URL: db.options.connectionString } };
    const preview = JSON.parse((await exec(process.execPath, command, options)).stdout);
    expect(preview.dryRun).toBe(true);
    expect((await settlement.read(identity())).operation.executionEpoch).toBe(0);
    const applied = JSON.parse((await exec(process.execPath, [...command, '--apply'], options)).stdout);
    expect(applied.outcomes[0].action).toBe('released');
  });
  it('requires a scoped manual retry and audits it without bypassing an active lease', async () => {
    await db.query('UPDATE ai_operations SET manual_review=true WHERE id=$1', [operation.id]);
    await expect(runner().run({ review: true })).rejects.toMatchObject({ code: 'review_requires_operation' });
    expect((await runner().run({ review: true, operationId: operation.id })).outcomes).toHaveLength(0);
    await expire();
    expect((await runner().run({ review: true, dryRun: false, operationId: operation.id })).outcomes[0].action).toBe('released');
    expect((await db.query('SELECT action FROM ai_recovery_events WHERE operation_id=$1 ORDER BY id', [operation.id])).rows[0].action).toBe('manual_claimed');
  });
  it('fences a runner whose lease is taken over while querying an existing external job', async () => {
    await start(); await expire();
    const inspect = vi.fn(async () => {
      await expire();
      const replacement = await recovery.claim({ operationId: operation.id, owner: 'replacement' });
      expect(replacement.executionEpoch).toBe(2);
      return { status: 'completed', fulfillment: result() };
    });
    const output = await runner(inspect).run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0]).toMatchObject({ action: 'deferred', reason: 'execution_lease_lost' });
    const current = await settlement.read(identity());
    expect(current.fulfillment).toBeNull();
    expect(current.status).toBe('reserved');
    expect((await getCreditBalance({ db, userId: accountId })).reserved).toBe(2);
  });
  it('releases only after a call observation explicitly confirms external failure', async () => {
    const callId = await start(); await expire();
    const inspect = async () => ({ status: 'failed', observations: [{ callId, observation: {
      outcome: 'failed', externalStatus: 'completed', metrics: {}, failureCode: 'confirmed_failure' } }] });
    const output = await runner(inspect).run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0]).toMatchObject({ action: 'released', reason: 'confirmed_execution_failed' });
    expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 10, reserved: 0 });
  });
  it('keeps late provider usage as evidence without reopening a settled user bill', async () => {
    const callId = await start();
    await usage.observe({ callId, accountId, observation: { outcome: 'succeeded', metrics: {} } });
    await settlement.stage({ ...identity(), fulfillment: result() }); await expire();
    expect((await runner().run({ dryRun: false, operationId: operation.id })).outcomes[0].action).toBe('settled');
    const observation = { outcome: 'succeeded', metrics: { inputTokens: { value: 9000, unit: 'token', source: 'provider' } } };
    await usage.observe({ callId, accountId, observation });
    await usage.observe({ callId, accountId, observation });
    expect((await usage.history({ callId, accountId }))).toHaveLength(2);
    expect((await runner().run({ dryRun: false, operationId: operation.id })).outcomes).toEqual([]);
    expect((await settlement.read(identity())).creditsUsed).toBe(2);
    expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 8, reserved: 0 });
  });
  it('rejects a resolver returning another policy version rather than repricing', async () => {
    await settlement.stage({ ...identity(), fulfillment: result() }); await expire();
    const recoveryRunner = createRecoveryRunner({ recoveryStore: recovery, settlementStore: settlement, usageStore: usage,
      resolvePolicy: () => ({ id: 'fixed', version: '999', decide: () => { throw new Error('must not run'); } }) });
    const output = await recoveryRunner.run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0]).toMatchObject({ action: 'deferred', reason: 'policy_version_unavailable' });
    expect((await getCreditBalance({ db, userId: accountId })).reserved).toBe(2);
  });
  it('recovers verified completion after local cancellation while retaining the original observation', async () => {
    const callId = await start();
    await usage.observe({ callId, accountId, observation: { outcome: 'cancelled', externalStatus: 'unknown', metrics: {}, failureCode: 'provider_aborted' } });
    await expire();
    const output = await runner(async () => ({ status: 'completed', fulfillment: result(), observations: [{ callId,
      observation: { outcome: 'succeeded', externalStatus: 'completed', metrics: {}, providerJobId: 'original-job' } }] }))
      .run({ dryRun: false, operationId: operation.id });
    expect(output.outcomes[0].action).toBe('settled');
    expect((await usage.history({ callId, accountId })).map((row) => row.observation.outcome)).toEqual(['cancelled','succeeded']);
    await expect(usage.observe({ callId, accountId, observation: { outcome: 'failed', externalStatus: 'completed', metrics: {} } }))
      .rejects.toMatchObject({ code: 'call_outcome_conflict' });
    expect((await usage.summary(identity())).calls).toHaveLength(1);
  });
  it('fills missing token usage through recovery and settles original rates after a process restart', async () => {
    const policy = createTokenPricingPolicy({ inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 } });
    const input = operationFixture(accountId);
    const limits = { models: ['fixture'], paths: [{ provider: 'fixture', model: 'fixture' }], maxCalls: 1,
      maxRetries: 0, maxInputTokens: 2000, maxOutputTokens: 1000, deadlineMs: 30000 };
    ({ operation } = await createOperationStore({ db }).reserve({ operation: input, quote: policy.quote(input, limits) }));
    const callId = randomUUID();
    await usage.start({ ...identity(), callId, provider: 'fixture', model: 'fixture', attempt: 1,
      executionBudget: { kind: 'primary', retryOf: null, resources: { inputTokens: 2000, outputTokens: 1000 } } });
    await usage.observe({ callId, accountId, observation: { outcome: 'succeeded', metrics: {} } });
    await settlement.stage({ ...identity(), fulfillment: result() }); await expire();
    const recovered = createRecoveryRunner({ recoveryStore: createOperationRecoveryStore({ db }), settlementStore: createOperationSettlementStore({ db }),
      usageStore: createUsageStore({ db }), resolvePolicy: () => createTokenPricingPolicy({ inputRate: { credits: 99, tokens: 1 }, outputRate: { credits: 99, tokens: 1 } }),
      inspectExecution: async () => ({ status: 'completed', observations: [{ callId, observation: { outcome: 'succeeded', metrics: {
        inputTokens: { value: 2000, unit: 'token', source: 'provider' }, outputTokens: { value: 1000, unit: 'token', source: 'provider' } } } }] }) });
    expect((await recovered.run({ dryRun: false, operationId: operation.id })).outcomes[0].action).toBe('settled');
    expect((await settlement.read(identity())).creditsUsed).toBe(4);
    expect((await usage.history({ callId, accountId }))).toHaveLength(2);
  });
});
