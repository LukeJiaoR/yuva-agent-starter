import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createOperationStore, grantCredits } from '@yuva/billing-core';
import { createServer } from '../server/index.js';
import { createImageRoutes } from '../server/routes/images.routes.js';
import { createMockImageUseCase } from '../server/application/mockImageUseCase.js';
import { identity } from '../server/artifacts/contract.js';
import { IMAGE_PROVIDER, IMAGE_MODEL } from '../server/domain/imageGenerationContract.js';
import { isolatedDatabase, operationFixture, quoteFixture } from './helpers/database.js';
import { imageProfile, imageResponse } from './fixtures/imageGeneration.js';

describe('authenticated local MOCK image HTTP product', () => {
  let db, close, accountId, foreign, root, env;
  const servers = [];
  beforeAll(async () => { ({ db, close } = await isolatedDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    accountId = randomUUID(); foreign = randomUUID();
    for (const id of [accountId, foreign]) {
      await db.query('INSERT INTO users(id) VALUES($1)', [id]);
      await grantCredits({ db, userId: id, credits: 20, creditType: 'purchased', idempotencyKey: randomUUID() });
    }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-image-http-'));
    for (const name of ['published', 'staged']) await fs.mkdir(path.join(root, name), { mode: 0o700 });
    env = { NODE_ENV: 'test', AI_PROVIDER: 'mock', MOCK_IMAGE_GENERATION: 'local-development',
      ARTIFACT_STORAGE: 'local', ARTIFACT_DIRECTORY: path.join(root, 'published'),
      ARTIFACT_STAGING: 'local', ARTIFACT_STAGING_DIRECTORY: path.join(root, 'staged') };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) { const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const appFor = (extraEnv = {}, config = {}) => createServer({ db, config: { env: { ...env, ...extraEnv }, imageProfile: imageProfile(), ...config }, auth: {
    verifyRequest: async (req) => req.headers['x-test-account'] ? { kind: 'authenticated', userId: req.headers['x-test-account'] } : { kind: 'missing' },
    findUser: async (id) => [accountId, foreign].includes(id) ? { id } : null,
  } });
  async function listen(app) { const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
  const headers = (id = accountId) => ({ 'content-type': 'application/json', 'x-test-account': id });
  const post = (base, body, extra = {}) => fetch(`${base}/api/images`, { method: 'POST', headers: headers(), body: JSON.stringify(body), ...extra });
  const expire = (operationId) => db.query("UPDATE ai_operations SET lease_expires_at=clock_timestamp()-interval '1 second',next_recovery_at=clock_timestamp() WHERE id=$1", [operationId]);

  it('exposes a synthetic submit → status → download loop and never returns internal recovery metrics', async () => {
    const app = appFor(), base = await listen(app), body = { requestId: randomUUID(), prompt: 'A local synthetic pixel' };
    const response = await post(base, body); expect(response.status).toBe(200);
    const result = await response.json(); expect(result).toMatchObject({ mock: true, financialStatus: 'settled', pricing: { chargedCredits: 2 } });
    expect(await (await post(base, body)).json()).toEqual(result);
    const queried = await fetch(`${base}/api/images/${result.operationId}`, { headers: headers() });
    expect(await queried.json()).toEqual(result);
    const download = await fetch(`${base}${result.artifact.downloadUrl}`, { headers: headers() });
    expect(download.status).toBe(200); expect(download.headers.get('content-type')).toContain('image/png');
    expect(download.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await download.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
    const recovery = await fetch(`${base}/api/images/${result.operationId}/recover`, { method: 'POST', headers: headers(), body: '{}' });
    expect(recovery.status).toBe(200); const recovered = await recovery.json();
    expect(recovered).toEqual(result); expect(JSON.stringify(recovered)).not.toMatch(/metrics|counts|leaseOwner|storageKey|recoveryPolicy/);
    expect((await db.query("SELECT * FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [accountId])).rows).toHaveLength(1);
    const changed = await post(base, { ...body, prompt: 'different' }); expect(changed.status).toBe(409);
  });

  it('requires authentication on submit, query, recover and download, and hides foreign operations', async () => {
    const base = await listen(appFor()), body = { requestId: randomUUID(), prompt: 'pixel' };
    expect((await post(base, body, { headers: { 'content-type': 'application/json' } })).status).toBe(401);
    const result = await (await post(base, body)).json();
    for (const [route, method] of [[`/api/images/${result.operationId}`, 'GET'], [`/api/images/${result.operationId}/recover`, 'POST'], [result.artifact.downloadUrl, 'GET']]) {
      expect((await fetch(base + route, { method })).status).toBe(401);
      expect((await fetch(base + route, { method, headers: headers(foreign) })).status).toBe(404);
    }
  });

  it('rejects request-side pricing/provider/account overrides before reserving', async () => {
    const base = await listen(appFor());
    for (const extra of [{ fixedCredits: 0 }, { provider: 'real' }, { accountId: foreign }, { n: 2 }]) {
      expect((await post(base, { requestId: randomUUID(), prompt: 'pixel', ...extra })).status).toBe(422);
    }
    expect((await db.query('SELECT * FROM ai_operations WHERE account_id=$1', [accountId])).rows).toHaveLength(0);
  });

  it('defaults off, fails closed for production or missing profile, and accepts explicit environment JSON', async () => {
    const disabled = await listen(appFor({ MOCK_IMAGE_GENERATION: undefined }));
    expect((await post(disabled, { requestId: randomUUID(), prompt: 'pixel' })).status).toBe(404);
    expect(() => appFor({ NODE_ENV: 'production', AI_PROVIDER: 'openai' })).toThrow();
    expect(() => appFor({}, { imageProfile: undefined })).toThrow('image_configuration_invalid');
    expect(() => appFor({ ARTIFACT_STAGING: 'disabled' })).toThrow('image_configuration_invalid');
    const json = await listen(appFor({ MOCK_IMAGE_PROFILE: JSON.stringify(imageProfile()) }, { imageProfile: undefined }));
    expect((await post(json, { requestId: randomUUID(), prompt: 'pixel' })).status).toBe(200);
  });

  it('requires actual loopback socket identity and ignores forwarded localhost claims', async () => {
    const submit = vi.fn(), app = express();
    app.use((req, res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.9', configurable: true });
      req.auth = { kind: 'authenticated' }; req.user = { id: accountId }; next();
    });
    app.use(createImageRoutes({ images: { submit } }));
    const base = await listen(app);
    const response = await post(base, { requestId: randomUUID(), prompt: 'pixel' }, { headers: { ...headers(), 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' } });
    expect(response.status).toBe(403); expect(submit).not.toHaveBeenCalled();
  });

  it('gates predictable IDs for staged, unreferenced and unsettled bytes even after disabled restart', async () => {
    const app = appFor(), base = await listen(app), failSave = vi.spyOn(app.locals.artifactStore, 'save').mockRejectedValue(new Error('disk unavailable'));
    const pending = await (await post(base, { requestId: randomUUID(), prompt: 'pixel' })).json();
    expect(pending.artifact).toBeNull(); const artifactId = identity(accountId, pending.operationId, 'output');
    expect((await fetch(`${base}/api/artifacts/${artifactId}`, { headers: headers() })).status).toBe(404);
    failSave.mockRestore();
    // Publishing the existing staged file does not establish canonical ready fulfillment or payment.
    await app.locals.artifactPipeline.recover({ accountId, operationId: pending.operationId, slot: 'output' });
    const disabled = await listen(appFor({ MOCK_IMAGE_GENERATION: 'disabled' }));
    for (const host of [base, disabled]) expect((await fetch(`${host}/api/artifacts/${artifactId}`, { headers: headers() })).status).toBe(404);
    const bytes = Buffer.from(JSON.parse(imageResponse().body).data[0].b64_json, 'base64');
    const unrelated = await app.locals.artifactStore.save({ accountId, operationId: randomUUID(), bytes,
      provenance: { providerId: IMAGE_PROVIDER, modelId: IMAGE_MODEL } });
    for (const host of [base, disabled]) expect((await fetch(`${host}/api/artifacts/${unrelated.id}`, { headers: headers() })).status).toBe(404);
    const { operation: chat } = await createOperationStore({ db }).reserve({ operation: operationFixture(accountId), quote: quoteFixture() });
    const wrongKind = await app.locals.artifactStore.save({ accountId, operationId: chat.id, bytes,
      provenance: { providerId: IMAGE_PROVIDER, modelId: IMAGE_MODEL } });
    for (const host of [base, disabled]) expect((await fetch(`${host}/api/artifacts/${wrongKind.id}`, { headers: headers() })).status).toBe(404);
    await expire(pending.operationId);
    const recovered = await fetch(`${base}/api/images/${pending.operationId}/recover`, { method: 'POST', headers: headers(), body: '{}' });
    expect((await recovered.json()).financialStatus).toBe('settled');
    for (const host of [base, disabled]) expect((await fetch(`${host}/api/artifacts/${artifactId}`, { headers: headers() })).status).toBe(200);
  });

  it('denies late released bytes through generic download both enabled and disabled', async () => {
    const app = appFor(), base = await listen(app);
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; }), pending = new Promise((resolve) => { release = resolve; });
    const product = createMockImageUseCase({ db, profile: { ...imageProfile(), deadlineMs: 100, recoveryPolicy: { version: '1', maxAgeMs: 150, onExpiry: 'waive' } },
      artifactStore: app.locals.artifactStore, artifactPipeline: app.locals.artifactPipeline,
      transport: async () => { enter(); await pending; return imageResponse(); } });
    const submission = product.submit({ accountId, requestId: randomUUID(), prompt: 'late' }); await entered;
    const operationId = (await db.query('SELECT id FROM ai_operations WHERE account_id=$1', [accountId])).rows[0].id;
    try { await new Promise((resolve) => setTimeout(resolve, 180)); await expire(operationId); expect((await product.recover({ accountId, operationId })).financialStatus).toBe('released'); }
    finally { release(); await submission; }
    const disabled = await listen(appFor({ MOCK_IMAGE_GENERATION: 'disabled' })), artifactId = identity(accountId, operationId, 'output');
    expect((await app.locals.artifactStore.get({ accountId, id: artifactId })).bytes.length).toBeGreaterThan(0);
    for (const host of [base, disabled]) expect((await fetch(`${host}/api/artifacts/${artifactId}`, { headers: headers() })).status).toBe(404);
  });
});
