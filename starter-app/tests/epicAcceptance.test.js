import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { migrateDatabase } from '../../scripts/migrations.mjs';
import { createServer } from '../server/index.js';
import { createUsageStore } from '../server/stores/usageStore.js';
import { createBudgetedProvider, createMeteredProvider } from '@yuva/ai-engine';
import { isolatedDatabase, operationFixture, quoteFixture } from './helpers/database.js';
import { grantCredits, getCreditBalance, reserveFeatureCredits, settleFeatureCredits,
  createOperationStore, createOperationSettlementStore, createOperationRecoveryStore,
  createRecoveryRunner, createFixedOperationPricingPolicy, createTokenPricingPolicy,
  createOperationBillingPort, validateFulfillment } from '@yuva/billing-core';

describe('Epic #1 cross-module acceptance', () => {
  it('does not restore expired membership remainder when actual charge is below reservation', async () => {
    const { db, close } = await isolatedDatabase();
    try {
      const accountId = randomUUID();
      await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
      const grant = await grantCredits({ db, userId: accountId, credits: 5, creditType: 'membership',
        sourceType: 'membership', expiresAt: new Date(Date.now() + 60000), idempotencyKey: randomUUID() });
      const { operation } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote: quoteFixture(5) });
      await db.query("UPDATE credit_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [grant.grantId]);
      const settlement = createOperationSettlementStore({ db });
      const context = { operationId: operation.id, accountId, decision: { action: 'settle', credits: 2, reason: 'actual_usage' },
        fulfillment: { accountId, status: 'ready', ruleVersion: '1', resultId: operation.id,
          artifacts: [{ accountId, id: operation.id, type: 'text', state: 'available', text: 'Saved result' }] } };
      expect((await settlement.apply(context)).creditsUsed).toBe(2);
      expect((await settlement.apply(context)).replay).toBe(true);
      expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 0, reserved: 0 });
      expect((await db.query('SELECT remaining_credits,reserved_credits,status FROM credit_grants WHERE id=$1', [grant.grantId])).rows[0])
        .toEqual({ remaining_credits: 0, reserved_credits: 0, status: 'expired' });
      expect((await db.query('SELECT settled_credits,released_credits FROM credit_usage_allocations WHERE usage_request_id=$1', [operation.ledgerRequestId])).rows[0])
        .toEqual({ settled_credits: 2, released_credits: 3 });
      expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(1);
    } finally { await close(); }
  }, 20000);

  it.each([['fixed', 'stream'], ['token', 'stream'], ['fixed', 'sync'], ['token', 'sync']])('%s %s product retains all retry cost facts and settles one frozen bill', async (strategy, mode) => {
    const { db, close } = await isolatedDatabase();
    try {
      const accountId = randomUUID();
      await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
      await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
      const usage = createUsageStore({ db });
      const policy = strategy === 'fixed' ? createFixedOperationPricingPolicy({ credits: 2 })
        : createTokenPricingPolicy({ inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 } });
      const executionLimits = { models: ['fixture'], paths: [{ provider: 'fixture', model: 'fixture' }],
        maxCalls: 3, maxRetries: 1, maxInputTokens: 6000, maxOutputTokens: 3000,
        maxTotalInputTokens: 6000, maxTotalOutputTokens: 3000, deadlineMs: 30000 };
      const billing = createOperationBillingPort({ db, operationStore: createOperationStore({ db, capabilities: [{ taskType: 'text', mode }] }), policy, executionLimits,
        readUsage: (identity) => usage.summary(identity), evaluateFulfillment: ({ operation }) => ({ accountId, status: 'ready',
          ruleVersion: '1', resultId: operation.id, artifacts: [{ accountId, id: operation.id, type: 'text', state: 'available', text: 'Final result' }] }) });
      const request = { clientRequestId: randomUUID() };
      request.operationInput = operationFixture(accountId, request.clientRequestId);
      request.operationInput.mode = mode;
      const reserved = await billing.reserve({ request, user: { id: accountId } });
      expect(reserved.kind).toBe('reserved');
      const invoke = vi.fn(async ({ callId }) => ({ callId, outcome: invoke.mock.calls.length === 1 ? 'safety_refusal' : 'success',
        usage: { source: 'provider', inputTokens: 1000, outputTokens: 500,
          cost: { amount: '100', scale: 3, currency: 'USD', source: 'provider', status: 'observed' } } }));
      const run = createBudgetedProvider({ operation: reserved.operation, provider: 'fixture', model: 'fixture',
        capabilities: { taskType: 'text', outputLimit: true, abort: true },
        invoke: createMeteredProvider({ store: usage, operation: reserved.operation, provider: 'fixture', model: 'fixture', invoke }) });
      const input = { messages: [{ role: 'user', content: 'Hello' }], options: { maxOutputTokens: 1000 } };
      const failed = await run(input);
      await run({ ...input, retryOf: failed.callId }); await run(input);
      await expect(run(input)).rejects.toMatchObject({ code: 'execution_calls_exceeded' });
      const facts = await usage.summary({ operationId: reserved.operation.id, accountId });
      expect(facts.calls.map((call) => call.outcome)).toEqual(['failed', 'succeeded', 'succeeded']);
      expect(facts.calls[1].retryOf).toBe(failed.callId);
      expect(facts.costs.USD).toEqual({ amount: '300', scale: 3 });
      const context = { request, user: { id: accountId }, reservation: { ...reserved, reservationId: reserved.request.id } };
      const results = await Promise.all([billing.settle(context), billing.settle(context)]);
      const credits = strategy === 'fixed' ? 2 : 4;
      expect(results.map((result) => result.creditsUsed)).toEqual([credits, credits]);
      expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(1);
      expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 20 - credits, reserved: 0 });
      expect(invoke).toHaveBeenCalledTimes(3);
    } finally { await close(); }
  }, 20000);

  it.each(['reserved', 'generated', 'ready'])('recovers after real SIGKILL at %s phase without a second generation', async (phase) => {
    const { db, close } = await isolatedDatabase();
    try {
      const accountId = randomUUID(), requestId = randomUUID();
      await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
      await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import pg from 'pg';
        import { randomUUID } from 'node:crypto';
        import { createOperationStore, createOperationSettlementStore } from '@yuva/billing-core';
        import { createUsageStore } from './starter-app/server/stores/usageStore.js';
        import { operationFixture, quoteFixture } from './starter-app/tests/helpers/database.js';
        const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        const accountId = process.env.FIXTURE_ACCOUNT;
        const { operation } = await createOperationStore({db}).reserve({
          operation: operationFixture(accountId, process.env.FIXTURE_REQUEST), quote: quoteFixture() });
        if (process.env.FIXTURE_PHASE !== 'reserved') {
          const usage = createUsageStore({db}), callId = randomUUID();
          await usage.start({operationId:operation.id, accountId, callId, provider:'fixture', model:'fixture', attempt:1});
          await usage.observe({accountId, callId, observation:{outcome:'succeeded',metrics:{}}});
          if (process.env.FIXTURE_PHASE === 'ready') await createOperationSettlementStore({db}).stage({operationId:operation.id, accountId,
            fulfillment:{accountId,status:'ready',ruleVersion:'1',resultId:operation.id,
              artifacts:[{accountId,id:operation.id,type:'text',state:'available',text:'Crash fixture result'}]}});
        }
        process.kill(process.pid, 'SIGKILL');
      `], { env: { ...process.env, DATABASE_URL: db.options.connectionString,
        FIXTURE_ACCOUNT: accountId, FIXTURE_REQUEST: requestId, FIXTURE_PHASE: phase }, stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; });
      const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
      let code, signal;
      try { [code, signal] = await once(child, 'exit'); }
      finally { clearTimeout(timer); }
      expect(errors).toBe(''); expect(code).toBeNull(); expect(signal).toBe('SIGKILL');
      const operation = await createOperationStore({ db }).find({ accountId, clientRequestId: requestId });
      expect(operation.financialStatus).toBe('reserved');
      await db.query("UPDATE ai_operations SET lease_expires_at=clock_timestamp()-interval '1 second',next_recovery_at=clock_timestamp() WHERE id=$1", [operation.id]);
      const inspect = vi.fn(async () => ({ status: 'completed', fulfillment: {
        accountId, status: 'ready', ruleVersion: '1', resultId: operation.id,
        artifacts: [{ accountId, id: operation.id, type: 'text', state: 'available', text: 'Crash fixture result' }] } }));
      const settlement = createOperationSettlementStore({ db });
      const runner = createRecoveryRunner({ recoveryStore: createOperationRecoveryStore({ db }), settlementStore: settlement,
        usageStore: createUsageStore({ db }), inspectExecution: inspect, resolvePolicy: () => createFixedOperationPricingPolicy({ credits: 99 }) });
      expect((await runner.run({ dryRun: false, operationId: operation.id })).outcomes[0].action).toBe(phase !== 'reserved' ? 'settled' : 'released');
      expect(inspect).toHaveBeenCalledTimes(phase === 'generated' ? 1 : 0);
      const state = await settlement.read({ operationId: operation.id, accountId });
      if (phase !== 'reserved') expect(state.fulfillment.artifacts[0].text).toBe('Crash fixture result');
      expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: phase !== 'reserved' ? 18 : 20, reserved: 0 });
      expect((await runner.run({ dryRun: false, operationId: operation.id })).outcomes).toEqual([]);
      expect((await db.query('SELECT * FROM ai_provider_calls WHERE operation_id=$1', [operation.id])).rows).toHaveLength(phase !== 'reserved' ? 1 : 0);
    } finally { await close(); }
  }, 20000);

  it('upgrades legacy settled history without changing identities, balances, grants or transactions', async () => {
    const legacy = await isolatedDatabase({ migrate: false });
    const fresh = await isolatedDatabase();
    try {
      await legacy.db.query(await fs.readFile(new URL('../../scripts/schema.sql', import.meta.url), 'utf8'));
      const userId = '00000000-0000-0000-0000-000000000001';
      await legacy.db.query('INSERT INTO users(id) VALUES($1)', [userId]);
      await grantCredits({ db: legacy.db, userId, credits: 30, creditType: 'purchased', idempotencyKey: randomUUID() });
      const reserved = await reserveFeatureCredits({ db: legacy.db, userId, featureKey: 'deep_reasoning', clientRequestId: 'legacy-settled', credits: 2 });
      await settleFeatureCredits({ db: legacy.db, userId, requestId: reserved.request.id, creditsUsed: 2,
        persistResult: (client) => client.query('UPDATE credit_usage_requests SET assistant_text=$2 WHERE id=$1', [reserved.request.id, 'Historical result']) });
      const tables = ['users', 'credit_accounts', 'credit_grants', 'credit_usage_requests', 'credit_usage_allocations', 'credit_transactions'];
      const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (table) =>
        [table, (await legacy.db.query(`SELECT * FROM ${table} ORDER BY ${table === 'credit_accounts' ? 'user_id' : 'id'}`)).rows])));
      const before = await snapshot();
      await Promise.all([migrateDatabase(legacy.db), migrateDatabase(legacy.db)]);
      expect(await snapshot()).toEqual(before);
      expect(await getCreditBalance({ db: legacy.db, userId })).toMatchObject({ available: 28, reserved: 0 });
      const columns = async (db) => (await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position`)).rows;
      expect(await columns(legacy.db)).toEqual(await columns(fresh.db));
      const provider = vi.fn();
      const app = createServer({ db: legacy.db, callAIStream: provider, config: { env: { NODE_ENV: 'development', ALLOW_DEV_GUEST: 'true' } } });
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Hello', requestId: 'legacy-settled' }) });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Historical result');
        const store = createOperationStore({ db: legacy.db });
        expect((await store.reserve({ operation: { ...operationFixture(userId, 'legacy-settled'), featureKey: 'deep_reasoning' }, quote: quoteFixture() })).kind).toBe('legacy');
        expect(provider).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
      } finally { await new Promise((resolve) => server.close(resolve)); }
    } finally { await legacy.close(); await fresh.close(); }
  }, 20000);

  it.each(['image', 'video'])('recovers %s async fixture after unknown submission and duplicate completion without regenerating', async (taskType) => {
    const { db, close } = await isolatedDatabase();
    try {
      const accountId = randomUUID();
      await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
      await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
      const store = createOperationStore({ db, capabilities: [{ taskType, mode: 'async' }] });
      const quote = quoteFixture(5);
      delete quote.limits.maxInputTokens; delete quote.limits.maxOutputTokens;
      quote.limits.maxImages = 2; quote.limits.maxDurationMs = 1000;
      const requestId = randomUUID();
      const rawInput = { asset: { id: 'source-asset', version: 'v1', accessUrl: 'https://fixture.invalid/source?signature=first' },
        specs: taskType === 'image' ? { width: 1024, images: 2 } : { durationMs: 1000 } };
      // This fixture is the product input boundary: access credentials are excluded from identity.
      const normalize = (input) => ({ ...operationFixture(accountId, requestId, taskType),
        input: { assets: [{ id: input.asset.id, version: input.asset.version }], specs: input.specs } });
      const { operation } = await store.reserve({ operation: normalize(rawInput), quote });
      expect((await store.reserve({ operation: normalize({ ...rawInput, asset: { ...rawInput.asset,
        accessUrl: 'https://fixture.invalid/source?signature=renewed' } }), quote })).kind).toBe('existing');
      await expect(store.reserve({ operation: normalize({ ...rawInput, asset: { ...rawInput.asset, version: 'v2' } }), quote }))
        .rejects.toMatchObject({ code: 'idempotency_conflict' });
      await expect(store.reserve({ operation: normalize({ ...rawInput, specs: taskType === 'image' ? { width: 2048, images: 2 } : { durationMs: 2000 } }), quote }))
        .rejects.toMatchObject({ code: 'idempotency_conflict' });
      const identity = { operationId: operation.id, accountId };
      const usage = createUsageStore({ db });
      const callId = randomUUID(), jobId = randomUUID();
      const submit = vi.fn(async () => { throw Object.assign(new Error('submit acknowledgment lost'), { jobId }); });
      await usage.start({ ...identity, callId, provider: 'fixture', model: 'fixture', attempt: 1 });
      await expect(submit()).rejects.toThrow('acknowledgment lost');
      const metric = taskType === 'image' ? { images: { value: 2, unit: 'image', source: 'synthetic' } }
        : { durationMs: { value: 1000, unit: 'millisecond', source: 'synthetic' } };
      await usage.observe({ callId, accountId, observation: { outcome: 'failed', externalStatus: 'unknown', providerJobId: jobId, metrics: {} } });
      const fulfillment = { accountId, status: 'ready', ruleVersion: '1', resultId: operation.id,
        artifacts: [{ accountId, id: jobId, type: taskType, state: 'available', storageKey: `fixture/${jobId}`,
          specs: taskType === 'image' ? { width: 1024, height: 1024 } : { durationMs: 1000 } }] };
      expect(() => validateFulfillment({ ...fulfillment, artifacts: [{ ...fulfillment.artifacts[0], storageKey: 'https://fixture.invalid/result?signature=expired' }] }, accountId))
        .toThrow('unstable_artifact_reference');
      const settlement = createOperationSettlementStore({ db });
      let completed = false, saved = false;
      const inspect = vi.fn(async ({ calls }) => {
        expect(calls[0].providerJobId).toBe(jobId);
        return completed ? { status: 'completed', fulfillment: saved ? fulfillment : { ...fulfillment, status: 'partial', artifacts: [] }, observations: [{ callId, observation: {
          outcome: 'succeeded', externalStatus: 'completed', providerJobId: jobId, metrics: metric } }] } : { status: 'running' };
      });
      const runner = () => createRecoveryRunner({ recoveryStore: createOperationRecoveryStore({ db }), settlementStore: settlement,
        usageStore: usage, inspectExecution: inspect, resolvePolicy: () => createFixedOperationPricingPolicy({ credits: 99 }) });
      const expire = () => db.query("UPDATE ai_operations SET lease_expires_at=clock_timestamp()-interval '1 second',next_recovery_at=clock_timestamp() WHERE id=$1", [operation.id]);
      await expire();
      expect((await runner().run({ dryRun: false, operationId: operation.id })).outcomes[0].action).toBe('deferred');
      expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 15, reserved: 5 });
      completed = true; await expire();
      expect((await runner().run({ dryRun: false, operationId: operation.id })).outcomes[0].action).toBe('deferred');
      expect((await settlement.read(identity)).fulfillment.status).toBe('partial');
      expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 15, reserved: 5 });
      saved = true; await expire();
      const outputs = await Promise.all([runner().run({ dryRun: false, operationId: operation.id }), runner().run({ dryRun: false, operationId: operation.id })]);
      expect(outputs.flatMap((result) => result.outcomes).filter((result) => result.action === 'settled')).toHaveLength(1);
      const state = await settlement.read(identity);
      expect(state.creditsUsed).toBe(5); expect(state.fulfillment).toEqual(fulfillment);
      const observation = { outcome: 'succeeded', externalStatus: 'completed', providerJobId: jobId, metrics: metric };
      await usage.observe({ callId, accountId, observation }); await usage.observe({ callId, accountId, observation });
      expect((await usage.summary(identity)).calls).toHaveLength(1);
      expect((await usage.summary(identity)).calls[0].metrics.inputTokens).toBeUndefined();
      expect((await usage.history({ callId, accountId }))).toHaveLength(2);
      expect((await runner().run({ dryRun: false, operationId: operation.id })).outcomes).toEqual([]);
      expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(1);
      expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 15, reserved: 0 });
      expect(submit).toHaveBeenCalledTimes(1);
    } finally { await close(); }
  }, 20000);
});
