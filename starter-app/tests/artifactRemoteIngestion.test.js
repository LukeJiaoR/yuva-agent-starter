import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeArtifactStore, LIMITS } from '../server/artifacts/contract.js';
import { createRemoteArtifactIngestor, configuredRemoteArtifactIngestor, REMOTE_LIMITS } from '../server/artifacts/remoteIngestion.js';

const png = () => PNG.sync.write({ width: 1, height: 1, data: Buffer.alloc(4, 128) }, { colorType: 6 });
const input = (extra = {}) => ({ sourceUrl: 'https://images.example.com/render.png?token=secret',
  accountId: 'account-a', operationId: 'operation-1', provenance: { providerId: 'fixture', modelId: 'png' }, ...extra });
function fixture({ addresses = [{ address: '8.8.8.8', family: 4 }], status = 200,
  headers = { 'content-type': 'image/png' }, body = png(), complete = true, run, ...options } = {}) {
  const store = createFakeArtifactStore();
  const save = vi.spyOn(store, 'save');
  const lookup = vi.fn(async () => addresses);
  const req = new EventEmitter(); req.destroy = vi.fn();
  let res;
  const request = vi.fn((opts, callback) => {
    req.end = () => queueMicrotask(() => {
      res = new PassThrough(); res.statusCode = status; res.headers = headers; res.complete = complete;
      callback(res);
      if (run) run(res, req); else if (!res.destroyed) res.end(body);
    });
    return req;
  });
  const ingestor = createRemoteArtifactIngestor({ enabled: true, trustedHostnames: ['images.example.com'], store, lookup, request, ...options });
  return { ingestor, store, save, lookup, request, req, get response() { return res; } };
}
afterEach(() => vi.useRealTimers());

describe('trusted remote PNG ingestion', () => {
  it('is disabled by default, requires explicit bounded configuration and storage', async () => {
    await expect(createRemoteArtifactIngestor().ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_disabled' });
    await expect(configuredRemoteArtifactIngestor({}, null).ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_disabled' });
    for (const options of [{ enabled: true }, { trustedHostnames: ['*.example.com'] }, { trustedHostnames: ['127.0.0.1'] },
      { trustedHostnames: ['images.example.com.'] }, { deadlineMs: 10001 }, { deadlineMs: 0 }]) {
      expect(() => createRemoteArtifactIngestor(options)).toThrow();
    }
    expect(() => configuredRemoteArtifactIngestor({ ARTIFACT_REMOTE_INGESTION: 'fetch' }, {})).toThrow();
  });
  it('pins transport to one validated IP while preserving TLS hostname, and saves before availability', async () => {
    const f = fixture(); const artifact = await f.ingestor.ingest(input());
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith('images.example.com', { all: true, verbatim: true });
    const options = f.request.mock.calls[0][0];
    expect(options).toEqual({ protocol: 'https:', hostname: '8.8.8.8', family: 4, port: 443, method: 'GET',
      path: '/render.png?token=secret', servername: 'images.example.com', rejectUnauthorized: true,
      agent: false, maxHeaderSize: 8192,
      headers: { Host: 'images.example.com', Accept: 'image/png', 'Accept-Encoding': 'identity' } });
    expect(artifact.state).toBe('available');
    expect(JSON.stringify(artifact)).not.toMatch(/secret|sourceUrl|https:/);
    expect(f.save.mock.calls[0][0]).not.toHaveProperty('sourceUrl');
    expect((await f.store.get({ accountId: 'account-a', id: artifact.id })).bytes).toEqual(png());
    expect(await f.ingestor.ingest(input())).toEqual(artifact);
  });
  it('accepts public IPv6 and explicit 443 but never re-resolves at connection time', async () => {
    const f = fixture({ addresses: [{ address: '2606:4700:4700::1111', family: 6 }] });
    await f.ingestor.ingest(input({ sourceUrl: 'https://images.example.com:443/image.png' }));
    expect(f.request.mock.calls[0][0]).toMatchObject({ hostname: '2606:4700:4700::1111', family: 6, servername: 'images.example.com', agent: false });
    expect(f.lookup).toHaveBeenCalledTimes(1);
  });
  it.each(['http://images.example.com/a', 'https://images.example.com:444/a', 'https://a:b@images.example.com/a', 'https://@images.example.com/a',
    'https://127.0.0.1/a', 'https://2130706433/a', 'https://[::1]/a', 'https://images.example.com.evil.test/a',
    'https://sub.images.example.com/a', 'https://images.example.com./a', 'https://images.example.com/a#fragment',
    'https://images.example.com\\@evil.test/a', ' https://images.example.com/a', 'https://images.example.com/a\n',
    'https://images.example.com/' + 'a'.repeat(REMOTE_LIMITS.urlLength), 'not-a-url'])('rejects URL before DNS: %s', async (sourceUrl) => {
    const f = fixture(); await expect(f.ingestor.ingest(input({ sourceUrl }))).rejects.toMatchObject({ code: 'artifact_remote_url_rejected' });
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it.each(['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1',
    '192.0.0.9', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:8.8.8.8', '::8.8.8.8',
    '64:ff9b::808:808', '64:ff9b:1::1', '2002:808:808::1', '2001::1', '2001:20::1', '2001:db8::1',
    '3fff::1', '5f00::1', '100::1', '100:0:0:1::1', 'fec0::1', 'bad-ip'])('rejects unsafe DNS answer %s including mixed sets', async (address) => {
    const f = fixture({ addresses: [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] });
    await expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_address_rejected' });
    expect(f.request).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it.each([[], [{ address: '8.8.8.8', family: 6 }], Array(65).fill({ address: '8.8.8.8', family: 4 })].map((addresses) => ({ addresses })))('rejects empty, inconsistent or excessive DNS sets', async ({ addresses }) => {
    const f = fixture({ addresses }); await expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_address_rejected' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([301, 302, 307, 308, 400, 500])('rejects status %i without following any redirect', async (status) => {
    const f = fixture({ status, headers: { 'content-type': 'image/png', location: 'http://127.0.0.1/' } });
    await expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_response_rejected' });
    expect(f.request).toHaveBeenCalledTimes(1); expect(f.req.destroy).toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it.each([{ 'content-type': 'text/html' }, {}, { 'content-type': 'image/png; charset=utf-8' },
    { 'content-type': 'image/png', 'content-encoding': 'gzip' }, { 'content-type': 'image/png', 'content-encoding': 'identity' },
    { 'content-type': 'image/png', 'content-length': String(LIMITS.bytes + 1) },
    { 'content-type': 'image/png', 'content-length': '-1' }, { 'content-type': 'image/png', 'content-length': '99999999999999999999' },
    { 'content-type': 'image/png', 'content-length': '1' }])('rejects bad response headers %j', async (headers) => {
    const f = fixture({ headers }); await expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_response_rejected' });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('accepts matching content length and rejects chunked body over the byte limit', async () => {
    const f = fixture({ headers: { 'content-type': 'image/png', 'content-length': String(png().length) } });
    await f.ingestor.ingest(input());
    const large = fixture({ body: Buffer.alloc(LIMITS.bytes + 1) });
    await expect(large.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_response_rejected' });
    expect(large.save).not.toHaveBeenCalled(); expect(large.response.destroyed).toBe(true);
  });
  it('rejects malformed PNG and mismatching specs before store save', async () => {
    for (const body of [Buffer.from('<svg/>'), png().subarray(0, 40), Buffer.concat([png(), Buffer.from('tail')])]) {
      const f = fixture({ body }); await expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_invalid_image' }); expect(f.save).not.toHaveBeenCalled();
    }
    const f = fixture(); await expect(f.ingestor.ingest(input({ expectedSpecs: { width: 2 } }))).rejects.toMatchObject({ code: 'artifact_spec_mismatch' }); expect(f.save).not.toHaveBeenCalled();
  });
  it('rejects invalid metadata and caller request controls before DNS', async () => {
    for (const extra of [{ accountId: '' }, { provenance: { providerId: 'a', modelId: '' } }, { expectedSpecs: { unknown: 1 } },
      { expectedSpecs: { width: {} } }, { expectedSpecs: { toString: 1 } }, { bytes: png() }, { headers: { Authorization: 'secret' } }, { url: 'https://evil.test' }]) {
      const f = fixture(); await expect(f.ingestor.ingest(input(extra))).rejects.toThrow(); expect(f.lookup).not.toHaveBeenCalled();
    }
  });
  it('snapshots metadata and allowlist before asynchronous work', async () => {
    let resolve; const lookup = () => new Promise((r) => { resolve = r; });
    const hosts = ['images.example.com'], f = fixture({ lookup, trustedHostnames: hosts });
    const value = input({ expectedSpecs: { width: 1 } }); const pending = f.ingestor.ingest(value);
    value.accountId = 'victim'; value.provenance.modelId = 'changed'; value.expectedSpecs.width = 2; value.sourceUrl = 'https://evil.test'; hosts.push('evil.test');
    resolve([{ address: '8.8.8.8', family: 4 }]); const artifact = await pending;
    expect(artifact).toMatchObject({ accountId: 'account-a', provenance: { modelId: 'png' } });
    await expect(f.ingestor.ingest(input({ sourceUrl: 'https://evil.test' }))).rejects.toMatchObject({ code: 'artifact_remote_url_rejected' });
  });
  it('bounds DNS time and never starts transport after a late DNS answer', async () => {
    vi.useFakeTimers(); let resolve;
    const f = fixture({ lookup: () => new Promise((r) => { resolve = r; }) });
    const pending = expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_timeout' });
    await vi.advanceTimersByTimeAsync(10000); await pending;
    resolve([{ address: '8.8.8.8', family: 4 }]); await Promise.resolve();
    expect(f.request).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it('checks absolute time after overdue DNS completion even before the timeout callback runs', async () => {
    const f = fixture({ deadlineMs: 1, lookup: async () => {
      const until = performance.now() + 10;
      while (performance.now() < until) { /* Synthetic event-loop delay, no network. */ }
      return [{ address: '8.8.8.8', family: 4 }];
    } });
    await expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_timeout' });
    expect(f.request).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it('checks absolute time before accepting a body when the event loop delayed the timer', async () => {
    const f = fixture({ deadlineMs: 10, run: (res) => {
      const until = performance.now() + 20;
      while (performance.now() < until) { /* Delay the timer while returning body synchronously. */ }
      res.end(png());
    } });
    await expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_timeout' });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('applies one total DNS plus transfer deadline even when data trickles in', async () => {
    vi.useFakeTimers(); let resolve;
    const f = fixture({ lookup: () => new Promise((r) => { resolve = r; }), run: (res) => res.write(png().subarray(0, 8)) });
    const pending = expect(f.ingestor.ingest(input())).rejects.toMatchObject({ code: 'artifact_remote_timeout' });
    await vi.advanceTimersByTimeAsync(9000); resolve([{ address: '8.8.8.8', family: 4 }]); await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(f.req.destroy).toHaveBeenCalled(); expect(f.response.destroyed).toBe(true); expect(f.save).not.toHaveBeenCalled();
  });
  it('sanitizes DNS/TLS errors and rejects aborted/incomplete streams', async () => {
    for (const options of [{ lookup: async () => { throw new Error(input().sourceUrl); } },
      { request: () => { throw new Error(input().sourceUrl); } },
      { run: (res, req) => req.emit('error', new Error(input().sourceUrl)) },
      { run: (res) => res.emit('aborted') }, { complete: false }]) {
      const f = fixture(options); const error = await f.ingestor.ingest(input()).catch((e) => e);
      expect(error.message).toMatch(/^artifact_remote_/); expect(error.message).not.toContain('secret'); expect(error.cause).toBeUndefined(); expect(f.save).not.toHaveBeenCalled();
    }
  });
  it('does not report available before save settles and propagates save failure without retrying generation', async () => {
    let resolve; const f = fixture(); f.save.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    let finished = false; const pending = f.ingestor.ingest(input()).then((result) => { finished = true; return result; });
    await new Promise((r) => setImmediate(r)); expect(finished).toBe(false);
    resolve({ state: 'available' }); expect(await pending).toEqual({ state: 'available' });
    f.save.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.ingestor.ingest(input())).rejects.toThrow('storage unavailable');
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});
