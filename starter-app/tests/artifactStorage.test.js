import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, createFakeArtifactStore, hash } from '../server/artifacts/contract.js';
import { createLocalArtifactStore, configuredArtifactStore } from '../server/artifacts/localStore.js';
import { createServer } from '../server/index.js';

const roots = [], servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections(); await closed;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starter-artifact-test-'));
  roots.push(root); await fs.chmod(root, 0o700); return root;
}
function png(value = 128, width = 2, height = 3) {
  return PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4, value) }, { colorType: 6, inputColorType: 6 });
}
function chunk(type, data) {
  const label = Buffer.from(type), crcInput = Buffer.concat([label, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4), tail = Buffer.alloc(4);
  header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, label, data, tail]);
}
function withCompressed(data) {
  const valid = png();
  return Buffer.concat([valid.subarray(0, 33), chunk('IDAT', data), chunk('IEND', Buffer.alloc(0))]);
}
function input(extra = {}) {
  return { accountId: 'account-a', operationId: 'operation-1', slot: 'output', bytes: png(),
    provenance: { providerId: 'synthetic', modelId: 'fixture-1' }, ...extra };
}
async function serve(env) {
  const app = createServer({ db: {}, config: { env: { NODE_ENV: 'test', AI_PROVIDER: 'mock', ...env } }, auth: {
    verifyRequest: async (req) => req.headers.authorization?.startsWith('Bearer ')
      ? { kind: 'authenticated', userId: req.headers.authorization.slice(7) } : { kind: 'missing' },
    findUser: async (id) => ({ id }),
  } });
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
  return { app, url: `http://127.0.0.1:${server.address().port}` };
}

for (const kind of ['fake', 'local']) {
  describe(`${kind} artifact port`, () => {
    const store = async () => kind === 'fake' ? createFakeArtifactStore() : createLocalArtifactStore({ directory: await directory() });
    it('persists content-derived metadata and supports exact base64 retries', async () => {
      const adapter = await store(), request = input(), artifact = await adapter.save(request);
      expect(artifact).toMatchObject({ state: 'available', accountId: 'account-a', version: 1, sha256: hash(request.bytes),
        specs: { width: 2, height: 3, mediaType: 'image/png', sizeBytes: request.bytes.length } });
      expect(artifact.storageKey).toBe(`local-v1/${artifact.id}`);
      const { bytes, ...rest } = request;
      expect(await adapter.save({ ...rest, base64: bytes.toString('base64') })).toEqual(artifact);
      const result = await adapter.get({ accountId: 'account-a', id: artifact.id });
      expect(result.bytes).toEqual(bytes);
      result.bytes.fill(0); result.artifact.specs.width = 900;
      expect((await adapter.get({ accountId: 'account-a', id: artifact.id })).bytes).toEqual(bytes);
    });
    it('isolates accounts and rejects traversal or forged storage keys', async () => {
      const adapter = await store(), artifact = await adapter.save(input());
      await expect(adapter.get({ accountId: 'account-b', id: artifact.id })).rejects.toMatchObject({ code: 'artifact_unavailable' });
      for (const id of ['../secret', artifact.storageKey, '/etc/passwd', 'art_' + '0'.repeat(64)]) {
        await expect(adapter.get({ accountId: 'account-a', id })).rejects.toMatchObject({ code: 'artifact_unavailable' });
      }
      const second = await adapter.save(input({ accountId: 'account-b' }));
      expect(second.id).not.toBe(artifact.id);
    });
    it('makes identical concurrent writes idempotent and conflicting content immutable', async () => {
      const adapter = await store();
      const results = await Promise.all(Array.from({ length: 8 }, () => adapter.save(input())));
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      await expect(adapter.save(input({ bytes: png(64) }))).rejects.toMatchObject({ code: 'artifact_conflict' });
      await expect(adapter.save(input({ provenance: { providerId: 'other', modelId: 'fixture-1' } }))).rejects.toMatchObject({ code: 'artifact_conflict' });
    });
    it('concurrent different bytes have exactly one winner without overwrite', async () => {
      const adapter = await store(), first = input(), second = input({ bytes: png(9) });
      const results = await Promise.allSettled([adapter.save(first), adapter.save(second)]);
      const winner = results.findIndex((result) => result.status === 'fulfilled');
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected').reason.code).toBe('artifact_conflict');
      const saved = results[winner].value;
      expect((await adapter.get({ accountId: 'account-a', id: saved.id })).bytes).toEqual([first, second][winner].bytes);
    });
    it('rejects invalid specs, noncanonical base64, unsupported data and unbounded identity', async () => {
      const adapter = await store();
      for (const extra of [
        { expectedSpecs: { width: 100 } }, { expectedSpecs: { mediaType: 'image/jpeg' } }, { expectedSpecs: { width: '2' } },
        { expectedSpecs: { sizeBytes: 1 } }, { expectedSpecs: { unknown: true } }, { expectedSpecs: [] },
        { accountId: '' }, { operationId: 'x'.repeat(257) }, { slot: '\n' }, { provenance: {} },
        { bytes: undefined, base64: 'not base64' }, { bytes: undefined, base64: 'AAAA====' }, { base64: 'AAAA' },
        { bytes: Buffer.alloc(LIMITS.bytes + 1) }, { bytes: Buffer.from('<svg><script/></svg>') },
      ]) await expect(adapter.save(input(extra))).rejects.toBeDefined();
    });
    it('rejects all URLs without invoking fetch, including SSRF and credentials', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
      const adapter = await store();
      for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://user:pass@example.com/image.png', 'https://trusted.example/redirect', 'data:image/png;base64,AAAA']) {
        await expect(adapter.save(input({ url }))).rejects.toMatchObject({ code: 'artifact_remote_source_unsupported' });
        await expect(adapter.save(input({ sourceUrl: url }))).rejects.toMatchObject({ code: 'artifact_remote_source_unsupported' });
      }
      expect(fetch).not.toHaveBeenCalled();
    });
    it('fully validates bounded zlib data even when chunk CRCs are valid', async () => {
      const adapter = await store(), validStream = deflateSync(Buffer.alloc(27));
      for (const stream of [validStream.subarray(0, validStream.length - 1), Buffer.concat([validStream, Buffer.from('trailing')]),
        deflateSync(Buffer.alloc(28)), deflateSync(Buffer.alloc(26)), deflateSync(Buffer.alloc(1024 * 1024)), deflateSync(Buffer.alloc(27, 255))]) {
        await expect(adapter.save(input({ bytes: withCompressed(stream) }))).rejects.toMatchObject({ code: 'artifact_invalid_image' });
      }
    });
    it('rejects truncated, corrupt, polyglot, interlaced and oversized-pixel PNGs', async () => {
      const adapter = await store(), valid = png();
      const invalidCrc = Buffer.from(valid); invalidCrc[29] ^= 1;
      const giant = Buffer.from(valid); giant.writeUInt32BE(100000, 16);
      const interlaced = Buffer.from(valid); interlaced[28] = 1;
      const bogusData = Buffer.from(valid); bogusData[45] ^= 1;
      for (const bytes of [valid.subarray(0, valid.length - 1), valid.subarray(0, 33), Buffer.concat([valid, Buffer.from('<script/>')]), invalidCrc, giant, interlaced, bogusData]) {
        await expect(adapter.save(input({ bytes }))).rejects.toMatchObject({ code: 'artifact_invalid_image' });
      }
    });
  });
}

describe('local durability and fail-closed storage', () => {
  it('survives restart with one committed asset and ignores uncommitted crash leftovers', async () => {
    const root = await directory(), adapter = createLocalArtifactStore({ directory: root });
    const artifact = await adapter.save(input());
    await fs.writeFile(path.join(root, '.pending-crash'), '{partial', { mode: 0o600 });
    const restarted = createLocalArtifactStore({ directory: root });
    expect((await restarted.get({ accountId: 'account-a', id: artifact.id })).bytes).toEqual(png());
    expect(await restarted.save(input())).toEqual(artifact);
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.json'))).toEqual([`${artifact.id}.json`]);
    await expect(restarted.get({ accountId: 'account-a', id: '.pending-crash' })).rejects.toBeDefined();
  });
  it('roundtrips large valid base64 across save and process-style restart', async () => {
    const root = await directory(), adapter = createLocalArtifactStore({ directory: root });
    const bytes = PNG.sync.write({ width: 1024, height: 1024, data: randomBytes(1024 * 1024 * 4) });
    expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024);
    const artifact = await adapter.save(input({ bytes }));
    const restarted = createLocalArtifactStore({ directory: root });
    expect((await restarted.get({ accountId: 'account-a', id: artifact.id })).bytes.equals(bytes)).toBe(true);
    expect(await restarted.save(input({ bytes: undefined, base64: bytes.toString('base64') }))).toEqual(artifact);
    await expect(adapter.save(input({ bytes: undefined, base64: 'A'.repeat(11000000) }))).rejects.toMatchObject({ code: 'artifact_invalid_image' });
  }, 15000);
  it('does not overwrite partial committed files or return corrupted metadata/content', async () => {
    const root = await directory(), adapter = createLocalArtifactStore({ directory: root });
    const artifact = await adapter.save(input()), target = path.join(root, `${artifact.id}.json`);
    const original = await fs.readFile(target, 'utf8');
    for (const change of [
      (raw) => { raw.artifact.accountId = 'account-b'; },
      (raw) => { raw.artifact.sha256 = '0'.repeat(64); },
      (raw) => { raw.artifact.specs.width = 5; },
      (raw) => { raw.base64 = png(12).toString('base64'); },
      (raw) => { raw.artifact.storageKey = '../secret'; },
    ]) {
      const raw = JSON.parse(original); change(raw); await fs.writeFile(target, JSON.stringify(raw));
      await expect(adapter.get({ accountId: 'account-a', id: artifact.id })).rejects.toMatchObject({ code: 'artifact_unavailable' });
    }
    await fs.writeFile(target, '{partial');
    await expect(adapter.save(input())).rejects.toBeDefined();
    expect(await fs.readFile(target, 'utf8')).toBe('{partial');
  });
  it('rejects unsafe directories, ancestor symlinks and artifact symlinks', async () => {
    const root = await directory(), outside = await directory(), adapter = createLocalArtifactStore({ directory: root });
    const artifact = await adapter.save(input()), target = path.join(root, `${artifact.id}.json`);
    const secret = path.join(outside, 'secret'); await fs.writeFile(secret, 'secret', { mode: 0o600 });
    await fs.unlink(target); await fs.symlink(secret, target);
    await expect(adapter.get({ accountId: 'account-a', id: artifact.id })).rejects.toBeDefined();
    await expect(adapter.save(input())).rejects.toBeDefined();
    expect(await fs.readFile(secret, 'utf8')).toBe('secret');
    const link = path.join(outside, 'linked'); await fs.symlink(root, link);
    await expect(createLocalArtifactStore({ directory: link }).save(input())).rejects.toBeDefined();
    await fs.chmod(root, 0o755);
    await expect(adapter.save(input())).rejects.toBeDefined();
    expect(() => createLocalArtifactStore({ directory: './relative' })).toThrow();
  });
  it('recovers exact retries when a crash happens just after atomic publication', async () => {
    const root = await directory(), adapter = createLocalArtifactStore({ directory: root });
    const originalLink = fs.link;
    const link = vi.spyOn(fs, 'link').mockImplementationOnce(async (...args) => {
      await originalLink(...args); throw Object.assign(new Error('crash after publish'), { code: 'EIO' });
    });
    await expect(adapter.save(input())).rejects.toThrow('crash after publish');
    link.mockRestore();
    const restored = await createLocalArtifactStore({ directory: root }).save(input());
    expect(restored.state).toBe('available');
    expect((await fs.readdir(root))).toEqual([`${restored.id}.json`]);
  });
  it('a failed storage commit yields no available artifact; retry saves same generated bytes', async () => {
    const root = await directory(), adapter = createLocalArtifactStore({ directory: root });
    const generation = vi.fn(() => input()), request = generation();
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(adapter.save(request)).rejects.toThrow('disk full');
    expect(await fs.readdir(root)).toEqual([]);
    link.mockRestore();
    expect(await adapter.save(request)).toMatchObject({ state: 'available' });
    expect(generation).toHaveBeenCalledTimes(1);
  });
});

describe('authenticated artifact HTTP composition', () => {
  it('is disabled by default and rejects unsupported/incomplete trusted configuration', async () => {
    expect(configuredArtifactStore({})).toBeNull();
    expect(() => configuredArtifactStore({ ARTIFACT_STORAGE: 's3' })).toThrow();
    expect(() => configuredArtifactStore({ ARTIFACT_STORAGE: 'local' })).toThrow();
    const { app, url } = await serve({});
    expect(app.locals.artifactStore).toBeNull();
    expect((await fetch(`${url}/api/artifacts/art_${'0'.repeat(64)}`)).status).toBe(404);
  });
  it('uses verified profile identity only and serves private PNG bytes without filenames', async () => {
    const root = await directory(), { app, url } = await serve({ ARTIFACT_STORAGE: 'local', ARTIFACT_DIRECTORY: root });
    const artifact = await app.locals.artifactStore.save(input());
    const route = `${url}/api/artifacts/${artifact.id}?accountId=account-a&filename=unsafe`;
    expect((await fetch(route, { headers: { 'x-user-id': 'account-a' } })).status).toBe(401);
    expect((await fetch(route, { headers: { authorization: 'Bearer account-b', 'x-user-id': 'account-a' } })).status).toBe(404);
    const result = await fetch(route, { headers: { authorization: 'Bearer account-a' } });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('image/png');
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('content-disposition')).toBe('inline');
    expect(Buffer.from(await result.arrayBuffer())).toEqual(png());
    expect((await fetch(route, { method: 'POST', headers: { authorization: 'Bearer account-a' } })).status).toBe(404);
  });
});
