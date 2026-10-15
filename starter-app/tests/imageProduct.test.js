import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createOperationStore, grantCredits, getCreditBalance } from '@yuva/billing-core';
import { createMockImageUseCase, createMockImageSettlementStore } from '../server/application/mockImageUseCase.js';
import { createUsageStore } from '../server/stores/usageStore.js';
import { createLocalArtifactStore } from '../server/artifacts/localStore.js';
import { createStagedArtifactPipeline } from '../server/artifacts/staging.js';
import { identity } from '../server/artifacts/contract.js';
import { isolatedDatabase, operationFixture, quoteFixture } from './helpers/database.js';
import { imageProfile, imageResponse } from './fixtures/imageGeneration.js';

describe('usable MOCK image product with real PostgreSQL and private files', () => {
  let db, close, accountId, requestId, root, store, pipeline, directory, artifactDirectory;
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID(); requestId = randomUUID();
    await db.query('INSERT INTO users(id) VALUES($1)', [accountId]);
    await grantCredits({ db, userId: accountId, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-image-product-'));
    directory = path.join(root, 'staged'); artifactDirectory = path.join(root, 'published');
    await fs.mkdir(directory, { mode: 0o700 }); await fs.mkdir(artifactDirectory, { mode: 0o700 });
    store = createLocalArtifactStore({ directory: artifactDirectory });
    pipeline = createStagedArtifactPipeline({ store, directory, artifactDirectory });
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  const make = (extra = {}) => createMockImageUseCase({ db, profile: imageProfile(), artifactStore: store,
    artifactPipeline: pipeline, transport: async () => imageResponse(), ...extra });
  const input = (extra = {}) => ({ accountId, requestId, prompt: 'Private synthetic pixel prompt', ...extra });
  const scope = (operationId) => ({ accountId, operationId });
  const expireLease = (id) => db.query("UPDATE ai_operations SET lease_expires_at=clock_timestamp()-interval '1 second',next_recovery_at=clock_timestamp() WHERE id=$1", [id]);
  const charges = async () => (await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows;
  const row = async (id) => (await db.query('SELECT * FROM ai_operations WHERE id=$1', [id])).rows[0];
  const calls = async () => (await db.query('SELECT c.* FROM ai_provider_calls c JOIN ai_operations o ON o.id=c.operation_id WHERE o.account_id=$1', [accountId])).rows;

  it('submits, queries and authorizes one canonical image with exactly one fixed debit', async () => {
    const transport = vi.fn(async () => {
      expect(await calls()).toHaveLength(1);
      expect((await calls())[0].outcome).toBe('started');
      return imageResponse();
    });
    const product = make({ transport }), result = await product.submit(input());
    expect(result).toMatchObject({ mock: true, fulfillmentStatus: 'ready', financialStatus: 'settled', pricing: { credits: 2, chargedCredits: 2 } });
    expect(result.artifact.downloadUrl).toBe(`/api/artifacts/${result.artifact.id}`);
    expect(await product.query(scope(result.operationId))).toEqual(result);
    const stored = await store.get({ accountId, id: result.artifact.id });
    await expect(product.authorizeArtifact({ accountId, artifact: stored.artifact })).resolves.toBeUndefined();
    expect(stored.bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(await product.submit(input())).toEqual(result);
    expect(transport).toHaveBeenCalledTimes(1); expect(await charges()).toHaveLength(1);
    expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 18, reserved: 0 });
    expect(JSON.stringify(await row(result.operationId))).not.toContain(input().prompt);
    expect(JSON.stringify(result)).not.toMatch(/storageKey|supplierAuthorization|providerRequestId/);
  });

  it('coalesces concurrent duplicates and rejects changed prompts without new calls', async () => {
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; }), pending = new Promise((resolve) => { release = resolve; });
    const transport = vi.fn(async () => { enter(); await pending; return imageResponse(); });
    const product = make({ transport }), first = product.submit(input()); await entered;
    try {
      const repeats = await Promise.all(Array.from({ length: 6 }, () => product.submit(input())));
      expect(new Set(repeats.map((r) => r.operationId)).size).toBe(1);
      expect(repeats.every((r) => r.artifact === null)).toBe(true);
      await expect(product.submit(input({ prompt: 'Changed input' }))).rejects.toMatchObject({ code: 'idempotency_conflict' });
    } finally { release(); await first; }
    expect(transport).toHaveBeenCalledTimes(1); expect(await charges()).toHaveLength(1);
  });

  it.each(['failed', 'committed ACK lost'])('never hands off after durable call start %s', async (mode) => {
    const real = createUsageStore({ db }), transport = vi.fn();
    const product = make({ transport, usageStore: { ...real, start: async (args) => {
      if (mode === 'committed ACK lost') await real.start(args);
      throw new Error('start acknowledgement unavailable');
    } } });
    const first = await product.submit(input());
    expect(first.artifact).toBeNull();
    await make({ transport }).submit(input());
    expect(transport).not.toHaveBeenCalled(); expect(await charges()).toHaveLength(0);
    expect(await calls()).toHaveLength(mode === 'failed' ? 0 : 1);
  });

  it('recovers a final-save failure in a fresh process without any generation', async () => {
    const transport = vi.fn(async () => imageResponse());
    const failedPipeline = createStagedArtifactPipeline({ directory, artifactDirectory, store: {
      save: async () => { throw new Error('final disk write failed'); },
    } });
    const first = await make({ transport, artifactPipeline: failedPipeline }).submit(input());
    expect(first.artifact).toBeNull(); expect(first.financialStatus).toBe('reconciliation_required');
    expect(await charges()).toHaveLength(0); expect(await fs.readdir(directory)).toHaveLength(1);
    expect(await fs.readdir(artifactDirectory)).toHaveLength(0);
    await expireLease(first.operationId);
    const script = `import pg from 'pg';
      import {createMockImageUseCase} from './server/application/mockImageUseCase.js';
      import {createLocalArtifactStore} from './server/artifacts/localStore.js';
      import {createStagedArtifactPipeline} from './server/artifacts/staging.js';
      const db = new pg.Pool({connectionString:process.env.IMAGE_TEST_DB});
      globalThis.fetch = () => {throw new Error('network forbidden');};
      const store=createLocalArtifactStore({directory:${JSON.stringify(artifactDirectory)}});
      const pipeline=createStagedArtifactPipeline({store,directory:${JSON.stringify(directory)},artifactDirectory:${JSON.stringify(artifactDirectory)}});
      try {const product=createMockImageUseCase({db,profile:${JSON.stringify({ ...imageProfile(), fixedCredits: 9 })},artifactStore:store,artifactPipeline:pipeline,transport:()=>{throw new Error('generation forbidden');}});
      console.log(JSON.stringify(await product.recover(${JSON.stringify(scope(first.operationId))})));} finally {await db.end();}`;
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('../', import.meta.url), env: { ...process.env, IMAGE_TEST_DB: db.options.connectionString },
    });
    const recovered = JSON.parse(child.stdout);
    expect(recovered).toMatchObject({ financialStatus: 'settled', fulfillmentStatus: 'ready', pricing: { credits: 2, chargedCredits: 2 } });
    expect(recovered.artifact).not.toBeNull(); expect(await charges()).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1); expect(await calls()).toHaveLength(1);
  });

  it('repairs settlement acknowledgement loss ledger-first without a second debit or file recovery', async () => {
    const real = createMockImageSettlementStore({ db }), transport = vi.fn(async () => imageResponse());
    const settlementStore = { ...real, apply: async (args) => {
      await real.apply(args);
      await db.query("UPDATE ai_operations SET financial_status='reconciliation_required' WHERE id=$1", [args.operationId]);
      throw new Error('commit acknowledgement lost');
    } };
    const first = await make({ transport, settlementStore }).submit(input());
    expect(first.artifact).toBeNull(); expect(await charges()).toHaveLength(1);
    await expireLease(first.operationId);
    const recover = vi.spyOn(pipeline, 'recover');
    const result = await make({ transport, profile: { ...imageProfile(), fixedCredits: 9 } }).recover(scope(first.operationId));
    expect(result).toMatchObject({ financialStatus: 'settled', pricing: { chargedCredits: 2 } });
    expect(result.artifact).not.toBeNull(); expect(await charges()).toHaveLength(1);
    expect(recover).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not stage fulfillment, settle or authorize bytes from a stale execution epoch', async () => {
    const transport = vi.fn(async () => {
      await db.query('UPDATE ai_operations SET execution_epoch=execution_epoch+1 WHERE account_id=$1', [accountId]);
      return imageResponse();
    });
    const product = make({ transport }), result = await product.submit(input());
    expect(result.artifact).toBeNull(); expect(result.fulfillmentStatus).not.toBe('ready');
    expect(await charges()).toHaveLength(0);
    const id = identity(accountId, result.operationId, 'output'), published = await store.get({ accountId, id });
    await expect(product.authorizeArtifact({ accountId, artifact: published.artifact })).rejects.toMatchObject({ code: 'artifact_unavailable' });
    expect((await calls())[0].outcome).toBe('succeeded');
  });

  it('waives an expired unknown operation and late success cannot charge or authorize its bytes', async () => {
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; }), pending = new Promise((resolve) => { release = resolve; });
    const profile = { ...imageProfile(), deadlineMs: 100, recoveryPolicy: { version: '1', maxAgeMs: 150, onExpiry: 'waive' } };
    const transport = vi.fn(async () => { enter(); await pending; return imageResponse(); });
    const product = make({ profile, transport }), first = product.submit(input()); await entered;
    const operationId = (await db.query('SELECT id FROM ai_operations WHERE account_id=$1', [accountId])).rows[0].id;
    try {
      await new Promise((resolve) => setTimeout(resolve, 180)); await expireLease(operationId);
      const recovered = await product.recover(scope(operationId));
      expect(recovered).toMatchObject({ financialStatus: 'released', artifact: null });
    } finally { release(); await first; }
    const result = await product.query(scope(operationId));
    expect(result).toMatchObject({ financialStatus: 'released', artifact: null });
    expect(await charges()).toHaveLength(0);
    expect(await getCreditBalance({ db, userId: accountId })).toMatchObject({ available: 20, reserved: 0 });
    const published = await store.get({ accountId, id: identity(accountId, operationId, 'output') });
    await expect(product.authorizeArtifact({ accountId, artifact: published.artifact })).rejects.toMatchObject({ code: 'artifact_unavailable' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not charge a late success after expiry even when no recovery has run yet', async () => {
    const transport = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); return imageResponse(); });
    const product = make({ transport, profile: { ...imageProfile(), deadlineMs: 100,
      recoveryPolicy: { version: '1', maxAgeMs: 150, onExpiry: 'waive' } } });
    const result = await product.submit(input());
    expect(result.artifact).toBeNull(); expect(result.fulfillmentStatus).not.toBe('ready');
    expect(await charges()).toHaveLength(0);
    const published = await store.get({ accountId, id: identity(accountId, result.operationId, 'output') });
    await expect(product.authorizeArtifact({ accountId, artifact: published.artifact })).rejects.toMatchObject({ code: 'artifact_unavailable' });
    await expireLease(result.operationId);
    expect(await product.recover(scope(result.operationId))).toMatchObject({ financialStatus: 'released', artifact: null });
    expect(await charges()).toHaveLength(0); expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'unsafe'])('rejects %s staging before reserving or invoking', async (mode) => {
    if (mode === 'missing') await fs.rmdir(directory); else await fs.chmod(directory, 0o755);
    const transport = vi.fn();
    await expect(make({ transport }).submit(input())).rejects.toThrow();
    expect((await db.query('SELECT * FROM ai_operations WHERE account_id=$1', [accountId])).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM credit_usage_requests WHERE user_id=$1', [accountId])).rows).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses wrong-provenance staged bytes without publishing or charging', async () => {
    const failedPipeline = createStagedArtifactPipeline({ directory, artifactDirectory, store: { save: async () => { throw new Error('disk failed'); } } });
    const first = await make({ artifactPipeline: failedPipeline }).submit(input());
    const filename = path.join(directory, `${identity(accountId, first.operationId, 'output')}.json`);
    const record = JSON.parse(await fs.readFile(filename)); record.artifact.provenance.providerId = 'untrusted-provider';
    await fs.writeFile(filename, JSON.stringify(record)); await expireLease(first.operationId);
    const transport = vi.fn(), recover = vi.spyOn(pipeline, 'recover');
    expect((await make({ transport }).recover(scope(first.operationId))).artifact).toBeNull();
    expect(recover).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    expect(await fs.readdir(artifactDirectory)).toEqual([]); expect(await charges()).toHaveLength(0);
  });

  it('refuses chat operations and recovers only the authorized image, leaving other work untouched', async () => {
    const operations = createOperationStore({ db });
    const { operation: chat } = await operations.reserve({ operation: operationFixture(accountId), quote: quoteFixture() });
    await expireLease(chat.id);
    const product = make();
    await expect(product.recover(scope(chat.id))).rejects.toMatchObject({ code: 'operation_not_found' });
    const failed = await make({ usageStore: { ...createUsageStore({ db }), start: async () => { throw new Error('no start'); } } }).submit(input());
    await expireLease(failed.operationId);
    expect((await product.recover(scope(failed.operationId))).financialStatus).toBe('released');
    const untouched = await row(chat.id);
    expect(untouched.execution_epoch).toBe(0); expect(untouched.financial_status).toBe('reserved');
    expect((await db.query('SELECT * FROM ai_recovery_events WHERE operation_id=$1', [chat.id])).rows).toHaveLength(0);
  });

  it('isolates queries, recovery and artifact authorization by account', async () => {
    const product = make(), result = await product.submit(input()), foreign = randomUUID();
    for (const method of ['query', 'recover']) await expect(product[method]({ accountId: foreign, operationId: result.operationId }))
      .rejects.toMatchObject({ code: 'operation_not_found' });
    const { artifact } = await store.get({ accountId, id: result.artifact.id });
    await expect(product.authorizeArtifact({ accountId: foreign, artifact })).rejects.toMatchObject({ code: 'operation_not_found' });
    await expect(product.authorizeArtifact({ accountId, artifact: { ...artifact, sha256: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'artifact_unavailable' });
    expect(await charges()).toHaveLength(1);
  });

  it('keeps free fulfillment downloadable without creating a credit reservation or debit', async () => {
    const product = make({ profile: { ...imageProfile(), fixedCredits: 0 } }), result = await product.submit(input());
    expect(result).toMatchObject({ financialStatus: 'no_charge', fulfillmentStatus: 'ready', pricing: { chargedCredits: 0 } });
    const { artifact } = await store.get({ accountId, id: result.artifact.id });
    await expect(product.authorizeArtifact({ accountId, artifact })).resolves.toBeUndefined();
    expect(await charges()).toHaveLength(0);
    expect((await db.query('SELECT * FROM credit_usage_requests WHERE user_id=$1', [accountId])).rows).toHaveLength(0);
  });

  it('validates input and trusted configuration before any reservation or provider call', async () => {
    const transport = vi.fn(), product = make({ transport });
    for (const extra of [{ prompt: '' }, { prompt: 'x'.repeat(4097) }, { requestId: '' }, { n: 2 }, { accountId: '' }]) {
      await expect(product.submit(input(extra))).rejects.toThrow();
    }
    for (const profile of [{ ...imageProfile(), fixedCredits: -1 }, { ...imageProfile(), supplierAuthorization: undefined }, { ...imageProfile(), maxCalls: 2 }]) {
      expect(() => make({ profile, transport })).toThrow();
    }
    expect((await db.query('SELECT * FROM ai_operations WHERE account_id=$1', [accountId])).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM credit_usage_requests WHERE user_id=$1', [accountId])).rows).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();
  });
});
