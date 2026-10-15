import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { identity, prepare } from '../server/artifacts/contract.js';
import { createLocalArtifactStore } from '../server/artifacts/localStore.js';
import { createStagedArtifactPipeline, configuredStagedArtifactPipeline } from '../server/artifacts/staging.js';
import { createRemoteArtifactIngestor } from '../server/artifacts/remoteIngestion.js';
import { createServer } from '../server/index.js';

const roots = [], servers = [];
const png = (value = 128) => PNG.sync.write({ width: 1, height: 1, data: Buffer.alloc(4, value) }, { colorType: 6 });
const input = (extra = {}) => ({ accountId: 'account-a', operationId: 'operation-1', slot: 'output', bytes: png(),
  provenance: { providerId: 'synthetic', modelId: 'fixture' }, ...extra });
const trustedIdentity = { accountId: 'account-a', operationId: 'operation-1', slot: 'output' };
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-staging-')); roots.push(root);
  const directory = path.join(root, 'staged'), artifactDirectory = path.join(root, 'published');
  await fs.mkdir(directory, { mode: 0o700 }); await fs.mkdir(artifactDirectory, { mode: 0o700 });
  const store = createLocalArtifactStore({ directory: artifactDirectory });
  const options = { store, directory, artifactDirectory };
  return { ...options, root, pipeline: createStagedArtifactPipeline(options) };
}

describe('private durable artifact staging', () => {
  it('fsyncs a staged source before final save failure, retains no delivery-ready state, and recovers in a new process', async () => {
    const f = await fixture(), provider = vi.fn();
    const failedStore = { save: vi.fn(async () => {
      const raw = JSON.parse(await fs.readFile(path.join(f.directory, `${identity('account-a', 'operation-1', 'output')}.json`)));
      expect(raw.artifact.state).toBe('staged'); expect(raw.artifact.storageKey).toMatch(/^staging-v1\//);
      throw new Error('disk unavailable');
    }) };
    await expect(createStagedArtifactPipeline({ ...f, store: failedStore }).save(input())).rejects.toThrow('disk unavailable');
    const receipt = await f.pipeline.stage(input());
    expect(receipt).toEqual({ recoveryId: identity('account-a', 'operation-1', 'output'), state: 'staged' });
    await expect(f.store.get({ accountId: 'account-a', id: receipt.recoveryId })).rejects.toMatchObject({ code: 'artifact_unavailable' });
    const sourceBefore = await fs.readFile(path.join(f.directory, `${receipt.recoveryId}.json`));
    const moduleUrl = new URL('../server/artifacts/staging.js', import.meta.url).href;
    const storeUrl = new URL('../server/artifacts/localStore.js', import.meta.url).href;
    const script = `import {createStagedArtifactPipeline} from ${JSON.stringify(moduleUrl)};
      import {createLocalArtifactStore} from ${JSON.stringify(storeUrl)};
      globalThis.fetch = () => { throw new Error('network forbidden'); };
      const artifactDirectory = ${JSON.stringify(f.artifactDirectory)};
      const pipeline = createStagedArtifactPipeline({directory:${JSON.stringify(f.directory)}, artifactDirectory, store:createLocalArtifactStore({directory:artifactDirectory})});
      console.log(JSON.stringify(await pipeline.recover(${JSON.stringify(trustedIdentity)})));`;
    const recovered = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])));
    const artifact = JSON.parse(recovered[0].stdout);
    expect(recovered.every(({ stdout }) => JSON.stringify(JSON.parse(stdout)) === JSON.stringify(artifact))).toBe(true);
    expect(artifact).toEqual(prepare(input()).artifact);
    expect((await f.store.get({ accountId: 'account-a', id: artifact.id })).bytes).toEqual(png());
    expect(await fs.readFile(path.join(f.directory, `${receipt.recoveryId}.json`))).toEqual(sourceBefore);
    expect(provider).not.toHaveBeenCalled();
  });
  it('does not attempt final publication until stage file and directory fsync both finish', async () => {
    const f = await fixture(), events = [], originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(f.directory)) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => { await originalSync(); events.push(args[0] === f.directory ? 'directory sync' : 'file sync'); };
      }
      return handle;
    });
    const finalSave = vi.spyOn(f.store, 'save').mockImplementation(async (request) => {
      expect(events).toEqual(['file sync', 'directory sync']); return prepare(request).artifact;
    });
    await f.pipeline.save(input()); expect(finalSave).toHaveBeenCalledTimes(1);
  });
  it('does not publish after a stage fsync failure and reconciles the committed source on exact retry', async () => {
    const f = await fixture(), finalSave = vi.spyOn(f.store, 'save'), originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === f.directory) handle.sync = async () => { throw new Error('sync failed'); };
      return handle;
    });
    await expect(f.pipeline.save(input())).rejects.toThrow('sync failed');
    expect(finalSave).not.toHaveBeenCalled();
    open.mockRestore();
    expect(await f.pipeline.save(input())).toEqual(prepare(input()).artifact);
  });
  it('recovers an acknowledged-as-failed final commit idempotently', async () => {
    const f = await fixture();
    const pipeline = createStagedArtifactPipeline({ ...f, store: { save: async (request) => {
      await f.store.save(request); throw new Error('lost acknowledgement');
    } } });
    await expect(pipeline.save(input())).rejects.toThrow('lost acknowledgement');
    const before = await fs.readFile(path.join(f.artifactDirectory, `${identity('account-a', 'operation-1', 'output')}.json`));
    expect(await f.pipeline.recover(trustedIdentity)).toEqual(prepare(input()).artifact);
    expect(await fs.readFile(path.join(f.artifactDirectory, `${identity('account-a', 'operation-1', 'output')}.json`))).toEqual(before);
    expect(await fs.readdir(f.artifactDirectory)).toHaveLength(1);
  });
  it('keeps final publication untouched when staging itself fails', async () => {
    const f = await fixture(), finalSave = vi.spyOn(f.store, 'save');
    await fs.rmdir(f.directory);
    await expect(f.pipeline.save(input())).rejects.toThrow();
    expect(finalSave).not.toHaveBeenCalled(); expect(await fs.readdir(f.artifactDirectory)).toEqual([]);
  });
  it('makes repeated/concurrent staging, saves, and recoveries idempotent without changing original bytes', async () => {
    const f = await fixture();
    const receipts = await Promise.all(Array.from({ length: 6 }, () => f.pipeline.stage(input())));
    expect(receipts.every((r) => r.recoveryId === receipts[0].recoveryId)).toBe(true);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => i % 2 ? f.pipeline.recover(trustedIdentity) : f.pipeline.save(input())));
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    await expect(f.pipeline.save(input({ bytes: png(2) }))).rejects.toMatchObject({ code: 'artifact_conflict' });
    await expect(f.pipeline.stage(input({ provenance: { providerId: 'changed', modelId: 'fixture' } }))).rejects.toMatchObject({ code: 'artifact_conflict' });
    expect(await f.pipeline.recover(trustedIdentity)).toEqual(results[0]);
  });
  it('allows one winner for competing changed sources', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.pipeline.save(input()), f.pipeline.save(input({ bytes: png(2) }))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('artifact_conflict');
    expect(await f.pipeline.recover(trustedIdentity)).toEqual(results.find((r) => r.status === 'fulfilled').value);
  });
  it('snapshots bytes and metadata before asynchronous staging', async () => {
    const f = await fixture(), request = input(), pending = f.pipeline.save(request);
    request.bytes.fill(0); request.provenance.modelId = 'changed'; request.accountId = 'changed';
    expect(await pending).toEqual(prepare(input()).artifact);
  });
  it('rejects invalid source/specs and URLs before any final save', async () => {
    const f = await fixture(), save = vi.spyOn(f.store, 'save');
    for (const request of [input({ bytes: Buffer.from('bad') }), input({ expectedSpecs: { width: 2 } }), input({ sourceUrl: 'https://example.com/token' })]) {
      await expect(f.pipeline.save(request)).rejects.toThrow();
    }
    expect(save).not.toHaveBeenCalled(); expect(await fs.readdir(f.directory)).toEqual([]);
  });
  it('isolates accounts and rejects forged recovery IDs/metadata rather than allowing overrides', async () => {
    const f = await fixture(), receipt = await f.pipeline.stage(input());
    await expect(f.pipeline.recover({ ...trustedIdentity, accountId: 'account-b' })).rejects.toMatchObject({ code: 'artifact_unavailable' });
    for (const extra of [{ recoveryId: receipt.recoveryId }, { id: receipt.recoveryId }, { bytes: png(2) }, { provenance: input().provenance }]) {
      await expect(f.pipeline.recover({ ...trustedIdentity, ...extra })).rejects.toMatchObject({ code: 'artifact_invalid_input' });
    }
    await expect(f.pipeline.recover({ ...trustedIdentity, operationId: 'unknown' })).rejects.toMatchObject({ code: 'artifact_unavailable' });
    const second = await f.pipeline.stage(input({ accountId: 'account-b' }));
    expect(second.recoveryId).not.toBe(receipt.recoveryId);
    expect((await f.pipeline.recover({ ...trustedIdentity, accountId: 'account-b' })).accountId).toBe('account-b');
  });
  it.each(['partial', 'hash', 'specs', 'state', 'provenance', 'owner', 'missing', 'symlink'])('fails closed for %s staged source without final publication', async (kind) => {
    const f = await fixture(), receipt = await f.pipeline.stage(input()), save = vi.spyOn(f.store, 'save');
    const file = path.join(f.directory, `${receipt.recoveryId}.json`);
    const raw = JSON.parse(await fs.readFile(file));
    if (kind === 'partial') await fs.writeFile(file, '{');
    else if (kind === 'missing') { await fs.rename(file, path.join(f.directory, '.pending-fixture')); }
    else if (kind === 'symlink') { await fs.rename(file, path.join(f.root, 'source')); await fs.symlink(path.join(f.root, 'source'), file); }
    else {
      if (kind === 'hash') raw.artifact.sha256 = '0'.repeat(64);
      if (kind === 'specs') raw.artifact.specs.width = 2;
      if (kind === 'state') raw.artifact.state = 'available';
      if (kind === 'provenance') raw.artifact.provenance.sourceUrl = 'https://example.com';
      if (kind === 'owner') raw.artifact.accountId = 'account-b';
      await fs.writeFile(file, JSON.stringify(raw));
    }
    await expect(f.pipeline.recover(trustedIdentity)).rejects.toMatchObject({ code: 'artifact_unavailable' });
    expect(save).not.toHaveBeenCalled();
  });
  it('does not claim delivery for an inconsistent final adapter result, and retains source', async () => {
    const f = await fixture();
    const bad = createStagedArtifactPipeline({ ...f, store: { save: async () => ({ ...prepare(input()).artifact, sha256: 'bad' }) } });
    await expect(bad.save(input())).rejects.toMatchObject({ code: 'artifact_publish_mismatch' });
    expect(await f.pipeline.recover(trustedIdentity)).toEqual(prepare(input()).artifact);
  });
  it('fails closed for final conflicts, preserving the source for operator reconciliation', async () => {
    const f = await fixture(); await f.store.save(input({ bytes: png(2) }));
    await expect(f.pipeline.save(input())).rejects.toMatchObject({ code: 'artifact_conflict' });
    await expect(f.pipeline.recover(trustedIdentity)).rejects.toMatchObject({ code: 'artifact_conflict' });
    expect(await f.pipeline.stage(input())).toHaveProperty('state', 'staged');
  });
  it('requires explicit configuration, rejects overlaps and symlink aliases/ancestors', async () => {
    const f = await fixture();
    expect(configuredStagedArtifactPipeline({}, f.store)).toBeNull();
    expect(configuredStagedArtifactPipeline({ ARTIFACT_STAGING: 'disabled' }, f.store)).toBeNull();
    for (const env of [{ ARTIFACT_STAGING: 'unknown' }, { ARTIFACT_STAGING: 'local' }, { ARTIFACT_STAGING: 'local', ARTIFACT_STORAGE: 'local' }]) {
      expect(() => configuredStagedArtifactPipeline(env, f.store)).toThrow();
    }
    for (const directory of [f.artifactDirectory, path.join(f.artifactDirectory, 'nested'), f.root]) {
      expect(() => createStagedArtifactPipeline({ ...f, directory })).toThrow();
    }
    const alias = path.join(f.root, 'alias'); await fs.symlink(f.directory, alias);
    await expect(createStagedArtifactPipeline({ ...f, directory: alias }).stage(input())).rejects.toThrow();
    const finalAlias = path.join(f.root, 'final-alias'); await fs.symlink(f.artifactDirectory, finalAlias);
    await expect(createStagedArtifactPipeline({ ...f, artifactDirectory: finalAlias }).stage(input())).rejects.toThrow();
    const parentAlias = path.join(f.root, 'parent-alias'); await fs.symlink(f.root, parentAlias);
    await expect(createStagedArtifactPipeline({ ...f, directory: path.join(parentAlias, 'staged') }).stage(input())).rejects.toThrow();
    await fs.chmod(f.directory, 0o755);
    await expect(f.pipeline.stage(input())).rejects.toMatchObject({ code: 'artifact_storage_unsafe' });
  });
  it('wires opt-in pipeline while normal authenticated GET cannot expose stage-only records', async () => {
    const f = await fixture();
    const env = { NODE_ENV: 'test', AI_PROVIDER: 'mock', ARTIFACT_STORAGE: 'local', ARTIFACT_DIRECTORY: f.artifactDirectory,
      ARTIFACT_STAGING: 'local', ARTIFACT_STAGING_DIRECTORY: f.directory };
    const app = createServer({ db: {}, config: { env }, auth: {
      verifyRequest: async () => ({ kind: 'authenticated', userId: 'account-a' }), findUser: async (id) => ({ id }),
    } });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
    const receipt = await app.locals.artifactPipeline.stage(input());
    const url = `http://127.0.0.1:${server.address().port}/api/artifacts/${receipt.recoveryId}`;
    expect((await fetch(url)).status).toBe(404);
    await app.locals.artifactPipeline.recover(trustedIdentity);
    const response = await fetch(url); expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png());
    const disabled = createServer({ db: {}, config: { env: { NODE_ENV: 'test', AI_PROVIDER: 'mock' } } });
    expect(disabled.locals.artifactPipeline).toBeNull();
  });
  it('composes remote ingestion before publication and recovers offline without persisting signed URLs', async () => {
    const f = await fixture(), provider = vi.fn(), req = new EventEmitter(); req.destroy = vi.fn();
    const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const request = vi.fn((options, callback) => {
      req.end = () => queueMicrotask(() => {
        const res = new PassThrough(); res.statusCode = 200; res.headers = { 'content-type': 'image/png' }; res.complete = true;
        callback(res); res.end(png());
      }); return req;
    });
    const pipeline = createStagedArtifactPipeline({ ...f, store: { save: async () => { throw new Error('final failed'); } } });
    const remote = createRemoteArtifactIngestor({ store: pipeline, enabled: true, trustedHostnames: ['images.example.com'], lookup, request });
    const { bytes, ...metadata } = input();
    await expect(remote.ingest({ ...metadata, sourceUrl: 'https://images.example.com/file?token=secret' })).rejects.toThrow('final failed');
    for (const file of await fs.readdir(f.directory)) expect(await fs.readFile(path.join(f.directory, file), 'utf8')).not.toMatch(/secret|sourceUrl|https:/);
    const artifact = await createStagedArtifactPipeline(f).recover(trustedIdentity);
    expect(artifact).toEqual(prepare(input()).artifact);
    expect(lookup).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1); expect(provider).not.toHaveBeenCalled();
  });
});
